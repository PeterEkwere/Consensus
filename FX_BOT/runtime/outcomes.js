/**
 * Consensus FX Sentinel - alert ledger and outcome state machine.
 *
 * Lifecycle:
 *
 *   candidate -> pending_entry -> entered -> complete
 *                              -> cancelled_before_entry
 *                              -> expired
 *
 * The 1:1 and 3:1 legs resolve independently as pending / win / loss / void.
 *
 * Conservative rules, applied exactly:
 *
 * 1. Only fully closed M1 candles whose OPEN time is at or after `watchFromMs`
 *    are eligible. A candle that opened before the alert was sent is never
 *    used, even if it closed afterward.
 * 2. Entry activates when `low <= entry <= high`.
 * 3. Cancellation before entry happens only when a candle reaches the stop
 *    WITHOUT touching the entry at all.
 * 4. If one eligible candle holds both entry and stop, the plan is entered and
 *    the stop-first rule immediately resolves both legs as losses.
 * 5. After entry, a candle holding both the stop and an unresolved target
 *    records the stop first for that leg. A single OHLC bar cannot tell us
 *    which came first, so we always assume the worse path.
 * 9. Expiry voids unresolved legs; already resolved legs keep their result.
 * 10. A data fetch failure increments a gap counter and resolves nothing.
 *
 * Notifications are persisted BEFORE they are sent, so a crash can never
 * replay one. There are exactly two moments: `first_target` and `final`.
 *
 * Pure state machine plus a thin ledger. No network, no timers.
 */

"use strict";

const LEG_STATES = Object.freeze(["pending", "win", "loss", "void"]);
const LIFECYCLE = Object.freeze([
  "pending_entry",
  "entered",
  "complete",
  "cancelled_before_entry",
  "expired",
]);

/** Buckets a plan can occupy in `/results`. Exactly one applies at any time. */
const BUCKETS = Object.freeze([
  "pending_entry",
  "entered_unresolved",
  "cancelled_before_entry",
  "expired",
  "complete",
]);

// ---------------------------------------------------------------------------
// Record construction
// ---------------------------------------------------------------------------

function createRecord({ candidate, plan, id, dedupeKey, groupKey, sentAt, costs, configHash, provider }) {
  const watchFromMs = Number.isFinite(sentAt) ? sentAt : Date.parse(sentAt);
  return {
    id,
    dedupeKey,
    // Identifies the whole decision, so a rescan of the same candle cannot
    // publish the playbook that lost the first conflict resolution.
    groupKey,
    provider,
    symbol: candidate.symbol,
    playbookId: candidate.playbookId,
    playbookName: candidate.playbookName,
    side: plan.side,
    configHash,
    strategyVersion: Number.isFinite(candidate.strategyVersion) ? candidate.strategyVersion : null,
    strategyHash: candidate.strategyHash || configHash || null,
    cohortId: candidate.cohortId || configHash || null,
    thresholdAtAlert: null,
    universeHash: candidate.universeHash || null,

    signalTime: candidate.signalTime,
    triggerCandleTime: candidate.triggerCandleTime,
    // Decision-delay evidence. A 30-minute cadence evaluating 5-minute triggers
    // is a different product from 5-minute delivery, and the ledger must be
    // able to show that rather than implying they are equivalent.
    triggerCloseTime: Number.isFinite(candidate.triggerCloseTime) ? candidate.triggerCloseTime : null,
    scanTime: Number.isFinite(candidate.scanTime) ? candidate.scanTime : null,
    decisionDelayMs: Number.isFinite(candidate.decisionDelayMs) ? candidate.decisionDelayMs : null,
    quoteDriftR: Number.isFinite(candidate.quoteDriftR) ? candidate.quoteDriftR : null,
    qualityScore: Number.isFinite(candidate.qualityScore) ? candidate.qualityScore : null,
    familyCount: Number.isFinite(candidate.familyCount) ? candidate.familyCount : null,
    coveragePct: Number.isFinite(candidate.coveragePct) ? candidate.coveragePct : null,
    exposureKey: candidate.exposureKey || null,
    clusterId: candidate.exposureKey || null,
    setupStartedAt: candidate.setupStartedAt,
    sentAt: new Date(watchFromMs).toISOString(),
    watchFromMs,

    entry: plan.entry,
    stop: plan.stop,
    firstTarget: plan.firstTarget,
    finalTarget: plan.finalTarget,
    r: plan.r,
    stopPips: plan.stopPips,

    status: "pending_entry",
    entryTime: null,
    firstLeg: "pending",
    firstLegAt: null,
    finalLeg: "pending",
    finalLegAt: null,
    finalisedAt: null,

    notified: { firstTarget: false, final: false },

    // Cost is recorded at alert time. Unknown stays unknown; it is never
    // silently replaced with zero.
    costs: {
      observedSpread: costs.observedSpread,
      slippagePrice: costs.slippagePrice,
      commissionPrice: costs.commissionPrice,
      estimatedCostPrice: costs.estimatedCostPrice,
      costR: costs.costR,
      known: costs.known,
    },

    // Enough to reproduce the decision without re-running a scan.
    diagnostics: {
      score: candidate.score,
      session: candidate.session || null,
      newsStatus: candidate.newsStatus || "unknown",
      sourceLevel: candidate.sourceLevel,
      invalidation: candidate.invalidation,
      confirmations: (candidate.confirmations || []).map((c) => ({ family: c.family, text: c.text })),
      nearestOpposingStructure: candidate.nearestOpposingStructure
        ? { price: candidate.nearestOpposingStructure.price }
        : null,
    },
    lastCandleTime: null,
    candlesSeen: 0,
    dataGaps: 0,
    mfeR: null,
    maeR: null,
    msToEntry: null,
    msToFirstTarget: null,
    msToFinalResolution: null,
  };
}

/**
 * Round-trip cost in price units and in R.
 * Returns `known: false` when the spread was never observed.
 */
function estimateCosts({ observedSpread, r, strategy, symbol }) {
  const slippagePrice = strategy.costs.slippagePips * symbol.pip;
  const commissionPrice = strategy.costs.commissionPips * symbol.pip;
  if (!Number.isFinite(observedSpread)) {
    return {
      observedSpread: null,
      slippagePrice,
      commissionPrice,
      estimatedCostPrice: null,
      costR: null,
      known: false,
    };
  }
  const estimatedCostPrice = observedSpread + 2 * slippagePrice + commissionPrice;
  return {
    observedSpread,
    slippagePrice,
    commissionPrice,
    estimatedCostPrice,
    costR: r > 0 ? estimatedCostPrice / r : null,
    known: r > 0,
  };
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

function touches(candle, price) {
  return candle.low <= price && price <= candle.high;
}

function reachesStop(record, candle) {
  return record.side === "buy" ? candle.low <= record.stop : candle.high >= record.stop;
}

function reachesTarget(record, candle, target) {
  return record.side === "buy" ? candle.high >= target : candle.low <= target;
}

function trackExcursion(record, candle) {
  if (!(record.r > 0)) return;
  const favourable = record.side === "buy"
    ? candle.high - record.entry
    : record.entry - candle.low;
  const adverse = record.side === "buy"
    ? record.entry - candle.low
    : candle.high - record.entry;
  const mfe = favourable / record.r;
  const mae = adverse / record.r;
  if (Number.isFinite(mfe)) record.mfeR = record.mfeR === null ? mfe : Math.max(record.mfeR, mfe);
  if (Number.isFinite(mae)) record.maeR = record.maeR === null ? mae : Math.max(record.maeR, mae);
}

/**
 * Advance one record over a batch of closed M1 candles.
 *
 * Pure: returns a NEW record plus the events that fired. The caller persists
 * the record before sending anything.
 */
function applyCandles(record, candles, { now = Date.now(), expiryMs = 24 * 3600 * 1000 } = {}) {
  const next = { ...record, notified: { ...record.notified } };
  const events = [];
  if (next.status !== "pending_entry" && next.status !== "entered") {
    return { record: next, events };
  }

  const eligible = (candles || [])
    .filter((c) => c
      && Number.isFinite(c.time)
      && Number.isFinite(c.high)
      && Number.isFinite(c.low)
      && c.high >= c.low)
    // Rule 1: the candle must have OPENED at or after the alert was sent.
    .filter((c) => c.time >= next.watchFromMs)
    .filter((c) => !Number.isFinite(next.lastCandleTime) || c.time > next.lastCandleTime)
    .sort((a, b) => a.time - b.time);

  for (const candle of eligible) {
    next.lastCandleTime = candle.time;
    next.candlesSeen += 1;
    const at = new Date(candle.time).toISOString();
    let enteredThisCandle = false;

    if (next.status === "pending_entry") {
      if (touches(candle, next.entry)) {
        next.status = "entered";
        next.entryTime = at;
        next.msToEntry = candle.time - next.watchFromMs;
        enteredThisCandle = true;
        // Falls through: this same candle is now checked for resolution, which
        // is what makes rule 4 (entry + stop in one candle) a loss.
      } else if (reachesStop(next, candle)) {
        // Rule 3: stop reached, entry never touched.
        next.status = "cancelled_before_entry";
        next.firstLeg = "void";
        next.finalLeg = "void";
        next.finalisedAt = at;
        break;
      } else {
        continue;
      }
    }

    // The entry candle's sequence is unknowable from OHLC. Keep the
    // conservative stop-first outcome rule, but start excursion measurement on
    // the next candle rather than crediting a high/low that may predate entry.
    if (!enteredThisCandle) trackExcursion(next, candle);
    const stopped = reachesStop(next, candle);

    if (next.firstLeg === "pending") {
      if (stopped) {
        // Rules 4 and 5: stop first, whatever else this candle contains.
        next.firstLeg = "loss";
        next.firstLegAt = at;
        next.finalLeg = "loss";
        next.finalLegAt = at;
        next.status = "complete";
        next.finalisedAt = at;
        events.push({ type: "final", at });
        break;
      }
      if (reachesTarget(next, candle, next.firstTarget)) {
        next.firstLeg = "win";
        next.firstLegAt = at;
        if (reachesTarget(next, candle, next.finalTarget)) {
          // Rule 7: one candle reached both, so only the final event is sent.
          next.finalLeg = "win";
          next.finalLegAt = at;
          next.status = "complete";
          next.finalisedAt = at;
          events.push({ type: "final", at });
          break;
        }
        events.push({ type: "first_target", at });
        continue;
      }
      continue;
    }

    if (next.finalLeg === "pending") {
      if (stopped) {
        // Rule 8: first leg keeps its win, final leg is a loss.
        next.finalLeg = "loss";
        next.finalLegAt = at;
        next.status = "complete";
        next.finalisedAt = at;
        events.push({ type: "final", at });
        break;
      }
      if (reachesTarget(next, candle, next.finalTarget)) {
        next.finalLeg = "win";
        next.finalLegAt = at;
        next.status = "complete";
        next.finalisedAt = at;
        events.push({ type: "final", at });
        break;
      }
    }
  }

  // Rule 9: expiry voids what is unresolved and never invents a result.
  const stillOpen = next.status === "pending_entry" || next.status === "entered";
  if (stillOpen && now - next.watchFromMs >= expiryMs) {
    const hadEntered = next.status === "entered";
    next.status = "expired";
    next.finalisedAt = new Date(now).toISOString();
    if (next.firstLeg === "pending") next.firstLeg = "void";
    if (next.finalLeg === "pending") next.finalLeg = "void";
    // An entered setup must tell readers that monitoring ended, even when one
    // or both targets remained unresolved. Never-entered expiries stay silent.
    if (hadEntered) events.push({ type: "final", at: next.finalisedAt });
  }

  const entryMs = next.entryTime ? Date.parse(next.entryTime) : null;
  if (Number.isFinite(entryMs)) {
    const firstMs = next.firstLegAt ? Date.parse(next.firstLegAt) : null;
    const finalMs = next.finalisedAt ? Date.parse(next.finalisedAt) : null;
    if (Number.isFinite(firstMs)) next.msToFirstTarget = firstMs - entryMs;
    if (Number.isFinite(finalMs)) next.msToFinalResolution = finalMs - entryMs;
  }

  return { record: next, events: dedupeEvents(next, events) };
}

/**
 * Collapse to at most one first-target and one final notification, dropping
 * anything already announced. Flags live on the record, so dedup survives a
 * restart.
 */
function dedupeEvents(record, events) {
  const out = [];
  for (const event of events) {
    if (event.type === "first_target") {
      if (record.notified.firstTarget || record.notified.final) continue;
      record.notified.firstTarget = true;
      out.push(event);
    } else if (event.type === "final") {
      if (record.notified.final) continue;
      record.notified.firstTarget = true;
      record.notified.final = true;
      out.push({ ...event, firstLeg: record.firstLeg, finalLeg: record.finalLeg });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation of persisted rows
// ---------------------------------------------------------------------------

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Accept a persisted row only if it can still be reasoned about. */
function sanitizeRecord(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  if (typeof row.id !== "string" || !row.id) return null;
  if (typeof row.symbol !== "string" || !row.symbol) return null;
  const side = row.side === "buy" || row.side === "sell" ? row.side : null;
  if (!side) return null;

  const nums = ["entry", "stop", "firstTarget", "finalTarget", "r"].map((k) => Number(row[k]));
  if (!nums.every(Number.isFinite)) return null;
  const [entry, stop, firstTarget, finalTarget, r] = nums;
  if (entry <= 0 || r <= 0) return null;
  const ordered = side === "buy"
    ? stop < entry && entry < firstTarget && firstTarget < finalTarget
    : stop > entry && entry > firstTarget && firstTarget > finalTarget;
  if (!ordered) return null;

  const watchFromMs = Number(row.watchFromMs);
  const notified = row.notified && typeof row.notified === "object" ? row.notified : {};
  return {
    ...row,
    side,
    entry,
    stop,
    firstTarget,
    finalTarget,
    r,
    watchFromMs: Number.isFinite(watchFromMs) ? watchFromMs : Date.parse(row.sentAt) || 0,
    status: oneOf(row.status, LIFECYCLE, "pending_entry"),
    firstLeg: oneOf(row.firstLeg, LEG_STATES, "pending"),
    finalLeg: oneOf(row.finalLeg, LEG_STATES, "pending"),
    notified: {
      firstTarget: notified.firstTarget === true,
      final: notified.final === true,
    },
    lastCandleTime: Number.isFinite(Number(row.lastCandleTime)) ? Number(row.lastCandleTime) : null,
    candlesSeen: Number(row.candlesSeen) || 0,
    dataGaps: Number(row.dataGaps) || 0,
    cohortId: typeof row.cohortId === "string" && row.cohortId ? row.cohortId : null,
    clusterId: typeof row.clusterId === "string" && row.clusterId
      ? row.clusterId
      : (typeof row.exposureKey === "string" && row.exposureKey ? row.exposureKey : null),
    mfeR: finiteOrNull(row.mfeR),
    maeR: finiteOrNull(row.maeR),
    msToEntry: finiteOrNull(row.msToEntry),
    msToFirstTarget: finiteOrNull(row.msToFirstTarget),
    msToFinalResolution: finiteOrNull(row.msToFinalResolution),
  };
}

/** The single mutually exclusive bucket this record belongs to. */
function bucketOf(record) {
  if (record.status === "complete") return "complete";
  if (record.status === "cancelled_before_entry") return "cancelled_before_entry";
  if (record.status === "expired") return "expired";
  if (record.status === "entered") return "entered_unresolved";
  return "pending_entry";
}

module.exports = {
  BUCKETS,
  LEG_STATES,
  LIFECYCLE,
  applyCandles,
  bucketOf,
  createRecord,
  dedupeEvents,
  estimateCosts,
  sanitizeRecord,
};
