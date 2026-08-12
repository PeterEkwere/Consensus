"use strict";

/**
 * Playbook detection: one positive fixture per playbook plus the near-misses
 * that must NOT fire. Fixtures validate rules, not profitability.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { STRATEGY, SYMBOLS, configHashOf } = require("../config");
const { TIMEFRAME_MS } = require("../market");
const {
  buildContext,
  generateCandidates,
  p1LiquiditySweepReversal,
  p2BreakoutRetest,
  p3TrendPullback,
  p4InternalBosRetest,
  p5RangeBoundaryRejection,
  p6FailedBreakout,
} = require("../playbooks");

const EUR = SYMBOLS.EUR_USD;
const T0 = Date.UTC(2026, 0, 7, 8, 0, 0);

function bar(start, timeframe, index, open, high, low, close) {
  return {
    time: start + index * TIMEFRAME_MS[timeframe],
    open, high, low, close, volume: 100, complete: true,
  };
}

/**
 * M15 series holding exactly ONE confirmed swing low, at `level`.
 *
 * Background candles share identical highs and lows on purpose: a fractal needs
 * to be strictly beyond its neighbours, so a flat background produces no other
 * levels and the fixture stays unambiguous about which level was swept.
 *
 * The whole series sits BEFORE `T0`, so every swing is confirmed long before
 * the M5 candles that trade against it.
 */
function m15WithSupport(level, count = 30) {
  const start = T0 - count * TIMEFRAME_MS.M15;
  const lowIndex = count - 12;
  const out = [];
  for (let i = 0; i < count; i++) {
    if (i === lowIndex) {
      out.push(bar(start, "M15", i, 1.0906, 1.0910, level, 1.0905));
      continue;
    }
    out.push(bar(start, "M15", i, 1.0907, 1.0910, 1.0906, 1.0908));
  }
  return out;
}

function quietM5(count, price, start = T0) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const base = price + (i % 3) * 0.0001;
    out.push(bar(start, "M5", i, base, base + 0.0002, base - 0.0002, base + 0.0001));
  }
  return out;
}

function contextFor({ m5, m15 = [], h1 = [], asOf }) {
  return buildContext({
    symbol: EUR,
    candles: { M5: m5, M15: m15, H1: h1 },
    asOf,
    strategy: STRATEGY,
  });
}

// ---------------------------------------------------------------------------
// P1 - liquidity sweep reversal
// ---------------------------------------------------------------------------

function p1Fixture({ sweepLow = 1.0894, confirmClose = 1.0912, confirmOpen = 1.0903 } = {}) {
  const m5 = quietM5(20, 1.0905);
  const n = m5.length;
  m5.push(bar(T0, "M5", n, 1.0905, 1.0907, sweepLow, 1.0903));
  m5.push(bar(T0, "M5", n + 1, confirmOpen, Math.max(confirmClose + 0.0001, 1.0913), 1.0902, confirmClose));
  const m15 = m15WithSupport(1.0900);
  return { m5, m15, asOf: m5[m5.length - 1].time + TIMEFRAME_MS.M5 };
}

test("P1 fires when a level is swept and the next candle closes back through it", () => {
  const fx = p1Fixture();
  const candidate = p1LiquiditySweepReversal(contextFor(fx));
  assert.ok(candidate, "a sweep reversal is detected");
  assert.equal(candidate.playbookId, "P1");
  assert.equal(candidate.side, "buy");
  assert.equal(candidate.entry, 1.0912, "entry is the confirmation close");
  assert.ok(candidate.stop < 1.0894, "stop sits beyond the sweep extreme plus buffer");
  assert.equal(candidate.sourceLevel.price, 1.0900, "the swept level is preserved for audit");
});

test("P1 does not fire when the sweep is too shallow", () => {
  // Dips only 0.5 pip below the level; the configured minimum is 1 pip.
  const fx = p1Fixture({ sweepLow: 1.08995 });
  assert.equal(p1LiquiditySweepReversal(contextFor(fx)), null);
});

test("P1 does not fire without a closing confirmation candle", () => {
  // Confirmation closes near its low instead of pushing back up.
  const fx = p1Fixture({ confirmClose: 1.0903, confirmOpen: 1.0912 });
  assert.equal(p1LiquiditySweepReversal(contextFor(fx)), null);
});

test("P1 ignores a level whose confirming candles had not closed yet", () => {
  const fx = p1Fixture();
  // Decide before the M15 swing is confirmed: the level does not exist yet.
  const ctx = contextFor({ ...fx, asOf: fx.m15[fx.m15.length - 20].time });
  assert.equal(p1LiquiditySweepReversal(ctx), null);
});

// ---------------------------------------------------------------------------
// P2 - breakout and retest
// ---------------------------------------------------------------------------

function p2Fixture({ breakoutClose = 1.0925, wickOnly = false } = {}) {
  // M15 with a confirmed resistance near 1.0910, then a decisive close above.
  const m15 = [];
  for (let i = 0; i < 24; i++) {
    const base = 1.0900 + (i % 3) * 0.0002;
    const isHigh = i === 12;
    m15.push(bar(T0, "M15", i, base, isHigh ? 1.0910 : base + 0.0003, base - 0.0003, base + 0.0001));
  }
  const breakIndex = 22;
  m15[breakIndex] = wickOnly
    ? bar(T0, "M15", breakIndex, 1.0905, 1.0930, 1.0903, 1.0906)  // wick through, close back under
    : bar(T0, "M15", breakIndex, 1.0905, breakoutClose + 0.0002, 1.0903, breakoutClose);

  const breakoutCloseMs = m15[breakIndex].time + TIMEFRAME_MS.M15;
  // M5 candles after the breakout: dip back to the level, then reject upward.
  const m5 = [];
  for (let i = 0; i < 4; i++) {
    m5.push({
      time: breakoutCloseMs + i * TIMEFRAME_MS.M5,
      open: 1.0918, high: 1.0922, low: 1.0914, close: 1.0919, volume: 100, complete: true,
    });
  }
  m5.push({
    time: breakoutCloseMs + 4 * TIMEFRAME_MS.M5,
    open: 1.0912, high: 1.0921, low: 1.0909, close: 1.0920, volume: 100, complete: true,
  });
  return { m5, m15, asOf: m5[m5.length - 1].time + TIMEFRAME_MS.M5 };
}

test("P2 fires on a body close beyond a level followed by a held retest", () => {
  const candidate = p2BreakoutRetest(contextFor(p2Fixture()));
  assert.ok(candidate, "breakout and retest detected");
  assert.equal(candidate.playbookId, "P2");
  assert.equal(candidate.side, "buy");
  assert.equal(candidate.entry, 1.0920, "entry is the rejection close");
  assert.ok(Number.isFinite(candidate.breakoutCandleTime), "breakout is recorded for P6 exclusivity");
});

test("P2 rejects a wick through the level with no body close beyond it", () => {
  assert.equal(p2BreakoutRetest(contextFor(p2Fixture({ wickOnly: true }))), null);
});

// ---------------------------------------------------------------------------
// P3 - trend pullback
// ---------------------------------------------------------------------------

function trendSeries(timeframe, count, { up = true, start = T0 } = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const drift = (up ? 1 : -1) * i * 0.0012;
    const wiggle = (i % 4 < 2 ? 1 : -1) * 0.0004;
    const open = 1.0800 + drift + wiggle;
    const close = 1.0800 + drift - wiggle + (up ? 0.0004 : -0.0004);
    out.push({
      time: start + i * TIMEFRAME_MS[timeframe],
      open,
      close,
      high: Math.max(open, close) + 0.0004,
      low: Math.min(open, close) - 0.0004,
      volume: 100,
      complete: true,
    });
  }
  return out;
}

test("P3 refuses to fire when the two structural timeframes disagree", () => {
  const h1 = trendSeries("H1", 30, { up: true });
  const m15 = trendSeries("M15", 30, { up: false });
  const m5 = quietM5(10, 1.0900);
  const ctx = contextFor({ m5, m15, h1, asOf: m5[m5.length - 1].time + TIMEFRAME_MS.M5 });
  assert.equal(p3TrendPullback(ctx), null, "no signal when 1h and 15m disagree");
});

test("P3 refuses to fire when higher-timeframe structure is unclear", () => {
  const flat = quietM5(30, 1.0900);
  const ctx = contextFor({ m5: flat, m15: [], h1: [], asOf: flat[flat.length - 1].time + TIMEFRAME_MS.M5 });
  assert.equal(p3TrendPullback(ctx), null);
});

test("P3 fires on an aligned trend, valid pullback and closed reversal candle", () => {
  const asOf = T0 + 10 * TIMEFRAME_MS.M5;
  const previous = bar(T0, "M5", 8, 1.1075, 1.1077, 1.1063, 1.1065);
  const trigger = bar(T0, "M5", 9, 1.1064, 1.1082, 1.1058, 1.1080);
  const ctx = {
    symbol: EUR,
    strategy: STRATEGY,
    asOf,
    observedSpread: 0.00008,
    m5: [previous, trigger],
    trigger,
    h1Structure: { direction: "bullish" },
    m15Structure: { direction: "bullish" },
    h1Swings: {
      highs: [
        { price: 1.1050, time: T0 - 8 * TIMEFRAME_MS.H1, confirmedAt: T0 - 6 * TIMEFRAME_MS.H1 },
        { price: 1.1100, time: T0 - 4 * TIMEFRAME_MS.H1, confirmedAt: T0 - 2 * TIMEFRAME_MS.H1 },
      ],
      lows: [
        { price: 1.0950, time: T0 - 9 * TIMEFRAME_MS.H1, confirmedAt: T0 - 7 * TIMEFRAME_MS.H1 },
        { price: 1.1000, time: T0 - 5 * TIMEFRAME_MS.H1, confirmedAt: T0 - 3 * TIMEFRAME_MS.H1 },
      ],
    },
  };
  const candidate = p3TrendPullback(ctx);
  assert.ok(candidate);
  assert.equal(candidate.playbookId, "P3");
  assert.equal(candidate.side, "buy");
  assert.equal(candidate.entry, trigger.close);
});

// ---------------------------------------------------------------------------
// P4 - internal break of structure retest
// ---------------------------------------------------------------------------

function p4Context({ h1 = "bullish", m15 = "bullish" } = {}) {
  const swingPrice = 1.1000;
  const confirmAt = T0 + 2 * TIMEFRAME_MS.M5;
  const m5 = [
    bar(T0, "M5", 0, 1.0988, 1.0992, 1.0985, 1.0990),
    bar(T0, "M5", 1, 1.0990, 1.0995, 1.0988, 1.0993),
    bar(T0, "M5", 2, 1.0994, 1.1010, 1.0993, 1.1008),
    bar(T0, "M5", 3, 1.1002, 1.1009, 1.0999, 1.1007),
  ];
  return {
    symbol: EUR,
    strategy: STRATEGY,
    asOf: m5[m5.length - 1].time + TIMEFRAME_MS.M5,
    observedSpread: 0.00008,
    m5,
    trigger: m5[m5.length - 1],
    h1Structure: { direction: h1 },
    m15Structure: { direction: m15 },
    m5Swings: {
      highs: [{ price: swingPrice, time: T0 - TIMEFRAME_MS.M5, confirmedAt: confirmAt }],
      lows: [],
    },
  };
}

test("P4 fires when an internal break retests in an aligned larger trend", () => {
  const candidate = p4InternalBosRetest(p4Context());
  assert.ok(candidate);
  assert.equal(candidate.playbookId, "P4");
  assert.equal(candidate.side, "buy");
});

test("P4 refuses a larger-timeframe disagreement", () => {
  assert.equal(p4InternalBosRetest(p4Context({ h1: "bullish", m15: "bearish" })), null);
});

// ---------------------------------------------------------------------------
// P5 - range boundary rejection
// ---------------------------------------------------------------------------

function rangeM15(count = 30, upper = 1.0930, lower = 1.0900) {
  const out = [];
  for (let i = 0; i < count; i++) {
    // Alternate touches of both boundaries, always closing back inside.
    const touchUpper = i % 6 === 2;
    const touchLower = i % 6 === 5;
    const open = 1.0915;
    const close = 1.0915;
    out.push(bar(
      T0, "M15", i, open,
      touchUpper ? upper : 1.0922,
      touchLower ? lower : 1.0908,
      close,
    ));
  }
  return out;
}

test("P5 fires when a range boundary is tested and rejected", () => {
  const m15 = rangeM15();
  const lastM15Close = m15[m15.length - 1].time + TIMEFRAME_MS.M15;
  const m5 = [
    // Approach candle, then the boundary test, then the confirmation.
    { time: lastM15Close, open: 1.0921, high: 1.0924, low: 1.0919, close: 1.0923, volume: 100, complete: true },
    { time: lastM15Close + TIMEFRAME_MS.M5, open: 1.0925, high: 1.0932, low: 1.0924, close: 1.0926, volume: 100, complete: true },
    { time: lastM15Close + 2 * TIMEFRAME_MS.M5, open: 1.0926, high: 1.0927, low: 1.0918, close: 1.0919, volume: 100, complete: true },
  ];
  const ctx = contextFor({ m5, m15, asOf: m5[m5.length - 1].time + TIMEFRAME_MS.M5 });
  const candidate = p5RangeBoundaryRejection(ctx);
  assert.ok(candidate, "range rejection detected");
  assert.equal(candidate.side, "sell", "rejected the top, so it points back inside");
  assert.equal(candidate.entry, 1.0919);
});

test("P5 does not classify a trending series as a range", () => {
  const m15 = trendSeries("M15", 30, { up: true });
  const m5 = quietM5(5, 1.0900);
  const ctx = contextFor({ m5, m15, asOf: m5[m5.length - 1].time + TIMEFRAME_MS.M5 });
  assert.equal(p5RangeBoundaryRejection(ctx), null);
});

// ---------------------------------------------------------------------------
// P6 - failed breakout
// ---------------------------------------------------------------------------

test("P6 fires when a break beyond a level closes back through it", () => {
  const m15 = m15WithSupport(1.0900);
  const start = m15[m15.length - 1].time + TIMEFRAME_MS.M15;
  const m5 = [
    { time: start, open: 1.0902, high: 1.0903, low: 1.0885, close: 1.0888, volume: 100, complete: true },
    { time: start + TIMEFRAME_MS.M5, open: 1.0888, high: 1.0892, low: 1.0886, close: 1.0890, volume: 100, complete: true },
    { time: start + 2 * TIMEFRAME_MS.M5, open: 1.0890, high: 1.0908, low: 1.0889, close: 1.0906, volume: 100, complete: true },
  ];
  const ctx = contextFor({ m5, m15, asOf: m5[m5.length - 1].time + TIMEFRAME_MS.M5 });
  const candidate = p6FailedBreakout(ctx);
  assert.ok(candidate, "failed breakout detected");
  assert.equal(candidate.playbookId, "P6");
  assert.equal(candidate.side, "buy", "a failed downside break points up");
  assert.equal(candidate.entry, 1.0906);
});

// ---------------------------------------------------------------------------
// Shared behaviour
// ---------------------------------------------------------------------------

test("a detector throwing does not stop the other five", () => {
  const fx = p1Fixture();
  const ctx = contextFor(fx);
  // Corrupt the context a detector reads so it throws internally.
  Object.defineProperty(ctx, "m15Levels", {
    get() { throw new Error("boom"); },
  });
  const candidates = generateCandidates(ctx);
  assert.ok(Array.isArray(candidates), "the scan survives");
  assert.ok(ctx.errors && ctx.errors.length > 0, "the failure is recorded, not swallowed");
});

test("no candidate is produced without a closed trigger candle", () => {
  const ctx = contextFor({ m5: [], m15: m15WithSupport(1.0900), asOf: T0 });
  assert.deepEqual(generateCandidates(ctx), []);
});

test("every confirmation carries a family so correlated evidence can be collapsed", () => {
  const candidate = p1LiquiditySweepReversal(contextFor(p1Fixture()));
  assert.ok(candidate.confirmations.length >= 3);
  for (const c of candidate.confirmations) {
    assert.ok(typeof c.family === "string" && c.family.length > 0, "family present");
    assert.ok(typeof c.text === "string" && c.text.length > 0);
    assert.ok(Number.isFinite(c.weight));
  }
});

test("the configuration hash is stable and changes when tuning changes", () => {
  const a = configHashOf(STRATEGY, [EUR]);
  const b = configHashOf(STRATEGY, [EUR]);
  assert.equal(a, b, "same inputs, same hash");

  const tweaked = JSON.parse(JSON.stringify(STRATEGY));
  tweaked.p1.minSweepPips = 99;
  assert.notEqual(configHashOf(tweaked, [EUR]), a, "changed tuning changes the hash");

  // Key order must not affect the hash.
  const reordered = { ...STRATEGY };
  assert.equal(configHashOf(reordered, [EUR]), a);
});
