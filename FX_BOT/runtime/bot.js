/**
 * Consensus FX Sentinel - CLI and lifecycle.
 *
 * Alert-only FX setup finder. It never logs into a trading account, places an
 * order, reads a balance, or tells anyone they made or lost money.
 *
 * Modes:
 *   --dry-run --fixtures   deterministic offline scan, no secrets, sends nothing
 *   --dry-run              real provider fetch and candidate summary, sends nothing
 *   --send-test            one unmistakable non-market test message
 *   --once                 one real research scan plus one outcome pass
 *   (no flag)              long-running polling and scanning process
 *
 * This file starts work only under `require.main === module`. Importing it -
 * and every other runtime module - starts no timer, no polling, no network
 * request and no filesystem write.
 */

"use strict";

const path = require("node:path");

const { loadConfig, loadEnv, SYMBOLS } = require("./config");
const { createFixtureProvider, createTiingoProvider } = require("./provider");
const { createScanner } = require("./scanner");
const { ANCHOR, buildFixtureDataset } = require("./fixtures/dataset");
const telegram = require("./telegram");

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    dryRun: args.has("--dry-run"),
    fixtures: args.has("--fixtures"),
    sendTest: args.has("--send-test"),
    once: args.has("--once"),
  };
}

/**
 * Live modes need credentials; fixture and dry-run modes must work with none,
 * so a developer can validate the pipeline without touching a secret.
 */
function buildRuntime(options) {
  const { dryRun, fixtures, sendTest, once } = options;
  const needsTelegram = sendTest || once || (!dryRun && !fixtures);
  const needsProvider = !fixtures && !sendTest;

  // State files must be private even if the process manager set a loose umask.
  process.umask(0o077);

  const env = loadEnv(path.join(__dirname, "..", ".env"));
  const requiredVars = [];
  if (needsTelegram) requiredVars.push("FX_TELEGRAM_BOT_TOKEN", "FX_TELEGRAM_CHAT_ID");
  if (once || (!dryRun && !fixtures && !sendTest)) requiredVars.push("FX_OWNER_TELEGRAM_USER_ID");
  if (needsProvider) requiredVars.push("FX_TIINGO_API_TOKEN");
  const config = loadConfig({ env, requiredVars });

  const provider = sendTest
    ? null
    : fixtures
    ? createFixtureProvider(buildFixtureDataset(), { name: "fixtures" })
    : createTiingoProvider({ baseUrl: config.tiingo.baseUrl, token: config.tiingo.token });

  const client = needsTelegram && config.telegram.token
    ? telegram.createTelegramClient({ token: config.telegram.token })
    : null;

  // Fixture mode must be reproducible on any calendar date. Using wall-clock
  // time eventually makes every fixture candle stale and turns the advertised
  // end-to-end check into a zero-decision no-op.
  const now = fixtures ? () => ANCHOR : undefined;
  return { config, provider, client, now };
}

function printDryRun(report, config) {
  console.log("Consensus FX Sentinel - dry run");
  console.log(`Mode: ${config.alertMode} (research mode ${config.researchMode ? "on" : "off"})`);
  console.log(`Settings fingerprint: ${config.configHash}`);
  console.log(`Scanned at: ${report.at}`);
  console.log("");

  for (const s of report.symbols) {
    console.log(`${s.symbol} [${s.provider}]`);
    console.log(`  data usable        : ${s.dataOk ? "yes" : "NO"}`);
    console.log(`  latest complete M5 : ${s.latestComplete || "none"}`);
    console.log(`  candles used       : M1=${s.counts.M1} M5=${s.counts.M5} M15=${s.counts.M15} H1=${s.counts.H1}`);
    console.log(`  missing bars       : M1=${s.gaps.M1} M5=${s.gaps.M5} M15=${s.gaps.M15} H1=${s.gaps.H1}`);
    console.log(`  current quote time : ${s.quoteTime || "unavailable"}`);
    console.log(`  M5 decisions tested: ${s.evaluatedM5}`);
    if (s.errors.length) {
      for (const e of s.errors) console.log(`  data error         : ${e.timeframe} ${e.message || e.status}`);
    }
    console.log(`  raw candidates     : ${s.rawCandidates}`);
    console.log(`  rejected by gates  : ${s.rejected.length}${s.rejected.length ? ` (${s.rejected.map((r) => `${r.playbookId}:${r.reason}`).join(", ")})` : ""}`);
    console.log(`  conflicts          : ${s.conflicts.length}`);
    console.log(`  detector errors    : ${s.detectorErrors.length}`);
    console.log(`  publishable plans  : ${s.publishable}`);
    console.log("");
  }

  const usable = report.symbols.filter((s) => s.dataOk).length;
  console.log(`Instruments with usable data: ${usable}/${report.symbols.length}`);
  if (!usable) {
    // Zero candidates means nothing if the feed never delivered a candle.
    console.log("No instrument returned usable candles. This run proves nothing about the market.");
  } else {
    console.log("Nothing was sent and no setup was persisted.");
  }
  return usable;
}

async function main(argv = process.argv) {
  const options = parseArgs(argv);
  const { config, provider, client, now } = buildRuntime(options);

  if (options.sendTest) {
    if (!client) throw new Error("A Telegram token is required to send a test message.");
    const text = [
      "🧪 <b>TEST MESSAGE — NOT A TRADING SETUP</b>",
      "",
      "This message confirms that Consensus FX Sentinel can reach this chat.",
      "It contains no market data and no setup.",
    ].join("\n");
    await client.sendMessage(config.telegram.seedChatId, text);
    console.log("Test message sent to 1 chat.");
    return 0;
  }

  const scanner = createScanner({ config, provider, client, now, seedTargets: !options.dryRun });

  if (options.dryRun) {
    const report = await scanner.scanOnce({ dryRun: true });
    const usable = printDryRun(report, config);
    // Exit nonzero when every instrument failed to deliver data.
    return usable === 0 ? 1 : 0;
  }

  if (options.once) {
    await scanner.scanOnce({ monitorOutcomes: true });
    console.log("One scan and one outcome pass complete.");
    return 0;
  }

  console.log("Consensus FX Sentinel is running.");
  console.log(`Mode: ${config.alertMode}. Sending setup messages: ${config.sendResearchAlerts ? "yes" : "no"}.`);
  console.log(`Instruments: ${config.symbolIds.join(", ")}`);
  console.log(`Settings fingerprint: ${config.configHash}`);

  await scanner.start();

  let polling = true;
  const shutdown = async (signal) => {
    if (!polling) return;
    polling = false;
    console.log(`\n${signal} received. Saving state and stopping.`);
    await scanner.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => { shutdown("SIGINT"); });
  process.on("SIGTERM", () => { shutdown("SIGTERM"); });

  // One long poll at a time.
  while (polling) {
    try {
      await scanner.processUpdates(() => scanner.scanOnce({ manual: true, monitorOutcomes: true }));
    } catch (err) {
      if (err && err.fatal) {
        console.error(err.message);
        await scanner.stop();
        process.exit(1);
      }
      console.error(`update poll failed: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => {
    if (code) process.exit(code);
  }).catch((err) => {
    // Config errors name variables only; they never carry a value.
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { buildRuntime, main, parseArgs, printDryRun, SYMBOLS };
