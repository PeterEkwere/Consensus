/**
 * Consensus FX Sentinel - the six candidate playbooks.
 *
 * Each generator is a pure function of already-validated closed candles. It
 * returns `null` or ONE candidate. A generator never sends a message, never
 * touches the filesystem and never decides publishability - that is engine.js.
 *
 * None of these six is a proven strategy. They are hypotheses this runtime
 * exists to measure. Their parameters live in config.js and must not be tuned
 * in response to test or backtest output.
 *
 * Confirmation discipline: every confirmation carries a `family`. The engine
 * counts at most one confirmation per family when ranking and when choosing the
 * reader-facing top three, so one candle described three different ways cannot
 * masquerade as three independent pieces of evidence.
 */

"use strict";

const {
  closePosition,
  confirmedBy,
  isBear,
  isBull,
  isEngulfing,
  isRejection,
  levelsFrom,
  pipsToPrice,
  structureOf,
  swingPoints,
} = require("./market");

const PLAYBOOKS = Object.freeze({
  P1: "Liquidity Sweep Reversal",
  P2: "Higher Timeframe Breakout and Retest",
  P3: "Trend Pullback",
  P4: "Internal Break of Structure Retest",
  P5: "Range Boundary Rejection",
  P6: "Failed Breakout Trap",
});

const FAMILIES = Object.freeze(["structure", "location", "liquidity", "candle", "session", "momentum"]);

function confirmation(family, text, weight) {
  return { family, text, weight };
}

/**
 * Shared context built once per symbol per scan and handed to every generator,
 * so the six detectors cannot disagree about what the market looked like.
 */
function buildContext({ symbol, candles, asOf, strategy, spread = null }) {
  const m5 = candles.M5 || [];
  const m15 = candles.M15 || [];
  const h1 = candles.H1 || [];
  const { swingLeft, swingRight } = strategy;

  const m5Swings = swingPoints(m5, swingLeft, swingRight, "M5");
  const m15Swings = swingPoints(m15, swingLeft, swingRight, "M15");
  const h1Swings = swingPoints(h1, swingLeft, swingRight, "H1");

  return {
    symbol,
    asOf,
    strategy,
    observedSpread: spread,
    m5,
    m15,
    h1,
    m5Swings,
    m15Swings,
    h1Swings,
    // Only swings whose confirming candle has closed may inform a decision.
    m5Levels: levelsFrom(m5Swings, asOf),
    m15Levels: levelsFrom(m15Swings, asOf),
    h1Levels: levelsFrom(h1Swings, asOf),
    h1Structure: structureOf(
      { highs: confirmedBy(h1Swings.highs, asOf), lows: confirmedBy(h1Swings.lows, asOf) },
      strategy.p3.minStructureLegs,
    ),
    m15Structure: structureOf(
      { highs: confirmedBy(m15Swings.highs, asOf), lows: confirmedBy(m15Swings.lows, asOf) },
      2,
    ),
    trigger: m5.length ? m5[m5.length - 1] : null,
  };
}

/** Every candidate shares this envelope so the engine can treat them uniformly. */
function makeCandidate(ctx, fields) {
  const { symbol, trigger } = ctx;
  return {
    playbookId: fields.playbookId,
    playbookName: PLAYBOOKS[fields.playbookId],
    symbol: symbol.id,
    side: fields.side,
    signalTime: trigger.time,
    triggerCandleTime: trigger.time,
    setupStartedAt: fields.setupStartedAt,
    entry: fields.entry,
    stop: fields.stop,
    sourceLevel: fields.sourceLevel,
    invalidation: fields.invalidation,
    confirmations: fields.confirmations,
    nearestOpposingStructure: null, // filled by the engine from shared levels
    observedSpread: null,           // filled by the engine from provider data
    configHash: null,               // filled by the engine
  };
}

/** Stop placed beyond a structural extreme, padded for spread and noise. */
function stopBeyond(extreme, side, ctx) {
  const { strategy, symbol } = ctx;
  const spreadPrice = Number.isFinite(ctx.observedSpread) ? ctx.observedSpread : 0;
  const buffer = pipsToPrice(strategy.stopBufferPips, symbol)
    + spreadPrice * strategy.stopSpreadMultiple;
  return side === "buy" ? extreme - buffer : extreme + buffer;
}

// ---------------------------------------------------------------------------
// P1 - Liquidity sweep reversal
// ---------------------------------------------------------------------------

/**
 * A confirmed level is swept by a closed M5 candle that trades through it and
 * closes back on the original side; a later closed M5 candle then confirms the
 * reversal.
 */
function p1LiquiditySweepReversal(ctx) {
  const { m5, strategy, symbol, asOf } = ctx;
  const cfg = strategy.p1;
  if (m5.length < 3) return null;

  const trigger = m5[m5.length - 1];
  const minSweep = pipsToPrice(cfg.minSweepPips, symbol);
  // Levels from the higher timeframes only: sweeping an M5 swing is noise.
  const levels = [...ctx.m15Levels, ...ctx.h1Levels];

  // The rejection candle must be recent enough to still matter.
  for (let back = 1; back <= cfg.maxConfirmBars; back++) {
    const sweepIndex = m5.length - 1 - back;
    if (sweepIndex < 0) break;
    const sweep = m5[sweepIndex];

    for (const level of levels) {
      // The level must have been confirmed before the sweep candle closed.
      if (level.confirmedAt > sweep.time) continue;

      // Sell setup: sweep above a resistance level, close back below it.
      if (level.side === "resistance"
        && sweep.high >= level.price + minSweep
        && sweep.close < level.price) {
        const confirmed = isBear(trigger)
          && trigger.close < sweep.close
          && (1 - closePosition(trigger)) >= cfg.minConfirmFraction;
        if (!confirmed) continue;
        return makeCandidate(ctx, {
          playbookId: "P1",
          side: "sell",
          entry: trigger.close,
          stop: stopBeyond(sweep.high, "sell", ctx),
          sourceLevel: { price: level.price, side: level.side, time: level.time, timeframe: "M15/H1" },
          setupStartedAt: sweep.time,
          invalidation: sweep.high,
          confirmations: [
            confirmation("liquidity", "Price ran past a level that had held before, then failed to hold above it", 24),
            confirmation("candle", "The next completed 5-minute candle closed back down", 16),
            confirmation("location", "The reversal happened at a level confirmed on a higher timeframe", 14),
          ],
        });
      }

      // Buy setup: sweep below a support level, close back above it.
      if (level.side === "support"
        && sweep.low <= level.price - minSweep
        && sweep.close > level.price) {
        const confirmed = isBull(trigger)
          && trigger.close > sweep.close
          && closePosition(trigger) >= cfg.minConfirmFraction;
        if (!confirmed) continue;
        return makeCandidate(ctx, {
          playbookId: "P1",
          side: "buy",
          entry: trigger.close,
          stop: stopBeyond(sweep.low, "buy", ctx),
          sourceLevel: { price: level.price, side: level.side, time: level.time, timeframe: "M15/H1" },
          setupStartedAt: sweep.time,
          invalidation: sweep.low,
          confirmations: [
            confirmation("liquidity", "Price dipped below a level that had held before, then failed to stay below it", 24),
            confirmation("candle", "The next completed 5-minute candle closed back up", 16),
            confirmation("location", "The reversal happened at a level confirmed on a higher timeframe", 14),
          ],
        });
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// P2 - Higher timeframe breakout and retest
// ---------------------------------------------------------------------------

/**
 * A closed M15 body clears a confirmed level, then price returns to that level
 * and a closed M5 candle rejects it in the breakout direction.
 *
 * Returns extra bookkeeping (`breakoutCandleTime`, `failed`) so the engine can
 * enforce P2/P6 exclusivity.
 */
function p2BreakoutRetest(ctx) {
  const { m5, m15, strategy, symbol } = ctx;
  const cfg = strategy.p2;
  if (m5.length < 2 || m15.length < 2) return null;

  const trigger = m5[m5.length - 1];
  const buffer = pipsToPrice(cfg.breakoutBufferPips, symbol);
  const proximity = pipsToPrice(cfg.retestProximityPips, symbol);
  const levels = [...ctx.m15Levels, ...ctx.h1Levels];

  // Most recent M15 breakout first.
  for (let i = m15.length - 1; i >= Math.max(0, m15.length - 8); i--) {
    const breakout = m15[i];
    for (const level of levels) {
      if (level.confirmedAt > breakout.time) continue;

      const brokeUp = breakout.close > level.price + buffer;
      const brokeDown = breakout.close < level.price - buffer;
      if (!brokeUp && !brokeDown) continue;

      const side = brokeUp ? "buy" : "sell";
      // Only M5 candles that closed after the breakout candle closed count.
      const breakoutClose = breakout.time + 15 * 60 * 1000;
      const after = m5.filter((c) => c.time >= breakoutClose);
      if (!after.length || after.length > cfg.maxRetestBars) continue;
      if (after[after.length - 1].time !== trigger.time) continue;

      // A decisive close back through the level kills the breakout. That is
      // P6's territory, not a retest.
      const invalidated = after.slice(0, -1).some((c) => (brokeUp
        ? c.close < level.price - buffer
        : c.close > level.price + buffer));
      if (invalidated) continue;

      const retested = after.some((c) => Math.abs(
        (brokeUp ? c.low : c.high) - level.price,
      ) <= proximity);
      if (!retested) continue;

      const rejected = brokeUp
        ? isBull(trigger) && trigger.close > level.price && trigger.low <= level.price + proximity
        : isBear(trigger) && trigger.close < level.price && trigger.high >= level.price - proximity;
      if (!rejected) continue;

      const extreme = brokeUp
        ? Math.min(...after.map((c) => c.low))
        : Math.max(...after.map((c) => c.high));

      const candidate = makeCandidate(ctx, {
        playbookId: "P2",
        side,
        entry: trigger.close,
        stop: stopBeyond(extreme, side, ctx),
        sourceLevel: { price: level.price, side: level.side, time: level.time, timeframe: "M15/H1" },
        setupStartedAt: breakout.time,
        invalidation: extreme,
        confirmations: [
          confirmation("structure", "A 15-minute candle closed beyond a level that had held before", 24),
          confirmation("location", "Price came back to that level and held it", 18),
          confirmation("candle", "A completed 5-minute candle turned away from the level", 14),
        ],
      });
      candidate.breakoutCandleTime = breakout.time;
      candidate.breakoutLevel = level.price;
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// P3 - Trend pullback
// ---------------------------------------------------------------------------

/**
 * H1 shows a directional structure, M15 agrees, price has pulled back into the
 * last unbroken zone, and a closed M5 candle confirms in the H1 direction.
 */
function p3TrendPullback(ctx) {
  const { m5, strategy, h1Structure, m15Structure, asOf } = ctx;
  const cfg = strategy.p3;
  if (m5.length < 2) return null;
  if (h1Structure.direction === "mixed") return null;
  // A disagreement between the two structural timeframes is a no-trade.
  if (m15Structure.direction !== h1Structure.direction) return null;

  const side = h1Structure.direction === "bullish" ? "buy" : "sell";
  const trigger = m5[m5.length - 1];
  const previous = m5[m5.length - 2];

  const h1Highs = confirmedBy(ctx.h1Swings.highs, asOf);
  const h1Lows = confirmedBy(ctx.h1Swings.lows, asOf);
  if (h1Highs.length < cfg.minStructureLegs || h1Lows.length < cfg.minStructureLegs) return null;

  // The impulse is the most recent confirmed swing leg; the pullback is
  // measured as a fraction of it.
  const lastHigh = h1Highs[h1Highs.length - 1];
  const lastLow = h1Lows[h1Lows.length - 1];
  const impulse = Math.abs(lastHigh.price - lastLow.price);
  if (!(impulse > 0)) return null;

  const retrace = side === "buy"
    ? (lastHigh.price - trigger.low) / impulse
    : (trigger.high - lastLow.price) / impulse;
  if (!(retrace >= cfg.minPullbackFraction && retrace <= cfg.maxPullbackFraction)) return null;

  const confirmed = isEngulfing(trigger, previous, side)
    || isRejection(trigger, side, strategy.p1.minConfirmFraction);
  if (!confirmed) return null;

  const extreme = side === "buy"
    ? Math.min(trigger.low, previous.low)
    : Math.max(trigger.high, previous.high);

  return makeCandidate(ctx, {
    playbookId: "P3",
    side,
    entry: trigger.close,
    stop: stopBeyond(extreme, side, ctx),
    sourceLevel: {
      price: side === "buy" ? lastLow.price : lastHigh.price,
      side: side === "buy" ? "support" : "resistance",
      time: side === "buy" ? lastLow.time : lastHigh.time,
      timeframe: "H1",
    },
    setupStartedAt: side === "buy" ? lastLow.time : lastHigh.time,
    invalidation: extreme,
    confirmations: [
      confirmation("structure", "The 1-hour and 15-minute charts are moving the same way", 24),
      confirmation("location", "Price paused and came back into the last area that held", 18),
      confirmation("candle", "A completed 5-minute candle turned back with the larger move", 14),
    ],
  });
}

// ---------------------------------------------------------------------------
// P4 - Internal break of structure retest
// ---------------------------------------------------------------------------

/**
 * An M5-internal transition inside an already-valid M15/H1 location. Distinct
 * from P2: the broken level here is an M5 swing, not a higher-timeframe level.
 */
function p4InternalBosRetest(ctx) {
  const { m5, strategy, symbol, asOf, h1Structure, m15Structure } = ctx;
  const cfg = strategy.p4;
  if (m5.length < 4) return null;

  // The internal break only counts inside an established higher-timeframe bias.
  if (h1Structure.direction === "mixed" || m15Structure.direction === "mixed") return null;
  if (h1Structure.direction !== m15Structure.direction) return null;
  const bias = h1Structure.direction;
  const side = bias === "bullish" ? "buy" : "sell";

  const trigger = m5[m5.length - 1];
  const minBreak = pipsToPrice(cfg.minBreakPips, symbol);
  const proximity = pipsToPrice(cfg.retestProximityPips, symbol);

  // The opposing M5 swing that a continuation must break.
  const opposing = side === "buy"
    ? confirmedBy(ctx.m5Swings.highs, asOf)
    : confirmedBy(ctx.m5Swings.lows, asOf);
  if (!opposing.length) return null;

  for (let s = opposing.length - 1; s >= Math.max(0, opposing.length - 3); s--) {
    const swing = opposing[s];

    // A closed body beyond the swing, at some candle after it was confirmed.
    const afterSwing = m5.filter((c) => c.time >= swing.confirmedAt);
    const breakIndex = afterSwing.findIndex((c) => (side === "buy"
      ? c.close > swing.price + minBreak
      : c.close < swing.price - minBreak));
    if (breakIndex === -1) continue;

    const breakCandle = afterSwing[breakIndex];
    const since = afterSwing.slice(breakIndex + 1);
    if (!since.length || since.length > cfg.maxRetestBars) continue;
    if (since[since.length - 1].time !== trigger.time) continue;

    // Retest of the broken internal swing, then a close back in the direction.
    const retested = since.some((c) => Math.abs(
      (side === "buy" ? c.low : c.high) - swing.price,
    ) <= proximity);
    if (!retested) continue;

    const closedBack = side === "buy"
      ? isBull(trigger) && trigger.close > swing.price
      : isBear(trigger) && trigger.close < swing.price;
    if (!closedBack) continue;

    const extreme = side === "buy"
      ? Math.min(...since.map((c) => c.low))
      : Math.max(...since.map((c) => c.high));

    const candidate = makeCandidate(ctx, {
      playbookId: "P4",
      side,
      entry: trigger.close,
      stop: stopBeyond(extreme, side, ctx),
      sourceLevel: { price: swing.price, side: side === "buy" ? "resistance" : "support", time: swing.time, timeframe: "M5" },
      setupStartedAt: breakCandle.time,
      invalidation: extreme,
      confirmations: [
        confirmation("structure", "The short-term pattern flipped to match the bigger move", 22),
        confirmation("location", "Price returned to the level it just broke and held it", 16),
        confirmation("candle", "A completed 5-minute candle closed in the new direction", 12),
      ],
    });
    // Recorded so the engine can stop this same feature being reused as a
    // generic breakout confirmation elsewhere.
    candidate.internalSwing = { price: swing.price, time: swing.time };
    candidate.breakoutCandleTime = breakCandle.time;
    return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// P5 - Range boundary rejection
// ---------------------------------------------------------------------------

/** Classify the recent M15 window as a range, or return null. */
function detectRange(ctx) {
  const { m15, strategy, symbol, asOf } = ctx;
  const cfg = strategy.p5;
  const window = m15.slice(-cfg.windowBars);
  if (window.length < cfg.windowBars) return null;

  const highs = confirmedBy(ctx.m15Swings.highs, asOf).filter((s) => s.time >= window[0].time);
  const lows = confirmedBy(ctx.m15Swings.lows, asOf).filter((s) => s.time >= window[0].time);
  if (highs.length < cfg.minBoundaryTouches || lows.length < cfg.minBoundaryTouches) return null;

  const upper = Math.max(...highs.map((s) => s.price));
  const lower = Math.min(...lows.map((s) => s.price));
  const width = upper - lower;
  const minWidth = pipsToPrice(cfg.minWidthPips, symbol);
  const maxWidth = pipsToPrice(cfg.maxWidthPips, symbol);
  if (!(width >= minWidth && width <= maxWidth)) return null;

  // No accepted close outside either boundary during the window.
  const escaped = window.some((c) => c.close > upper || c.close < lower);
  if (escaped) return null;

  return { upper, lower, width, from: window[0].time };
}

function p5RangeBoundaryRejection(ctx) {
  const { m5, strategy } = ctx;
  const cfg = strategy.p5;
  if (m5.length < 3) return null;

  const box = detectRange(ctx);
  if (!box) return null;

  const trigger = m5[m5.length - 1];

  // The test candle is the one before the confirmation.
  for (let back = 1; back <= 2; back++) {
    const testIndex = m5.length - 1 - back;
    if (testIndex < 0) break;
    const test = m5[testIndex];

    // Rejected the upper boundary -> sell back into the range.
    if (test.high >= box.upper && test.close < box.upper) {
      if (!(isBear(trigger) && trigger.close < test.close)) continue;
      return makeCandidate(ctx, {
        playbookId: "P5",
        side: "sell",
        entry: trigger.close,
        stop: stopBeyond(test.high, "sell", ctx),
        sourceLevel: { price: box.upper, side: "resistance", time: box.from, timeframe: "M15" },
        setupStartedAt: test.time,
        invalidation: test.high,
        confirmations: [
          confirmation("location", "Price has been moving between two prices and reached the top of that area", 22),
          confirmation("liquidity", "It pushed above the top and could not stay there", 18),
          confirmation("candle", "A completed 5-minute candle turned back down into the area", 12),
        ],
      });
    }

    // Rejected the lower boundary -> buy back into the range.
    if (test.low <= box.lower && test.close > box.lower) {
      if (!(isBull(trigger) && trigger.close > test.close)) continue;
      return makeCandidate(ctx, {
        playbookId: "P5",
        side: "buy",
        entry: trigger.close,
        stop: stopBeyond(test.low, "buy", ctx),
        sourceLevel: { price: box.lower, side: "support", time: box.from, timeframe: "M15" },
        setupStartedAt: test.time,
        invalidation: test.low,
        confirmations: [
          confirmation("location", "Price has been moving between two prices and reached the bottom of that area", 22),
          confirmation("liquidity", "It pushed below the bottom and could not stay there", 18),
          confirmation("candle", "A completed 5-minute candle turned back up into the area", 12),
        ],
      });
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// P6 - Failed breakout trap
// ---------------------------------------------------------------------------

/**
 * Price closes beyond a confirmed M15 level, then within a short window closes
 * back through it. Entry is the failure confirmation, against the breakout.
 */
function p6FailedBreakout(ctx) {
  const { m5, strategy, symbol } = ctx;
  const cfg = strategy.p6;
  if (m5.length < 3) return null;

  const trigger = m5[m5.length - 1];
  const reentry = pipsToPrice(cfg.reentryBufferPips, symbol);
  const breakoutBuffer = pipsToPrice(strategy.p2.breakoutBufferPips, symbol);
  const levels = ctx.m15Levels;

  for (const level of levels) {
    // Look back over the short failure window for the breakout close.
    const window = m5.slice(-(cfg.maxFailureBars + 1), -1);
    if (!window.length) continue;

    const brokeUp = window.find((c) => c.close > level.price + breakoutBuffer
      && level.confirmedAt <= c.time);
    const brokeDown = window.find((c) => c.close < level.price - breakoutBuffer
      && level.confirmedAt <= c.time);

    // Failed upside breakout -> sell.
    if (brokeUp && trigger.close < level.price - reentry && isBear(trigger)) {
      const extreme = Math.max(...window.filter((c) => c.time >= brokeUp.time).map((c) => c.high), trigger.high);
      const candidate = makeCandidate(ctx, {
        playbookId: "P6",
        side: "sell",
        entry: trigger.close,
        stop: stopBeyond(extreme, "sell", ctx),
        sourceLevel: { price: level.price, side: level.side, time: level.time, timeframe: "M15" },
        setupStartedAt: brokeUp.time,
        invalidation: extreme,
        confirmations: [
          confirmation("liquidity", "Price broke above a level and then dropped back below it", 24),
          confirmation("structure", "The break did not hold, which often traps buyers", 16),
          confirmation("candle", "A completed 5-minute candle closed back inside", 12),
        ],
      });
      candidate.breakoutCandleTime = brokeUp.time;
      candidate.breakoutLevel = level.price;
      return candidate;
    }

    // Failed downside breakout -> buy.
    if (brokeDown && trigger.close > level.price + reentry && isBull(trigger)) {
      const extreme = Math.min(...window.filter((c) => c.time >= brokeDown.time).map((c) => c.low), trigger.low);
      const candidate = makeCandidate(ctx, {
        playbookId: "P6",
        side: "buy",
        entry: trigger.close,
        stop: stopBeyond(extreme, "buy", ctx),
        sourceLevel: { price: level.price, side: level.side, time: level.time, timeframe: "M15" },
        setupStartedAt: brokeDown.time,
        invalidation: extreme,
        confirmations: [
          confirmation("liquidity", "Price broke below a level and then climbed back above it", 24),
          confirmation("structure", "The break did not hold, which often traps sellers", 16),
          confirmation("candle", "A completed 5-minute candle closed back inside", 12),
        ],
      });
      candidate.breakoutCandleTime = brokeDown.time;
      candidate.breakoutLevel = level.price;
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

const GENERATORS = Object.freeze([
  { id: "P1", run: p1LiquiditySweepReversal },
  { id: "P2", run: p2BreakoutRetest },
  { id: "P3", run: p3TrendPullback },
  { id: "P4", run: p4InternalBosRetest },
  { id: "P5", run: p5RangeBoundaryRejection },
  { id: "P6", run: p6FailedBreakout },
]);

/** Run all six generators over one prepared context. */
function generateCandidates(ctx) {
  if (!ctx.trigger) return [];
  const out = [];
  for (const generator of GENERATORS) {
    let candidate = null;
    try {
      candidate = generator.run(ctx);
    } catch (err) {
      // A detector bug must not take down the scan for the other five.
      candidate = null;
      ctx.errors = ctx.errors || [];
      ctx.errors.push({ playbookId: generator.id, message: err.message });
    }
    if (candidate) out.push(candidate);
  }
  return out;
}

module.exports = {
  FAMILIES,
  GENERATORS,
  PLAYBOOKS,
  buildContext,
  detectRange,
  generateCandidates,
  p1LiquiditySweepReversal,
  p2BreakoutRetest,
  p3TrendPullback,
  p4InternalBosRetest,
  p5RangeBoundaryRejection,
  p6FailedBreakout,
};
