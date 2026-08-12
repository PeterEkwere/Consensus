/**
 * Consensus FX Sentinel - historical replay on the canonical engine.
 *
 * This file deliberately contains NO strategy logic. It walks candles forward
 * and calls the exact same `evaluateSymbol` and outcome state machine the live
 * scanner uses, because a replay that reimplements the rules will drift from
 * the bot it is supposed to validate.
 *
 * No-look-ahead contract enforced here:
 *
 * - at decision time, M5 is exposed only through the just-closed candle;
 * - M15/H1 are exposed only where those candles have fully closed by then;
 * - a plan emitted at decision time cannot enter or resolve on its trigger
 *   candle, because outcome evaluation starts at `watchFromMs`, which is the
 *   decision time, and the trigger candle opened before it;
 * - stop-first ambiguity is shared with live outcomes, not reimplemented;
 * - costs come from the historical spread when present, and are unknown, never
 *   zero, when absent.
 *
 * The replay never selects or tunes parameters. Configuration is frozen before
 * a run and its hash is recorded with every result.
 */

"use strict";

const { evaluateSymbol, makeAlertId } = require("./engine");
const { strategyHashOf, universeHashOf } = require("./config");
const exposure = require("./exposure");
const { TIMEFRAME_MS } = require("./market");
const outcomes = require("./outcomes");
const { observedSpread } = require("./provider");
const quality = require("./quality");
const results = require("./results");

/** Candles that had fully closed by `asOf`. */
function closedBy(series, timeframe, asOf) {
  const duration = TIMEFRAME_MS[timeframe];
  return series.filter((c) => c.time + duration <= asOf);
}

/**
 * Replay one symbol over its M5 series.
 *
 * `candles` is `{ M1, M5, M15, H1 }` in ascending order. Each M5 close becomes
 * a decision time; outcomes are resolved from M1 candles that opened at or
 * after it.
 */
function replaySymbol({ symbol, candles, strategy, configHash, newsStatus = "unknown",
  scanIntervalSeconds = 1800, strategyHash = strategyHashOf(strategy), universeHash = null }) {
  const m5 = candles.M5 || [];
  const m1 = candles.M1 || [];
  const records = [];
  const rejections = [];
  const conflicts = [];

  const intervalMs = Math.max(TIMEFRAME_MS.M5, Number(scanIntervalSeconds) * 1000);
  const groups = new Map();
  for (const trigger of m5) {
    const triggerClose = trigger.time + TIMEFRAME_MS.M5;
    const scanAt = Math.ceil(triggerClose / intervalMs) * intervalMs;
    if (!groups.has(scanAt)) groups.set(scanAt, []);
    groups.get(scanAt).push(trigger);
  }

  for (const [scanAt, triggers] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    // Live scanning evaluates every newly closed trigger at one scan time, with
    // the quote available at that scan. This deliberately models decision
    // delay instead of pretending each M5 candle was acted on immediately.
    const scanM5 = closedBy(m5, "M5", scanAt);
    const scanM1 = closedBy(m1, "M1", scanAt);
    if (!scanM5.length) continue;
    const spread = observedSpread(scanM1.length ? scanM1 : scanM5);
    const quote = scanM5[scanM5.length - 1].close;

    for (const trigger of triggers) {
      const triggerAsOf = trigger.time + TIMEFRAME_MS.M5;
      const view = {
        M5: closedBy(m5, "M5", triggerAsOf),
        M15: closedBy(candles.M15 || [], "M15", triggerAsOf),
        H1: closedBy(candles.H1 || [], "H1", triggerAsOf),
      };
      if (view.M5.length < 3) continue;

      const evaluation = evaluateSymbol({
        symbol,
        candles: view,
        asOf: triggerAsOf,
        now: scanAt,
        strategy,
        configHash,
        provider: "replay",
        spread,
        quote,
        newsStatus,
        existing: records,
        // The view is constructed from already-validated candles.
        diagnostics: { incomplete: 0, outOfOrder: 0 },
      });

      for (const rejection of evaluation.rejected) rejections.push({ ...rejection, at: scanAt });
      for (const conflict of evaluation.conflicts) conflicts.push({ ...conflict, at: scanAt });

      for (const { candidate, gate } of evaluation.published) {
        quality.annotate(candidate);
        candidate.strategyVersion = strategy.version;
        candidate.strategyHash = strategyHash;
        candidate.cohortId = configHash;
        candidate.universeHash = universeHash;
        candidate.triggerCloseTime = triggerAsOf;
        candidate.scanTime = scanAt;
        candidate.decisionDelayMs = scanAt - triggerAsOf;
        const costs = outcomes.estimateCosts({
          observedSpread: candidate.observedSpread,
          r: gate.plan.r,
          strategy,
          symbol,
        });
        candidate.session = gate.session;
        candidate.newsStatus = newsStatus;
        records.push(outcomes.createRecord({
          candidate,
          plan: gate.plan,
          id: makeAlertId(candidate, records, scanAt),
          dedupeKey: gate.key,
          groupKey: gate.group,
          sentAt: scanAt,
          costs,
          configHash,
          provider: "replay",
        }));
      }
    }
  }

  // Resolve every plan against M1 candles that opened at or after its own
  // decision time. This is the same state machine the live monitor uses.
  const expiryMs = 24 * 3600 * 1000;
  const resolved = records.map((record) => {
    const eligible = m1.filter((c) => c.time >= record.watchFromMs);
    const lastTime = eligible.length ? eligible[eligible.length - 1].time : record.watchFromMs;
    const applied = outcomes.applyCandles(record, eligible, {
      now: lastTime + TIMEFRAME_MS.M1,
      expiryMs,
    });
    return applied.record;
  });

  return { records: resolved, rejections, conflicts };
}

/**
 * Replay a set of symbols and produce machine-readable per-playbook summaries.
 * Deliberately no single blended "strategy win rate".
 */
function runReplay({ dataset, strategy, configHash, symbols, source = "fixtures",
  scanIntervalSeconds = 1800, strategyHash = strategyHashOf(strategy),
  universeHash = universeHashOf(symbols) }) {
  const proposed = [];
  const replayed = {};
  const perSymbol = {};

  for (const symbol of symbols) {
    const candles = dataset[symbol.id];
    if (!candles) continue;
    const outcome = replaySymbol({
      symbol, candles, strategy, configHash, scanIntervalSeconds, strategyHash, universeHash,
    });
    proposed.push(...outcome.records);
    replayed[symbol.id] = outcome;
  }

  // Apply the same independent-event identity used by the live scanner before
  // computing any statistics. Without this pass a replay would count several
  // correlated currency expressions as separate evidence.
  const selected = new Set();
  for (const cluster of exposure.clusterByExposure(proposed)) {
    for (const record of cluster.members) {
      record.exposureKey = cluster.exposureKey;
      record.clusterId = cluster.exposureKey;
    }
    const ranked = exposure.rankCandidates(cluster.members.map((record) => ({
      ...record,
      costR: record.costs && record.costs.costR,
      record,
    })), strategy.playbookPriority);
    for (const row of ranked.slice(0, strategy.gates.maxPerExposureCluster)) selected.add(row.record);
  }
  const all = proposed.filter((record) => selected.has(record));

  for (const symbol of symbols) {
    const outcome = replayed[symbol.id];
    if (!outcome) continue;
    const records = outcome.records.filter((record) => selected.has(record));
    perSymbol[symbol.id] = {
      symbol: symbol.id,
      plans: records.length,
      withheldByExposure: outcome.records.length - records.length,
      rejections: outcome.rejections.length,
      conflicts: outcome.conflicts.length,
      summary: results.summarise(records, { configHash, alertMode: "research" }),
    };
  }

  const times = all.map((r) => r.watchFromMs).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    source,
    configHash,
    strategyHash,
    universeHash,
    strategyVersion: strategy.version,
    scanIntervalSeconds,
    dateRange: times.length
      ? { from: new Date(times[0]).toISOString(), to: new Date(times[times.length - 1]).toISOString() }
      : null,
    symbols: perSymbol,
    overall: results.summarise(all, { configHash, alertMode: "research" }),
    // Stated explicitly so a report can never be read as a profitability claim.
    disclaimer:
      "Replay of candidate research playbooks on the canonical engine. "
      + "No edge is claimed or demonstrated by these figures.",
  };
}

module.exports = { closedBy, replaySymbol, runReplay };
