/**
 * Consensus FX Sentinel - hard gates, conflict resolution and trade plans.
 *
 * This module decides whether a raw candidate may become a publishable plan.
 * It is the only place that:
 *
 *   - applies the ten hard gates;
 *   - collapses correlated confirmations to one per family;
 *   - resolves several playbooks firing on the same candle;
 *   - constructs the canonical entry / stop / 1:1 / 3:1 levels;
 *   - assigns the stable alert ID and dedupe key.
 *
 * Every rejection is returned with a reason so the journal can explain why a
 * candidate did not become an alert. A silent drop would make the research
 * unauditable.
 *
 * Pure: no I/O, no clock of its own. `now` and all candles are supplied.
 */

"use strict";

const {
  nearestOpposing,
  priceToPips,
  roundPrice,
} = require("./market");
const { buildContext, generateCandidates } = require("./playbooks");

const DIRECTION_SIGN = Object.freeze({ buy: 1, sell: -1 });

// ---------------------------------------------------------------------------
// Confirmations
// ---------------------------------------------------------------------------

/**
 * Keep the highest-weighted confirmation per family.
 *
 * "Breakout", "break of structure" and "momentum close" often describe the same
 * candle. Counting them separately would inflate a single observation into
 * three independent reasons, so only one item per family survives.
 */
function collapseConfirmations(confirmations) {
  const best = new Map();
  for (const item of confirmations || []) {
    if (!item || !item.family) continue;
    const current = best.get(item.family);
    if (!current || item.weight > current.weight) best.set(item.family, item);
  }
  return [...best.values()].sort((a, b) => b.weight - a.weight);
}

/** Frozen ranking score: the sum of the surviving per-family weights. */
function scoreOf(confirmations) {
  return collapseConfirmations(confirmations).reduce((sum, c) => sum + c.weight, 0);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** True when `now` falls inside one of the configured UTC session windows. */
function sessionFor(now, windows) {
  const hour = new Date(now).getUTCHours();
  for (const window of windows) {
    if (hour >= window.startHour && hour < window.endHour) return window.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Trade plan
// ---------------------------------------------------------------------------

/**
 * Build the canonical levels.
 *
 * Full precision is kept until this point, then every level is rounded once to
 * the instrument's display precision. The rounded values are what the reader
 * copies AND what the outcome monitor tracks; they can never diverge.
 */
function buildTradePlan(candidate, symbol) {
  const side = candidate.side === "buy" ? "buy" : candidate.side === "sell" ? "sell" : null;
  if (!side) return { ok: false, reason: "invalid_side" };

  const sign = DIRECTION_SIGN[side];
  const rawEntry = Number(candidate.entry);
  const rawStop = Number(candidate.stop);
  if (!Number.isFinite(rawEntry) || !Number.isFinite(rawStop)) {
    return { ok: false, reason: "non_finite_levels" };
  }
  if (rawEntry <= 0 || rawStop <= 0) return { ok: false, reason: "non_positive_levels" };

  // Stop must be on the losing side of the entry.
  if (side === "buy" && rawStop >= rawEntry) return { ok: false, reason: "stop_wrong_side" };
  if (side === "sell" && rawStop <= rawEntry) return { ok: false, reason: "stop_wrong_side" };

  const entry = roundPrice(rawEntry, symbol);
  const stop = roundPrice(rawStop, symbol);
  const r = Math.abs(entry - stop);
  if (!Number.isFinite(r) || r <= 0) return { ok: false, reason: "rounding_collapsed_risk" };

  const firstTarget = roundPrice(entry + sign * r, symbol);
  const finalTarget = roundPrice(entry + sign * 3 * r, symbol);

  // Rounding must not fold a level back onto its neighbour.
  const ordered = side === "buy"
    ? stop < entry && entry < firstTarget && firstTarget < finalTarget
    : stop > entry && entry > firstTarget && firstTarget > finalTarget;
  if (!ordered) return { ok: false, reason: "rounding_collapsed_levels" };

  const stopPips = priceToPips(r, symbol);
  if (stopPips < symbol.minStopPips) return { ok: false, reason: "stop_too_tight" };
  if (stopPips > symbol.maxStopPips) return { ok: false, reason: "stop_too_wide" };

  return { ok: true, plan: { side, entry, stop, firstTarget, finalTarget, r, stopPips } };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function utcDateStamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}`
    + `${String(d.getUTCMonth() + 1).padStart(2, "0")}`
    + `${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** `FXS-EURUSD-20260808-001`. Sequence is per symbol per UTC date. */
function makeAlertId(candidate, existing, now) {
  const symbol = String(candidate.symbol).replace(/_/g, "");
  const prefix = `FXS-${symbol}-${utcDateStamp(now)}`;
  let highest = 0;
  for (const record of existing || []) {
    if (!record || typeof record.id !== "string") continue;
    if (!record.id.startsWith(`${prefix}-`)) continue;
    const seq = Number(record.id.slice(prefix.length + 1));
    if (Number.isFinite(seq) && seq > highest) highest = seq;
  }
  return `${prefix}-${String(highest + 1).padStart(3, "0")}`;
}

/**
 * Identity of a candidate. Repeat scans of the same closed candle under the
 * same configuration produce the same key, which is what makes scanning
 * idempotent.
 */
function dedupeKey(candidate, provider) {
  return [
    provider,
    candidate.symbol,
    candidate.playbookId,
    candidate.side,
    candidate.signalTime,
    candidate.configHash,
  ].join(":");
}

/**
 * Identity of the whole decision, independent of which playbook won it.
 *
 * At most one plan is published per symbol/candle, so a rescan must be blocked
 * at the group level too. Without this, the runner-up from the first scan would
 * be published on the second one, once the winner is deduped out.
 */
function groupKey(candidate) {
  return [candidate.symbol, candidate.signalTime, candidate.configHash].join(":");
}

// ---------------------------------------------------------------------------
// Hard gates
// ---------------------------------------------------------------------------

/**
 * Apply the ten hard gates in order. Returns `{ ok }` or `{ ok:false, reason }`.
 *
 * News is deliberately fail-safe: with no authenticated calendar the status is
 * "unknown", which is allowed to be journaled in research mode but can never be
 * reported to a reader as "news checked".
 */
function applyGates(candidate, context) {
  const { symbol, strategy, now, diagnostics, quote, quoteTime, newsStatus, existingKeys,
    researchMode = true, requireFreshQuote = false } = context;
  const gates = strategy.gates;

  // The canonical plan is pure, so building it up front costs nothing and lets
  // every rejection carry the plan it would have published. Shadow research
  // needs that plan; the gate ORDER below is unchanged, so a candidate that is
  // both out of session and unplannable still reports "outside_session".
  const built = buildTradePlan(candidate, symbol);
  const plannedOrNull = built.ok ? built.plan : null;
  const refuse = (reason) => ({ ok: false, reason, plan: plannedOrNull });

  // 1. Data completeness and chronology.
  if (!diagnostics || diagnostics.incomplete > 0 || diagnostics.outOfOrder > 0) {
    return refuse("incomplete_or_unordered_data");
  }
  if (requireFreshQuote) {
    if (!Number.isFinite(quote) || !Number.isFinite(quoteTime)) {
      return refuse("live_quote_unavailable");
    }
    const quoteAge = now - quoteTime;
    if (quoteAge < 0 || quoteAge > gates.maxQuoteAgeMinutes * 60 * 1000) {
      return refuse("live_quote_stale");
    }
  }

  // 2/3. Regime and trigger closure are enforced by the generators, which only
  // ever receive closed candles and matched contexts. Re-assert the trigger.
  if (!Number.isFinite(candidate.triggerCandleTime)) {
    return refuse("no_closed_trigger");
  }

  // 4. Spread limit.
  const spread = candidate.observedSpread;
  if (spread !== null && spread !== undefined) {
    if (priceToPips(spread, symbol) > symbol.maxSpreadPips) {
      return refuse("spread_too_wide");
    }
  }

  // 5. Session.
  const session = sessionFor(now, gates.sessionWindowsUtc);
  if (!session) return refuse("outside_session");

  // 6. News. Unknown is tolerated only in research mode, and the message must
  // say protection is unavailable.
  if (newsStatus === "blocked") return refuse("news_block");
  if (newsStatus !== "clear" && newsStatus !== "unknown") {
    return refuse("news_status_invalid");
  }
  if (!researchMode && newsStatus !== "clear") {
    return refuse("news_unavailable_for_normal_mode");
  }
  if (!researchMode && !Number.isFinite(candidate.observedSpread)) {
    return refuse("costs_unknown_for_normal_mode");
  }

  // 7. Finite positive R inside the instrument's limits.
  if (!built.ok) return refuse(built.reason);
  const plan = built.plan;

  // 8. Structural room for the full 3:1 target.
  const opposing = candidate.nearestOpposingStructure;
  if (opposing && Number.isFinite(opposing.price)) {
    const room = Math.abs(opposing.price - plan.entry);
    if (room < gates.minStructuralRoomR * plan.r) {
      return refuse("insufficient_structural_room");
    }
  }

  // 9. No chasing: the live quote must still be near the canonical entry.
  if (Number.isFinite(quote)) {
    const drift = Math.abs(quote - plan.entry);
    if (drift > gates.maxChaseFractionOfR * plan.r) {
      return refuse("price_moved_too_far");
    }
  }

  // 10. Not already processed, either as this exact candidate or as any plan
  //     already published for this symbol/candle/configuration.
  const key = dedupeKey(candidate, context.provider);
  if (existingKeys && existingKeys.has(key)) return refuse("duplicate");
  const group = groupKey(candidate);
  if (context.existingGroups && context.existingGroups.has(group)) {
    return refuse("already_published_for_candle");
  }

  return { ok: true, plan, session, key, group };
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

/**
 * At most one plan per symbol/side/signal candle may be published.
 *
 * Opposing valid candidates on the same candle cancel each other: the market
 * evidence contradicts itself, so publishing either would be arbitrary.
 */
function resolveConflicts(passing, strategy) {
  const groups = new Map();
  for (const item of passing) {
    const groupKey = `${item.candidate.symbol}:${item.candidate.signalTime}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(item);
  }

  const published = [];
  const conflicts = [];
  for (const [groupKey, items] of groups) {
    const sides = new Set(items.map((i) => i.candidate.side));
    if (sides.size > 1) {
      conflicts.push({
        key: groupKey,
        reason: "opposing_candidates",
        playbooks: items.map((i) => i.candidate.playbookId),
      });
      continue;
    }
    // Same side: rank by frozen score, then by explicit playbook priority.
    const sorted = items.slice().sort((a, b) => {
      const scoreDiff = scoreOf(b.candidate.confirmations) - scoreOf(a.candidate.confirmations);
      if (scoreDiff !== 0) return scoreDiff;
      const pa = strategy.playbookPriority[a.candidate.playbookId] ?? 99;
      const pb = strategy.playbookPriority[b.candidate.playbookId] ?? 99;
      return pa - pb;
    });
    published.push(sorted[0]);
    for (const loser of sorted.slice(1)) {
      conflicts.push({
        key: groupKey,
        reason: "superseded",
        playbookId: loser.candidate.playbookId,
        winner: sorted[0].candidate.playbookId,
        // A valid, lower-ranked plan is measurable shadow evidence.
        candidate: loser.candidate,
        plan: loser.gate.plan,
      });
    }
  }
  return { published, conflicts };
}

/**
 * P2 and P6 describe opposite conclusions about the same breakout, so they can
 * never both be valid. P2 expires the moment failure is confirmed.
 */
function enforceBreakoutExclusivity(candidates) {
  const p6 = candidates.filter((c) => c.playbookId === "P6");
  if (!p6.length) return { kept: candidates, suppressed: [] };

  const failedLevels = new Set(p6.map((c) => `${c.symbol}:${c.breakoutLevel}`));
  const kept = [];
  const suppressed = [];
  for (const candidate of candidates) {
    if (candidate.playbookId === "P2" && failedLevels.has(`${candidate.symbol}:${candidate.breakoutLevel}`)) {
      suppressed.push({ playbookId: "P2", reason: "breakout_failed_p6_wins" });
      continue;
    }
    kept.push(candidate);
  }
  return { kept, suppressed };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Run the full pipeline for one symbol.
 *
 * Returns every raw candidate for the journal alongside the (at most one)
 * publishable plan, so research keeps the near-misses that a published-only
 * view would throw away.
 */
function evaluateSymbol(input) {
  const {
    symbol, candles, asOf, now, strategy, configHash,
    provider = "fixtures", spread = null, quote = null, quoteTime = null,
    requireFreshQuote = false,
    newsStatus = "unknown", researchMode = true, existing = [], diagnostics = {},
  } = input;

  const ctx = buildContext({ symbol, candles, asOf, strategy, spread });
  const raw = generateCandidates(ctx);

  const exclusivity = enforceBreakoutExclusivity(raw);
  const existingKeys = new Set((existing || []).map((r) => r.dedupeKey).filter(Boolean));
  const existingGroups = new Set((existing || []).map((r) => r.groupKey).filter(Boolean));

  const levels = [...ctx.m15Levels, ...ctx.h1Levels];
  const evaluated = [];
  for (const candidate of exclusivity.kept) {
    candidate.configHash = configHash;
    candidate.observedSpread = spread;
    candidate.nearestOpposingStructure = nearestOpposing(levels, candidate.entry, candidate.side);
    candidate.confirmations = collapseConfirmations(candidate.confirmations);
    candidate.score = scoreOf(candidate.confirmations);

    const gate = applyGates(candidate, {
      symbol, strategy, now, diagnostics, quote, quoteTime, newsStatus, researchMode,
      requireFreshQuote,
      existingKeys, existingGroups, provider,
    });
    evaluated.push({ candidate, gate });
  }

  const passing = evaluated.filter((e) => e.gate.ok);
  const rejected = evaluated
    .filter((e) => !e.gate.ok)
    .map((e) => ({
      playbookId: e.candidate.playbookId,
      reason: e.gate.reason,
      // Carried so a withheld-but-valid setup can be shadow-measured. Null when
      // the candidate could never have been published at all.
      candidate: e.candidate,
      plan: e.gate.plan || null,
    }));

  const { published, conflicts } = resolveConflicts(passing, strategy);

  return {
    symbol: symbol.id,
    rawCandidates: raw,
    published,
    rejected,
    conflicts: [...conflicts, ...exclusivity.suppressed],
    detectorErrors: ctx.errors || [],
    context: ctx,
  };
}

module.exports = {
  DIRECTION_SIGN,
  applyGates,
  buildTradePlan,
  collapseConfirmations,
  dedupeKey,
  enforceBreakoutExclusivity,
  evaluateSymbol,
  groupKey,
  makeAlertId,
  resolveConflicts,
  scoreOf,
  sessionFor,
  utcDateStamp,
};
