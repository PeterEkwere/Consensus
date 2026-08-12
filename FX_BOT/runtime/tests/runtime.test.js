"use strict";

/**
 * Runtime guarantees: importing starts nothing, storage is private and atomic,
 * configuration fails safely, the offline dry run sends nothing, and the
 * canonical engine is shared by the live scanner and the replay.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { REQUIRED_LIVE_VARS, STRATEGY, SYMBOLS, loadConfig, loadEnv } = require("../config");
const storage = require("../storage");
const { createFixtureProvider } = require("../provider");
const { createScanner } = require("../scanner");
const { buildFixtureDataset } = require("../fixtures/dataset");
const { replaySymbol, runReplay } = require("../backtest");
const { parseArgs } = require("../bot");

const MODULES = [
  "../config", "../storage", "../market", "../provider", "../playbooks",
  "../engine", "../outcomes", "../results", "../telegram", "../scanner",
  "../backtest", "../bot", "../fixtures/dataset",
];

function tmpDir(prefix = "fx-runtime-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Import safety
// ---------------------------------------------------------------------------

test("requiring any module starts no timer, no polling, no network and no write", () => {
  const realFetch = globalThis.fetch;
  const realSetInterval = globalThis.setInterval;
  const realWriteFileSync = fs.writeFileSync;
  const realMkdirSync = fs.mkdirSync;

  const violations = [];
  globalThis.fetch = () => { violations.push("fetch"); throw new Error("network at import"); };
  globalThis.setInterval = () => { violations.push("setInterval"); return { unref() {} }; };
  fs.writeFileSync = () => { violations.push("writeFileSync"); };
  fs.mkdirSync = () => { violations.push("mkdirSync"); };

  try {
    for (const id of MODULES) {
      delete require.cache[require.resolve(id)];
      require(id);
    }
    assert.deepEqual(violations, [], "importing must be inert");
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setInterval = realSetInterval;
    fs.writeFileSync = realWriteFileSync;
    fs.mkdirSync = realMkdirSync;
    for (const id of MODULES) delete require.cache[require.resolve(id)];
  }
});

test("no runtime module opens an HTTP listener", () => {
  const dir = path.join(__dirname, "..");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    for (const token of ["createServer", ".listen(", "require(\"node:http\")", "require(\"http\")"]) {
      assert.ok(!text.includes(token), `${file} must not open a port (found "${token}")`);
    }
  }
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("fixture and dry-run modes need no environment variables at all", () => {
  const config = loadConfig({ env: {} });
  assert.equal(config.researchMode, true, "research mode is the default");
  assert.equal(config.sendResearchAlerts, false, "sending is off by default");
  assert.equal(config.alertMode, "research");
  assert.equal(config.symbolIds.length, 4);
  assert.ok(config.configHash);
});

test("missing live variables fail by name and never reveal a value", () => {
  const env = { FX_TELEGRAM_BOT_TOKEN: "super-secret-token" };
  try {
    loadConfig({ env, requireLive: true });
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err.message.includes("FX_TIINGO_API_TOKEN"), "names what is missing");
    assert.ok(!err.message.includes("super-secret-token"), "never echoes a value");
    for (const name of REQUIRED_LIVE_VARS) {
      if (name !== "FX_TELEGRAM_BOT_TOKEN") assert.ok(err.message.includes(name));
    }
  }
});

test("normal alert mode is blocked until a news provider exists", () => {
  const config = loadConfig({ env: { FX_RESEARCH_MODE: "true" } });
  assert.equal(config.alertMode, "research");
  assert.throws(() => loadConfig({ env: { FX_RESEARCH_MODE: "false" } }), /must remain true/i);
});

test("the configuration is validated, not trusted", () => {
  assert.throws(() => loadConfig({ env: { FX_SYMBOLS: "EUR_USD,DOGE_USD" } }), /unsupported instrument/i);
  assert.equal(loadConfig({ env: {} }).tiingo.baseUrl, "https://api.tiingo.com");
  assert.equal(loadConfig({ env: { FX_SCAN_INTERVAL_SECONDS: "bad" } }).scanIntervalSeconds, 1800);
});

test("the redacted config view carries no credentials", () => {
  const config = loadConfig({
    env: {
      FX_TIINGO_API_TOKEN: "tiingo-secret",
      FX_TELEGRAM_BOT_TOKEN: "telegram-secret",
      FX_TELEGRAM_CHAT_ID: "12345",
    },
  });
  const described = JSON.stringify(config.describe());
  assert.ok(!described.includes("tiingo-secret"));
  assert.ok(!described.includes("telegram-secret"));
  assert.ok(described.includes(config.configHash));
});

test("the dotenv reader accepts only literal key/value pairs", () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, [
      "# a comment",
      "",
      "FX_RESEARCH_MODE=true",
      "FX_SYMBOLS=EUR_USD,GBP_USD",
      "EXPANDED=$HOME/should/not/expand",
      "lowercase=ignored",
      "no_equals_sign",
    ].join("\n"));
    const env = {};
    loadEnv(file, env);
    assert.equal(env.FX_RESEARCH_MODE, "true");
    assert.equal(env.FX_SYMBOLS, "EUR_USD,GBP_USD");
    assert.equal(env.EXPANDED, "$HOME/should/not/expand", "no shell expansion");
    assert.equal(env.lowercase, undefined, "only upper-case keys");
    assert.equal(env.no_equals_sign, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("environment values already set win over the file", () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "FX_SCAN_INTERVAL_SECONDS=60\n");
    const env = { FX_SCAN_INTERVAL_SECONDS: "300" };
    loadEnv(file, env);
    assert.equal(env.FX_SCAN_INTERVAL_SECONDS, "300", "PM2 overrides the file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing .env file is not an error", () => {
  const env = {};
  loadEnv(path.join(tmpDir(), "absent.env"), env);
  assert.deepEqual(env, {});
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test("state files are private and written atomically", () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, "state", "setups.json");
    storage.writeJson(file, { records: [{ id: "a" }] });

    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, "owner-only file");
    const dirMode = fs.statSync(path.dirname(file)).mode & 0o777;
    assert.equal(dirMode, 0o700, "owner-only directory");

    // No temporary file is left behind.
    const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftovers, []);

    const read = storage.readJson(file, null);
    assert.equal(read.records[0].id, "a");
    assert.equal(read.schemaVersion, storage.SCHEMA_VERSION);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed or newer state fails loudly with a path-only message", () => {
  const dir = tmpDir();
  try {
    const bad = path.join(dir, "broken.json");
    fs.writeFileSync(bad, "{ not json");
    assert.throws(() => storage.readJson(bad, null), (err) => {
      assert.equal(err.name, "StateError");
      assert.ok(err.message.includes(bad));
      assert.ok(err.message.includes("Refusing to overwrite"));
      return true;
    });

    const future = path.join(dir, "future.json");
    fs.writeFileSync(future, JSON.stringify({ schemaVersion: 99 }));
    assert.throws(() => storage.readJson(future, null), /newer version/);

    const noVersion = path.join(dir, "unversioned.json");
    fs.writeFileSync(noVersion, JSON.stringify({ records: [] }));
    assert.throws(() => storage.readJson(noVersion, null), /schemaVersion/);

    // A missing file is simply the default.
    assert.deepEqual(storage.readJson(path.join(dir, "absent.json"), { ok: true }), { ok: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the journal appends one JSON record per line", () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, "journal.jsonl");
    storage.appendJsonl(file, { kind: "candidate", playbookId: "P1" });
    storage.appendJsonl(file, { kind: "rejected", reason: "spread_too_wide" });
    const { records, skipped } = storage.readJsonl(file);
    assert.equal(records.length, 2);
    assert.equal(skipped, 0);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    // A corrupt line is skipped, not fatal.
    fs.appendFileSync(file, "{ broken\n");
    assert.equal(storage.readJsonl(file).skipped, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("compaction is available but only drops finished records past retention", () => {
  const old = Date.now() - 200 * 24 * 3600 * 1000;
  const records = [
    { id: "a", status: "complete", finalisedAt: new Date(old).toISOString() },
    { id: "b", status: "complete", finalisedAt: new Date().toISOString() },
    { id: "c", status: "pending_entry", sentAt: new Date(old).toISOString() },
    { id: "d", status: "entered", sentAt: new Date(old).toISOString() },
  ];
  const { kept, removed } = storage.compactCompleted(records, { retentionDays: 90 });
  assert.equal(removed, 1);
  assert.deepEqual(kept.map((r) => r.id), ["b", "c", "d"], "unfinished work is never dropped");
});

// ---------------------------------------------------------------------------
// CLI and dry run
// ---------------------------------------------------------------------------

test("CLI flags parse into the documented modes", () => {
  assert.deepEqual(parseArgs(["node", "bot.js", "--dry-run", "--fixtures"]),
    { dryRun: true, fixtures: true, sendTest: false, once: false });
  assert.deepEqual(parseArgs(["node", "bot.js", "--once"]),
    { dryRun: false, fixtures: false, sendTest: false, once: true });
  assert.deepEqual(parseArgs(["node", "bot.js"]),
    { dryRun: false, fixtures: false, sendTest: false, once: false });
});

test("an offline fixture dry run sends nothing and persists nothing", async () => {
  const dir = tmpDir();
  try {
    const config = loadConfig({ env: { FX_STATE_DIR: path.join(dir, "state") } });
    let sends = 0;
    const scanner = createScanner({
      config,
      provider: createFixtureProvider(buildFixtureDataset()),
      client: { sendMessage: async () => { sends += 1; }, getUpdates: async () => [] },
      now: () => require("../fixtures/dataset").ANCHOR,
    });

    const report = await scanner.scanOnce({ dryRun: true });
    assert.equal(sends, 0, "a dry run never sends");
    assert.equal(scanner.records.length, 0, "a dry run never persists a setup");
    assert.equal(report.symbols.length, 4);

    // The report proves data actually arrived, rather than implying it.
    const eur = report.symbols.find((s) => s.symbol === "EUR_USD");
    assert.equal(eur.dataOk, true);
    assert.ok(eur.counts.M5 > 0 && eur.counts.M15 > 0 && eur.counts.H1 > 0);
    assert.ok(eur.latestComplete, "a concrete latest closed candle time");
    assert.ok(eur.publishable >= 1, "the fixture exercises the full pipeline");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a scan persists the plan before any message is attempted", async () => {
  const dir = tmpDir();
  try {
    const config = loadConfig({
      env: { FX_STATE_DIR: path.join(dir, "state"), FX_SEND_RESEARCH_ALERTS: "true" },
    });
    const order = [];
    const setupsPath = path.join(dir, "state", "setups.json");
    const scanner = createScanner({
      config,
      provider: createFixtureProvider(buildFixtureDataset()),
      client: {
        sendMessage: async () => {
          // By the time a message goes out, the plan is already on disk.
          order.push(fs.existsSync(setupsPath) ? "persisted-then-sent" : "sent-before-persist");
        },
        getUpdates: async () => [],
      },
      now: () => require("../fixtures/dataset").ANCHOR,
    });
    scanner.targets.add("123");
    await scanner.scanOnce();
    assert.ok(scanner.records.length >= 1);
    assert.ok(order.length >= 1, "an alert was attempted");
    assert.ok(order.every((o) => o === "persisted-then-sent"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("re-scanning the same candle publishes nothing new", async () => {
  const dir = tmpDir();
  try {
    const config = loadConfig({ env: { FX_STATE_DIR: path.join(dir, "state") } });
    const scanner = createScanner({
      config,
      provider: createFixtureProvider(buildFixtureDataset()),
      now: () => require("../fixtures/dataset").ANCHOR,
    });
    await scanner.scanOnce();
    const afterFirst = scanner.records.length;
    assert.ok(afterFirst >= 1);
    await scanner.scanOnce();
    assert.equal(scanner.records.length, afterFirst, "scanning is idempotent");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("one scan batches quotes and repeated manual requests stay inside the cadence", async () => {
  const dir = tmpDir();
  try {
    const base = createFixtureProvider(buildFixtureDataset());
    let historyCalls = 0;
    let quoteCalls = 0;
    const provider = {
      name: "counted-fixtures",
      async fetchCandles(...args) {
        historyCalls += 1;
        return base.fetchCandles(...args);
      },
      async fetchQuotes(ids) {
        quoteCalls += 1;
        assert.equal(ids.length, 4);
        return { quotes: {}, error: null };
      },
    };
    const config = loadConfig({ env: { FX_STATE_DIR: path.join(dir, "state") } });
    const scanner = createScanner({
      config,
      provider,
      now: () => require("../fixtures/dataset").ANCHOR,
    });
    await scanner.scanOnce();
    assert.equal(quoteCalls, 1);
    assert.equal(historyCalls, 16, "four timeframes for each of four instruments");
    const skipped = await scanner.scanOnce({ manual: true });
    assert.equal(skipped.skipped, "provider_budget_cadence");
    assert.equal(quoteCalls, 1, "a manual command cannot add a second provider pass");
    assert.equal(historyCalls, 16);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Replay shares the canonical engine
// ---------------------------------------------------------------------------

test("the replay reports per playbook and never blends a single win rate", () => {
  const dataset = buildFixtureDataset();
  const report = runReplay({
    dataset,
    strategy: STRATEGY,
    configHash: "hash",
    symbols: [SYMBOLS.EUR_USD],
    source: "fixtures",
  });
  assert.equal(report.configHash, "hash");
  assert.ok(report.disclaimer.includes("No edge is claimed"));
  assert.ok(report.overall.firstLeg);
  assert.ok(report.overall.finalLeg);
  assert.ok(report.symbols.EUR_USD, "per-symbol cohort present");
  assert.notEqual(report.strategyHash, report.configHash, "strategy and cohort provenance stay distinct");
  assert.ok(report.universeHash);
  assert.equal(report.scanIntervalSeconds, 1800);
  // There is no single blended figure anywhere in the report.
  assert.equal(report.overall.winRate, undefined);

  // The live cross-symbol cap is also applied to replay output. Reusing the
  // deterministic EUR shape on a correlated EUR cross gives two proposals but
  // only one publishable independent event.
  const correlated = runReplay({
    dataset: { EUR_USD: dataset.EUR_USD, EUR_CAD: dataset.EUR_USD },
    strategy: STRATEGY,
    configHash: "hash",
    symbols: [SYMBOLS.EUR_USD, SYMBOLS.EUR_CAD],
  });
  const kept = correlated.symbols.EUR_USD.plans + correlated.symbols.EUR_CAD.plans;
  const withheld = correlated.symbols.EUR_USD.withheldByExposure
    + correlated.symbols.EUR_CAD.withheldByExposure;
  assert.ok(kept > 0, "the replay exercised correlated proposals");
  assert.equal(withheld, kept, "one of the two correlated proposals is withheld in every event");
});

test("a replayed plan cannot resolve on its own trigger candle", () => {
  const dataset = buildFixtureDataset();
  const replay = replaySymbol({
    candles: dataset.EUR_USD,
    strategy: STRATEGY,
    configHash: "hash",
    symbol: SYMBOLS.EUR_USD,
  });
  assert.ok(replay.records.length > 0, "the guard must exercise at least one real record");
  for (const record of replay.records) {
    assert.ok(record.watchFromMs >= record.triggerCandleTime + require("../market").TIMEFRAME_MS.M5);
  }
});
