/**
 * Consensus FX Sentinel - shadow research ledger.
 *
 * The live diagnostic found 25 raw candidates, 24 rejected by hard gates and
 * ZERO published plans, almost all rejected by `insufficient_structural_room`.
 * That gate may be right or it may be throwing away the entire strategy - and
 * with no published outcomes there is currently no way to tell.
 *
 * So the gate is NOT relaxed. Instead, every candidate it withholds that had a
 * perfectly valid canonical plan is tracked in shadow, using the same candle
 * eligibility and stop-first rules as a published setup. After a forward
 * period, the evidence can say whether the gate helped, hurt, or should become
 * playbook-specific.
 *
 * Boundaries, enforced here and by tests:
 *
 * - Shadow records are never sent to Telegram and never become alerts.
 * - They use a distinct id namespace (`FXS-SHADOW-`).
 * - They live in their own file and never reach published `/results`.
 * - Only candidates with a VALID plan are shadowed. Malformed, stale or
 *   unavailable data is not gate evidence and is never tracked.
 */

"use strict";

const path = require("node:path");

const outcomes = require("./outcomes");
const storage = require("./storage");

const ID_PREFIX = "FXS-SHADOW";

/**
 * Gate rejections that represent a strategy JUDGEMENT and are therefore worth
 * measuring. Each one is a claim that could be wrong.
 */
const MEASURABLE_REJECTIONS = Object.freeze([
  "insufficient_structural_room",
  "outside_session",
  "price_moved_too_far",
  "spread_too_wide",
  "correlated_currency_exposure",
  "superseded",
  "stop_too_tight",
  "stop_too_wide",
]);

/**
 * Rejections that describe unusable DATA rather than a judgement. Shadowing
 * these would mix feed failures into gate evidence.
 */
const NEVER_SHADOW = Object.freeze([
  "incomplete_or_unordered_data",
  "no_closed_trigger",
  "live_quote_unavailable",
  "live_quote_stale",
  "non_finite_levels",
  "non_positive_levels",
  "stop_wrong_side",
  "rounding_collapsed_risk",
  "rounding_collapsed_levels",
  "invalid_side",
  "duplicate",
  "already_published_for_candle",
  "news_block",
  "news_status_invalid",
  "news_unavailable_for_normal_mode",
  "costs_unknown_for_normal_mode",
]);

function isMeasurable(reason) {
  return MEASURABLE_REJECTIONS.includes(reason) && !NEVER_SHADOW.includes(reason);
}

/**
 * Create the shadow ledger.
 *
 * It has no Telegram client and no notifier parameter, so there is no code path
 * through which a shadow record could be announced.
 */
function createShadowLedger({ stateDir, expiryHours = 24, provider, logger = console }) {
  const store = storage.createStore(path.join(stateDir, "shadow.json"), { records: [] });
  let records = (store.load().records || []).map(outcomes.sanitizeRecord).filter(Boolean);
  const expiryMs = expiryHours * 3600 * 1000;

  function persist() {
    store.save({ records });
  }

  /**
   * Track a withheld candidate. Returns null when the candidate is not
   * measurable gate evidence, or when it is already tracked.
   */
  function track({ candidate, plan, reason, symbol, sentAt, costs, configHash, quality }) {
    if (!isMeasurable(reason)) return null;
    if (!plan) return null;

    const dedupeKey = [
      "shadow", candidate.symbol, candidate.playbookId, candidate.side,
      candidate.signalTime, configHash, reason,
    ].join(":");
    const existing = records.find((r) => r.dedupeKey === dedupeKey);
    if (existing) return existing;

    const sequence = String(records.length + 1).padStart(4, "0");
    const record = outcomes.createRecord({
      candidate,
      plan,
      id: `${ID_PREFIX}-${String(candidate.symbol).replace(/_/g, "")}-${sequence}`,
      dedupeKey,
      groupKey: null,
      sentAt,
      costs,
      configHash,
      provider: "shadow",
    });

    record.shadow = true;
    record.rejectionReason = reason;
    record.qualityScore = quality ? quality.score : null;
    record.familyCount = quality ? quality.familyCount : null;
    record.coveragePct = quality ? quality.coveragePct : null;
    record.exposureKey = candidate.exposureKey || null;
    record.decisionDelayMs = Number.isFinite(candidate.decisionDelayMs)
      ? candidate.decisionDelayMs
      : null;

    records.unshift(record);
    persist();
    return record;
  }

  /** Advance open shadow records. Events are discarded: nothing is announced. */
  async function poll(now = Date.now(), markets = null) {
    const open = records.filter((r) => r.status === "pending_entry" || r.status === "entered");
    const groups = new Map();
    for (const record of open) {
      if (!groups.has(record.symbol)) groups.set(record.symbol, []);
      groups.get(record.symbol).push(record);
    }
    for (const [symbolId, group] of groups) {
      let fetched;
      try {
        if (markets && markets.has(symbolId)) {
          const loaded = markets.get(symbolId);
          fetched = {
            candles: (loaded.candles && loaded.candles.M1) || [],
            error: (loaded.errors || []).find((error) => error.timeframe === "M1") || null,
          };
        } else {
          fetched = await provider.fetchCandles(symbolId, "M1", { count: 300, asOf: now });
        }
      } catch (err) {
        for (const record of group) record.dataGaps = (record.dataGaps || 0) + 1;
        logger.error(`shadow: candle fetch failed for ${symbolId}: ${err.message}`);
        continue;
      }
      if (!fetched || fetched.error || !fetched.candles.length) {
        for (const record of group) record.dataGaps = (record.dataGaps || 0) + 1;
        continue;
      }
      for (const record of group) {
        // The same state machine published setups use.
        const applied = outcomes.applyCandles(record, fetched.candles, { now, expiryMs });
        const index = records.findIndex((r) => r.id === record.id);
        if (index >= 0) records[index] = { ...applied.record, shadow: true };
      }
    }
    persist();
  }

  return {
    get records() {
      return records;
    },
    track,
    poll,
    persist,
    find: (id) => records.find((r) => r.id === id) || null,
  };
}

/**
 * Group shadow evidence by rejection reason and playbook.
 * `summariseLeg` is injected from results.js so the maths matches the published
 * report exactly.
 */
function summarise(records, { summariseLeg, lifecycleOf }) {
  const rows = Array.isArray(records) ? records : [];
  const byReason = {};
  const byPlaybook = {};

  function bucket(target, key, record) {
    if (!target[key]) target[key] = [];
    target[key].push(record);
  }

  for (const record of rows) {
    bucket(byReason, record.rejectionReason || "unknown", record);
    bucket(byPlaybook, record.playbookId || "unknown", record);
  }

  function describe(group) {
    const out = {};
    for (const [key, cohort] of Object.entries(group)) {
      const complete = cohort.filter((r) => r.status === "complete");
      out[key] = {
        key,
        total: cohort.length,
        lifecycle: lifecycleOf(cohort),
        firstLeg: summariseLeg(complete, "first"),
        finalLeg: summariseLeg(complete, "final"),
        unknownCost: cohort.filter((r) => !r.costs || !r.costs.known).length,
      };
    }
    return out;
  }

  return {
    total: rows.length,
    byReason: describe(byReason),
    byPlaybook: describe(byPlaybook),
  };
}

module.exports = {
  ID_PREFIX,
  MEASURABLE_REJECTIONS,
  NEVER_SHADOW,
  createShadowLedger,
  isMeasurable,
  summarise,
};
