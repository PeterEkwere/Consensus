"use strict";

/**
 * Deterministic tests for outcome monitoring. No network, no clock dependence:
 * every candle and every timestamp is supplied by the test.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  applyCandles,
  buildTradePlan,
  createOutcomeTracker,
  createRecord,
  DEFAULT_COSTS,
  loadRecords,
  makeAlertId,
  sanitizeRecord,
  summarise,
  summariseAllCohorts,
} = require("./outcomes");

const MINUTE = 60 * 1000;
const ALERT_MS = Date.parse("2026-08-08T12:00:00.000Z");
const EXPIRY_MS = 24 * 3600 * 1000;

// Tests are queued and then run in order, so async cases are actually awaited
// and a rejection fails the suite instead of vanishing.
const queue = [];
function test(name, fn) {
  queue.push({ name, fn });
}
function section(name) {
  queue.push({ section: name });
}

function longSignal(overrides = {}) {
  return {
    exchange: "OKX",
    market: "futures",
    symbol: "BTCUSDT",
    name: "BTC / USDT",
    side: "long",
    price: 100,
    stop: 90,
    score: 80,
    time: "2026-08-08T11:59:00.000Z",
    confirmations: ["Break and retest above prior resistance"],
    ...overrides,
  };
}

function shortSignal(overrides = {}) {
  return longSignal({ side: "short", price: 100, stop: 110, symbol: "ETHUSDT", name: "ETH / USDT", ...overrides });
}

function recordFor(signal, id = "CR-TEST-20260808-001") {
  const plan = buildTradePlan(signal);
  assert(plan, "test fixture must produce a valid plan");
  return createRecord({
    signal,
    plan,
    id,
    sentAt: new Date(ALERT_MS).toISOString(),
    costs: DEFAULT_COSTS,
  });
}

/** Candle helper: minute offset from the alert, plus the range it traded. */
function candle(minute, low, high) {
  return { time: ALERT_MS + minute * MINUTE, low, high, open: low, close: high };
}

function run(record, candles, now = ALERT_MS + 60 * MINUTE) {
  return applyCandles(record, candles, { now, expiryMs: EXPIRY_MS });
}

// ---------------------------------------------------------------------------
// Trade plan maths and directional validation
// ---------------------------------------------------------------------------

section("trade plan");

test("long targets are one and three times the measured risk", () => {
  const plan = buildTradePlan(longSignal());
  assert.strictEqual(plan.r, 10);
  assert.strictEqual(plan.tp1, 110);
  assert.strictEqual(plan.tp3, 130);
});

test("short targets mirror the long formulas", () => {
  const plan = buildTradePlan(shortSignal());
  assert.strictEqual(plan.r, 10);
  assert.strictEqual(plan.tp1, 90);
  assert.strictEqual(plan.tp3, 70);
});

test("missing, non-finite, zero and inverted levels are rejected", () => {
  assert.strictEqual(buildTradePlan(null), null);
  assert.strictEqual(buildTradePlan(longSignal({ price: undefined })), null);
  assert.strictEqual(buildTradePlan(longSignal({ stop: NaN })), null);
  assert.strictEqual(buildTradePlan(longSignal({ stop: Infinity })), null);
  assert.strictEqual(buildTradePlan(longSignal({ price: 0 })), null);
  assert.strictEqual(buildTradePlan(longSignal({ stop: 100 })), null, "zero risk must be rejected");
  assert.strictEqual(buildTradePlan(longSignal({ side: "sideways" })), null);
  // A long whose stop sits above the entry is directionally invalid.
  assert.strictEqual(buildTradePlan(longSignal({ stop: 110 })), null);
  assert.strictEqual(buildTradePlan(shortSignal({ stop: 90 })), null);
});

// ---------------------------------------------------------------------------
// Resolution paths
// ---------------------------------------------------------------------------

section("resolution");

test("long reaches the first target, then the final target", () => {
  const first = run(recordFor(longSignal()), [candle(1, 99, 100), candle(2, 105, 112)]);
  assert.strictEqual(first.record.entryStatus, "entered");
  assert.strictEqual(first.record.r1Status, "tp");
  assert.strictEqual(first.record.r3Status, "open");
  assert.deepStrictEqual(first.events.map((e) => e.type), ["first_target"]);

  const second = run(first.record, [candle(3, 120, 131)]);
  assert.strictEqual(second.record.r3Status, "tp");
  assert.strictEqual(second.record.r1Status, "tp");
  assert.strictEqual(second.record.status, "complete");
  assert.deepStrictEqual(second.events.map((e) => e.type), ["final"]);
});

test("short reaches the first target, then the final target", () => {
  const first = run(recordFor(shortSignal()), [candle(1, 100, 101), candle(2, 88, 95)]);
  assert.strictEqual(first.record.entryStatus, "entered");
  assert.strictEqual(first.record.r1Status, "tp");
  assert.strictEqual(first.record.r3Status, "open");

  const second = run(first.record, [candle(3, 69, 80)]);
  assert.strictEqual(second.record.r3Status, "tp");
  assert.strictEqual(second.record.status, "complete");
});

test("stop before the first target loses both legs", () => {
  const result = run(recordFor(longSignal()), [candle(1, 99, 101), candle(2, 89, 97)]);
  assert.strictEqual(result.record.r1Status, "sl");
  assert.strictEqual(result.record.r3Status, "sl");
  assert.strictEqual(result.record.status, "complete");
  assert.deepStrictEqual(result.events.map((e) => e.type), ["final"]);
});

test("first target then a later stop records a hit and a loss", () => {
  const first = run(recordFor(longSignal()), [candle(1, 99, 111)]);
  assert.strictEqual(first.record.r1Status, "tp");
  const second = run(first.record, [candle(5, 89, 105)]);
  assert.strictEqual(second.record.r1Status, "tp", "a reached target is never taken back");
  assert.strictEqual(second.record.r3Status, "sl");
  assert.strictEqual(second.record.status, "complete");
});

test("running straight to the final target sends one message, not two", () => {
  const result = run(recordFor(longSignal()), [candle(1, 99, 131)]);
  assert.strictEqual(result.record.r1Status, "tp");
  assert.strictEqual(result.record.r3Status, "tp");
  assert.deepStrictEqual(result.events.map((e) => e.type), ["final"]);
});

// ---------------------------------------------------------------------------
// Entry activation
// ---------------------------------------------------------------------------

section("entry activation");

test("a setup whose exact entry is never traded stays pending", () => {
  const result = run(recordFor(longSignal()), [candle(1, 101, 105), candle(2, 102, 108)]);
  assert.strictEqual(result.record.entryStatus, "pending");
  assert.strictEqual(result.record.r1Status, "open");
  assert.strictEqual(result.record.status, "open");
  assert.strictEqual(result.events.length, 0);
});

test("invalidation without an entry cancels the setup", () => {
  // Price gaps away from the exact entry and runs to the stop untouched.
  const result = run(recordFor(longSignal()), [candle(1, 95, 98), candle(2, 88, 94)]);
  assert.strictEqual(result.record.entryStatus, "cancelled");
  assert.strictEqual(result.record.status, "cancelled");
  assert.strictEqual(result.record.r1Status, "void");
  assert.strictEqual(result.record.r3Status, "void");
  assert.strictEqual(result.events.length, 0, "a cancelled setup is not announced");
});

test("candles that opened before the alert are ignored", () => {
  const stale = { time: ALERT_MS - MINUTE, low: 89, high: 131, open: 89, close: 131 };
  const result = run(recordFor(longSignal()), [stale]);
  assert.strictEqual(result.record.entryStatus, "pending");
  assert.strictEqual(result.record.candlesSeen, 0);
});

// ---------------------------------------------------------------------------
// Ambiguity and expiry
// ---------------------------------------------------------------------------

section("ambiguity and expiry");

test("one candle holding both stop and target records the stop", () => {
  const result = run(recordFor(longSignal()), [candle(1, 89, 131)]);
  assert.strictEqual(result.record.entryStatus, "entered");
  assert.strictEqual(result.record.r1Status, "sl");
  assert.strictEqual(result.record.r3Status, "sl");
});

test("after the first target, an ambiguous candle still records the stop", () => {
  const first = run(recordFor(longSignal()), [candle(1, 99, 111)]);
  const second = run(first.record, [candle(2, 89, 131)]);
  assert.strictEqual(second.record.r1Status, "tp");
  assert.strictEqual(second.record.r3Status, "sl");
});

test("unresolved setups expire without being scored", () => {
  const pending = run(recordFor(longSignal()), [], ALERT_MS + EXPIRY_MS + MINUTE);
  assert.strictEqual(pending.record.status, "expired");
  assert.strictEqual(pending.record.entryStatus, "expired");
  assert.strictEqual(pending.record.r1Status, "void");
  assert.strictEqual(pending.record.r3Status, "void");
  assert.strictEqual(pending.events.length, 0);

  const entered = run(recordFor(longSignal()), [candle(1, 99, 101)], ALERT_MS + EXPIRY_MS + MINUTE);
  assert.strictEqual(entered.record.entryStatus, "entered");
  assert.strictEqual(entered.record.status, "expired");
  assert.strictEqual(entered.record.r1Status, "void");

  const stats = summarise([entered.record]);
  assert.strictEqual(stats.oneR.resolved, 0, "expired setups are not wins or losses");
  assert.strictEqual(stats.expired, 1);
});

test("a reached first target remains scored when only the final leg expires", () => {
  const first = run(recordFor(longSignal()), [candle(1, 99, 111)]);
  const expired = run(first.record, [], ALERT_MS + EXPIRY_MS + MINUTE).record;
  assert.strictEqual(expired.status, "expired");
  assert.strictEqual(expired.r1Status, "tp");
  assert.strictEqual(expired.r3Status, "void");

  const stats = summarise([expired]);
  assert.strictEqual(stats.oneR.resolved, 1, "the resolved 1:1 leg belongs in its sample");
  assert.strictEqual(stats.oneR.tp, 1);
  assert.strictEqual(stats.threeR.resolved, 0, "the unresolved 3:1 leg stays excluded");
});

test("MFE, MAE and timings begin at entry and use only eligible chronology", () => {
  const initial = recordFor(longSignal());
  const beforeAlert = { time: ALERT_MS - MINUTE, low: 80, high: 140, open: 100, close: 100 };
  const beforeEntry = candle(1, 101, 108);
  const pending = run(initial, [beforeAlert, beforeEntry], ALERT_MS + MINUTE).record;
  assert.strictEqual(pending.mfeR, null);
  assert.strictEqual(pending.maeR, null);
  const entered = run(initial, [beforeAlert, beforeEntry, candle(2, 98, 106)], ALERT_MS + 2 * MINUTE);

  assert.strictEqual(entered.record.entryStatus, "entered");
  assert.strictEqual(entered.record.msToEntry, 2 * MINUTE);
  assert.strictEqual(entered.record.mfeR, null, "entry-candle ordering is unknowable from OHLC");
  assert.strictEqual(entered.record.maeR, null);

  const first = run(entered.record, [candle(3, 95, 112)], ALERT_MS + 3 * MINUTE);
  assert.strictEqual(first.record.r1Status, "tp");
  assert.strictEqual(first.record.msToFirstTarget, MINUTE);
  assert(Math.abs(first.record.mfeR - 1.2) < 1e-9);
  assert(Math.abs(first.record.maeR - 0.5) < 1e-9);

  const final = run(first.record, [candle(4, 97, 131)], ALERT_MS + 4 * MINUTE);
  assert.strictEqual(final.record.r3Status, "tp");
  assert.strictEqual(final.record.msToFinalResolution, 2 * MINUTE);
  assert(Math.abs(final.record.mfeR - 3.1) < 1e-9);
  assert(Math.abs(final.record.maeR - 0.5) < 1e-9);
});

test("a setup resolved just before expiry keeps its result", () => {
  const result = run(recordFor(longSignal()), [candle(1, 99, 131)], ALERT_MS + EXPIRY_MS + MINUTE);
  assert.strictEqual(result.record.status, "complete");
  assert.strictEqual(result.record.r3Status, "tp");
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

section("statistics");

test("expectancy is net of the configured costs", () => {
  const win = run(recordFor(longSignal()), [candle(1, 99, 131)]).record;
  const stats = summarise([win]);
  // entry 100, R 10, 0.1% round trip => 0.2 price units => 0.02R of cost.
  assert.strictEqual(stats.oneR.tp, 1);
  assert.strictEqual(stats.oneR.grossExpectancyR, 1);
  assert(Math.abs(stats.oneR.netExpectancyR - 0.98) < 1e-9, `got ${stats.oneR.netExpectancyR}`);
  assert(Math.abs(stats.threeR.netExpectancyR - 2.98) < 1e-9, `got ${stats.threeR.netExpectancyR}`);
  const observedWin = run(recordFor(longSignal({ execution: { costR: 0.07, known: true } })), [candle(1, 99, 131)]).record;
  const observed = summarise([observedWin]);
  assert(Math.abs(observed.oneR.netExpectancyR - 0.93) < 1e-9, `got ${observed.oneR.netExpectancyR}`);
  assert(Math.abs(observed.oneRStats.netExpectancyR - 0.93) < 1e-9);
});

test("all-cohort summaries keep their actual labels", () => {
  const a = recordFor(longSignal({ cohortId: "cohort-a" }), "CR-A-001");
  const b = recordFor(longSignal({ cohortId: "cohort-b", symbol: "ETHUSDT" }), "CR-B-001");
  const legacy = recordFor(longSignal({ cohortId: null, symbol: "SOLUSDT" }), "CR-L-001");
  const rows = summariseAllCohorts([a, b, legacy]);
  assert.deepStrictEqual(rows.map((row) => row.cohortId), ["cohort-a", "cohort-b", "legacy-unknown"]);
  assert(rows.every((row) => row.total === 1));
});

test("win rate and t-statistic need enough data", () => {
  const win = run(recordFor(longSignal()), [candle(1, 99, 131)]).record;
  const loss = run(recordFor(longSignal(), "CR-TEST-20260808-002"), [candle(1, 89, 101)]).record;
  const stats = summarise([win, loss]);
  assert.strictEqual(stats.oneR.resolved, 2);
  assert.strictEqual(stats.oneR.winRate, 50);
  assert(stats.oneR.tStat !== null, "two differing results define a t-statistic");
  // A single observation has no variance to measure.
  assert.strictEqual(summarise([win]).oneR.tStat, null);
});

test("lifecycle buckets are mutually exclusive and add up to total alerts", () => {
  const awaiting = recordFor(longSignal(), "CR-LIFE-001");
  const monitoring = run(recordFor(longSignal(), "CR-LIFE-002"), [candle(1, 99, 101)]).record;
  const cancelled = run(recordFor(longSignal(), "CR-LIFE-003"), [candle(1, 88, 95)]).record;
  const expiredBefore = run(recordFor(longSignal(), "CR-LIFE-004"), [], ALERT_MS + EXPIRY_MS + MINUTE).record;
  const expiredAfter = run(recordFor(longSignal(), "CR-LIFE-005"), [candle(1, 99, 101)], ALERT_MS + EXPIRY_MS + MINUTE).record;
  const complete = run(recordFor(longSignal(), "CR-LIFE-006"), [candle(1, 99, 131)]).record;
  const stats = summarise([awaiting, monitoring, cancelled, expiredBefore, expiredAfter, complete]);
  const lifecycleTotal = stats.awaitingEntry + stats.enteredMonitoring + stats.cancelled
    + stats.expiredBeforeEntry + stats.expiredAfterEntry + stats.completed;
  assert.strictEqual(lifecycleTotal, stats.total);
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

section("identity");

test("alert ids are readable, dated and collision-protected", () => {
  const signal = longSignal();
  const first = makeAlertId(signal, []);
  assert.strictEqual(first, "CR-BTC-20260808-001");
  const second = makeAlertId(signal, [{ id: first }]);
  assert.strictEqual(second, "CR-BTC-20260808-002");
  // Unrelated symbols and days do not consume the sequence.
  assert.strictEqual(makeAlertId(shortSignal(), [{ id: first }]), "CR-ETH-20260808-001");
});

// ---------------------------------------------------------------------------
// Persistence, restart recovery and malformed input
// ---------------------------------------------------------------------------

section("persistence");

// Awaits the body before cleaning up, so async cases still have their ledger.
async function withTracker(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consensus-outcomes-"));
  const file = path.join(dir, "outcomes.json");
  try {
    return await fn(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const quietLogger = { error() {}, log() {} };

test("the same signal is never tracked twice", () => {
  return withTracker((file) => {
    const tracker = createOutcomeTracker({ file, fetchCandles: async () => [], logger: quietLogger });
    const a = tracker.track(longSignal());
    const b = tracker.track(longSignal());
    assert.strictEqual(a.id, b.id, "a repeated signal reuses its alert id");
    assert.strictEqual(tracker.records.length, 1);
  });
});

test("untrackable setups are refused", () => {
  return withTracker((file) => {
    const tracker = createOutcomeTracker({ file, fetchCandles: async () => [], logger: quietLogger });
    assert.strictEqual(tracker.track(longSignal({ stop: 100 })), null);
    assert.strictEqual(tracker.records.length, 0);
  });
});

test("an unresolved setup resumes after a restart", async () => {
  await withTracker(async (file) => {
    const first = createOutcomeTracker({
      file,
      logger: quietLogger,
      fetchCandles: async () => [candle(1, 99, 100)],
    });
    const record = first.track(longSignal(), new Date(ALERT_MS).toISOString());
    await first.poll(ALERT_MS + 2 * MINUTE);
    assert.strictEqual(first.find(record.id).entryStatus, "entered");

    // A brand new tracker reading the same file must continue, not restart.
    const second = createOutcomeTracker({
      file,
      logger: quietLogger,
      fetchCandles: async () => [candle(2, 105, 131)],
    });
    const resumed = second.find(record.id);
    assert(resumed, "the open setup survives the restart");
    assert.strictEqual(resumed.entryStatus, "entered");
    assert.strictEqual(resumed.id, record.id, "the id is stable across restarts");

    const events = await second.poll(ALERT_MS + 5 * MINUTE);
    assert.deepStrictEqual(events.map((e) => e.type), ["final"]);
    assert.strictEqual(second.find(record.id).r3Status, "tp");
  });
});

test("a notification is never sent twice, including across restarts", async () => {
  await withTracker(async (file) => {
    const sent = [];
    const options = {
      file,
      logger: quietLogger,
      notify: async (event, record) => sent.push(`${record.id}:${event.type}`),
      fetchCandles: async () => [candle(1, 99, 111)],
    };
    const tracker = createOutcomeTracker(options);
    const record = tracker.track(longSignal(), new Date(ALERT_MS).toISOString());
    await tracker.poll(ALERT_MS + 2 * MINUTE);
    // Polling again over the same candle must not re-announce anything.
    await tracker.poll(ALERT_MS + 3 * MINUTE);
    assert.deepStrictEqual(sent, [`${record.id}:first_target`]);

    const restarted = createOutcomeTracker(options);
    await restarted.poll(ALERT_MS + 4 * MINUTE);
    assert.deepStrictEqual(sent, [`${record.id}:first_target`], "the flag survived the restart");
  });
});

test("a failing notification does not lose the recorded outcome", async () => {
  await withTracker(async (file) => {
    const tracker = createOutcomeTracker({
      file,
      logger: quietLogger,
      notify: async () => {
        throw new Error("telegram is down");
      },
      fetchCandles: async () => [candle(1, 99, 131)],
    });
    const record = tracker.track(longSignal(), new Date(ALERT_MS).toISOString());
    await tracker.poll(ALERT_MS + 2 * MINUTE);
    assert.strictEqual(tracker.find(record.id).r3Status, "tp");
  });
});

test("a candle fetch failure never fabricates an outcome", async () => {
  await withTracker(async (file) => {
    const tracker = createOutcomeTracker({
      file,
      logger: quietLogger,
      fetchCandles: async () => {
        throw new Error("okx unreachable");
      },
    });
    const record = tracker.track(longSignal(), new Date(ALERT_MS).toISOString());
    await tracker.poll(ALERT_MS + 2 * MINUTE);
    const stored = tracker.find(record.id);
    assert.strictEqual(stored.status, "open");
    assert.strictEqual(stored.entryStatus, "pending");
  });
});

test("malformed persisted records fail closed before they can be overwritten", () => {
  return withTracker((file) => {
    const good = recordFor(longSignal());
    fs.writeFileSync(file, JSON.stringify([
      good,
      null,
      "not an object",
      42,
      [],
      {},
      { id: "CR-X-1", symbol: "BTCUSDT", side: "long", entry: "abc", stop: 1, tp1: 2, tp3: 3, r: 1 },
      { id: "CR-X-2", symbol: "BTCUSDT", side: "long", entry: 100, stop: 110, tp1: 110, tp3: 130, r: 10 },
      { id: "CR-X-3", symbol: "BTCUSDT", side: "banana", entry: 100, stop: 90, tp1: 110, tp3: 130, r: 10 },
      { id: "CR-X-4", symbol: "BTCUSDT", side: "long", entry: 100, stop: 90, tp1: 111, tp3: 130, r: 10 },
    ]));
    assert.throws(
      () => createOutcomeTracker({ file, fetchCandles: async () => [], logger: quietLogger }),
      /malformed record/,
    );
  });
});

test("a corrupt or non-array ledger fails closed while a missing ledger starts empty", () => {
  return withTracker((file) => {
    fs.writeFileSync(file, "{ this is not json");
    assert.throws(() => loadRecords(file, quietLogger), /not valid JSON/);
    fs.writeFileSync(file, JSON.stringify({ not: "an array" }));
    assert.throws(() => loadRecords(file, quietLogger), /did not contain an array/);
    assert.deepStrictEqual(loadRecords(path.join(path.dirname(file), "missing.json"), quietLogger), []);
  });
});

test("unknown status strings fall back to safe values", () => {
  const clean = sanitizeRecord({
    id: "CR-X-1",
    symbol: "BTCUSDT",
    side: "long",
    entry: 100,
    stop: 90,
    tp1: 110,
    tp3: 130,
    r: 10,
    entryStatus: "weird",
    r1Status: "weird",
    status: "weird",
  });
  assert.strictEqual(clean.entryStatus, "pending");
  assert.strictEqual(clean.r1Status, "open");
  assert.strictEqual(clean.status, "open");
  assert.strictEqual(clean.notified.firstTarget, false);
});

test("the ledger is written atomically", () => {
  return withTracker((file, dir) => {
    const tracker = createOutcomeTracker({ file, fetchCandles: async () => [], logger: quietLogger });
    tracker.track(longSignal());
    assert(fs.existsSync(file), "the ledger exists");
    assert.deepStrictEqual(
      fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")),
      [],
      "no temporary file is left behind",
    );
    assert(Array.isArray(JSON.parse(fs.readFileSync(file, "utf8"))));
  });
});

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
  console.log(`\noutcomes tests passed (${passed} tests)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
