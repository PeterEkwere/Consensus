"use strict";

/**
 * Supported vs active instruments, the Tiingo request budget, quality scoring,
 * currency exposure and shadow tracking. All deterministic and offline.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ADDITIONAL_PAIRS,
  DEFAULT_SYMBOL_IDS,
  STRATEGY,
  SUPPORTED_SYMBOLS,
  SYMBOLS,
  buildSymbol,
  classifyPair,
  configHashOf,
  loadConfig,
} = require("../config");
const budget = require("../budget");
const quality = require("../quality");
const exposure = require("../exposure");
const shadow = require("../shadow");
const outcomes = require("../outcomes");
const results = require("../results");

// ---------------------------------------------------------------------------
// Instrument universe
// ---------------------------------------------------------------------------

test("all twenty-four instruments are supported and uniquely mapped", () => {
  assert.equal(SUPPORTED_SYMBOLS.length, 24);
  assert.equal(ADDITIONAL_PAIRS.length, 20);

  const tiingo = new Set();
  const tradingView = new Set();
  for (const id of SUPPORTED_SYMBOLS) {
    const meta = SYMBOLS[id];
    assert.ok(meta, `${id} has metadata`);
    assert.equal(meta.id, id);
    assert.ok(!tiingo.has(meta.tiingo), `${id} has a unique Tiingo ticker`);
    assert.ok(!tradingView.has(meta.tradingView), `${id} has a unique TradingView symbol`);
    tiingo.add(meta.tiingo);
    tradingView.add(meta.tradingView);
    assert.ok(Number.isFinite(meta.pip) && meta.pip > 0);
    assert.ok(Number.isInteger(meta.precision));
    assert.ok(meta.maxSpreadPips > 0 && meta.minStopPips > 0 && meta.maxStopPips > meta.minStopPips);
  }
});

test("mechanical mappings follow the documented conventions", () => {
  // Tiingo: lowercase, no underscore. TradingView: OANDA: plus the flat pair.
  assert.equal(SYMBOLS.EUR_CAD.tiingo, "eurcad");
  assert.equal(SYMBOLS.EUR_CAD.tradingView, "OANDA:EURCAD");
  assert.equal(SYMBOLS.AUD_NZD.tiingo, "audnzd");

  // Non-JPY keeps five decimals and a 0.0001 pip; JPY quotes use three/0.01.
  assert.equal(SYMBOLS.EUR_CAD.precision, 5);
  assert.equal(SYMBOLS.EUR_CAD.pip, 0.0001);
  assert.equal(SYMBOLS.GBP_JPY.precision, 3);
  assert.equal(SYMBOLS.GBP_JPY.pip, 0.01);
  assert.equal(SYMBOLS.NZD_JPY.pip, 0.01);
});

test("spread and stop policy is classified, not hand-tuned per pair", () => {
  assert.equal(classifyPair("AUD", "USD"), "usdMajor");
  assert.equal(classifyPair("GBP", "USD"), "usdSterling");
  assert.equal(classifyPair("EUR", "CAD"), "cross");
  assert.equal(classifyPair("GBP", "JPY"), "crossSterling");

  // Every pair in a class shares one policy, so no single pair can be tuned.
  const crosses = ["EUR_CAD", "EUR_CHF", "AUD_CAD", "AUD_NZD"];
  for (const id of crosses) {
    assert.equal(SYMBOLS[id].maxSpreadPips, SYMBOLS.EUR_CAD.maxSpreadPips, id);
    assert.equal(SYMBOLS[id].minStopPips, SYMBOLS.EUR_CAD.minStopPips, id);
  }
  // A USD major matches the existing EUR/USD baseline exactly.
  assert.equal(SYMBOLS.AUD_USD.maxSpreadPips, SYMBOLS.EUR_USD.maxSpreadPips);
  assert.equal(SYMBOLS.AUD_USD.minStopPips, SYMBOLS.EUR_USD.minStopPips);
  // Building a symbol is a pure function of its currencies.
  assert.deepEqual(buildSymbol("AUD_CAD"), SYMBOLS.AUD_CAD);
});

test("the default universe is exactly the original four", () => {
  assert.deepEqual([...DEFAULT_SYMBOL_IDS], ["EUR_USD", "GBP_USD", "USD_JPY", "XAU_USD"]);
  const config = loadConfig({ env: {} });
  assert.deepEqual(config.symbolIds, ["EUR_USD", "GBP_USD", "USD_JPY", "XAU_USD"],
    "absent FX_SYMBOLS must not activate the twenty new pairs");
});

test("supporting more instruments does not change the default cohort", () => {
  // The hash is taken over the ACTIVE symbols, so adding supported metadata to
  // the table cannot move an in-flight trial to a new cohort.
  const active = DEFAULT_SYMBOL_IDS.map((id) => SYMBOLS[id]);
  const fromFullTable = configHashOf(STRATEGY, active);
  const fromFourOnly = configHashOf(STRATEGY, [
    SYMBOLS.EUR_USD, SYMBOLS.GBP_USD, SYMBOLS.USD_JPY, SYMBOLS.XAU_USD,
  ]);
  assert.equal(fromFullTable, fromFourOnly);
  assert.equal(
    configHashOf(STRATEGY, active),
    configHashOf(STRATEGY, active.slice().reverse()),
    "symbol order is not a different universe",
  );
  const defaultConfig = loadConfig({ env: {} });
  assert.equal(defaultConfig.configHash, configHashOf(STRATEGY, active, {
    alertMode: "research", outcomeExpiryHours: 24, scanIntervalSeconds: 1800,
  }));
  const slower = loadConfig({ env: { FX_SCAN_INTERVAL_SECONDS: "3600" } });
  assert.notEqual(slower.configHash, defaultConfig.configHash, "cadence changes the cohort");

  // Activating a new instrument DOES change the cohort, which is correct.
  // A fifth instrument also needs a slower cadence: 21 requests/scan every
  // 30 minutes is 1,008/day, over the free daily allowance. That interaction is
  // exactly why supported and active are separate decisions.
  const widened = loadConfig({
    env: {
      FX_SYMBOLS: "EUR_USD,GBP_USD,USD_JPY,XAU_USD,AUD_USD",
      FX_SCAN_INTERVAL_SECONDS: "3600",
    },
  });
  assert.notEqual(widened.configHash, defaultConfig.configHash);
});

test("any supported subset loads and unknown instruments fail safely", () => {
  const subset = loadConfig({ env: { FX_SYMBOLS: "EUR_CAD,AUD_JPY" } });
  assert.deepEqual(subset.symbolIds, ["EUR_CAD", "AUD_JPY"]);

  assert.throws(() => loadConfig({ env: { FX_SYMBOLS: "EUR_USD,DOGE_USD" } }),
    /unsupported instrument/i);
  // The error names the offender without inventing a fallback universe.
  try {
    loadConfig({ env: { FX_SYMBOLS: "XXX_YYY" } });
    assert.fail("should have thrown");
  } catch (err) {
    assert.match(err.message, /XXX_YYY/);
  }
});

// ---------------------------------------------------------------------------
// Request budget
// ---------------------------------------------------------------------------

test("a scan costs one batched quote plus four candle calls per instrument", () => {
  assert.equal(budget.requestsPerScan(4), 17);
  assert.equal(budget.requestsPerScan(1), 5);
  assert.equal(budget.requestsPerScan(24), 97);
});

test("the default four-instrument configuration fits the free tier", () => {
  const check = budget.validate({ instrumentCount: 4, scanIntervalSeconds: 1800 });
  assert.equal(check.ok, true, check.problems.join(" "));
  assert.equal(check.projection.requestsPerScan, 17);
  assert.equal(check.projection.hourlyRequests, 34);
  assert.equal(check.projection.dailyRequests, 816);
  assert.ok(check.projection.hourlyHeadroom > 0);
  assert.ok(check.projection.dailyHeadroom > 0);
});

test("all twenty-four instruments break the hourly limit in a single scan", () => {
  const check = budget.validate({ instrumentCount: 24, scanIntervalSeconds: 1800 });
  assert.equal(check.ok, false);
  assert.match(check.problems[0], /one scan of 24 instrument\(s\) needs 97 requests/);
  // No cadence can rescue it, so slowing down must not be suggested as a fix.
  const slower = budget.validate({ instrumentCount: 24, scanIntervalSeconds: 86400 });
  assert.equal(slower.ok, false);
});

test("budget checks catch burst, hourly and daily limits independently", () => {
  // Hourly: 8 instruments = 33/scan; every 10 minutes = 198/hour.
  const hourly = budget.validate({ instrumentCount: 8, scanIntervalSeconds: 600 });
  assert.equal(hourly.ok, false);
  assert.ok(hourly.problems.some((p) => /requests\/hour/.test(p)));

  // Daily only: sits under the hourly cap but exceeds 1,000/day.
  const daily = budget.validate({ instrumentCount: 4, scanIntervalSeconds: 1200 });
  assert.equal(daily.ok, false);
  assert.ok(daily.problems.some((p) => /requests\/day/.test(p)));
  assert.ok(!daily.problems.some((p) => /alone exceeds/.test(p)));
});

test("boundary configurations are evaluated exactly", () => {
  // 17/scan hourly with a 5-request reserve leaves 45; 2 scans/hour = 34, fine.
  assert.equal(budget.validate({ instrumentCount: 4, scanIntervalSeconds: 1800 }).ok, true);
  // Three scans/hour = 51, over the 45 available.
  assert.equal(budget.validate({ instrumentCount: 4, scanIntervalSeconds: 1200 }).ok, false);
  // A raised limit (paid plan) makes the same configuration valid again.
  assert.equal(budget.validate({
    instrumentCount: 4, scanIntervalSeconds: 1200, limits: { hourly: 500, daily: 20000 },
  }).ok, true);
});

test("an over-subscribed configuration fails before any network or write", () => {
  // loadConfig runs the budget check, so a bad configuration cannot reach the
  // provider, the poller or the state directory at all.
  assert.throws(
    () => loadConfig({ env: { FX_SYMBOLS: SUPPORTED_SYMBOLS.join(",") } }),
    /Provider request budget exceeded/,
  );
  assert.throws(
    () => loadConfig({ env: { FX_SCAN_INTERVAL_SECONDS: "60" } }),
    /Provider request budget exceeded/,
  );
  // Credential-free overrides allow a future paid plan without code changes.
  const paid = loadConfig({
    env: {
      FX_SYMBOLS: SUPPORTED_SYMBOLS.join(","),
      FX_PROVIDER_HOURLY_LIMIT: "5000",
      FX_PROVIDER_DAILY_LIMIT: "100000",
    },
  });
  assert.equal(paid.symbolIds.length, 24);
});

test("the budget never silently degrades the requested configuration", () => {
  // A failing configuration throws; it does not quietly drop symbols or slow
  // the cadence, either of which would corrupt a forward trial unnoticed.
  let thrown = null;
  try {
    loadConfig({ env: { FX_SYMBOLS: SUPPORTED_SYMBOLS.join(",") } });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, "an invalid budget must be fatal");
  assert.match(thrown.message, /FX_SYMBOLS|FX_SCAN_INTERVAL_SECONDS/);
  // The message carries counts and variable names, never a secret.
  assert.ok(!/token|secret|key=/i.test(thrown.message));
});

// ---------------------------------------------------------------------------
// Quality score
// ---------------------------------------------------------------------------

test("the quality score normalizes against a frozen denominator", () => {
  const full = quality.scoreConfirmations([
    { family: "structure", text: "a", weight: 24 },
    { family: "location", text: "b", weight: 22 },
    { family: "liquidity", text: "c", weight: 24 },
    { family: "candle", text: "d", weight: 16 },
  ]);
  assert.equal(full.raw, quality.DENOMINATOR);
  assert.equal(full.score, 100);
  assert.equal(full.familyCount, 4);
  assert.equal(full.coveragePct, 100);

  const partial = quality.scoreConfirmations([
    { family: "structure", text: "a", weight: 24 },
    { family: "location", text: "b", weight: 22 },
  ]);
  // 46 of 86 = 53%. Missing evidence lowers the score rather than vanishing.
  assert.equal(partial.score, 53);
  assert.equal(partial.coveragePct, 50);
});

test("correlated evidence inside one family still counts once", () => {
  const scored = quality.scoreConfirmations([
    { family: "structure", text: "weaker", weight: 16 },
    { family: "structure", text: "stronger", weight: 24 },
  ]);
  assert.equal(scored.raw, 24);
  assert.equal(scored.familyCount, 1);
  assert.equal(scored.winners[0].text, "stronger");
});

test("an unknown family and an over-weighted item cannot inflate the score", () => {
  assert.equal(quality.scoreConfirmations([{ family: "invented", text: "x", weight: 99 }]).raw, 0);
  assert.equal(quality.scoreConfirmations([{ family: "liquidity", text: "x", weight: 999 }]).raw, 24);
  assert.equal(quality.scoreConfirmations([]).score, 0);
});

test("annotating a candidate adds fields without changing its gate outcome", () => {
  const candidate = {
    symbol: "EUR_USD",
    confirmations: [{ family: "structure", text: "a", weight: 24 }],
  };
  const before = JSON.stringify(candidate.confirmations);
  quality.annotate(candidate);
  assert.equal(candidate.qualityScore, 28);
  assert.equal(candidate.familyCount, 1);
  assert.equal(JSON.stringify(candidate.confirmations), before, "confirmations are untouched");
});

// ---------------------------------------------------------------------------
// Currency exposure
// ---------------------------------------------------------------------------

test("a side maps to two opposite currency legs", () => {
  assert.deepEqual(exposure.exposureOf("EUR_USD", "buy"), { long: "EUR", short: "USD" });
  assert.deepEqual(exposure.exposureOf("EUR_USD", "sell"), { long: "USD", short: "EUR" });
  assert.deepEqual(exposure.exposureOf("GBP_JPY", "sell"), { long: "JPY", short: "GBP" });
  assert.equal(exposure.exposureOf("NOTAPAIR", "buy"), null);
});

test("different pairs expressing the same view share exposure", () => {
  // Buy EUR/USD and sell GBP/EUR are both long EUR.
  assert.equal(
    exposure.sharesExposure({ symbol: "EUR_USD", side: "buy" }, { symbol: "GBP_EUR", side: "sell" }),
    "EUR",
  );
  // Buy EUR/USD and buy EUR/CAD are both long EUR.
  assert.equal(
    exposure.sharesExposure({ symbol: "EUR_USD", side: "buy" }, { symbol: "EUR_CAD", side: "buy" }),
    "EUR",
  );
  // Buy EUR/USD and buy GBP/USD are both short USD.
  assert.equal(
    exposure.sharesExposure({ symbol: "EUR_USD", side: "buy" }, { symbol: "GBP_USD", side: "buy" }),
    "USD",
  );
});

test("opposite views on the same pair are never collapsed", () => {
  assert.equal(
    exposure.sharesExposure({ symbol: "EUR_USD", side: "buy" }, { symbol: "EUR_USD", side: "sell" }),
    null,
  );
  // Unrelated pairs share nothing.
  assert.equal(
    exposure.sharesExposure({ symbol: "EUR_USD", side: "buy" }, { symbol: "AUD_JPY", side: "buy" }),
    null,
  );
});

test("a scan clusters by dominant shared exposure", () => {
  const clusters = exposure.clusterByExposure([
    { symbol: "EUR_USD", side: "buy", qualityScore: 80 },
    { symbol: "EUR_CAD", side: "buy", qualityScore: 70 },
    { symbol: "GBP_EUR", side: "sell", qualityScore: 60 },
    { symbol: "AUD_JPY", side: "buy", qualityScore: 50 },
  ]);
  const eur = clusters.find((c) => c.currency === "EUR" && c.direction === "long");
  assert.ok(eur, "the three long-EUR expressions are one cluster");
  assert.equal(eur.members.length, 3);
  // The unrelated pair keeps its own cluster.
  assert.ok(clusters.some((c) => c.members.length === 1 && c.members[0].symbol === "AUD_JPY"));

  const bridged = exposure.clusterByExposure([
    { symbol: "EUR_USD", side: "buy", signalTime: 1 },
    { symbol: "EUR_JPY", side: "buy", signalTime: 1 },
    { symbol: "GBP_JPY", side: "buy", signalTime: 1 },
  ]);
  assert.equal(bridged.length, 1, "a shared-JPY bridge cannot escape the shared-EUR cluster");
  assert.equal(bridged[0].members.length, 3);
});

test("opposite exposures land in separate clusters", () => {
  const clusters = exposure.clusterByExposure([
    { symbol: "EUR_USD", side: "buy" },
    { symbol: "EUR_USD", side: "sell" },
  ]);
  assert.equal(clusters.length, 2, "a buy and a sell are never one exposure");
  const separateWindows = exposure.clusterByExposure([
    { symbol: "EUR_USD", side: "buy", signalTime: 1000 },
    { symbol: "EUR_CAD", side: "buy", signalTime: 2000 },
  ]);
  assert.equal(separateWindows.length, 2);
  assert.notEqual(separateWindows[0].exposureKey, separateWindows[1].exposureKey);
});

test("ranking is deterministic and prefers a measured cost", () => {
  const ranked = exposure.rankCandidates([
    { symbol: "EUR_CAD", side: "buy", qualityScore: 70, costR: 0.1, playbookId: "P1" },
    { symbol: "EUR_USD", side: "buy", qualityScore: 80, costR: 0.2, playbookId: "P2" },
  ], { P1: 1, P2: 2 });
  assert.equal(ranked[0].symbol, "EUR_USD", "quality first");

  const tied = exposure.rankCandidates([
    { symbol: "ZZZ_USD", side: "buy", qualityScore: 80, costR: null, playbookId: "P1" },
    { symbol: "AAA_USD", side: "buy", qualityScore: 80, costR: 0.3, playbookId: "P6" },
  ], { P1: 1, P6: 6 });
  assert.equal(tied[0].symbol, "AAA_USD", "a measured cost beats an unknown one");

  const priority = exposure.rankCandidates([
    { symbol: "BBB_USD", side: "buy", qualityScore: 80, costR: 0.1, playbookId: "P4" },
    { symbol: "AAA_USD", side: "buy", qualityScore: 80, costR: 0.1, playbookId: "P2" },
  ], { P2: 2, P4: 4 });
  assert.equal(priority[0].playbookId, "P2", "explicit playbook priority breaks the tie");
});

// ---------------------------------------------------------------------------
// Shadow tracking
// ---------------------------------------------------------------------------

test("only judgement gates produce shadow evidence", () => {
  for (const reason of ["insufficient_structural_room", "outside_session", "price_moved_too_far",
    "spread_too_wide", "correlated_currency_exposure", "superseded"]) {
    assert.equal(shadow.isMeasurable(reason), true, reason);
  }
  // Data failures and identity rules say nothing about a strategy judgement.
  for (const reason of shadow.NEVER_SHADOW) {
    assert.equal(shadow.isMeasurable(reason), false, reason);
  }
  assert.equal(shadow.isMeasurable("something_new"), false, "unknown reasons are not assumed");
});

function withShadow(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-shadow-"));
  const stateDir = path.join(dir, "state");
  try {
    return fn(shadow.createShadowLedger({
      stateDir,
      expiryHours: 24,
      provider: { fetchCandles: async () => ({ candles: [], error: null }) },
      logger: { error() {} },
    }), stateDir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CANDIDATE = {
  symbol: "EUR_USD",
  playbookId: "P1",
  playbookName: "Liquidity Sweep Reversal",
  side: "buy",
  signalTime: Date.UTC(2026, 0, 7, 12, 0, 0),
  triggerCandleTime: Date.UTC(2026, 0, 7, 12, 0, 0),
  confirmations: [],
  observedSpread: 0.00008,
};
const PLAN = {
  side: "buy", entry: 1.1, stop: 1.098, firstTarget: 1.102, finalTarget: 1.106,
  r: 0.002, stopPips: 20,
};
const COSTS = { observedSpread: 0.00008, slippagePrice: 0, commissionPrice: 0,
  estimatedCostPrice: 0.00008, costR: 0.04, known: true };

test("a shadow record is namespaced, flagged and carries its reason", () => {
  withShadow((ledger) => {
    const record = ledger.track({
      candidate: { ...CANDIDATE },
      plan: PLAN,
      reason: "insufficient_structural_room",
      symbol: SYMBOLS.EUR_USD,
      sentAt: Date.UTC(2026, 0, 7, 12, 5, 0),
      costs: COSTS,
      configHash: "hash",
      quality: { score: 70, familyCount: 3, coveragePct: 50 },
    });
    assert.ok(record.id.startsWith("FXS-SHADOW-"), "never confusable with a published id");
    assert.equal(record.shadow, true);
    assert.equal(record.rejectionReason, "insufficient_structural_room");
    assert.equal(record.qualityScore, 70);
    assert.equal(record.status, "pending_entry");
  });
});

test("data failures and unplannable candidates are never shadowed", () => {
  withShadow((ledger) => {
    assert.equal(ledger.track({
      candidate: { ...CANDIDATE }, plan: PLAN, reason: "live_quote_stale",
      symbol: SYMBOLS.EUR_USD, sentAt: 0, costs: COSTS, configHash: "h",
    }), null);
    assert.equal(ledger.track({
      candidate: { ...CANDIDATE }, plan: null, reason: "insufficient_structural_room",
      symbol: SYMBOLS.EUR_USD, sentAt: 0, costs: COSTS, configHash: "h",
    }), null, "no plan means no measurable setup");
    assert.equal(ledger.records.length, 0);
  });
});

test("the same withheld candidate is only shadowed once", () => {
  withShadow((ledger) => {
    const args = {
      candidate: { ...CANDIDATE }, plan: PLAN, reason: "insufficient_structural_room",
      symbol: SYMBOLS.EUR_USD, sentAt: 0, costs: COSTS, configHash: "hash",
    };
    const a = ledger.track(args);
    const b = ledger.track({ ...args, candidate: { ...CANDIDATE } });
    assert.equal(a.id, b.id);
    assert.equal(ledger.records.length, 1);
  });
});

test("shadow outcomes obey the published entry and stop-first rules", async () => {
  const alertMs = Date.UTC(2026, 0, 7, 12, 0, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-shadow-"));
  let fetches = 0;
  try {
    const ledger = shadow.createShadowLedger({
      stateDir: path.join(dir, "state"),
      expiryHours: 24,
      // One candle spanning entry, target and stop must record the stop.
      provider: {
        fetchCandles: async () => {
          fetches += 1;
          return {
            candles: [{ time: alertMs + 60000, open: 1.1, high: 1.107, low: 1.097, close: 1.1, complete: true }],
            error: null,
          };
        },
      },
      logger: { error() {} },
    });
    ledger.track({
      candidate: { ...CANDIDATE }, plan: PLAN, reason: "insufficient_structural_room",
      symbol: SYMBOLS.EUR_USD, sentAt: alertMs, costs: COSTS, configHash: "hash",
    });
    ledger.track({
      candidate: { ...CANDIDATE, signalTime: alertMs + 300000, playbookId: "P2" },
      plan: PLAN, reason: "superseded",
      symbol: SYMBOLS.EUR_USD, sentAt: alertMs, costs: COSTS, configHash: "hash",
    });
    await ledger.poll(alertMs + 300000);
    assert.equal(fetches, 1, "records for one symbol share a single candle request");
    for (const record of ledger.records) {
      assert.equal(record.status, "complete");
      assert.equal(record.firstLeg, "loss", "stop-first ambiguity is shared with published setups");
      assert.equal(record.finalLeg, "loss");
      assert.equal(record.shadow, true);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a candle predating the shadow record is ignored", async () => {
  const alertMs = Date.UTC(2026, 0, 7, 12, 0, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-shadow-"));
  try {
    const ledger = shadow.createShadowLedger({
      stateDir: path.join(dir, "state"),
      expiryHours: 24,
      provider: {
        fetchCandles: async () => ({
          candles: [{ time: alertMs - 60000, open: 1.1, high: 1.107, low: 1.097, close: 1.1, complete: true }],
          error: null,
        }),
      },
      logger: { error() {} },
    });
    ledger.track({
      candidate: { ...CANDIDATE }, plan: PLAN, reason: "insufficient_structural_room",
      symbol: SYMBOLS.EUR_USD, sentAt: alertMs, costs: COSTS, configHash: "hash",
    });
    await ledger.poll(alertMs + 300000);
    assert.equal(ledger.records[0].status, "pending_entry");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the shadow ledger has no way to send a message", () => {
  withShadow((ledger) => {
    for (const key of ["notify", "send", "sendMessage", "client", "telegram"]) {
      assert.equal(ledger[key], undefined, `a shadow ledger must not expose ${key}`);
    }
  });
});

test("shadow state is private and versioned", () => {
  withShadow((ledger, stateDir) => {
    ledger.track({
      candidate: { ...CANDIDATE }, plan: PLAN, reason: "insufficient_structural_room",
      symbol: SYMBOLS.EUR_USD, sentAt: 0, costs: COSTS, configHash: "hash",
    });
    const file = path.join(stateDir, "shadow.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
    assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion >= 1);
  });
});

test("shadow summaries reconcile by reason and by playbook", () => {
  const rows = [
    { id: "a", status: "complete", firstLeg: "win", finalLeg: "loss", playbookId: "P1",
      rejectionReason: "insufficient_structural_room", costs: { costR: 0.05, known: true } },
    { id: "b", status: "complete", firstLeg: "loss", finalLeg: "loss", playbookId: "P1",
      rejectionReason: "insufficient_structural_room", costs: { costR: 0.05, known: true } },
    { id: "c", status: "pending_entry", firstLeg: "pending", finalLeg: "pending", playbookId: "P2",
      rejectionReason: "outside_session", costs: { costR: null, known: false } },
  ];
  const summary = shadow.summarise(rows, {
    summariseLeg: results.summariseLeg,
    lifecycleOf: results.lifecycleOf,
  });
  assert.equal(summary.total, 3);
  const room = summary.byReason.insufficient_structural_room;
  assert.equal(room.total, 2);
  assert.equal(room.firstLeg.wins, 1);
  assert.equal(room.firstLeg.losses, 1);
  // Totals across reasons and across playbooks both add back to the whole.
  const byReasonTotal = Object.values(summary.byReason).reduce((s, r) => s + r.total, 0);
  const byPlaybookTotal = Object.values(summary.byPlaybook).reduce((s, r) => s + r.total, 0);
  assert.equal(byReasonTotal, 3);
  assert.equal(byPlaybookTotal, 3);
  assert.equal(summary.byReason.outside_session.unknownCost, 1);
});
