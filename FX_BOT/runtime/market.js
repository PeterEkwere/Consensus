/**
 * Consensus FX Sentinel - candle validation and shared market features.
 *
 * Pure functions only. Everything the playbooks need to reason about structure
 * lives here so the six detectors share one definition of a swing, a level and
 * a body close, instead of each inventing its own.
 *
 * The hard rule enforced throughout: a candle is usable only once it has fully
 * closed, and a swing is only "confirmed" once the candles that prove it have
 * also closed. Nothing here may look at data later than the decision time.
 */

"use strict";

const TIMEFRAME_MS = Object.freeze({
  M1: 60 * 1000,
  M5: 5 * 60 * 1000,
  M15: 15 * 60 * 1000,
  H1: 60 * 60 * 1000,
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isFinitePositive(n) {
  return Number.isFinite(n) && n > 0;
}

/** A candle is structurally valid if its OHLC are finite, positive and ordered. */
function isValidCandle(candle) {
  if (!candle || typeof candle !== "object") return false;
  const { time, open, high, low, close } = candle;
  if (!Number.isFinite(time)) return false;
  if (![open, high, low, close].every(isFinitePositive)) return false;
  if (high < low) return false;
  if (high < open || high < close) return false;
  if (low > open || low > close) return false;
  return true;
}

/**
 * Filter a raw candle array down to the ones that may inform a decision.
 *
 * Rejects incomplete candles, structurally invalid candles, duplicates and
 * out-of-order timestamps, and any candle that has not fully closed by
 * `asOf`. Returns the clean ascending series plus a diagnostic record so the
 * caller can surface data gaps instead of silently trading on thin data.
 */
function usableCandles(raw, { timeframe, asOf }) {
  const durationMs = TIMEFRAME_MS[timeframe];
  if (!durationMs) throw new Error(`Unknown timeframe: ${timeframe}`);

  const diagnostics = {
    timeframe,
    received: Array.isArray(raw) ? raw.length : 0,
    incomplete: 0,
    invalid: 0,
    duplicates: 0,
    outOfOrder: 0,
    notYetClosed: 0,
    gaps: 0,
  };
  if (!Array.isArray(raw)) return { candles: [], diagnostics };

  const seen = new Set();
  const kept = [];
  for (const candle of raw) {
    if (candle && candle.complete === false) {
      diagnostics.incomplete += 1;
      continue;
    }
    if (!isValidCandle(candle)) {
      diagnostics.invalid += 1;
      continue;
    }
    // A candle opening at t is only usable once t + duration has passed.
    if (Number.isFinite(asOf) && candle.time + durationMs > asOf) {
      diagnostics.notYetClosed += 1;
      continue;
    }
    if (seen.has(candle.time)) {
      diagnostics.duplicates += 1;
      continue;
    }
    seen.add(candle.time);
    kept.push(candle);
  }

  kept.sort((a, b) => a.time - b.time);

  // Count missing bars. Weekends and holidays legitimately create gaps in FX,
  // so this is reported rather than treated as an error.
  for (let i = 1; i < kept.length; i++) {
    const step = kept[i].time - kept[i - 1].time;
    if (step > durationMs) diagnostics.gaps += Math.round(step / durationMs) - 1;
    if (step <= 0) diagnostics.outOfOrder += 1;
  }

  return { candles: kept, diagnostics };
}

/** Close time of a candle, i.e. the first instant its data may be used. */
function closeTime(candle, timeframe) {
  return candle.time + TIMEFRAME_MS[timeframe];
}

/** The most recent candle that had fully closed by `asOf`. */
function lastClosed(candles) {
  return candles.length ? candles[candles.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/**
 * Fractal swing points.
 *
 * A swing high at index i needs `left` lower highs before it and `right` lower
 * highs after it. It is therefore only *confirmed* once candle i+right has
 * closed, which is the timestamp recorded in `confirmedAt`. Detectors must use
 * `confirmedAt`, not the swing's own time, when asking "did I know this yet?".
 */
function swingPoints(candles, left = 2, right = 2, timeframe = null) {
  const highs = [];
  const lows = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    const provingIndex = i + right;
    const explicitDuration = timeframe ? TIMEFRAME_MS[timeframe] : null;
    const inferredDuration = provingIndex + 1 < candles.length
      ? candles[provingIndex + 1].time - candles[provingIndex].time
      : provingIndex > 0
        ? candles[provingIndex].time - candles[provingIndex - 1].time
        : 0;
    const duration = explicitDuration || inferredDuration;
    // Candle timestamps are OPEN times. The swing becomes knowable only when
    // the proving candle closes, not when that candle opens.
    const confirmedAt = candles[provingIndex].time + duration;
    if (isHigh) highs.push({ index: i, price: c.high, time: c.time, confirmedAt, kind: "high" });
    if (isLow) lows.push({ index: i, price: c.low, time: c.time, confirmedAt, kind: "low" });
  }
  return { highs, lows };
}

/** Swings whose confirming candle had closed at or before `asOf`. */
function confirmedBy(swings, asOf) {
  return swings.filter((s) => s.confirmedAt <= asOf);
}

/**
 * Directional structure read from confirmed swings.
 * Returns "bullish", "bearish" or "mixed"; `legs` counts the agreeing sequences.
 */
function structureOf(swings, minLegs = 2) {
  const highs = swings.highs;
  const lows = swings.lows;
  if (highs.length < minLegs || lows.length < minLegs) return { direction: "mixed", legs: 0 };

  let upLegs = 0;
  let downLegs = 0;
  for (let i = 1; i < Math.min(highs.length, lows.length); i++) {
    const higherHigh = highs[i].price > highs[i - 1].price;
    const higherLow = lows[i].price > lows[i - 1].price;
    const lowerHigh = highs[i].price < highs[i - 1].price;
    const lowerLow = lows[i].price < lows[i - 1].price;
    if (higherHigh && higherLow) upLegs += 1;
    if (lowerHigh && lowerLow) downLegs += 1;
  }
  if (upLegs >= minLegs && upLegs > downLegs) return { direction: "bullish", legs: upLegs };
  if (downLegs >= minLegs && downLegs > upLegs) return { direction: "bearish", legs: downLegs };
  return { direction: "mixed", legs: Math.max(upLegs, downLegs) };
}

/**
 * Horizontal levels worth trading against: confirmed swing prices, most recent
 * first. Each carries the swing that produced it for audit output.
 */
function levelsFrom(swings, asOf) {
  const all = [
    ...confirmedBy(swings.highs, asOf).map((s) => ({ ...s, side: "resistance" })),
    ...confirmedBy(swings.lows, asOf).map((s) => ({ ...s, side: "support" })),
  ];
  return all.sort((a, b) => b.confirmedAt - a.confirmedAt);
}

/**
 * Nearest structure that would block a move in `direction` from `price`.
 * Used by the 3R-room gate: publishing a 3:1 target through a wall of opposing
 * liquidity would measure an outcome the setup never really offered.
 */
function nearestOpposing(levels, price, direction) {
  const ahead = levels.filter((level) => (direction === "buy" ? level.price > price : level.price < price));
  if (!ahead.length) return null;
  return ahead.reduce((closest, level) => {
    const d = Math.abs(level.price - price);
    return d < Math.abs(closest.price - price) ? level : closest;
  });
}

// ---------------------------------------------------------------------------
// Candle shape
// ---------------------------------------------------------------------------

function body(candle) {
  return Math.abs(candle.close - candle.open);
}

function range(candle) {
  return Math.max(candle.high - candle.low, Number.EPSILON);
}

function isBull(candle) {
  return candle.close > candle.open;
}

function isBear(candle) {
  return candle.close < candle.open;
}

/** Where a candle closed within its own range, 0 at the low and 1 at the high. */
function closePosition(candle) {
  return (candle.close - candle.low) / range(candle);
}

/** True when `candle` engulfs the previous candle's body in `direction`. */
function isEngulfing(candle, previous, direction) {
  if (!previous) return false;
  if (direction === "buy") {
    return isBull(candle) && isBear(previous)
      && candle.close >= previous.open && candle.open <= previous.close;
  }
  return isBear(candle) && isBull(previous)
    && candle.close <= previous.open && candle.open >= previous.close;
}

/**
 * A rejection candle: a long wick against `direction` with the close pushed
 * back the other way.
 */
function isRejection(candle, direction, minFraction = 0.5) {
  const r = range(candle);
  if (r <= 0) return false;
  if (direction === "buy") {
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    return lowerWick / r >= minFraction * 0.5 && closePosition(candle) >= minFraction;
  }
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  return upperWick / r >= minFraction * 0.5 && (1 - closePosition(candle)) >= minFraction;
}

// ---------------------------------------------------------------------------
// Pips and rounding
// ---------------------------------------------------------------------------

function pipsToPrice(pips, symbol) {
  return pips * symbol.pip;
}

function priceToPips(price, symbol) {
  return price / symbol.pip;
}

/**
 * Round to the instrument's displayed precision. The rounded value is what is
 * both shown to the reader and tracked for outcomes; they must never diverge.
 */
function roundPrice(price, symbol) {
  const factor = 10 ** symbol.precision;
  return Math.round(price * factor) / factor;
}

module.exports = {
  TIMEFRAME_MS,
  body,
  closePosition,
  closeTime,
  confirmedBy,
  isBear,
  isBull,
  isEngulfing,
  isRejection,
  isValidCandle,
  lastClosed,
  levelsFrom,
  nearestOpposing,
  pipsToPrice,
  priceToPips,
  range,
  roundPrice,
  structureOf,
  swingPoints,
  usableCandles,
};
