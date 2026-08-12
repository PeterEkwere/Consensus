"use strict";

/** Reader-facing text, commands, targets and the Bot API client. */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { STRATEGY, SYMBOLS } = require("../config");
const { createRecord, estimateCosts } = require("../outcomes");
const { summarise } = require("../results");
const storage = require("../storage");
const {
  HELP_TEXT,
  TelegramConflictError,
  alertButtons,
  createTargets,
  createTelegramClient,
  esc,
  formatEntryAlert,
  formatOutcome,
  formatResults,
  handleCommand,
  parseCommand,
} = require("../telegram");

const EUR = SYMBOLS.EUR_USD;
const ALERT = Date.UTC(2026, 0, 7, 12, 0, 0);

/**
 * Abbreviations a reader is not assumed to understand. Checked as whole words
 * so ordinary prose ("results", "slippage") does not trip them.
 */
const FORBIDDEN = ["LONG", "SHORT", "SL", "TP", "TP1", "TP3", "RR", "1R", "3R", "BOS", "CHoCH", "HTF", "LTF"];

function assertPlainLanguage(text, label) {
  const visible = text.replace(/<[^>]+>/g, " ");
  for (const term of FORBIDDEN) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9])${term}([^A-Za-z0-9]|$)`);
    assert.ok(!pattern.test(visible), `${label} must not use the bare abbreviation "${term}"`);
  }
}

function assertNoPersonalClaim(text, label) {
  for (const claim of ["you won", "you lost", "your profit", "your loss", "you made", "you earned", "profit of"]) {
    assert.ok(!text.toLowerCase().includes(claim), `${label} must not claim "${claim}"`);
  }
}

function record(overrides = {}) {
  const plan = {
    side: "buy", entry: 1.1000, stop: 1.0980,
    firstTarget: 1.1020, finalTarget: 1.1060, r: 0.002, stopPips: 20,
  };
  const base = createRecord({
    candidate: {
      symbol: "EUR_USD",
      playbookId: "P1",
      playbookName: "Liquidity Sweep Reversal",
      signalTime: ALERT,
      triggerCandleTime: ALERT,
      setupStartedAt: ALERT,
      confirmations: [
        { family: "liquidity", text: "Price dipped below a level that had held before" },
        { family: "candle", text: "The next completed 5-minute candle closed back up" },
        { family: "location", text: "The reversal happened at a level confirmed on a higher timeframe" },
        { family: "structure", text: "A fourth reason that should not be shown" },
      ],
      sourceLevel: { price: 1.0990 },
      invalidation: 1.0985,
    },
    plan,
    id: "FXS-EURUSD-20260107-001",
    dedupeKey: "k",
    sentAt: ALERT,
    costs: estimateCosts({ observedSpread: 0.00008, r: plan.r, strategy: STRATEGY, symbol: EUR }),
    configHash: "hash",
    provider: "fixtures",
  });
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Entry alert
// ---------------------------------------------------------------------------

test("the entry alert carries every level and the alert id in copyable tags", () => {
  const text = formatEntryAlert({ record: record(), symbol: EUR });
  assert.ok(text.includes("Entry Price: <code>1.10000</code>"));
  assert.ok(text.includes("Stop Loss: <code>1.09800</code>"));
  assert.ok(text.includes("First Profit Target (risked amount equals possible gain): <code>1.10200</code>"));
  assert.ok(text.includes("Final Profit Target (possible gain is three times the risked amount): <code>1.10600</code>"));
  assert.ok(text.includes("Alert ID: <code>FXS-EURUSD-20260107-001</code>"));
});

test("prices are shown at the instrument's own precision", () => {
  const jpy = record({ entry: 150.123, stop: 149.988, firstTarget: 150.258, finalTarget: 150.528 });
  const text = formatEntryAlert({ record: jpy, symbol: SYMBOLS.USD_JPY });
  assert.ok(text.includes("<code>150.123</code>"), "three decimals for yen");
  assert.ok(!text.includes("150.12300"));
});

test("buy and sell each state plainly what is expected", () => {
  const buy = formatEntryAlert({ record: record(), symbol: EUR });
  assert.ok(buy.includes("🟢"));
  assert.ok(buy.includes("BUY"));
  assert.ok(buy.includes("Price is expected to rise"));

  const sell = formatEntryAlert({ record: record({ side: "sell" }), symbol: EUR });
  assert.ok(sell.includes("🔴"));
  assert.ok(sell.includes("SELL"));
  assert.ok(sell.includes("Price is expected to fall"));
});

test("the research label cannot be suppressed in research mode", () => {
  const text = formatEntryAlert({ record: record(), symbol: EUR, researchMode: true });
  assert.ok(text.includes("RESEARCH SETUP — performance is still being measured"));
  // Nothing in the alert may claim the setup is verified or profitable.
  for (const word of ["verified", "high-probability", "high probability", "profitable", "guaranteed", "safe"]) {
    assert.ok(!text.toLowerCase().includes(word), `must not claim "${word}"`);
  }
});

test("the alert says news protection is unavailable rather than implying it passed", () => {
  const text = formatEntryAlert({ record: record(), symbol: EUR, newsStatus: "unknown" });
  assert.ok(text.includes("economic news protection is unavailable"));
  assert.ok(!text.toLowerCase().includes("news checked"));
});

test("only the top three reasons are shown", () => {
  const text = formatEntryAlert({ record: record(), symbol: EUR });
  const bullets = text.split("\n").filter((line) => line.startsWith("•"));
  assert.equal(bullets.length, 3);
  assert.ok(!text.includes("A fourth reason that should not be shown"));
});

test("the alert states it neither trades nor reads an account", () => {
  const text = formatEntryAlert({ record: record(), symbol: EUR });
  assert.ok(text.includes("does not place a trade or read your account"));
  assert.ok(text.includes("your broker's prices and fills can differ"));
});

test("the entry alert uses no unexplained abbreviations", () => {
  assertPlainLanguage(formatEntryAlert({ record: record(), symbol: EUR }), "the entry alert");
  assertPlainLanguage(formatEntryAlert({ record: record({ side: "sell" }), symbol: EUR }), "the sell alert");
});

test("interpolated text is HTML-escaped", () => {
  assert.equal(esc('<b>&"'), "&lt;b&gt;&amp;&quot;");
  const hostile = record();
  hostile.diagnostics.confirmations = [{ family: "candle", text: "<script>alert(1)</script>" }];
  const text = formatEntryAlert({ record: hostile, symbol: EUR });
  assert.ok(!text.includes("<script>"), "raw markup never survives");
  assert.ok(text.includes("&lt;script&gt;"));
});

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

test("there is exactly one button and it opens TradingView", () => {
  const markup = alertButtons(EUR);
  assert.equal(markup.inline_keyboard.length, 1);
  assert.equal(markup.inline_keyboard[0].length, 1);
  const button = markup.inline_keyboard[0][0];
  assert.equal(button.text, "Open TradingView");
  assert.ok(button.url.includes("OANDA%3AEURUSD"), "explicit symbol map");
  assert.equal(button.web_app, undefined, "no Mini App");
  assert.equal(button.callback_data, undefined);
});

// ---------------------------------------------------------------------------
// Outcome messages
// ---------------------------------------------------------------------------

test("each outcome heading matches its leg combination", () => {
  const first = formatOutcome({ event: { type: "first_target" }, record: record({ firstLeg: "win" }), symbol: EUR });
  assert.ok(first.includes("✅ <b>FIRST PROFIT TARGET REACHED</b>"));
  assert.ok(first.includes("still being monitored"));

  const won = formatOutcome({ event: { type: "final" }, record: record({ firstLeg: "win", finalLeg: "win" }), symbol: EUR });
  assert.ok(won.includes("🏆 <b>FINAL PROFIT TARGET REACHED</b>"));

  const lost = formatOutcome({ event: { type: "final" }, record: record({ firstLeg: "loss", finalLeg: "loss" }), symbol: EUR });
  assert.ok(lost.includes("❌ <b>STOP LOSS REACHED</b>"));

  const mixed = formatOutcome({ event: { type: "final" }, record: record({ firstLeg: "win", finalLeg: "loss" }), symbol: EUR });
  assert.ok(mixed.includes("⚠️ <b>SETUP MONITORING COMPLETE</b>"));
  assert.ok(mixed.includes("First profit target result: <b>TARGET REACHED</b>"));
  assert.ok(mixed.includes("Final profit target result: <b>STOP LOSS REACHED</b>"));
});

test("every outcome references the alert id and states both legs", () => {
  for (const legs of [["win", "win"], ["loss", "loss"], ["win", "loss"], ["void", "void"]]) {
    const text = formatOutcome({
      event: { type: "final" },
      record: record({ firstLeg: legs[0], finalLeg: legs[1] }),
      symbol: EUR,
    });
    assert.ok(text.includes("FXS-EURUSD-20260107-001"));
    assert.ok(text.includes("First profit target result:"));
    assert.ok(text.includes("Final profit target result:"));
    assertPlainLanguage(text, "an outcome message");
    assertNoPersonalClaim(text, "an outcome message");
  }
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

test("results report both legs separately and never blend them", () => {
  const summary = summarise([
    { ...record({ status: "complete", firstLeg: "win", finalLeg: "loss" }), id: "a" },
    { ...record({ status: "complete", firstLeg: "loss", finalLeg: "loss" }), id: "b" },
    { ...record({ status: "pending_entry" }), id: "c" },
  ], { configHash: "hash", alertMode: "research" });

  const text = formatResults(summary);
  assert.ok(text.includes("First Profit Target (risked amount equals possible gain)"));
  assert.ok(text.includes("Final Profit Target (possible gain is three times the risked amount)"));
  assert.ok(text.includes("Total setups published: <b>3</b>"));
  assert.ok(text.includes("Waiting for entry price: <b>1</b>"));
  assert.ok(text.includes("Completed setups: <b>2</b>"));
  assert.ok(text.includes("A t-statistic above 2 is stronger evidence"));
  assert.ok(text.includes("not a record of anyone's trading account"));
  assert.ok(text.includes("By setup type"), "per-playbook cohorts are shown");
  assertPlainLanguage(text, "the results message");
  assertNoPersonalClaim(text, "the results message");
});

test("results show the research label and the settings fingerprint", () => {
  const text = formatResults(summarise([], { configHash: "abc123", alertMode: "research" }));
  assert.ok(text.includes("Research (measuring only)"));
  assert.ok(text.includes("abc123"));
});

// ---------------------------------------------------------------------------
// Help and commands
// ---------------------------------------------------------------------------

test("help is the exact short guide", () => {
  assert.equal(HELP_TEXT, [
    "Consensus FX Sentinel",
    "",
    "/status — check the bot and latest market data",
    "/scan — run one scan now",
    "/results — view tracked setup results",
    "/activate — send future alerts to this chat",
    "/deactivate — stop alerts to this chat",
    "/id — show this chat's ID",
    "/help — show this guide",
  ].join("\n"));
  assertPlainLanguage(HELP_TEXT, "the help text");
});

test("commands parse with and without a bot suffix", () => {
  assert.deepEqual(parseCommand("/status"), { name: "status", args: "" });
  assert.deepEqual(parseCommand("/scan@MyBot"), { name: "scan", args: "" });
  assert.deepEqual(parseCommand("/activate  extra"), { name: "activate", args: "extra" });
  assert.equal(parseCommand("hello"), null);
  assert.equal(parseCommand(null), null);
});

function targetsFor(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-targets-"));
  const store = storage.createStore(path.join(dir, "targets.json"), { chatIds: [], seeded: false });
  return { targets: createTargets(store, seed), dir, store };
}

test("owner-only commands are refused for everyone else", () => {
  const { targets, dir } = targetsFor("");
  try {
    for (const name of ["scan", "activate", "deactivate"]) {
      const reply = handleCommand({
        update: { message: { chat: { id: 5 }, from: { id: 999 }, text: `/${name}` } },
        targets,
        ownerUserId: "111",
      });
      assert.equal(reply.text, "This command is not available.");
      // Never leak configuration or the target list to a stranger.
      assert.ok(!reply.text.includes("111"));
    }
    assert.deepEqual(targets.list(), [], "a refused command changes nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("help and id answer anyone without storing the chat", () => {
  const { targets, dir } = targetsFor("");
  try {
    const help = handleCommand({
      update: { message: { chat: { id: 7 }, from: { id: 999 }, text: "/help" } },
      targets,
      ownerUserId: "111",
    });
    assert.equal(help.text, HELP_TEXT);
    const id = handleCommand({
      update: { message: { chat: { id: 7 }, from: { id: 999 }, text: "/id" } },
      targets,
      ownerUserId: "111",
    });
    assert.ok(id.text.includes("7"));
    assert.deepEqual(targets.list(), [], "asking for the id does not activate the chat");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the private target is seeded once and group activation needs no source edit", () => {
  const { targets, dir } = targetsFor("555");
  try {
    assert.deepEqual(targets.list(), ["555"], "seeded from configuration");

    // The owner adds the bot to a group and runs /activate there.
    const reply = handleCommand({
      update: { message: { chat: { id: -100200 }, from: { id: 111 }, text: "/activate" } },
      targets,
      ownerUserId: "111",
    });
    assert.ok(reply.text.includes("switched on"));
    assert.deepEqual(targets.list(), ["555", "-100200"], "the private chat is kept");
    // IDs are strings, so large group ids survive a JSON round-trip.
    for (const id of targets.list()) assert.equal(typeof id, "string");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deactivate removes only the current chat", () => {
  const { targets, dir } = targetsFor("555");
  try {
    targets.add("-100200");
    handleCommand({
      update: { message: { chat: { id: -100200 }, from: { id: 111 }, text: "/deactivate" } },
      targets,
      ownerUserId: "111",
    });
    assert.deepEqual(targets.list(), ["555"], "the other target is untouched");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a removed seed target does not come back on reload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-targets-"));
  try {
    const file = path.join(dir, "targets.json");
    const first = createTargets(storage.createStore(file, { chatIds: [], seeded: false }), "555");
    first.remove("555");
    // A fresh store reading the same file must not re-seed.
    const second = createTargets(storage.createStore(file, { chatIds: [], seeded: false }), "555");
    assert.deepEqual(second.list(), [], "seeding happens on first start only");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

test("a polling conflict is fatal rather than retried", async () => {
  const client = createTelegramClient({
    token: "secret-token-value",
    fetchImpl: async () => ({ status: 409, ok: false, json: async () => ({}) }),
  });
  await assert.rejects(() => client.getUpdates(0), (err) => {
    assert.ok(err instanceof TelegramConflictError);
    assert.equal(err.fatal, true);
    assert.ok(!err.message.includes("secret-token-value"), "the token is never in the error");
    return true;
  });
});

test("API errors never include the request URL or the token", async () => {
  const client = createTelegramClient({
    token: "secret-token-value",
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: "chat not found" }),
    }),
  });
  await assert.rejects(() => client.sendMessage("1", "hi"), (err) => {
    assert.ok(err.message.includes("chat not found"));
    assert.ok(!err.message.includes("secret-token-value"));
    assert.ok(!err.message.includes("api.telegram.org"));
    return true;
  });
});

test("messages are sent as HTML with previews disabled", async () => {
  let body = null;
  const client = createTelegramClient({
    token: "t",
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    },
  });
  await client.sendMessage("42", "hello");
  assert.equal(body.chat_id, "42");
  assert.equal(body.parse_mode, "HTML");
  assert.equal(body.disable_web_page_preview, true);
});
