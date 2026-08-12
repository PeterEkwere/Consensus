"use strict";

/**
 * Lifecycle accounting and per-leg statistics, on hand-calculated fixtures.
 *
 * The two properties that matter: buckets partition the plans exactly, and the
 * 1:1 and 3:1 legs are never blended.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  legResult,
  lifecycleOf,
  reconciles,
  summarise,
  summariseLeg,
  tStatistic,
} = require("../results");

let counter = 0;

function plan({
  status = "complete",
  firstLeg = "pending",
  finalLeg = "pending",
  costR = 0.05,
  playbookId = "P1",
  id = null,
  exposureKey = null,
  configHash = null,
} = {}) {
  counter += 1;
  return {
    id: id || `FXS-EURUSD-20260107-${String(counter).padStart(3, "0")}`,
    symbol: "EUR_USD",
    playbookId,
    playbookName: `Playbook ${playbookId}`,
    side: "buy",
    status,
    firstLeg,
    finalLeg,
    sentAt: new Date(Date.UTC(2026, 0, 7, 12, 0, 0) + counter * 60000).toISOString(),
    costs: { costR },
    dataGaps: 0,
    exposureKey,
    clusterId: exposureKey,
    configHash,
  };
}

// ---------------------------------------------------------------------------
// Leg arithmetic
// ---------------------------------------------------------------------------

test("a first-leg win is +1R gross and a loss is -1R", () => {
  assert.equal(legResult(plan({ firstLeg: "win" }), "first").gross, 1);
  assert.equal(legResult(plan({ firstLeg: "loss" }), "first").gross, -1);
});

test("a final-leg win is +3R gross while its loss is still only -1R", () => {
  assert.equal(legResult(plan({ finalLeg: "win" }), "final").gross, 3);
  assert.equal(legResult(plan({ finalLeg: "loss" }), "final").gross, -1);
});

test("net result subtracts the cost in R", () => {
  const result = legResult(plan({ firstLeg: "win", costR: 0.06 }), "first");
  assert.ok(Math.abs(result.net - 0.94) < 1e-9);
});

test("pending and void legs contribute nothing", () => {
  assert.equal(legResult(plan({ firstLeg: "pending" }), "first"), null);
  assert.equal(legResult(plan({ firstLeg: "void" }), "first"), null);
});

test("an unknown cost leaves the net result unknown rather than zero-cost", () => {
  const result = legResult(plan({ firstLeg: "win", costR: null }), "first");
  assert.equal(result.gross, 1);
  assert.equal(result.net, null);
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

test("win rate and expectancy are computed on resolved legs only", () => {
  const records = [
    plan({ firstLeg: "win", finalLeg: "win", costR: 0.1 }),
    plan({ firstLeg: "win", finalLeg: "loss", costR: 0.1 }),
    plan({ firstLeg: "loss", finalLeg: "loss", costR: 0.1 }),
    plan({ status: "expired", firstLeg: "void", finalLeg: "void" }),
  ];
  const complete = records.filter((r) => r.status === "complete");

  const first = summariseLeg(complete, "first");
  assert.equal(first.wins, 2);
  assert.equal(first.losses, 1);
  assert.equal(first.resolved, 3);
  assert.ok(Math.abs(first.winRate - (2 / 3) * 100) < 1e-9);
  // gross mean = (1 + 1 - 1)/3 = 0.3333; net subtracts 0.1 each.
  assert.ok(Math.abs(first.grossExpectancyR - 1 / 3) < 1e-9);
  assert.ok(Math.abs(first.netExpectancyR - (1 / 3 - 0.1)) < 1e-9);

  const final = summariseLeg(complete, "final");
  assert.equal(final.wins, 1);
  assert.equal(final.losses, 2);
  // gross mean = (3 - 1 - 1)/3 = 0.3333
  assert.ok(Math.abs(final.grossExpectancyR - 1 / 3) < 1e-9);
});

test("void, pending and cancelled records stay out of the denominators", () => {
  const records = [
    plan({ status: "expired", firstLeg: "void", finalLeg: "void" }),
    plan({ status: "cancelled_before_entry", firstLeg: "void", finalLeg: "void" }),
    plan({ status: "pending_entry" }),
    plan({ status: "entered" }),
  ];
  const leg = summariseLeg(records, "first");
  assert.equal(leg.resolved, 0);
  assert.equal(leg.winRate, null, "no denominator means no rate, not 0%");
  assert.equal(leg.netExpectancyR, null);
});

// ---------------------------------------------------------------------------
// t-statistic
// ---------------------------------------------------------------------------

test("the t-statistic matches a hand-calculated sample", () => {
  // Sample: 1, 2, 3, 4. mean 2.5, sample variance 1.6667, sd 1.29099,
  // se = 1.29099/2 = 0.645497, t = 2.5/0.645497 = 3.8730
  const t = tStatistic([1, 2, 3, 4]);
  assert.ok(Math.abs(t - 3.872983346207417) < 1e-9, `got ${t}`);
});

test("the t-statistic is unavailable rather than infinite", () => {
  assert.equal(tStatistic([]), null, "no sample");
  assert.equal(tStatistic([1]), null, "n < 2");
  assert.equal(tStatistic([2, 2, 2]), null, "zero variance is not infinite evidence");
  assert.equal(tStatistic([1, NaN]), null, "non-finite input");
  assert.equal(tStatistic([1, Infinity]), null);
});

test("inference collapses correlated setups to one currency-event observation", () => {
  const records = [
    plan({ firstLeg: "win", exposureKey: "window-a:EUR:1", costR: 0.1 }),
    plan({ firstLeg: "loss", exposureKey: "window-a:EUR:1", costR: 0.1 }),
    plan({ firstLeg: "win", exposureKey: "window-b:EUR:1", costR: 0.1 }),
  ];
  const leg = summariseLeg(records, "first");
  assert.equal(leg.netSampleSize, 3);
  assert.equal(leg.clusterCount, 2);
  // Event A mean: (-0.1); event B: 0.9; event-series mean: 0.4.
  assert.ok(Math.abs(leg.clusterNetExpectancyR - 0.4) < 1e-9);
  assert.notEqual(leg.tStatistic, null);

  const copies = Array.from({ length: 10 }, () => plan({
    firstLeg: "win", exposureKey: "one-event", costR: 0.1,
  }));
  const oneEvent = summariseLeg(copies, "first");
  assert.equal(oneEvent.clusterCount, 1);
  assert.equal(oneEvent.tStatistic, null, "ten copies of one event are not ten observations");
});

// ---------------------------------------------------------------------------
// Lifecycle partition
// ---------------------------------------------------------------------------

test("every plan lands in exactly one lifecycle bucket", () => {
  const records = [
    plan({ status: "pending_entry" }),
    plan({ status: "entered" }),
    plan({ status: "cancelled_before_entry" }),
    plan({ status: "expired" }),
    plan({ status: "complete", firstLeg: "win", finalLeg: "loss" }),
  ];
  const life = lifecycleOf(records);
  assert.equal(life.pending_entry, 1);
  assert.equal(life.entered_unresolved, 1);
  assert.equal(life.cancelled_before_entry, 1);
  assert.equal(life.expired, 1);
  assert.equal(life.complete, 1);
  assert.equal(life.total, 5);
});

test("lifecycle counts sum back to the unique plan count", () => {
  const records = [
    plan({ status: "pending_entry" }),
    plan({ status: "entered" }),
    plan({ status: "complete", firstLeg: "win", finalLeg: "win" }),
    plan({ status: "complete", firstLeg: "loss", finalLeg: "loss" }),
    plan({ status: "expired" }),
  ];
  const summary = summarise(records);
  assert.equal(summary.uniquePlans, 5);
  assert.ok(reconciles(summary));

  const active = plan({ configHash: "active", firstLeg: "win", exposureKey: "a" });
  const old = plan({ configHash: "old", firstLeg: "loss", exposureKey: "b" });
  const legacy = plan({ configHash: null, firstLeg: "loss", exposureKey: "c" });
  const scoped = summarise([active, old, legacy], { configHash: "active" });
  assert.equal(scoped.uniquePlans, 1);
  assert.equal(scoped.firstLeg.wins, 1);
  assert.equal(scoped.firstLeg.losses, 0);
  assert.equal(scoped.otherCohortCount, 1);
  assert.equal(scoped.legacyCount, 1);
});

test("a repeated plan id cannot be counted twice", () => {
  const duplicate = plan({ status: "complete", firstLeg: "win", finalLeg: "win", id: "FXS-DUP-001" });
  const summary = summarise([duplicate, { ...duplicate }, { ...duplicate }]);
  assert.equal(summary.uniquePlans, 1, "restarts and rescans cannot inflate the count");
  assert.equal(summary.firstLeg.resolved, 1);
  assert.ok(reconciles(summary));
});

test("resolved first legs survive a later setup expiry", () => {
  const summary = summarise([
    plan({ status: "expired", firstLeg: "win", finalLeg: "void" }),
    plan({ status: "entered" }),
  ]);
  assert.equal(summary.lifecycle.complete, 0);
  assert.equal(summary.firstLeg.wins, 1);
  assert.equal(summary.finalLeg.resolved, 0);
  assert.ok(reconciles(summary));
});

// ---------------------------------------------------------------------------
// Per-playbook cohorts
// ---------------------------------------------------------------------------

test("per-playbook totals reconcile with the global totals", () => {
  const records = [
    plan({ playbookId: "P1", status: "complete", firstLeg: "win", finalLeg: "win" }),
    plan({ playbookId: "P1", status: "complete", firstLeg: "loss", finalLeg: "loss" }),
    plan({ playbookId: "P2", status: "complete", firstLeg: "win", finalLeg: "loss" }),
    plan({ playbookId: "P2", status: "pending_entry" }),
    plan({ playbookId: "P3", status: "expired" }),
  ];
  const summary = summarise(records);

  assert.equal(summary.uniquePlans, 5);
  const cohortTotal = Object.values(summary.playbooks)
    .reduce((sum, cohort) => sum + cohort.lifecycle.total, 0);
  assert.equal(cohortTotal, summary.uniquePlans, "cohorts partition the plans");

  const cohortFirstWins = Object.values(summary.playbooks)
    .reduce((sum, cohort) => sum + cohort.firstLeg.wins, 0);
  assert.equal(cohortFirstWins, summary.firstLeg.wins);

  // Each cohort keeps its own record; a losing playbook is never averaged away.
  assert.equal(summary.playbooks.P1.firstLeg.wins, 1);
  assert.equal(summary.playbooks.P1.firstLeg.losses, 1);
  assert.equal(summary.playbooks.P2.finalLeg.losses, 1);
  assert.equal(summary.playbooks.P3.lifecycle.expired, 1);
});

test("an empty ledger reports nothing rather than a fabricated zero rate", () => {
  const summary = summarise([]);
  assert.equal(summary.uniquePlans, 0);
  assert.equal(summary.firstLeg.winRate, null);
  assert.equal(summary.finalLeg.tStatistic, null);
  assert.ok(reconciles(summary));
});
