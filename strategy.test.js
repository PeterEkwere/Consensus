"use strict";

/**
 * Consensus Reaper - strategy identity, family scoring, clusters and theses.
 * Deterministic and offline: no network, no clock dependence, no filesystem.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const strategy = require("./strategy");
const execution = require("./execution");
const stats = require("./stats");
const shadowModule = require("./shadow");
const outcomes = require("./outcomes");

const queue = [];
const test = (name, fn) => queue.push({ name, fn });
const section = (name) => queue.push({ section: name });

// ---------------------------------------------------------------------------

section("strategy identity");

test("the strategy hash ignores key order and reacts to any decision value", () => {
  const a = strategy.strategyHash(strategy.STRATEGY);
  assert.strictEqual(a, strategy.strategyHash(strategy.STRATEGY), "stable across calls");

  // Reordering keys must not change the fingerprint.
  const reordered = JSON.parse(strategy.stableStringify(strategy.STRATEGY));
  assert.strictEqual(strategy.strategyHash(reordered), a, "key order is irrelevant");

  // Any decision value must change it.
  for (const mutate of [
    (s) => { s.minFamilies = 4; },
    (s) => { s.families.location = 25; },
    (s) => { s.execution.maxChaseFractionOfR = 0.5; },
    (s) => { s.publication.maxPerCluster = 3; },
    (s) => { s.version = 99; },
  ]) {
    const copy = JSON.parse(JSON.stringify(strategy.STRATEGY));
    mutate(copy);
    assert.notStrictEqual(strategy.strategyHash(copy), a, "a changed rule changes the hash");
  }
});

test("the cohort changes when publication policy changes", () => {
  const base = {
    strategy: strategy.STRATEGY,
    threshold: 95,
    useHtfGate: true,
    pairs: [{ market: "futures", api: "BTCUSDT" }],
    costs: { feeRatePerSide: 0.0005, slippageRatePerSide: 0.0005 },
  };
  const id = strategy.cohortId(base);
  assert.strictEqual(strategy.cohortId(base), id, "stable");

  assert.notStrictEqual(strategy.cohortId({ ...base, threshold: 90 }), id, "threshold");
  assert.notStrictEqual(strategy.cohortId({ ...base, useHtfGate: false }), id, "1h gate");
  assert.notStrictEqual(
    strategy.cohortId({ ...base, pairs: [{ market: "futures", api: "ETHUSDT" }] }), id, "universe");
  assert.notStrictEqual(
    strategy.cohortId({ ...base, costs: { feeRatePerSide: 0.001, slippageRatePerSide: 0.0005 } }),
    id, "cost policy");
});

test("the universe hash ignores ordering but not membership", () => {
  const a = strategy.universeHash([{ market: "futures", api: "BTCUSDT" }, { market: "futures", api: "ETHUSDT" }]);
  const b = strategy.universeHash([{ market: "futures", api: "ETHUSDT" }, { market: "futures", api: "BTCUSDT" }]);
  assert.strictEqual(a, b, "scan order must not create a new cohort");
  assert.notStrictEqual(strategy.universeHash([{ market: "futures", api: "BTCUSDT" }]), a);
  // Spot and futures for the same symbol are different instruments.
  assert.notStrictEqual(strategy.universeHash([{ market: "spot", api: "BTCUSDT" }]),
    strategy.universeHash([{ market: "futures", api: "BTCUSDT" }]));
});

test("records without a cohort are labelled legacy, never adopted", () => {
  assert.strictEqual(strategy.cohortOf({ cohortId: "abc" }), "abc");
  assert.strictEqual(strategy.cohortOf({}), strategy.LEGACY_COHORT_ID);
  assert.strictEqual(strategy.cohortOf(null), strategy.LEGACY_COHORT_ID);
});

// ---------------------------------------------------------------------------

section("family-aware scoring");

test("correlated evidence in one family is counted once", () => {
  // Four descriptions of the same trend. Summing them would give 18+14=32 for
  // structure alone; only the strongest may count.
  const collapsed = strategy.scoreEvidence([
    { label: "Bullish market structure", points: 18 },
    { label: "Bullish break of structure", points: 14 },
  ]);
  assert.strictEqual(collapsed.raw, 18, "the strongest structural item only");
  assert.strictEqual(collapsed.familyCount, 1);
  assert.strictEqual(collapsed.unscored.length, 1, "the weaker one is kept for audit");
});

test("trend descriptions collapse instead of stacking", () => {
  const evidence = strategy.scoreEvidence([
    { label: "Price aligned above 20/50 EMA", points: 10 },
    { label: "1h trend aligned", points: 12 },
    { label: "5m momentum aligned", points: 6 },
  ]);
  assert.strictEqual(evidence.familyCount, 1, "all three are the trend family");
  assert.strictEqual(evidence.raw, 12, "only the strongest trend item scores");
});

test("the denominator is frozen, so missing evidence lowers the score", () => {
  const full = strategy.scoreEvidence([
    { label: "Bullish market structure", points: 18 },
    { label: "Break and retest above prior resistance", points: 24 },
    { label: "1h trend aligned", points: 12 },
    { label: "Bullish engulfing", points: 16 },
    { label: "RSI momentum supportive", points: 5 },
    { label: "Volume expansion on signal candle", points: 5 },
    { label: "Round-trip cost is a small fraction of risk", points: 10 },
  ]);
  assert.strictEqual(full.denominator, 90);
  assert.strictEqual(full.score, 100, "every family maxed reaches 100");

  const partial = strategy.scoreEvidence([
    { label: "Bullish market structure", points: 18 },
    { label: "Break and retest above prior resistance", points: 24 },
  ]);
  // 42/90 = 47%. Under a present-only denominator this would have been 100%.
  assert.strictEqual(partial.score, 47, "absent evidence must not flatter the rest");
});

test("the score no longer saturates from correlated trend evidence alone", () => {
  // The exact combination that used to reach 100 by summing.
  const evidence = strategy.scoreEvidence([
    { label: "Bullish market structure", points: 18 },
    { label: "Bullish break of structure", points: 14 },
    { label: "Price aligned above 20/50 EMA", points: 10 },
    { label: "1h trend aligned", points: 12 },
    { label: "5m momentum aligned", points: 6 },
    { label: "Compression breakout", points: 10 },
  ]);
  // structure 18 + trend 12 + trigger 10 = 40 of 90.
  assert.strictEqual(evidence.raw, 40);
  assert.strictEqual(evidence.score, 44);
  assert(evidence.score < 100, "correlated evidence alone cannot reach the top");
});

test("an observation cannot exceed its family ceiling", () => {
  const evidence = strategy.scoreEvidence([{ label: "RSI momentum supportive", points: 999 }]);
  assert.strictEqual(evidence.raw, 5, "capped at the frozen family maximum");
});

test("unmapped observations are recorded but never scored", () => {
  const evidence = strategy.scoreEvidence([{ label: "Something invented", points: 50 }]);
  assert.strictEqual(evidence.raw, 0);
  assert.strictEqual(evidence.familyCount, 0);
  assert.strictEqual(evidence.unscored[0].reason, "unmapped_family");
});

test("reader reasons come from different families", () => {
  const evidence = strategy.scoreEvidence([
    { label: "Break and retest above prior resistance", points: 24 },
    { label: "Bullish market structure", points: 18 },
    { label: "Bullish break of structure", points: 14 },
    { label: "1h trend aligned", points: 12 },
  ]);
  const reasons = strategy.topReasons(evidence, 3);
  assert.strictEqual(reasons.length, 3);
  assert(!reasons.includes("Bullish break of structure"), "no second structural reason");
  const families = reasons.map((r) => strategy.familyOf(r));
  assert.strictEqual(new Set(families).size, 3, "three genuinely different reasons");
});

test("every mapped observation belongs to a declared family", () => {
  for (const [label, family] of Object.entries(strategy.OBSERVATION_FAMILIES)) {
    assert(strategy.FAMILY_IDS.includes(family), `${label} maps to an unknown family`);
  }
});

// ---------------------------------------------------------------------------

section("market-event clusters");

test("same window, same direction and same regime is one market event", () => {
  const context = { benchmarkDirection: "bearish" };
  const a = { time: "2026-08-08T12:01:00.000Z", side: "short" };
  const b = { time: "2026-08-08T12:03:00.000Z", side: "short" };
  assert.strictEqual(
    strategy.clusterKey(a, context), strategy.clusterKey(b, context),
    "two shorts inside one five-minute window are one event",
  );

  const opposite = { time: "2026-08-08T12:03:00.000Z", side: "long" };
  assert.notStrictEqual(strategy.clusterKey(a, context), strategy.clusterKey(opposite, context),
    "opposite directions are never one event");

  const later = { time: "2026-08-08T12:30:00.000Z", side: "short" };
  assert.notStrictEqual(strategy.clusterKey(a, context), strategy.clusterKey(later, context));
});

test("candidates rank by quality, then cost, then liquidity, then symbol", () => {
  const ranked = strategy.rankCandidates([
    { symbol: "CCC", score: 80, costR: 0.1, volumeH24Usd: 10 },
    { symbol: "AAA", score: 90, costR: 0.2, volumeH24Usd: 10 },
    { symbol: "BBB", score: 90, costR: 0.1, volumeH24Usd: 10 },
  ]);
  assert.deepStrictEqual(ranked.map((c) => c.symbol), ["BBB", "AAA", "CCC"]);

  // Ties fall through deterministically rather than depending on scan order.
  const tie = strategy.rankCandidates([
    { symbol: "ZZZ", score: 90, costR: 0.1, volumeH24Usd: 5 },
    { symbol: "AAA", score: 90, costR: 0.1, volumeH24Usd: 5 },
  ]);
  assert.deepStrictEqual(tie.map((c) => c.symbol), ["AAA", "ZZZ"]);
});

test("an unknown cost never outranks a measured one", () => {
  const ranked = strategy.rankCandidates([
    { symbol: "AAA", score: 90, costR: null, volumeH24Usd: 100 },
    { symbol: "BBB", score: 90, costR: 0.3, volumeH24Usd: 1 },
  ]);
  assert.strictEqual(ranked[0].symbol, "BBB", "a measured cost wins the tie-break");
});

// ---------------------------------------------------------------------------

section("thesis identity");

test("the same structural level is the same thesis across rescans", () => {
  const base = {
    market: "futures", symbol: "BTCUSDT", side: "long", thesisLevel: 64000,
    thesisAnchorTime: 123456789, r: 400,
  };
  const key = strategy.thesisKey(base);
  // A later candle, same level: still the same idea.
  assert.strictEqual(strategy.thesisKey({ ...base }), key);
  // Tiny floating-point drift must not mint a new thesis.
  assert.strictEqual(strategy.thesisKey({ ...base, r: 900 }), key, "changing ATR does not mint a new thesis");
});

test("a genuinely different level is a different thesis", () => {
  const base = { market: "futures", symbol: "BTCUSDT", side: "long", thesisLevel: 64000, r: 400 };
  assert.notStrictEqual(strategy.thesisKey({ ...base, thesisLevel: 65000 }), strategy.thesisKey(base));
  assert.notStrictEqual(strategy.thesisKey({ ...base, side: "short" }), strategy.thesisKey(base));
  assert.notStrictEqual(strategy.thesisKey({ ...base, symbol: "ETHUSDT" }), strategy.thesisKey(base));
});

test("a thesis is released only once its setup reaches a terminal state", () => {
  assert.strictEqual(strategy.thesisIsSettled({ status: "open" }), false);
  for (const status of ["complete", "cancelled", "expired"]) {
    assert.strictEqual(strategy.thesisIsSettled({ status }), true, status);
  }
});

// ---------------------------------------------------------------------------

section("regime context");

test("breadth and benchmark are read from every usable pair", () => {
  const context = strategy.marketContext([
    { symbol: "BTCUSDT", trend: "bearish", trendH1: "bearish" },
    { symbol: "ETHUSDT", trend: "bearish", trendH1: "bearish" },
    { symbol: "SOLUSDT", trend: "bearish", trendH1: "bearish" },
    { symbol: "XRPUSDT", trend: "mixed", trendH1: "mixed" },
  ]);
  assert.strictEqual(context.benchmarkDirection, "bearish");
  assert.strictEqual(context.ethDirection, "bearish");
  assert.strictEqual(context.trackedPairs, 4);
  assert.strictEqual(context.bearishPct, 75);
  assert.strictEqual(context.breadthDirection, "bearish");
});

test("the contradiction rule is symmetric and narrow", () => {
  const bearish = {
    benchmarkDirection: "bearish", benchmarkTrendH1: "bearish", breadthDirection: "bearish",
  };
  const bullish = {
    benchmarkDirection: "bullish", benchmarkTrendH1: "bullish", breadthDirection: "bullish",
  };
  // Both sides behave identically.
  assert.strictEqual(strategy.contradictsRegime("long", bearish), true);
  assert.strictEqual(strategy.contradictsRegime("short", bearish), false);
  assert.strictEqual(strategy.contradictsRegime("short", bullish), true);
  assert.strictEqual(strategy.contradictsRegime("long", bullish), false);

  // Anything ambiguous stays measurable rather than blocked.
  assert.strictEqual(strategy.contradictsRegime("long", {
    benchmarkDirection: "bearish", benchmarkTrendH1: "bullish", breadthDirection: "bearish",
  }), false, "benchmark timeframes disagree");
  assert.strictEqual(strategy.contradictsRegime("long", {
    benchmarkDirection: "bearish", benchmarkTrendH1: "bearish", breadthDirection: "mixed",
  }), false, "breadth is not decisive");
  assert.strictEqual(strategy.contradictsRegime("long", null), false);
});

test("score bins are deterministic and cover the range", () => {
  assert.strictEqual(strategy.scoreBin(0), "lt70");
  assert.strictEqual(strategy.scoreBin(69), "lt70");
  assert.strictEqual(strategy.scoreBin(70), "70-79");
  assert.strictEqual(strategy.scoreBin(89), "80-89");
  assert.strictEqual(strategy.scoreBin(94), "90-94");
  assert.strictEqual(strategy.scoreBin(99), "95-99");
  assert.strictEqual(strategy.scoreBin(100), "100");
  assert.strictEqual(strategy.scoreBin(NaN), "unknown");
});

// ---------------------------------------------------------------------------

section("execution snapshot");

function ticker(overrides = {}) {
  return {
    code: "0",
    data: [{ instId: "BTC-USDT-SWAP", bidPx: "64000", askPx: "64010", ts: "1000000", ...overrides }],
  };
}

test("a well-formed ticker parses into a quote", () => {
  const parsed = execution.parseTicker(ticker(), "BTC-USDT-SWAP");
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.quote.bid, 64000);
  assert.strictEqual(parsed.quote.ask, 64010);
  assert.strictEqual(parsed.quote.spread, 10);
});

test("missing, malformed and mismatched quotes are refused, never guessed", () => {
  assert.strictEqual(execution.parseTicker(null, "X").reason, execution.REFUSALS.UNAVAILABLE);
  assert.strictEqual(execution.parseTicker({ code: "1", data: [] }, "X").reason, execution.REFUSALS.UNAVAILABLE);
  assert.strictEqual(execution.parseTicker(ticker({ bidPx: "abc" }), "BTC-USDT-SWAP").reason,
    execution.REFUSALS.MALFORMED);
  assert.strictEqual(execution.parseTicker(ticker({ bidPx: "0" }), "BTC-USDT-SWAP").reason,
    execution.REFUSALS.MALFORMED);
  assert.strictEqual(execution.parseTicker(ticker({ askPx: "63000" }), "BTC-USDT-SWAP").reason,
    execution.REFUSALS.MALFORMED, "crossed book");
  assert.strictEqual(execution.parseTicker(ticker({ ts: "x" }), "BTC-USDT-SWAP").reason,
    execution.REFUSALS.MALFORMED);
  // A quote for another market looks valid and is the most dangerous case.
  assert.strictEqual(execution.parseTicker(ticker(), "ETH-USDT-SWAP").reason,
    execution.REFUSALS.WRONG_INSTRUMENT);
});

const COSTS = { feeRatePerSide: 0.0005, slippageRatePerSide: 0.0005 };

function evaluate(side, quote, overrides = {}) {
  const entry = 64000;
  const stop = side === "long" ? 63000 : 65000;
  const plan = {
    side, entry, stop, r: 1000,
    tp1: side === "long" ? 65000 : 63000,
    tp3: side === "long" ? 67000 : 61000,
  };
  return execution.evaluateExecution({
    signal: {}, plan, quote, now: 1_000_000, strategy: strategy.STRATEGY, costs: COSTS, ...overrides,
  });
}

test("the round trip charges the spread once plus both sides of fee and slippage", () => {
  const cost = execution.roundTripCost({
    entry: 64000, spread: 10, feeRatePerSide: 0.0005, slippageRatePerSide: 0.0005,
  });
  // 10 + 64000 * 2 * 0.001 = 10 + 128 = 138
  assert.strictEqual(cost, 138);
  assert.strictEqual(execution.roundTripCost({ entry: NaN, spread: 10, feeRatePerSide: 0, slippageRatePerSide: 0 }), null);
});

test("cost in R is computed from the observed book", () => {
  const result = evaluate("long", { bid: 63999, ask: 64000, mid: 63999.5, spread: 1, ts: 1_000_000 });
  assert.strictEqual(result.ok, true, result.reason);
  // (1 + 128) / 1000
  assert(Math.abs(result.snapshot.costR - 0.129) < 1e-9, `got ${result.snapshot.costR}`);
  assert.strictEqual(result.snapshot.known, true);
});

test("no-chase is symmetric for long and short", () => {
  // A long pays the ask; a short receives the bid. Each is 300 away from entry,
  // which is 0.30R and beyond the 0.25R limit.
  const long = evaluate("long", { bid: 64290, ask: 64300, mid: 64295, spread: 10, ts: 1_000_000 });
  const short = evaluate("short", { bid: 63700, ask: 63710, mid: 63705, spread: 10, ts: 1_000_000 });
  assert.strictEqual(long.reason, execution.REFUSALS.CHASE);
  assert.strictEqual(short.reason, execution.REFUSALS.CHASE);
  assert(Math.abs(long.snapshot.driftFractionOfR - short.snapshot.driftFractionOfR) < 1e-9,
    "identical distance must be treated identically");

  // Just inside the limit, both sides pass.
  assert.strictEqual(evaluate("long", { bid: 64190, ask: 64200, mid: 64195, spread: 10, ts: 1_000_000 }).ok, true);
  assert.strictEqual(evaluate("short", { bid: 63800, ask: 63810, mid: 63805, spread: 10, ts: 1_000_000 }).ok, true);
});

test("a stale quote cannot authorise an alert", () => {
  const stale = evaluate("long", { bid: 63999, ask: 64000, mid: 63999.5, spread: 1, ts: 1_000_000 - 120_000 });
  assert.strictEqual(stale.reason, execution.REFUSALS.STALE);
  // A quote from the future is equally untrustworthy.
  const ahead = evaluate("long", { bid: 63999, ask: 64000, mid: 63999.5, spread: 1, ts: 1_000_000 + 120_000 });
  assert.strictEqual(ahead.reason, execution.REFUSALS.STALE);
});

test("an expensive book is refused before publication", () => {
  // Spread 200 on R=1000 is 0.20R, beyond the 0.15R spread limit.
  const wide = evaluate("long", { bid: 63900, ask: 64100, mid: 64000, spread: 200, ts: 1_000_000 });
  assert.strictEqual(wide.reason, execution.REFUSALS.SPREAD);
});

test("a setup whose costs eat the risk is refused", () => {
  const tiny = execution.evaluateExecution({
    signal: {},
    // R of only 300 against a 128-unit fee/slippage load plus spread.
    plan: { side: "long", entry: 64000, stop: 63700, r: 300 },
    quote: { bid: 63995, ask: 64000, mid: 63997.5, spread: 5, ts: 1_000_000 },
    now: 1_000_000,
    strategy: strategy.STRATEGY,
    costs: COSTS,
  });
  // (5 + 128) / 300 = 0.443R, beyond the 0.35R ceiling.
  assert.strictEqual(tiny.reason, execution.REFUSALS.COST);
  assert(tiny.snapshot.costR > 0.35);
});

test("execution evidence only appears when it was measured", () => {
  const good = evaluate("long", { bid: 63999, ask: 64000, mid: 63999.5, spread: 1, ts: 1_000_000 });
  const obs = execution.executionObservations(good.snapshot, strategy.STRATEGY);
  assert(obs.length >= 1, "a clean fill earns execution-family evidence");
  for (const o of obs) assert.strictEqual(strategy.familyOf(o.label), "execution");
  assert.deepStrictEqual(execution.executionObservations(null), [], "no snapshot, no evidence");
  assert.deepStrictEqual(execution.executionObservations({ known: false }), []);
});

test("a fetch failure is a refusal, not a price", async () => {
  const result = await execution.fetchQuote("BTC-USDT-SWAP", async () => { throw new Error("down"); });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, execution.REFUSALS.UNAVAILABLE);
});

// ---------------------------------------------------------------------------

section("cluster statistics");

test("correlated rows collapse to one observation per market event", () => {
  const series = stats.clusterSeries([
    { clusterId: "A", net: 1 },
    { clusterId: "A", net: 1 },
    { clusterId: "A", net: -2 },
    { clusterId: "B", net: 3 },
  ]);
  assert.strictEqual(series.length, 2);
  const a = series.find((s) => s.clusterId === "A");
  assert.strictEqual(a.size, 3);
  assert(Math.abs(a.net - 0) < 1e-9, "mean of 1, 1 and -2 is 0");
});

test("rows without a cluster stay independent rather than being merged", () => {
  const series = stats.clusterSeries([{ net: 1 }, { net: 2 }]);
  assert.strictEqual(series.length, 2, "never merge what we cannot prove belongs together");
});

test("the t-statistic uses market events, not raw rows", () => {
  // Ten identical wins from ONE event must not look like ten confirmations.
  const correlated = Array.from({ length: 10 }, () => ({ clusterId: "A", win: true, gross: 1, net: 0.5 }));
  const result = stats.legStatistics(correlated);
  assert.strictEqual(result.rawCount, 10);
  assert.strictEqual(result.clusterCount, 1);
  assert.strictEqual(result.tStatistic, null, "one event cannot produce confidence");
  assert.strictEqual(result.largestClusterSize, 10);
});

test("the t-statistic matches a hand-calculated sample", () => {
  // Cluster means 1, 2, 3, 4: mean 2.5, sd 1.290994, se 0.645497, t = 3.872983.
  const samples = [1, 2, 3, 4].map((n, i) => ({ clusterId: `c${i}`, win: n > 0, gross: n, net: n }));
  const result = stats.legStatistics(samples);
  assert.strictEqual(result.clusterCount, 4);
  assert(Math.abs(result.tStatistic - 3.872983346207417) < 1e-9, `got ${result.tStatistic}`);
});

test("the t-statistic refuses to be infinite", () => {
  assert.strictEqual(stats.tStatistic([]), null);
  assert.strictEqual(stats.tStatistic([1]), null);
  assert.strictEqual(stats.tStatistic([2, 2, 2]), null, "zero variance is not certainty");
  assert.strictEqual(stats.tStatistic([1, Infinity]), null);
  assert.strictEqual(stats.tStatistic([1, NaN]), null);
});

test("a verdict may honestly be insufficient", () => {
  const thin = stats.legStatistics([{ clusterId: "A", win: true, gross: 1, net: 1 }]);
  assert.strictEqual(stats.evidenceVerdict(thin, { minClusters: 50 }).verdict, "insufficient evidence");

  const flat = stats.legStatistics(
    Array.from({ length: 60 }, (_, i) => ({ clusterId: `c${i}`, win: i % 2 === 0, gross: 1, net: i % 2 ? 0.1 : -0.1 })),
  );
  assert.strictEqual(stats.evidenceVerdict(flat, { minClusters: 50 }).verdict, "insufficient evidence");

  const losing = stats.legStatistics(
    Array.from({ length: 60 }, (_, i) => ({ clusterId: `c${i}`, win: false, gross: -1, net: -0.9 - (i % 3) * 0.05 })),
  );
  assert.strictEqual(stats.evidenceVerdict(losing, { minClusters: 50 }).verdict, "negative evidence");
});

// ---------------------------------------------------------------------------

section("shadow ledger");

test("only measurable rejections may be shadowed", () => {
  assert.strictEqual(shadowModule.isShadowable(shadowModule.SHADOW_REASONS.CORRELATED_LOWER_RANK), true);
  assert.strictEqual(shadowModule.isShadowable(shadowModule.SHADOW_REASONS.DUPLICATE_THESIS), true);
  // Data failures say nothing about a gate and must never be tracked.
  for (const reason of shadowModule.NEVER_SHADOW) {
    assert.strictEqual(shadowModule.isShadowable(reason), false, reason);
  }
  assert.strictEqual(shadowModule.isShadowable(null), false);
});

// Awaits the body before cleaning up, so async cases still have their ledger.
async function withLedger(fn, candles = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-shadow-"));
  try {
    const ledger = shadowModule.createShadowLedger({
      file: path.join(dir, "shadow.json"),
      createRecord: outcomes.createRecord,
      applyCandles: outcomes.applyCandles,
      fetchCandles: async () => candles,
      expiryMs: 24 * 3600 * 1000,
      logger: { error() {} },
    });
    return await fn(ledger, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SHADOW_SIGNAL = {
  market: "futures", symbol: "BTCUSDT", name: "BTC / USDT", side: "long",
  price: 100, stop: 90, time: "2026-08-08T12:00:00.000Z",
  clusterId: "A", thesisKey: "T", cohortId: "C", score: 80,
};
const PLAN = { side: "long", entry: 100, stop: 90, tp1: 110, tp3: 130, r: 10 };

test("a shadow record is namespaced, flagged and never notifies", () => {
  return withLedger((ledger) => {
    const record = ledger.track({
      signal: SHADOW_SIGNAL,
      plan: PLAN,
      baseId: "CR-BTC-20260808-001",
      sentAt: "2026-08-08T12:00:00.000Z",
      costs: COSTS,
      reasons: [shadowModule.SHADOW_REASONS.CORRELATED_LOWER_RANK],
    });
    assert(record.id.startsWith("SH-"), "a shadow id can never read as an alert id");
    assert.strictEqual(record.shadow, true);
    assert.deepStrictEqual(record.rejectionReasons, ["correlated_lower_rank"]);
    // The ledger exposes no notifier at all.
    assert.strictEqual(typeof ledger.notify, "undefined");
  });
});

test("an unshadowable reason and a missing plan are both refused", () => {
  return withLedger((ledger) => {
    assert.strictEqual(ledger.track({
      signal: SHADOW_SIGNAL, plan: PLAN, baseId: "x", sentAt: "2026-08-08T12:00:00.000Z",
      costs: COSTS, reasons: ["quote_stale"],
    }), null, "a data failure is not gate evidence");
    assert.strictEqual(ledger.track({
      signal: SHADOW_SIGNAL, plan: null, baseId: "x", sentAt: "2026-08-08T12:00:00.000Z",
      costs: COSTS, reasons: [shadowModule.SHADOW_REASONS.BELOW_THRESHOLD],
    }), null, "an unmeasurable plan is never shadowed");
    assert.strictEqual(ledger.records.length, 0);
  });
});

test("the same withheld setup is never shadowed twice", () => {
  return withLedger((ledger) => {
    const args = {
      signal: SHADOW_SIGNAL, plan: PLAN, baseId: "CR-BTC-20260808-001",
      sentAt: "2026-08-08T12:00:00.000Z", costs: COSTS,
      reasons: [shadowModule.SHADOW_REASONS.CORRELATED_LOWER_RANK],
    };
    const a = ledger.track(args);
    const b = ledger.track(args);
    assert.strictEqual(a.id, b.id);
    assert.strictEqual(ledger.records.length, 1);
    const second = ledger.track({
      ...args,
      signal: { ...SHADOW_SIGNAL, time: "2026-08-08T12:05:00.000Z", thesisKey: "T2" },
    });
    assert.notStrictEqual(a.id, second.id, "different setups cannot reuse a shadow id");
    assert(second.id.endsWith("-002"));
  });
});

test("shadow outcomes obey the same entry and stop-first rules", async () => {
  const alertMs = Date.parse("2026-08-08T12:00:00.000Z");
  await withLedger(async (ledger) => {
    ledger.track({
      signal: SHADOW_SIGNAL, plan: PLAN, baseId: "CR-BTC-20260808-001",
      sentAt: "2026-08-08T12:00:00.000Z", costs: COSTS,
      reasons: [shadowModule.SHADOW_REASONS.CORRELATED_LOWER_RANK],
    });
    await ledger.poll(alertMs + 5 * 60000);
    const record = ledger.records[0];
    // One candle spanning entry, target and stop must record the stop.
    assert.strictEqual(record.entryStatus, "entered");
    assert.strictEqual(record.r1Status, "sl");
    assert.strictEqual(record.r3Status, "sl");
    assert.strictEqual(record.shadow, true, "it stays a shadow record");
  }, [{ time: alertMs + 60000, low: 89, high: 131, open: 100, close: 100 }]);
});

test("shadow polling fetches candles once per instrument, not once per record", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-shadow-"));
  let fetches = 0;
  try {
    const ledger = shadowModule.createShadowLedger({
      file: path.join(dir, "shadow.json"),
      createRecord: outcomes.createRecord,
      applyCandles: outcomes.applyCandles,
      fetchCandles: async () => {
        fetches += 1;
        return [];
      },
      expiryMs: 24 * 3600 * 1000,
      logger: { error() {} },
    });
    for (const [index, time] of ["12:00", "12:05"].entries()) {
      ledger.track({
        signal: { ...SHADOW_SIGNAL, time: `2026-08-08T${time}:00.000Z`, thesisKey: `T${index}` },
        plan: PLAN,
        baseId: "CR-BTC-20260808-001",
        sentAt: "2026-08-08T12:10:00.000Z",
        costs: COSTS,
        reasons: [shadowModule.SHADOW_REASONS.BELOW_THRESHOLD],
      });
    }
    await ledger.poll(Date.parse("2026-08-08T12:11:00.000Z"));
    assert.strictEqual(fetches, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a candle that predates the shadow alert is ignored", async () => {
  const alertMs = Date.parse("2026-08-08T12:00:00.000Z");
  await withLedger(async (ledger) => {
    ledger.track({
      signal: SHADOW_SIGNAL, plan: PLAN, baseId: "CR-BTC-20260808-001",
      sentAt: "2026-08-08T12:00:00.000Z", costs: COSTS,
      reasons: [shadowModule.SHADOW_REASONS.CORRELATED_LOWER_RANK],
    });
    await ledger.poll(alertMs + 5 * 60000);
    assert.strictEqual(ledger.records[0].entryStatus, "pending");
  }, [{ time: alertMs - 60000, low: 89, high: 131, open: 100, close: 100 }]);
});

test("the shadow ledger is private and atomic", () => {
  return withLedger((ledger, dir) => {
    ledger.track({
      signal: SHADOW_SIGNAL, plan: PLAN, baseId: "CR-BTC-20260808-001",
      sentAt: "2026-08-08T12:00:00.000Z", costs: COSTS,
      reasons: [shadowModule.SHADOW_REASONS.BELOW_THRESHOLD],
    });
    const file = path.join(dir, "shadow.json");
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, "owner-only");
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), [],
      "no temporary file left behind");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(parsed.schemaVersion, shadowModule.SCHEMA_VERSION);
  });
});

test("a newer shadow schema is refused rather than overwritten", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-shadow-"));
  try {
    const file = path.join(dir, "shadow.json");
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, records: [] }));
    assert.throws(() => shadowModule.loadShadow(file), /newer schema/);
    fs.writeFileSync(file, "{broken");
    assert.throws(() => shadowModule.loadShadow(file), /refusing to overwrite/);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "{broken");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

async function main() {
  let passed = 0;
  for (const item of queue) {
    if (item.section) {
      console.log(item.section);
      continue;
    }
    try {
      await item.fn();
    } catch (err) {
      console.error(`  FAIL  ${item.name}`);
      console.error(err);
      process.exit(1);
    }
    passed += 1;
    console.log(`  ok  ${item.name}`);
  }
  console.log(`\nstrategy tests passed (${passed} tests)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
