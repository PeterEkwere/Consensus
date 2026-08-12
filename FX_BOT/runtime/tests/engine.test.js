"use strict";

/** Hard gates, plan arithmetic, identity, dedupe and conflict resolution. */

const test = require("node:test");
const assert = require("node:assert/strict");

const { STRATEGY, SYMBOLS } = require("../config");
const {
  applyGates,
  buildTradePlan,
  collapseConfirmations,
  dedupeKey,
  enforceBreakoutExclusivity,
  groupKey,
  makeAlertId,
  resolveConflicts,
  scoreOf,
  sessionFor,
} = require("../engine");

const EUR = SYMBOLS.EUR_USD;
const JPY = SYMBOLS.USD_JPY;
// 12:00 UTC is inside the configured London and New York windows.
const NOON = Date.UTC(2026, 0, 7, 12, 0, 0);

function candidate(overrides = {}) {
  return {
    playbookId: "P1",
    symbol: "EUR_USD",
    side: "buy",
    signalTime: NOON - 5 * 60000,
    triggerCandleTime: NOON - 5 * 60000,
    entry: 1.1000,
    stop: 1.0980,
    configHash: "hash1",
    observedSpread: 0.00008,
    nearestOpposingStructure: null,
    confirmations: [
      { family: "liquidity", text: "a", weight: 24 },
      { family: "candle", text: "b", weight: 16 },
    ],
    ...overrides,
  };
}

function gateContext(overrides = {}) {
  return {
    symbol: EUR,
    strategy: STRATEGY,
    now: NOON,
    diagnostics: { incomplete: 0, outOfOrder: 0 },
    quote: 1.1000,
    newsStatus: "unknown",
    existingKeys: new Set(),
    provider: "fixtures",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Plan arithmetic
// ---------------------------------------------------------------------------

test("buy targets sit one and three units of risk above the entry", () => {
  const { ok, plan } = buildTradePlan(candidate(), EUR);
  assert.ok(ok);
  assert.equal(plan.entry, 1.1);
  assert.equal(plan.stop, 1.098);
  assert.ok(Math.abs(plan.r - 0.002) < 1e-9);
  assert.equal(plan.firstTarget, 1.102);
  assert.equal(plan.finalTarget, 1.106);
});

test("sell targets mirror the buy formulas", () => {
  const { ok, plan } = buildTradePlan(candidate({ side: "sell", entry: 1.1, stop: 1.102 }), EUR);
  assert.ok(ok);
  assert.equal(plan.firstTarget, 1.098);
  assert.equal(plan.finalTarget, 1.094);
});

test("levels are rounded to the instrument's precision, and display equals tracking", () => {
  const { ok, plan } = buildTradePlan(
    candidate({ symbol: "USD_JPY", entry: 150.123456, stop: 149.987654 }),
    JPY,
  );
  assert.ok(ok);
  // Three decimals for JPY; the same rounded value is what gets tracked.
  assert.equal(plan.entry, 150.123);
  assert.equal(plan.stop, 149.988);
  assert.equal(plan.firstTarget, Number((150.123 + 0.135).toFixed(3)));
  assert.equal(String(plan.firstTarget).split(".")[1].length <= 3, true);
});

test("invalid, zero and wrong-sided risk is rejected", () => {
  assert.equal(buildTradePlan(candidate({ entry: NaN }), EUR).reason, "non_finite_levels");
  assert.equal(buildTradePlan(candidate({ stop: Infinity }), EUR).reason, "non_finite_levels");
  assert.equal(buildTradePlan(candidate({ entry: 0 }), EUR).reason, "non_positive_levels");
  assert.equal(buildTradePlan(candidate({ stop: 1.1 }), EUR).reason, "stop_wrong_side");
  assert.equal(buildTradePlan(candidate({ side: "sell", stop: 1.098 }), EUR).reason, "stop_wrong_side");
  assert.equal(buildTradePlan(candidate({ side: "sideways" }), EUR).reason, "invalid_side");
});

test("a stop that rounds onto the entry is rejected instead of published", () => {
  // 0.1 of a pip apart: at five decimals this collapses to no risk at all.
  const result = buildTradePlan(candidate({ entry: 1.10000, stop: 1.099999 }), EUR);
  assert.equal(result.ok, false);
  assert.ok(["rounding_collapsed_risk", "stop_too_tight"].includes(result.reason));
});

test("stops outside the instrument's distance limits are refused", () => {
  assert.equal(buildTradePlan(candidate({ stop: 1.09995 }), EUR).reason, "stop_too_tight");
  assert.equal(buildTradePlan(candidate({ stop: 1.0500 }), EUR).reason, "stop_too_wide");
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

test("a clean candidate passes every gate", () => {
  const result = applyGates(candidate(), gateContext());
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.plan);
  assert.ok(result.session);
});

test("live scans require a recent top-of-book quote", () => {
  assert.equal(applyGates(candidate(), gateContext({
    requireFreshQuote: true,
    quoteTime: null,
  })).reason, "live_quote_unavailable");
  assert.equal(applyGates(candidate(), gateContext({
    requireFreshQuote: true,
    quoteTime: NOON - 16 * 60000,
  })).reason, "live_quote_stale");
  assert.equal(applyGates(candidate(), gateContext({
    requireFreshQuote: true,
    quoteTime: NOON - 2 * 60000,
  })).ok, true);
});

test("a wide spread is rejected", () => {
  // EUR/USD allows 2 pips; offer 3.
  const result = applyGates(candidate({ observedSpread: 0.0003 }), gateContext());
  assert.equal(result.reason, "spread_too_wide");
});

test("candidates outside the approved sessions are rejected", () => {
  const midnight = Date.UTC(2026, 0, 7, 2, 0, 0);
  assert.equal(applyGates(candidate(), gateContext({ now: midnight })).reason, "outside_session");
  assert.equal(sessionFor(midnight, STRATEGY.gates.sessionWindowsUtc), null);
  assert.equal(sessionFor(NOON, STRATEGY.gates.sessionWindowsUtc), "london");
  const invalidPlan = candidate({ stop: 1.1000 });
  const result = applyGates(invalidPlan, gateContext({ now: midnight }));
  assert.equal(result.reason, "outside_session", "session still precedes plan validation");
  assert.equal(result.plan, null, "an invalid plan is never made shadow-trackable");
});

test("an active news block stops publication", () => {
  assert.equal(applyGates(candidate(), gateContext({ newsStatus: "blocked" })).reason, "news_block");
  // Unknown is tolerated so research can continue, but is never called "clear".
  assert.equal(applyGates(candidate(), gateContext({ newsStatus: "unknown" })).ok, true);
  assert.equal(applyGates(candidate(), gateContext({ newsStatus: "garbage" })).reason, "news_status_invalid");
});

test("normal mode fails closed when news or spread protection is unavailable", () => {
  assert.equal(
    applyGates(candidate(), gateContext({ researchMode: false, newsStatus: "unknown" })).reason,
    "news_unavailable_for_normal_mode",
  );
  assert.equal(
    applyGates(candidate({ observedSpread: null }), gateContext({
      researchMode: false,
      newsStatus: "clear",
    })).reason,
    "costs_unknown_for_normal_mode",
  );
});

test("incomplete or unordered data blocks publication", () => {
  const bad = gateContext({ diagnostics: { incomplete: 1, outOfOrder: 0 } });
  assert.equal(applyGates(candidate(), bad).reason, "incomplete_or_unordered_data");
  const unordered = gateContext({ diagnostics: { incomplete: 0, outOfOrder: 2 } });
  assert.equal(applyGates(candidate(), unordered).reason, "incomplete_or_unordered_data");
});

test("a 3:1 target that would run into opposing structure is refused", () => {
  // R is 0.002, so 3R needs 0.006 of room. Offer only 0.003.
  const blocked = candidate({ nearestOpposingStructure: { price: 1.1030 } });
  assert.equal(applyGates(blocked, gateContext()).reason, "insufficient_structural_room");

  const clear = candidate({ nearestOpposingStructure: { price: 1.1100 } });
  assert.equal(applyGates(clear, gateContext()).ok, true);
});

test("a quote that has already run away from the entry is not chased", () => {
  // Allowed drift is a quarter of R = 0.0005.
  assert.equal(applyGates(candidate(), gateContext({ quote: 1.1004 })).ok, true);
  assert.equal(applyGates(candidate(), gateContext({ quote: 1.1010 })).reason, "price_moved_too_far");
});

test("an already-processed candidate is rejected as a duplicate", () => {
  const c = candidate();
  const key = dedupeKey(c, "fixtures");
  const ctx = gateContext({ existingKeys: new Set([key]) });
  assert.equal(applyGates(c, ctx).reason, "duplicate");
});

test("a candle that already produced a plan cannot produce a second one", () => {
  // The first scan publishes whichever playbook wins the conflict. A rescan
  // must not then publish the runner-up once the winner is deduped out.
  const winner = candidate({ playbookId: "P2" });
  const runnerUp = candidate({ playbookId: "P1" });
  const ctx = gateContext({
    existingKeys: new Set([dedupeKey(winner, "fixtures")]),
    existingGroups: new Set([groupKey(winner)]),
  });
  assert.equal(applyGates(winner, ctx).reason, "duplicate");
  assert.equal(applyGates(runnerUp, ctx).reason, "already_published_for_candle");
});

test("the group key ignores which playbook won", () => {
  assert.equal(groupKey(candidate({ playbookId: "P1" })), groupKey(candidate({ playbookId: "P6" })));
  assert.notEqual(groupKey(candidate()), groupKey(candidate({ signalTime: 1 })));
  assert.notEqual(groupKey(candidate()), groupKey(candidate({ configHash: "other" })));
});

test("the dedupe key is stable across repeated scans of the same candle", () => {
  const a = dedupeKey(candidate(), "fixtures");
  const b = dedupeKey(candidate(), "fixtures");
  assert.equal(a, b);
  // Any component change produces a different key.
  assert.notEqual(dedupeKey(candidate({ configHash: "hash2" }), "fixtures"), a);
  assert.notEqual(dedupeKey(candidate({ side: "sell" }), "fixtures"), a);
  assert.notEqual(dedupeKey(candidate(), "replay"), a);
});

// ---------------------------------------------------------------------------
// Confirmations
// ---------------------------------------------------------------------------

test("correlated confirmations in one family are counted once", () => {
  const collapsed = collapseConfirmations([
    { family: "structure", text: "breakout", weight: 10 },
    { family: "structure", text: "break of structure", weight: 24 },
    { family: "structure", text: "momentum close", weight: 8 },
    { family: "candle", text: "engulfing", weight: 16 },
  ]);
  assert.equal(collapsed.length, 2, "one per family");
  assert.equal(collapsed[0].text, "break of structure", "the strongest survives");
  assert.equal(scoreOf([
    { family: "structure", text: "a", weight: 10 },
    { family: "structure", text: "b", weight: 24 },
  ]), 24, "the same candle cannot score twice");
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test("alert ids are readable, dated and sequential per symbol", () => {
  const first = makeAlertId(candidate(), [], NOON);
  assert.equal(first, "FXS-EURUSD-20260107-001");
  assert.equal(makeAlertId(candidate(), [{ id: first }], NOON), "FXS-EURUSD-20260107-002");
  // A different instrument keeps its own sequence.
  assert.equal(
    makeAlertId(candidate({ symbol: "USD_JPY" }), [{ id: first }], NOON),
    "FXS-USDJPY-20260107-001",
  );
});

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

function passing(playbookId, side, weight) {
  const c = candidate({
    playbookId,
    side,
    confirmations: [{ family: "structure", text: "x", weight }],
  });
  return {
    candidate: c,
    gate: { ok: true, plan: buildTradePlan(c, EUR).plan },
  };
}

test("opposing candidates on the same candle publish nothing", () => {
  const { published, conflicts } = resolveConflicts(
    [passing("P1", "buy", 30), passing("P5", "sell", 30)],
    STRATEGY,
  );
  assert.equal(published.length, 0, "contradictory evidence publishes neither");
  assert.equal(conflicts[0].reason, "opposing_candidates");
});

test("same-side candidates resolve to exactly one published plan", () => {
  const { published, conflicts } = resolveConflicts(
    [passing("P3", "buy", 20), passing("P1", "buy", 30)],
    STRATEGY,
  );
  assert.equal(published.length, 1);
  assert.equal(published[0].candidate.playbookId, "P1", "highest score wins");
  assert.equal(conflicts[0].reason, "superseded");
  assert.equal(conflicts[0].candidate.playbookId, "P3");
  assert.ok(conflicts[0].plan, "the valid loser can be measured in shadow");
});

test("an exact score tie falls back to the explicit playbook priority", () => {
  const { published } = resolveConflicts(
    [passing("P4", "buy", 25), passing("P2", "buy", 25)],
    STRATEGY,
  );
  assert.equal(published[0].candidate.playbookId, "P2", "P2 outranks P4 by configuration");
});

test("P2 and P6 cannot both survive the same failed breakout", () => {
  const p2 = candidate({ playbookId: "P2", side: "buy", breakoutLevel: 1.1050 });
  const p6 = candidate({ playbookId: "P6", side: "sell", breakoutLevel: 1.1050 });
  const { kept, suppressed } = enforceBreakoutExclusivity([p2, p6]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].playbookId, "P6", "confirmed failure beats the retest thesis");
  assert.equal(suppressed[0].reason, "breakout_failed_p6_wins");

  // A P2 against an unrelated level is untouched.
  const other = candidate({ playbookId: "P2", side: "buy", breakoutLevel: 1.2000 });
  assert.equal(enforceBreakoutExclusivity([other, p6]).kept.length, 2);
});
