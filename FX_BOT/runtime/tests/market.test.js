"use strict";

/** Candle validation and structure primitives. No network, no clock. */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TIMEFRAME_MS,
  isValidCandle,
  levelsFrom,
  nearestOpposing,
  roundPrice,
  structureOf,
  swingPoints,
  usableCandles,
} = require("../market");
const { SYMBOLS } = require("../config");

const T0 = Date.UTC(2026, 0, 7, 10, 0, 0);

function bar(index, { open, high, low, close, timeframe = "M5", complete = true }) {
  return { time: T0 + index * TIMEFRAME_MS[timeframe], open, high, low, close, complete };
}

test("a candle is valid only when its OHLC are finite, positive and ordered", () => {
  assert.equal(isValidCandle(bar(0, { open: 1, high: 2, low: 0.5, close: 1.5 })), true);
  assert.equal(isValidCandle(bar(0, { open: 1, high: 0.5, low: 2, close: 1.5 })), false, "high below low");
  assert.equal(isValidCandle(bar(0, { open: 1, high: 1.2, low: 0.5, close: 5 })), false, "close above high");
  assert.equal(isValidCandle(bar(0, { open: 1, high: 2, low: 0.5, close: 0.1 })), false, "close below low");
  assert.equal(isValidCandle(bar(0, { open: 0, high: 2, low: 0.5, close: 1 })), false, "non-positive");
  assert.equal(isValidCandle({ time: NaN, open: 1, high: 2, low: 0.5, close: 1 }), false);
  assert.equal(isValidCandle(null), false);
});

test("incomplete candles are rejected outright", () => {
  const raw = [
    bar(0, { open: 1, high: 1.1, low: 0.9, close: 1.05 }),
    bar(1, { open: 1.05, high: 1.2, low: 1.0, close: 1.1, complete: false }),
  ];
  const { candles, diagnostics } = usableCandles(raw, { timeframe: "M5", asOf: T0 + 10 * TIMEFRAME_MS.M5 });
  assert.equal(candles.length, 1);
  assert.equal(diagnostics.incomplete, 1);
});

test("a candle that has not fully closed by the decision time is unusable", () => {
  const raw = [bar(0, { open: 1, high: 1.1, low: 0.9, close: 1.05 })];
  // One millisecond before the candle closes.
  const early = usableCandles(raw, { timeframe: "M5", asOf: T0 + TIMEFRAME_MS.M5 - 1 });
  assert.equal(early.candles.length, 0);
  assert.equal(early.diagnostics.notYetClosed, 1);
  // Exactly at its close time it becomes usable.
  const ready = usableCandles(raw, { timeframe: "M5", asOf: T0 + TIMEFRAME_MS.M5 });
  assert.equal(ready.candles.length, 1);
});

test("duplicates are dropped and output is sorted ascending", () => {
  const a = bar(2, { open: 1, high: 1.1, low: 0.9, close: 1.0 });
  const b = bar(1, { open: 1, high: 1.1, low: 0.9, close: 1.0 });
  const { candles, diagnostics } = usableCandles([a, b, { ...a }], {
    timeframe: "M5",
    asOf: T0 + 10 * TIMEFRAME_MS.M5,
  });
  assert.equal(diagnostics.duplicates, 1);
  assert.deepEqual(candles.map((c) => c.time), [b.time, a.time]);
});

test("missing bars are counted as gaps rather than hidden", () => {
  const raw = [
    bar(0, { open: 1, high: 1.1, low: 0.9, close: 1.0 }),
    bar(4, { open: 1, high: 1.1, low: 0.9, close: 1.0 }),
  ];
  const { diagnostics } = usableCandles(raw, { timeframe: "M5", asOf: T0 + 20 * TIMEFRAME_MS.M5 });
  assert.equal(diagnostics.gaps, 3);
});

test("invalid rows are counted, not silently skipped", () => {
  const raw = [
    bar(0, { open: 1, high: 1.1, low: 0.9, close: 1.0 }),
    { time: T0 + TIMEFRAME_MS.M5, open: 1, high: 0.1, low: 5, close: 1 },
  ];
  const { candles, diagnostics } = usableCandles(raw, { timeframe: "M5", asOf: T0 + 20 * TIMEFRAME_MS.M5 });
  assert.equal(candles.length, 1);
  assert.equal(diagnostics.invalid, 1);
});

test("a swing is only confirmed once the candles proving it have closed", () => {
  // A clear high at index 2 with two lower candles either side.
  const candles = [
    bar(0, { open: 1.10, high: 1.101, low: 1.099, close: 1.100 }),
    bar(1, { open: 1.10, high: 1.102, low: 1.099, close: 1.101 }),
    bar(2, { open: 1.10, high: 1.110, low: 1.100, close: 1.105 }),
    bar(3, { open: 1.10, high: 1.103, low: 1.099, close: 1.101 }),
    bar(4, { open: 1.10, high: 1.102, low: 1.098, close: 1.100 }),
  ];
  const swings = swingPoints(candles, 2, 2);
  assert.equal(swings.highs.length, 1);
  assert.equal(swings.highs[0].index, 2);
  // Confirmed only when index 4 has CLOSED, not when it merely opened.
  assert.equal(swings.highs[0].confirmedAt, candles[4].time + TIMEFRAME_MS.M5);
  assert.ok(swings.highs[0].confirmedAt > swings.highs[0].time);

  // With the proving candles absent, the swing does not exist yet.
  assert.equal(swingPoints(candles.slice(0, 4), 2, 2).highs.length, 0);
});

test("levels only include swings confirmed by the decision time", () => {
  const candles = [
    bar(0, { open: 1.10, high: 1.101, low: 1.099, close: 1.100 }),
    bar(1, { open: 1.10, high: 1.102, low: 1.099, close: 1.101 }),
    bar(2, { open: 1.10, high: 1.110, low: 1.100, close: 1.105 }),
    bar(3, { open: 1.10, high: 1.103, low: 1.099, close: 1.101 }),
    bar(4, { open: 1.10, high: 1.102, low: 1.098, close: 1.100 }),
  ];
  const swings = swingPoints(candles, 2, 2);
  assert.equal(levelsFrom(swings, candles[3].time).length, 0, "not yet confirmed");
  assert.equal(levelsFrom(swings, candles[4].time).length, 0, "proving candle is still open");
  assert.ok(levelsFrom(swings, candles[4].time + TIMEFRAME_MS.M5).length > 0,
    "confirmed when index 4 closes");
});

test("structure needs agreeing highs and lows to call a direction", () => {
  const rising = {
    highs: [{ price: 1.10 }, { price: 1.11 }, { price: 1.12 }],
    lows: [{ price: 1.09 }, { price: 1.095 }, { price: 1.10 }],
  };
  assert.equal(structureOf(rising, 2).direction, "bullish");

  const falling = {
    highs: [{ price: 1.12 }, { price: 1.11 }, { price: 1.10 }],
    lows: [{ price: 1.10 }, { price: 1.095 }, { price: 1.09 }],
  };
  assert.equal(structureOf(falling, 2).direction, "bearish");

  const choppy = {
    highs: [{ price: 1.10 }, { price: 1.12 }, { price: 1.11 }],
    lows: [{ price: 1.09 }, { price: 1.085 }, { price: 1.095 }],
  };
  assert.equal(structureOf(choppy, 2).direction, "mixed");
  assert.equal(structureOf({ highs: [], lows: [] }, 2).direction, "mixed");
});

test("nearest opposing structure only looks ahead of the trade", () => {
  const levels = [{ price: 1.11 }, { price: 1.105 }, { price: 1.09 }];
  assert.equal(nearestOpposing(levels, 1.10, "buy").price, 1.105);
  assert.equal(nearestOpposing(levels, 1.10, "sell").price, 1.09);
  assert.equal(nearestOpposing([{ price: 1.09 }], 1.10, "buy"), null, "nothing overhead");
});

test("prices round to the instrument's own precision", () => {
  assert.equal(roundPrice(1.234567, SYMBOLS.EUR_USD), 1.23457);
  assert.equal(roundPrice(150.256, SYMBOLS.USD_JPY), 150.256);
  assert.equal(roundPrice(2350.567, SYMBOLS.XAU_USD), 2350.57);
});
