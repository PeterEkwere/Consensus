/**
 * Deterministic candle fixtures.
 *
 * These candles are hand-built to exercise the pipeline's PLUMBING: validation,
 * gates, plan construction, persistence and outcome resolution. They are not
 * market data and they prove nothing about profitability. Any figure derived
 * from them measures the code, not an edge.
 *
 * Every series is anchored to a fixed UTC time so tests never depend on the
 * clock.
 */

"use strict";

const { TIMEFRAME_MS } = require("../market");

// Wednesday 2026-01-07 12:00:00 UTC: inside both configured sessions.
const ANCHOR = Date.UTC(2026, 0, 7, 12, 0, 0);

/** Build a candle whose open time is `index` steps of `timeframe` from `start`. */
function candle(start, timeframe, index, { open, high, low, close, spread = null }) {
  const row = {
    time: start + index * TIMEFRAME_MS[timeframe],
    open,
    high,
    low,
    close,
    volume: 100,
    complete: true,
  };
  if (spread !== null) {
    row.bid = close - spread / 2;
    row.ask = close + spread / 2;
    row.spread = spread;
  }
  return row;
}

/** A flat series used as neutral background context. */
function flatSeries(start, timeframe, count, price, step = 0.0002, spread = null) {
  const out = [];
  for (let i = 0; i < count; i++) {
    // A gentle zig-zag so swing detection has something to confirm.
    const drift = (i % 4 < 2 ? 1 : -1) * step;
    const open = price + drift;
    const close = price - drift;
    out.push(candle(start, timeframe, i, {
      open,
      high: Math.max(open, close) + step,
      low: Math.min(open, close) - step,
      close,
      spread,
    }));
  }
  return out;
}

/**
 * A liquidity sweep reversal on EUR/USD.
 *
 * M15 builds a confirmed support level near 1.0900; a closed M5 candle spikes
 * below it and closes back above; the next M5 candle closes higher still.
 */
function eurUsdSweepReversal() {
  const SPREAD = 0.00008;
  const LEVEL = 1.0900;

  // M15 context. Everything is kept at or below 1.0910 so that a buy entered at
  // 1.0912 has no opposing structure overhead and can clear the 3:1 room gate.
  // The dip at `lowIndex` becomes the confirmed support the M5 candle sweeps.
  const m15Count = 40;
  const m15Start = ANCHOR - m15Count * TIMEFRAME_MS.M15;
  const lowIndex = m15Count - 14;
  const m15 = [];
  for (let i = 0; i < m15Count; i++) {
    if (i === lowIndex) {
      m15.push(candle(m15Start, "M15", i, {
        open: 1.0906, high: 1.0908, low: LEVEL, close: 1.0905, spread: SPREAD,
      }));
      continue;
    }
    const base = 1.0904 + (i % 3) * 0.0002;
    m15.push(candle(m15Start, "M15", i, {
      open: base,
      high: Math.min(base + 0.0004, 1.0910),
      low: base - 0.0002,
      close: base + 0.0001,
      spread: SPREAD,
    }));
  }

  // H1 context, also capped below the entry.
  const h1Count = 30;
  const h1Start = ANCHOR - h1Count * TIMEFRAME_MS.H1;
  const h1 = [];
  for (let i = 0; i < h1Count; i++) {
    const base = 1.0902 + (i % 4) * 0.0002;
    h1.push(candle(h1Start, "H1", i, {
      open: base,
      high: Math.min(base + 0.0005, 1.0910),
      low: base - 0.0004,
      close: base + 0.0002,
      spread: SPREAD,
    }));
  }

  // M5: quiet background just above the level, then sweep and confirmation.
  const m5Count = 60;
  const m5Start = ANCHOR - m5Count * TIMEFRAME_MS.M5;
  const m5 = [];
  for (let i = 0; i < m5Count - 2; i++) {
    const base = 1.0905 + (i % 3) * 0.0001;
    m5.push(candle(m5Start, "M5", i, {
      open: base,
      high: base + 0.0002,
      low: base - 0.0002,
      close: base + 0.0001,
      spread: SPREAD,
    }));
  }
  // Sweep: trades a clear distance below 1.0900 and closes back above it.
  m5.push(candle(m5Start, "M5", m5Count - 2, {
    open: 1.0905, high: 1.0907, low: 1.0894, close: 1.0903, spread: SPREAD,
  }));
  // Confirmation: bullish, closing in the top of its range and above the sweep.
  m5.push(candle(m5Start, "M5", m5Count - 1, {
    open: 1.0903, high: 1.0913, low: 1.0902, close: 1.0912, spread: SPREAD,
  }));

  // M1 covering the alert window so outcome monitoring has candles to read.
  const m1Count = 120;
  const m1Start = ANCHOR - 60 * TIMEFRAME_MS.M1;
  const m1 = flatSeries(m1Start, "M1", m1Count, 1.0912, 0.0003, SPREAD);

  return { M1: m1, M5: m5, M15: m15, H1: h1 };
}

/** Quiet, structureless series: the pipeline should find nothing here. */
function quietSeries(price, pip) {
  const step = pip * 2;
  return {
    M1: flatSeries(ANCHOR - 120 * TIMEFRAME_MS.M1, "M1", 120, price, step, pip * 0.8),
    M5: flatSeries(ANCHOR - 60 * TIMEFRAME_MS.M5, "M5", 60, price, step, pip * 0.8),
    M15: flatSeries(ANCHOR - 40 * TIMEFRAME_MS.M15, "M15", 40, price, step, pip * 0.8),
    H1: flatSeries(ANCHOR - 30 * TIMEFRAME_MS.H1, "H1", 30, price, step, pip * 0.8),
  };
}

/** The full offline dataset used by `--dry-run --fixtures` and by tests. */
function buildFixtureDataset() {
  return {
    EUR_USD: eurUsdSweepReversal(),
    GBP_USD: quietSeries(1.2650, 0.0001),
    USD_JPY: quietSeries(150.25, 0.01),
    XAU_USD: quietSeries(2350.0, 0.1),
  };
}

module.exports = {
  ANCHOR,
  buildFixtureDataset,
  candle,
  eurUsdSweepReversal,
  flatSeries,
  quietSeries,
};
