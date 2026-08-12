"use strict";

/**
 * Tests for what the reader actually sees: the alert, the outcome messages and
 * the results summary. Requiring bot.js starts nothing, so these run offline
 * with no token and no polling.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  activeCohortId,
  analyzePair,
  broadcastSignal,
  formatOutcome,
  formatSignal,
  helpText,
  parseTelegramCommand,
  resultsText,
  sampleSignal,
  scheduledScanDue,
  selectPublishableCandidates,
  signalButtons,
  topConfirmations,
} = require("./bot");
const { buildTradePlan, createOutcomeTracker } = require("./outcomes");

const queue = [];
function test(name, fn) {
  queue.push({ name, fn });
}
function section(name) {
  queue.push({ section: name });
}

// Abbreviations that must never reach a reader. Checked as whole words so that
// ordinary prose ("results", "slippage") does not trip them.
const BANNED_TERMS = ["LONG", "SHORT", "SL", "TP1", "TP3", "RR", "1R", "3R", "R:R"];

function assertPlainLanguage(text, label) {
  const visible = text.replace(/<[^>]+>/g, " ");
  for (const term of BANNED_TERMS) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`);
    assert(!pattern.test(visible), `${label} must not use the bare abbreviation "${term}"`);
  }
}

function record(overrides = {}) {
  return {
    id: "CR-BTC-20260808-001",
    name: "BTC / USDT",
    symbol: "BTCUSDT",
    market: "futures",
    side: "long",
    entry: 64250,
    stop: 63680,
    tp1: 64820,
    tp3: 65960,
    r: 570,
    r1Status: "tp",
    r3Status: "open",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Entry alert
// ---------------------------------------------------------------------------

section("entry alert");

test("scheduled command parsing accepts group suffixes without treating prose as commands", () => {
  assert.deepStrictEqual(parseTelegramCommand("/help@ConsensusBot"), { name: "help", argument: "" });
  assert.deepStrictEqual(parseTelegramCommand(" /scan now "), { name: "scan", argument: "now" });
  assert.strictEqual(parseTelegramCommand("please /scan"), null);
});

test("scheduled scan cadence is slot based and resists clock rollback", () => {
  const fiveMinutes = 5 * 60 * 1000;
  const slot = 100 * fiveMinutes;
  assert.strictEqual(scheduledScanDue({ scanIntervalMinutes: 5, lastScheduledScanAt: 0 }, slot), true);
  assert.strictEqual(scheduledScanDue({ scanIntervalMinutes: 5, lastScheduledScanAt: slot + 1000 }, slot + 2000), false);
  assert.strictEqual(scheduledScanDue({ scanIntervalMinutes: 5, lastScheduledScanAt: slot + 1000 }, slot + fiveMinutes), true);
  assert.strictEqual(scheduledScanDue({ scanIntervalMinutes: 5, lastScheduledScanAt: slot + 1000 }, slot), false);
});

test("the alert carries entry, stop, both targets and the alert id", () => {
  const signal = sampleSignal();
  const text = formatSignal(signal, "CR-BTC-20260808-001");
  const plan = buildTradePlan(signal);

  assert(text.includes("Entry Price: <code>64250.00</code>"), "exact entry is copy-ready");
  assert(text.includes("Stop Loss: <code>63680.00</code>"), "stop is copy-ready");
  assert(text.includes(`First Profit Target (1:1): <code>64820.00</code>`), "first target is copy-ready");
  assert(text.includes(`Final Profit Target (3:1): <code>65960.00</code>`), "final target is copy-ready");
  assert(text.includes("Alert ID: <code>CR-BTC-20260808-001</code>"), "id is copy-ready");
  assert.strictEqual(plan.tp1, 64820);
  assert.strictEqual(plan.tp3, 65960);
});

test("a buy setup says buy, a sell setup says sell", () => {
  const buy = formatSignal(sampleSignal(), "CR-BTC-20260808-001");
  assert(buy.includes("🟢"), "buy setups are green");
  assert(buy.includes("BUY"), "the action is spelled out");
  assert(buy.includes("Price is expected to rise"));

  const sell = formatSignal(
    { ...sampleSignal(), side: "short", price: 64250, stop: 64820 },
    "CR-BTC-20260808-002",
  );
  assert(sell.includes("🔴"), "sell setups are red");
  assert(sell.includes("SELL"));
  assert(sell.includes("Price is expected to fall"));
  assert(sell.includes("First Profit Target (1:1): <code>63680.00</code>"), "sell targets sit below entry");
  assert(sell.includes("Final Profit Target (3:1): <code>62540.00</code>"));
});

test("the alert names the exchange, market and timeframe unambiguously", () => {
  const text = formatSignal(sampleSignal(), "CR-BTC-20260808-001");
  assert(text.includes("BTC / USDT"), "the symbol is present");
  assert(text.includes("OKX Futures"), "exchange and market type are explicit");
  assert(text.includes("Chart timeframe: <b>15 minutes</b>"), "timeframe is spelled out");
});

test("the alert uses no unexplained trading abbreviations", () => {
  assertPlainLanguage(formatSignal(sampleSignal(), "CR-BTC-20260808-001"), "the entry alert");
  assertPlainLanguage(
    formatSignal({ ...sampleSignal(), side: "short", price: 64250, stop: 64820 }, "CR-X-1"),
    "the sell alert",
  );
});

test("the alert explains what the ratios mean and what is tracked", () => {
  const text = formatSignal(sampleSignal(), "CR-BTC-20260808-001");
  assert(text.includes("1:1 means the target distance equals the amount risked."));
  assert(text.includes("3:1 means the target distance is three times the amount risked."));
  assert(text.includes("does not read your trading account"));
});

test("the verbose market context and consensus blocks are gone", () => {
  const text = formatSignal(sampleSignal(), "CR-BTC-20260808-001");
  for (const heading of ["Market Context", "Timeframe Consensus", "Setup Quality", "Confluence", "Trade Map", "24h volume", "RSI"]) {
    assert(!text.includes(heading), `"${heading}" must not appear in the alert`);
  }
});

test("only the three strongest reasons are shown", () => {
  const signal = sampleSignal();
  const reasons = topConfirmations(signal, 3);
  assert.strictEqual(reasons.length, 3);
  // Ranked by score weight, not by insertion order.
  assert.strictEqual(reasons[0], "Break and retest above prior resistance");
  assert(!formatSignal(signal, "CR-X-1").includes("5m momentum aligned"), "the fourth reason is dropped");
});

test("an inconsistent setup is never published as a tradeable alert", () => {
  const broken = formatSignal({ ...sampleSignal(), stop: 64250 }, "CR-X-1");
  assert(broken.includes("rejected"), "zero-risk setups are refused");
  assert(!broken.includes("Entry Price:"));
});

// ---------------------------------------------------------------------------
// Signal pipeline
// ---------------------------------------------------------------------------

section("signal pipeline");

/** Synthetic trending candles, so this runs without touching OKX. */
function series(count, start, step, noise) {
  const out = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    price += step + Math.sin(i / 3) * noise;
    const open = price - step / 2;
    const close = price;
    out.push({
      time: Date.now() - (count - i) * 900000,
      open,
      close,
      high: Math.max(open, close) + noise,
      low: Math.min(open, close) - noise,
      volume: 200000,
    });
  }
  return out;
}

test("a generated signal carries levels consistent with its own risk", () => {
  const pair = { api: "BTCUSDT", market: "futures", tv: "OKX:BTCUSDT.P", label: "BTC / USDT" };
  const signal = analyzePair(pair, {
    "15m": series(200, 60000, 30, 40),
    "5m": series(120, 60000, 30, 40),
    "1h": series(120, 60000, 30, 40),
  });
  assert(signal, "a clean uptrend produces a signal");
  assert.strictEqual(signal.side, "long");
  assert.strictEqual(signal.tp1, signal.entry + signal.r, "first target is one unit of risk away");
  assert.strictEqual(signal.tp3, signal.entry + signal.r * 3, "final target is three units of risk away");
  assert.strictEqual(signal.target, signal.tp3, "the legacy 3:1 target stays consistent");
  assert(signal.stop < signal.entry, "a buy risks the downside");

  // The published alert must show the same numbers the tracker will monitor.
  const plan = buildTradePlan(signal);
  assert(plan);
  assert.strictEqual(plan.entry, signal.entry);
  assert.strictEqual(plan.tp1, signal.tp1);
  assert.strictEqual(plan.tp3, signal.tp3);
});

test("scan selection shadows gate failures and publishes only the best measured cluster member", async () => {
  const base = {
    ...sampleSignal(),
    familyCount: 4,
    clusterId: "same-event",
    thesisKey: "thesis-a",
    score: 80,
    costR: 0.2,
  };
  const lowerCost = {
    ...base,
    symbol: "ETHUSDT",
    name: "ETH / USDT",
    thesisKey: "thesis-b",
    costR: 0.1,
  };
  const tooFewFamilies = {
    ...base,
    symbol: "SOLUSDT",
    name: "SOL / USDT",
    clusterId: "other-event",
    thesisKey: "thesis-c",
    familyCount: 2,
  };
  const selection = await selectPublishableCandidates(
    [base, lowerCost, tooFewFamilies],
    { benchmarkDirection: "mixed", benchmarkTrendH1: "mixed", breadthDirection: "mixed" },
    {
      threshold: 0,
      isCoolingDown: () => false,
      hasOpenThesis: () => false,
      prepareSignalExecution: async (signal) => ({
        ok: true,
        plan: buildTradePlan(signal),
        snapshot: { known: true, costR: signal.costR },
      }),
    },
  );

  assert.strictEqual(selection.accepted.length, 2);
  assert.strictEqual(selection.fresh.length, 1);
  assert.strictEqual(selection.fresh[0].signal.symbol, "ETHUSDT", "measured lower cost wins the tie");
  assert(selection.withheld.some((row) => row.signal.symbol === "SOLUSDT"
    && row.reason === "insufficient_families"));
  assert(selection.withheld.some((row) => row.signal.symbol === "BTCUSDT"
    && row.reason === "correlated_lower_rank"));
});

test("broadcast persists a trackable setup before sending and uses an injected live quote", async () => {
  const order = [];
  const sent = [];
  const signal = { ...sampleSignal() };
  const tracked = { id: "CR-BTC-20260808-999" };

  const result = await broadcastSignal(signal, {
    threshold: 0,
    checkExecution: async (_signal, plan) => {
      order.push("quote");
      assert(plan && plan.r > 0);
      return {
        ok: true,
        snapshot: {
          known: true,
          quoteTs: Date.now(),
          costR: 0.1,
          driftFractionOfR: 0.01,
        },
      };
    },
    outcomes: {
      track() {
        order.push("persist");
        return tracked;
      },
    },
    appendAlert() {
      order.push("journal");
    },
    chatIds: ["group-1"],
    async sendSignalAlert(chatId, _signal, text) {
      order.push("send");
      sent.push({ chatId, text });
    },
  });

  assert.strictEqual(result, tracked);
  assert.deepStrictEqual(order, ["quote", "persist", "journal", "send"]);
  assert.strictEqual(sent.length, 1);
  assert(sent[0].text.includes("CR-BTC-20260808-999"));
  assert(Number.isFinite(signal.execution.costR), "the observed cost is stamped before persistence");
});

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

section("buttons");

test("there is exactly one button and it opens TradingView", () => {
  const markup = signalButtons(sampleSignal());
  assert.strictEqual(markup.inline_keyboard.length, 1, "one row");
  assert.strictEqual(markup.inline_keyboard[0].length, 1, "one button");
  const button = markup.inline_keyboard[0][0];
  assert.strictEqual(button.text, "Open TradingView");
  assert(button.url.startsWith("https://www.tradingview.com/"), "the button opens a chart");
  assert.strictEqual(button.web_app, undefined, "no Mini App");
  assert.strictEqual(button.callback_data, undefined, "no copy button");
});

// ---------------------------------------------------------------------------
// Outcome notifications
// ---------------------------------------------------------------------------

section("outcome notifications");

test("the first target message keeps the final target open", () => {
  const text = formatOutcome({ type: "first_target" }, record());
  assert(text.includes("FIRST PROFIT TARGET REACHED"));
  assert(text.includes("1:1 setup result: <b>TARGET REACHED</b>"));
  assert(text.includes("The final 3:1 target is still being monitored."));
  assert(text.includes("Alert ID: <code>CR-BTC-20260808-001</code>"));
  assertPlainLanguage(text, "the first target message");
});

test("the final target message reports both legs as reached", () => {
  const text = formatOutcome({ type: "final" }, record({ r1Status: "tp", r3Status: "tp" }));
  assert(text.includes("🏆"));
  assert(text.includes("FINAL PROFIT TARGET REACHED"));
  assert(text.includes("1:1 setup result: <b>TARGET REACHED</b>"));
  assert(text.includes("3:1 setup result: <b>TARGET REACHED</b>"));
  assertPlainLanguage(text, "the final target message");
});

test("the stop message reports both legs as stopped", () => {
  const text = formatOutcome({ type: "final" }, record({ r1Status: "sl", r3Status: "sl" }));
  assert(text.includes("❌"));
  assert(text.includes("STOP LOSS REACHED"));
  assert(text.includes("1:1 setup result: <b>STOP LOSS REACHED</b>"));
  assert(text.includes("3:1 setup result: <b>STOP LOSS REACHED</b>"));
  assertPlainLanguage(text, "the stop message");
});

test("a first target followed by a stop reports one of each", () => {
  const text = formatOutcome({ type: "final" }, record({ r1Status: "tp", r3Status: "sl" }));
  assert(text.includes("SETUP MONITORING COMPLETE"));
  assert(text.includes("1:1 setup result: <b>TARGET REACHED</b>"));
  assert(text.includes("3:1 setup result: <b>STOP LOSS REACHED</b>"));
  assertPlainLanguage(text, "the mixed result message");
});

test("no outcome message claims the reader made or lost money", () => {
  const cases = [
    formatOutcome({ type: "first_target" }, record()),
    formatOutcome({ type: "final" }, record({ r1Status: "tp", r3Status: "tp" })),
    formatOutcome({ type: "final" }, record({ r1Status: "sl", r3Status: "sl" })),
  ];
  for (const text of cases) {
    for (const claim of ["you made", "you lost", "your profit", "your loss", "you earned", "profit of"]) {
      assert(!text.toLowerCase().includes(claim), `outcome messages must not claim "${claim}"`);
    }
  }
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

section("results");

const ALERT_MS = Date.parse("2026-08-08T12:00:00.000Z");

async function withTracker(fn, candles = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consensus-bot-"));
  try {
    return await fn(createOutcomeTracker({
      file: path.join(dir, "outcomes.json"),
      logger: { error() {} },
      fetchCandles: async () => candles,
    }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Published alerts always carry the cohort that produced them, so a fixture
// must too; `/results` is scoped to the active configuration by design.
function trialSignal(symbol, overrides = {}) {
  return {
    exchange: "OKX",
    market: "futures",
    symbol,
    name: `${symbol.replace("USDT", "")} / USDT`,
    side: "long",
    price: 100,
    stop: 90,
    time: "2026-08-08T11:59:00.000Z",
    confirmations: ["Bullish market structure"],
    cohortId: activeCohortId(),
    clusterId: `cluster-${symbol}`,
    score: 80,
    scoreBin: "80-89",
    ...overrides,
  };
}

test("results use plain labels and explain the t-statistic", async () => {
  // One setup that runs to the final target, so every statistic renders.
  const winner = [{ time: ALERT_MS + 60000, low: 99, high: 131, open: 99, close: 131 }];
  await withTracker(async (tracker) => {
    tracker.track(trialSignal("BTCUSDT"), new Date(ALERT_MS).toISOString());
    tracker.track(trialSignal("ETHUSDT"), new Date(ALERT_MS).toISOString());
    await tracker.poll(ALERT_MS + 120000);
    assert.strictEqual(tracker.summary().completed, 2, "both setups completed");

    const text = resultsText(tracker);
    for (const label of [
      "Total alerts published",
      "Awaiting Entry Price",
      "Entered and still being monitored",
      "Cancelled before entry",
      "Expired before entry",
      "Expired after entry",
      "Completed setups",
      "First Profit Target (1:1)",
      "Final Profit Target (3:1)",
      "Average result after estimated trading costs",
      "Statistical confidence (t-statistic)",
      "Independent market events",
      "Settings fingerprint",
      "Verdict",
    ]) {
      assert(text.includes(label), `results must report "${label}"`);
    }
    assert(text.includes("A t-statistic above 2 is stronger evidence that a result may not be random."));
    assert(text.includes("Estimated trading costs assumed"), "cost assumptions are disclosed");
    assertPlainLanguage(text, "the results summary");
  }, winner);
});

test("an empty trial says so rather than reporting a 0% success rate", async () => {
  await withTracker((tracker) => {
    const summary = tracker.summary();
    assert.strictEqual(summary.total, 0);
    assert.strictEqual(summary.completed, 0);
    assert.strictEqual(summary.stillMonitoring, 0);
    assert(resultsText(tracker).includes("No completed setups yet."));
  });
});

test("results report expectancy net of costs, not gross", async () => {
  const winner = [{ time: ALERT_MS + 60000, low: 99, high: 131, open: 99, close: 131 }];
  await withTracker(async (tracker) => {
    tracker.track(trialSignal("BTCUSDT"), new Date(ALERT_MS).toISOString());
    await tracker.poll(ALERT_MS + 120000);
    const summary = tracker.summary();
    assert.strictEqual(summary.oneR.grossExpectancyR, 1);
    assert(summary.oneR.netExpectancyR < summary.oneR.grossExpectancyR, "costs are deducted");
    assert(resultsText(tracker).includes("+0.980"), "the net figure is the one shown");
  }, winner);
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

section("help");

test("help explains buy, sell, the stop and both targets", () => {
  const text = helpText();
  assert(text.includes("Receive alerts in a group"));
  assert(text.includes("send /activate in the group"));
  assert(text.includes("BUY means the setup expects price to rise."));
  assert(text.includes("SELL means the setup expects price to fall."));
  assert(text.includes("The Entry Price is the planned starting price."));
  assert(text.includes("The Stop Loss is where the setup becomes invalid."));
  assert(text.includes("The 1:1 target offers a potential reward equal to the planned risk."));
  assert(text.includes("The 3:1 target offers a potential reward three times the planned risk."));
  assert(text.includes("not your personal trading account"));
  assert(text.includes("/results"), "the results command is documented");
  assert(!text.includes("/addpair"), "advanced pair editing stays out of the simple help text");
  assert(!text.includes("/threshold"), "advanced threshold editing stays out of the simple help text");
});

// ---------------------------------------------------------------------------
// Removed viewer must stay removed
// ---------------------------------------------------------------------------

section("no viewer residue");

test("no source file references the removed setup viewer", () => {
  const tokens = [
    "setup-viewer",
    "SETUP_VIEWER",
    "setupUrl",
    "createSetupViewer",
    "View complete setup",
    "setups.json",
    "consensus-setup-viewer",
  ];
  const files = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith(".js") || f.endsWith(".json") || f.endsWith(".md"))
    .filter((f) => f !== "package-lock.json" && f !== path.basename(__filename));
  for (const file of files) {
    const text = fs.readFileSync(path.join(__dirname, file), "utf8");
    for (const token of tokens) {
      assert(!text.includes(token), `${file} still references "${token}"`);
    }
  }
  assert(!fs.existsSync(path.join(__dirname, "setup-viewer.js")));
  assert(!fs.existsSync(path.join(__dirname, "deploy", "consensus-setup-viewer.nginx.conf.example")));
});

test("the bot opens no HTTP listener", () => {
  for (const file of ["bot.js", "outcomes.js"]) {
    const text = fs.readFileSync(path.join(__dirname, file), "utf8");
    for (const token of ["createServer", ".listen(", "require(\"http\")", "require('http')"]) {
      assert(!text.includes(token), `${file} must not open a port (found "${token}")`);
    }
  }
});

// ---------------------------------------------------------------------------

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
  console.log(`\nbot tests passed (${passed} tests)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
