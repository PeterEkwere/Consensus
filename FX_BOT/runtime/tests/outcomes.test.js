"use strict";

/**
 * The outcome state machine. Every candle and timestamp is supplied by the
 * test, so nothing here depends on the clock or the network.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { STRATEGY, SYMBOLS } = require("../config");
const {
  applyCandles,
  bucketOf,
  createRecord,
  estimateCosts,
  sanitizeRecord,
} = require("../outcomes");

const EUR = SYMBOLS.EUR_USD;
const MINUTE = 60 * 1000;
const ALERT = Date.UTC(2026, 0, 7, 12, 0, 0);
const EXPIRY = 24 * 3600 * 1000;

function planFor(side = "buy") {
  return side === "buy"
    ? { side, entry: 1.1000, stop: 1.0980, firstTarget: 1.1020, finalTarget: 1.1060, r: 0.002, stopPips: 20 }
    : { side, entry: 1.1000, stop: 1.1020, firstTarget: 1.0980, finalTarget: 1.0940, r: 0.002, stopPips: 20 };
}

function record(side = "buy", overrides = {}) {
  const plan = planFor(side);
  const base = createRecord({
    candidate: {
      symbol: "EUR_USD",
      playbookId: "P1",
      playbookName: "Liquidity Sweep Reversal",
      signalTime: ALERT - 5 * MINUTE,
      triggerCandleTime: ALERT - 5 * MINUTE,
      setupStartedAt: ALERT - 10 * MINUTE,
      confirmations: [{ family: "liquidity", text: "swept a level" }],
      sourceLevel: { price: 1.0990 },
      invalidation: 1.0985,
    },
    plan,
    id: "FXS-EURUSD-20260107-001",
    dedupeKey: "fixtures:EUR_USD:P1:buy:1:hash",
    sentAt: ALERT,
    costs: estimateCosts({ observedSpread: 0.00008, r: plan.r, strategy: STRATEGY, symbol: EUR }),
    configHash: "hash",
    provider: "fixtures",
  });
  return { ...base, ...overrides };
}

/** A candle `minute` minutes after the alert, trading between low and high. */
function candle(minute, low, high) {
  return { time: ALERT + minute * MINUTE, low, high, open: low, close: high, complete: true };
}

function run(rec, candles, now = ALERT + 60 * MINUTE) {
  return applyCandles(rec, candles, { now, expiryMs: EXPIRY });
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test("a candle that opened before the alert is never eligible", () => {
  // It spans entry, both targets and the stop, yet must be ignored entirely.
  const stale = { time: ALERT - MINUTE, low: 1.0900, high: 1.1100, open: 1.09, close: 1.11 };
  const result = run(record(), [stale]);
  assert.equal(result.record.status, "pending_entry");
  assert.equal(result.record.candlesSeen, 0);
  assert.equal(result.events.length, 0);
});

test("a candle opening exactly at the alert time is eligible", () => {
  const result = run(record(), [candle(0, 1.0999, 1.1001)]);
  assert.equal(result.record.status, "entered");
});

// ---------------------------------------------------------------------------
// Entry activation
// ---------------------------------------------------------------------------

test("entry activates when a candle trades through the exact entry price", () => {
  const result = run(record(), [candle(1, 1.0995, 1.1002)]);
  assert.equal(result.record.status, "entered");
  assert.equal(result.record.entryTime, new Date(ALERT + MINUTE).toISOString());
  assert.equal(result.record.firstLeg, "pending");
});

test("a setup whose entry is never touched stays pending", () => {
  const result = run(record(), [candle(1, 1.1005, 1.1010), candle(2, 1.1006, 1.1012)]);
  assert.equal(result.record.status, "pending_entry");
  assert.equal(bucketOf(result.record), "pending_entry");
  assert.equal(result.events.length, 0);
});

test("reaching the stop without touching the entry cancels before entry", () => {
  const result = run(record(), [candle(1, 1.0990, 1.0995), candle(2, 1.0975, 1.0988)]);
  assert.equal(result.record.status, "cancelled_before_entry");
  assert.equal(result.record.firstLeg, "void");
  assert.equal(result.record.finalLeg, "void");
  assert.equal(result.events.length, 0, "cancellations are not announced");
  assert.equal(bucketOf(result.record), "cancelled_before_entry");
});

test("entry and stop in one candle enters, then records stop-first losses", () => {
  const result = run(record(), [candle(1, 1.0975, 1.1005)]);
  assert.equal(result.record.status, "complete");
  assert.equal(result.record.entryTime, new Date(ALERT + MINUTE).toISOString());
  assert.equal(result.record.firstLeg, "loss");
  assert.equal(result.record.finalLeg, "loss");
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test("buy: first target then final target", () => {
  const first = run(record(), [candle(1, 1.0999, 1.1001), candle(2, 1.1010, 1.1025)]);
  assert.equal(first.record.firstLeg, "win");
  assert.equal(first.record.finalLeg, "pending");
  assert.deepEqual(first.events.map((e) => e.type), ["first_target"]);

  const second = run(first.record, [candle(3, 1.1040, 1.1065)]);
  assert.equal(second.record.finalLeg, "win");
  assert.equal(second.record.firstLeg, "win");
  assert.equal(second.record.status, "complete");
  assert.deepEqual(second.events.map((e) => e.type), ["final"]);
});

test("sell: first target then final target", () => {
  const first = run(record("sell"), [candle(1, 1.0999, 1.1001), candle(2, 1.0975, 1.0990)]);
  assert.equal(first.record.firstLeg, "win");
  const second = run(first.record, [candle(3, 1.0935, 1.0960)]);
  assert.equal(second.record.finalLeg, "win");
  assert.equal(second.record.status, "complete");
});

test("a stop before the first target loses both legs", () => {
  const result = run(record(), [candle(1, 1.0999, 1.1001), candle(2, 1.0975, 1.0995)]);
  assert.equal(result.record.firstLeg, "loss");
  assert.equal(result.record.finalLeg, "loss");
  assert.deepEqual(result.events.map((e) => e.type), ["final"]);
});

test("first target then a later stop keeps the win and loses the final leg", () => {
  const first = run(record(), [candle(1, 1.0999, 1.1021)]);
  assert.equal(first.record.firstLeg, "win");
  const second = run(first.record, [candle(5, 1.0975, 1.1010)]);
  assert.equal(second.record.firstLeg, "win", "a reached target is never taken back");
  assert.equal(second.record.finalLeg, "loss");
  assert.equal(second.record.status, "complete");
});

test("stop and target in one unresolved candle records the stop", () => {
  const result = run(record(), [candle(1, 1.0975, 1.1065)]);
  assert.equal(result.record.firstLeg, "loss");
  assert.equal(result.record.finalLeg, "loss");
});

test("after a first-target win, an ambiguous candle still records the stop", () => {
  const first = run(record(), [candle(1, 1.0999, 1.1021)]);
  const second = run(first.record, [candle(2, 1.0975, 1.1065)]);
  assert.equal(second.record.firstLeg, "win");
  assert.equal(second.record.finalLeg, "loss");
});

test("reaching the final target in one candle sends only the final event", () => {
  const result = run(record(), [candle(1, 1.0999, 1.1065)]);
  assert.equal(result.record.firstLeg, "win");
  assert.equal(result.record.finalLeg, "win");
  assert.deepEqual(result.events.map((e) => e.type), ["final"], "one message, not two");
});

test("MFE, MAE and timings start at entry and follow eligible candles", () => {
  const beforeAlert = { time: ALERT - MINUTE, low: 1.09, high: 1.11, open: 1.1, close: 1.1 };
  const pending = run(record(), [beforeAlert, candle(1, 1.1005, 1.1010)]).record;
  const reloadedPending = sanitizeRecord(JSON.parse(JSON.stringify(pending)));
  assert.equal(reloadedPending.mfeR, null);
  assert.equal(reloadedPending.maeR, null);
  assert.equal(reloadedPending.msToEntry, null);
  const entered = run(record(), [
    beforeAlert,
    candle(1, 1.1005, 1.1010),
    candle(2, 1.0995, 1.1008),
  ], ALERT + 2 * MINUTE);
  assert.equal(entered.record.status, "entered");
  assert.equal(entered.record.msToEntry, 2 * MINUTE);
  assert.equal(entered.record.mfeR, null, "entry-candle ordering is unknowable from OHLC");
  assert.equal(entered.record.maeR, null);

  const first = run(entered.record, [candle(3, 1.0990, 1.1025)], ALERT + 3 * MINUTE);
  assert.equal(first.record.firstLeg, "win");
  assert.equal(first.record.msToFirstTarget, MINUTE);
  assert.ok(Math.abs(first.record.mfeR - 1.25) < 1e-9);
  assert.ok(Math.abs(first.record.maeR - 0.5) < 1e-9);

  const final = run(first.record, [candle(4, 1.0998, 1.1065)], ALERT + 4 * MINUTE);
  assert.equal(final.record.finalLeg, "win");
  assert.equal(final.record.msToFinalResolution, 2 * MINUTE);
  assert.ok(Math.abs(final.record.mfeR - 3.25) < 1e-9);
});

// ---------------------------------------------------------------------------
// Expiry and gaps
// ---------------------------------------------------------------------------

test("an unentered setup expires without being scored", () => {
  const result = run(record(), [], ALERT + EXPIRY + MINUTE);
  assert.equal(result.record.status, "expired");
  assert.equal(result.record.firstLeg, "void");
  assert.equal(result.record.finalLeg, "void");
  assert.equal(result.events.length, 0);
});

test("expiry after a first-target win keeps that win and voids the rest", () => {
  const first = run(record(), [candle(1, 1.0999, 1.1021)]);
  const later = run(first.record, [], ALERT + EXPIRY + MINUTE);
  assert.equal(later.record.status, "expired");
  assert.equal(later.record.firstLeg, "win", "a resolved leg keeps its result");
  assert.equal(later.record.finalLeg, "void");
  assert.deepEqual(later.events.map((e) => e.type), ["final"],
    "an entered setup reports that monitoring completed");
});

test("an entered setup expiring before either target sends one final event", () => {
  const entered = run(record(), [candle(1, 1.0999, 1.1001)]);
  const expired = run(entered.record, [], ALERT + EXPIRY + MINUTE);
  assert.equal(expired.record.status, "expired");
  assert.deepEqual(expired.events.map((e) => e.type), ["final"]);
  assert.equal(expired.record.notified.final, true);
});

test("no candles at all changes nothing before expiry", () => {
  const result = run(record(), [], ALERT + MINUTE);
  assert.equal(result.record.status, "pending_entry");
  assert.equal(result.record.dataGaps, 0);
  assert.equal(result.events.length, 0);
});

// ---------------------------------------------------------------------------
// Notification dedupe
// ---------------------------------------------------------------------------

test("an already-announced event is never replayed", () => {
  const first = run(record(), [candle(1, 1.0999, 1.1021)]);
  assert.deepEqual(first.events.map((e) => e.type), ["first_target"]);
  assert.equal(first.record.notified.firstTarget, true);

  // Re-applying the same candle must not re-announce.
  const again = applyCandles(
    { ...first.record, lastCandleTime: null },
    [candle(1, 1.0999, 1.1021)],
    { now: ALERT + 10 * MINUTE, expiryMs: EXPIRY },
  );
  assert.equal(again.events.length, 0, "the persisted flag suppresses the repeat");
});

test("a restart from persisted state replays no notification", () => {
  const first = run(record(), [candle(1, 1.0999, 1.1021)]);
  // Simulate a restart: round-trip through JSON and re-sanitize.
  const reloaded = sanitizeRecord(JSON.parse(JSON.stringify(first.record)));
  assert.ok(reloaded);
  assert.equal(reloaded.notified.firstTarget, true);
  const resumed = run(reloaded, [candle(2, 1.1015, 1.1018)]);
  assert.equal(resumed.events.length, 0);
  // ...and it still resolves normally afterwards.
  const finished = run(resumed.record, [candle(3, 1.1050, 1.1065)]);
  assert.deepEqual(finished.events.map((e) => e.type), ["final"]);
});

test("a completed record is inert", () => {
  const done = run(record(), [candle(1, 1.0999, 1.1065)]);
  const again = run(done.record, [candle(9, 1.0900, 1.1200)]);
  assert.equal(again.events.length, 0);
  assert.equal(again.record.firstLeg, "win");
  assert.equal(again.record.finalLeg, "win");
});

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

test("cost is the spread plus two-sided slippage and commission, expressed in R", () => {
  const costs = estimateCosts({ observedSpread: 0.00008, r: 0.002, strategy: STRATEGY, symbol: EUR });
  // 0.00008 spread + 2 * 0.2 pips slippage = 0.00008 + 0.00004 = 0.00012
  assert.ok(Math.abs(costs.estimatedCostPrice - 0.00012) < 1e-9);
  assert.ok(Math.abs(costs.costR - 0.06) < 1e-9);
  assert.equal(costs.known, true);
});

test("an unobserved spread leaves cost unknown, never zero", () => {
  const costs = estimateCosts({ observedSpread: null, r: 0.002, strategy: STRATEGY, symbol: EUR });
  assert.equal(costs.observedSpread, null);
  assert.equal(costs.estimatedCostPrice, null);
  assert.equal(costs.costR, null);
  assert.equal(costs.known, false);
});

// ---------------------------------------------------------------------------
// Persisted rows
// ---------------------------------------------------------------------------

test("malformed persisted rows are dropped rather than repaired", () => {
  assert.equal(sanitizeRecord(null), null);
  assert.equal(sanitizeRecord("nope"), null);
  assert.equal(sanitizeRecord([]), null);
  assert.equal(sanitizeRecord({}), null);
  assert.equal(sanitizeRecord({ id: "x", symbol: "EUR_USD", side: "sideways" }), null);
  assert.equal(sanitizeRecord({
    id: "x", symbol: "EUR_USD", side: "buy",
    entry: "abc", stop: 1, firstTarget: 2, finalTarget: 3, r: 1,
  }), null);
  // Directionally impossible: a buy whose stop sits above the entry.
  assert.equal(sanitizeRecord({
    id: "x", symbol: "EUR_USD", side: "buy",
    entry: 1.1, stop: 1.2, firstTarget: 1.12, finalTarget: 1.16, r: 0.02,
  }), null);
});

test("unknown status strings fall back to safe values", () => {
  const clean = sanitizeRecord({
    id: "x", symbol: "EUR_USD", side: "buy",
    entry: 1.1, stop: 1.098, firstTarget: 1.102, finalTarget: 1.106, r: 0.002,
    status: "weird", firstLeg: "weird", finalLeg: "weird",
    sentAt: new Date(ALERT).toISOString(),
  });
  assert.equal(clean.status, "pending_entry");
  assert.equal(clean.firstLeg, "pending");
  assert.equal(clean.finalLeg, "pending");
  assert.equal(clean.notified.firstTarget, false);
  assert.equal(clean.watchFromMs, ALERT);
});
