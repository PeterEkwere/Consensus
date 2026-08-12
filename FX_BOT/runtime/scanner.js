/**
 * Consensus FX Sentinel - orchestration.
 *
 * Ties the provider, engine, ledger and Telegram layer together. One process
 * runs both the scanner and the outcome monitor; there is no worker pool and no
 * second PM2 process.
 *
 * Ordering rule that must never change: a plan is PERSISTED before its alert is
 * attempted, and a notification flag is persisted before the message is sent.
 * A crash may therefore lose a message, but it can never send one twice or
 * forget a setup it already published.
 *
 * Constructing a scanner performs no I/O beyond loading existing state. Timers
 * start only in `start()`.
 */

"use strict";

const path = require("node:path");

const { SYMBOLS } = require("./config");
const { evaluateSymbol, makeAlertId, dedupeKey } = require("./engine");
const { TIMEFRAME_MS, usableCandles } = require("./market");
const { observedSpread } = require("./provider");
const exposure = require("./exposure");
const outcomes = require("./outcomes");
const quality = require("./quality");
const results = require("./results");
const shadowLedger = require("./shadow");
const storage = require("./storage");
const telegram = require("./telegram");

const TIMEFRAMES = ["M1", "M5", "M15", "H1"];
const CANDLE_COUNTS = Object.freeze({ M1: 300, M5: 200, M15: 150, H1: 150 });

/** Milliseconds until just after the next boundary of `stepMs`. */
function msUntilNextBoundary(now, stepMs, safetyDelayMs) {
  const elapsed = now % stepMs;
  return stepMs - elapsed + safetyDelayMs;
}

function createScanner({
  config,
  provider,
  client = null,
  now = () => Date.now(),
  logger = console,
  safetyDelayMs = 3000,
  seedTargets = true,
}) {
  const stateDir = config.stateDir;
  const runtimeStore = storage.createStore(path.join(stateDir, "runtime.json"), {
    offset: 0,
    pausedForMemory: false,
    lastScanAt: null,
    lastEvaluatedM5: {},
    errors: [],
  });
  const targetsStore = storage.createStore(path.join(stateDir, "targets.json"), {
    chatIds: [],
    seeded: false,
  });
  const setupsStore = storage.createStore(path.join(stateDir, "setups.json"), { records: [] });
  const journalPath = path.join(stateDir, "journal.jsonl");

  const targets = telegram.createTargets(
    targetsStore,
    seedTargets ? config.telegram.seedChatId : "",
  );

  // Withheld-but-valid setups are measured here. This ledger has no Telegram
  // client and no notifier, so nothing in it can ever be announced.
  const shadow = shadowLedger.createShadowLedger({
    stateDir,
    expiryHours: config.outcomeExpiryHours,
    provider,
    logger,
  });

  let records = (setupsStore.load().records || [])
    .map(outcomes.sanitizeRecord)
    .filter(Boolean);
  let runtimeState = runtimeStore.load();
  let stopping = false;
  let scanning = false;
  const timers = new Set();

  function symbolById(id) {
    return SYMBOLS[id];
  }

  function persistRecords() {
    setupsStore.save({ records });
  }

  function journal(entry) {
    try {
      storage.appendJsonl(journalPath, { at: new Date(now()).toISOString(), ...entry });
    } catch (err) {
      logger.error(`journal write failed: ${err.message}`);
    }
  }

  function noteError(message) {
    const errors = Array.isArray(runtimeState.errors) ? runtimeState.errors : [];
    errors.unshift({ at: new Date(now()).toISOString(), message });
    // Cap diagnostic history so state cannot grow without bound.
    runtimeState = runtimeStore.save({ ...runtimeState, errors: errors.slice(0, 25) });
  }

  /** Fetch and validate every timeframe for one symbol. */
  async function loadMarket(symbolId, asOf) {
    const candles = {};
    const diagnostics = {};
    const errors = [];
    for (const timeframe of TIMEFRAMES) {
      const result = await provider.fetchCandles(symbolId, timeframe, {
        count: CANDLE_COUNTS[timeframe],
        asOf,
      });
      if (result.error) {
        errors.push({ timeframe, ...result.error });
        candles[timeframe] = [];
        diagnostics[timeframe] = { received: 0, gaps: 0 };
        continue;
      }
      const checked = usableCandles(result.candles, { timeframe, asOf });
      candles[timeframe] = checked.candles;
      diagnostics[timeframe] = checked.diagnostics;
    }
    return { candles, diagnostics, errors };
  }

  /**
   * One scan pass. `dryRun` evaluates and reports without persisting plans or
   * sending anything.
   */
  async function scanOnce({ dryRun = false, monitorOutcomes = false, manual = false,
    enforceCadence = false } = {}) {
    const asOf = now();
    const lastScanMs = Date.parse(runtimeState.lastScanAt);
    const minimumGapMs = config.scanIntervalSeconds * 1000;
    if ((manual || enforceCadence) && Number.isFinite(lastScanMs) && asOf - lastScanMs < minimumGapMs) {
      return {
        at: new Date(asOf).toISOString(),
        symbols: [],
        published: 0,
        failures: 0,
        skipped: "provider_budget_cadence",
        nextScanAt: new Date(lastScanMs + minimumGapMs).toISOString(),
      };
    }
    if (scanning) {
      return {
        at: new Date(asOf).toISOString(), symbols: [], published: 0, failures: 0,
        skipped: "scan_already_running",
      };
    }
    scanning = true;
    try {
    // Publication is deferred until every symbol is evaluated, so correlated
    // currency exposure is resolved across the whole scan.
    const publishable = [];
    const withheld = [];
    const report = { at: new Date(asOf).toISOString(), symbols: [], published: 0, failures: 0 };
    const quoteResult = typeof provider.fetchQuotes === "function"
      ? await provider.fetchQuotes(config.symbolIds)
      : { quotes: {}, error: null };
    const quotes = quoteResult.quotes || {};
    const loadedMarkets = new Map();
    const lastEvaluated = runtimeState.lastEvaluatedM5 && typeof runtimeState.lastEvaluatedM5 === "object"
      ? { ...runtimeState.lastEvaluatedM5 }
      : {};

    for (const symbol of config.symbols) {
      const market = await loadMarket(symbol.id, asOf);
      loadedMarkets.set(symbol.id, market);
      const m5 = market.candles.M5 || [];
      const m1 = market.candles.M1 || [];
      const quote = quotes[symbol.id] || null;

      const perSymbol = {
        symbol: symbol.id,
        provider: provider.name,
        latestComplete: m5.length ? new Date(m5[m5.length - 1].time).toISOString() : null,
        counts: Object.fromEntries(TIMEFRAMES.map((tf) => [tf, (market.candles[tf] || []).length])),
        gaps: Object.fromEntries(TIMEFRAMES.map((tf) => [tf, (market.diagnostics[tf] || {}).gaps || 0])),
        errors: [
          ...market.errors,
          ...(quoteResult.error ? [{ timeframe: "quote", ...quoteResult.error }] : []),
        ],
        quoteTime: quote ? new Date(quote.quoteTime).toISOString() : null,
        rawCandidates: 0,
        rejected: [],
        conflicts: [],
        detectorErrors: [],
        publishable: 0,
        evaluatedM5: 0,
      };

      if (!m5.length) {
        // No usable data is a failure, never "no setups found".
        perSymbol.dataOk = false;
        report.failures += 1;
        report.symbols.push(perSymbol);
        continue;
      }
      perSymbol.dataOk = true;

      const spread = quote && Number.isFinite(quote.spread)
        ? quote.spread
        : observedSpread(m1.length ? m1 : m5);
      const latestQuote = quote && Number.isFinite(quote.mid)
        ? quote.mid
        : m5[m5.length - 1].close;
      // A dry run is an isolated observation, not a continuation of the live
      // checkpoint. Otherwise a developer's runtime.json can silently turn a
      // fixture or provider validation into a zero-decision no-op.
      const previousTrigger = dryRun ? NaN : Number(lastEvaluated[symbol.id]);
      const triggerCandles = Number.isFinite(previousTrigger)
        ? m5.filter((c) => c.time > previousTrigger)
        : m5.slice(-1);

      for (const trigger of triggerCandles) {
        const triggerAsOf = trigger.time + TIMEFRAME_MS.M5;
        const slicedCandles = Object.fromEntries(TIMEFRAMES.map((tf) => [
          tf,
          (market.candles[tf] || []).filter((c) => c.time + TIMEFRAME_MS[tf] <= triggerAsOf),
        ]));
        const evaluation = evaluateSymbol({
          symbol,
          candles: slicedCandles,
          asOf: triggerAsOf,
          // Publication/session/no-chase decisions are made at scan time, not
          // retroactively at the trigger candle's timestamp.
          now: asOf,
          strategy: config.strategy,
          configHash: config.configHash,
          provider: provider.name,
          spread,
          quote: latestQuote,
          quoteTime: quote ? quote.quoteTime : null,
          requireFreshQuote: provider.name === "tiingo",
          newsStatus: "unknown", // No authenticated calendar in this runtime.
          researchMode: config.researchMode,
          existing: records,
          diagnostics: market.diagnostics.M5,
        });

        perSymbol.evaluatedM5 += 1;
        perSymbol.rawCandidates += evaluation.rawCandidates.length;
        perSymbol.rejected.push(...evaluation.rejected);
        perSymbol.conflicts.push(...evaluation.conflicts);
        perSymbol.detectorErrors.push(...evaluation.detectorErrors);
        perSymbol.publishable += evaluation.published.length;

        // Journal every raw candidate, published or not, so the research keeps
        // its near-misses.
        if (!dryRun) {
          for (const candidate of evaluation.rawCandidates) {
            journal({
              kind: "candidate",
              symbol: symbol.id,
              playbookId: candidate.playbookId,
              side: candidate.side,
              signalTime: candidate.signalTime,
              configHash: config.configHash,
              entry: candidate.entry,
              stop: candidate.stop,
              score: candidate.score,
            });
          }
          for (const rejection of evaluation.rejected) journal({ kind: "rejected", symbol: symbol.id, ...rejection });
          for (const conflict of evaluation.conflicts) journal({ kind: "conflict", symbol: symbol.id, ...conflict });
          for (const error of evaluation.detectorErrors) journal({ kind: "detector_error", symbol: symbol.id, ...error });
        }

        // Publication is deferred until every symbol has been evaluated, so
        // correlated currency exposure can be resolved across the whole scan
        // rather than one instrument at a time.
        for (const { candidate, gate } of evaluation.published) {
          quality.annotate(candidate);
          candidate.strategyVersion = config.strategy.version;
          candidate.strategyHash = config.strategyHash;
          candidate.cohortId = config.configHash;
          candidate.universeHash = config.universeHash;
          candidate.costR = gate.plan && gate.plan.r > 0 && Number.isFinite(candidate.observedSpread)
            ? outcomes.estimateCosts({
              observedSpread: candidate.observedSpread,
              r: gate.plan.r,
              strategy: config.strategy,
              symbol,
            }).costR
            : null;
          // Decision delay: how long after the trigger candle closed this scan
          // actually looked. A 30-minute cadence evaluating 5-minute triggers
          // is not the same product as a 5-minute cadence, and the ledger must
          // be able to show that.
          candidate.triggerCloseTime = triggerAsOf;
          candidate.scanTime = asOf;
          candidate.decisionDelayMs = asOf - triggerAsOf;
          candidate.quoteDriftR = gate.plan && gate.plan.r > 0 && Number.isFinite(latestQuote)
            ? Math.abs(latestQuote - gate.plan.entry) / gate.plan.r
            : null;
          publishable.push({ candidate, gate, symbol });
        }

        // Valid plans withheld by a judgement gate become shadow evidence.
        for (const rejection of evaluation.rejected) {
          if (!shadowLedger.isMeasurable(rejection.reason) || !rejection.plan) continue;
          quality.annotate(rejection.candidate);
          rejection.candidate.strategyVersion = config.strategy.version;
          rejection.candidate.strategyHash = config.strategyHash;
          rejection.candidate.cohortId = config.configHash;
          rejection.candidate.universeHash = config.universeHash;
          rejection.candidate.triggerCloseTime = triggerAsOf;
          rejection.candidate.scanTime = asOf;
          rejection.candidate.decisionDelayMs = asOf - triggerAsOf;
          const ownCluster = exposure.clusterByExposure([rejection.candidate])[0];
          rejection.candidate.exposureKey = ownCluster ? ownCluster.exposureKey : null;
          withheld.push({ ...rejection, symbol });
        }

        // Same-side conflict losers had valid plans and lost only a ranking
        // judgement, so they belong in shadow rather than disappearing.
        for (const conflict of evaluation.conflicts) {
          if (!shadowLedger.isMeasurable(conflict.reason) || !conflict.plan || !conflict.candidate) continue;
          quality.annotate(conflict.candidate);
          conflict.candidate.strategyVersion = config.strategy.version;
          conflict.candidate.strategyHash = config.strategyHash;
          conflict.candidate.cohortId = config.configHash;
          conflict.candidate.universeHash = config.universeHash;
          conflict.candidate.triggerCloseTime = triggerAsOf;
          conflict.candidate.scanTime = asOf;
          conflict.candidate.decisionDelayMs = asOf - triggerAsOf;
          const ownCluster = exposure.clusterByExposure([conflict.candidate])[0];
          conflict.candidate.exposureKey = ownCluster ? ownCluster.exposureKey : null;
          withheld.push({ ...conflict, symbol });
        }
      }

      if (!dryRun) lastEvaluated[symbol.id] = m5[m5.length - 1].time;

      report.symbols.push(perSymbol);
    }

    // ---- Correlation control across the whole scan ----------------------
    // Buying EUR/USD and selling GBP/EUR are both long-EUR. Publishing both is
    // one conviction expressed twice, and counting their outcomes separately
    // would overstate the independent evidence.
    const clusters = exposure.clusterByExposure(publishable.map((p) => p.candidate));
    const maxPerCluster = config.strategy.gates.maxPerExposureCluster;
    const cleared = new Set();
    for (const cluster of clusters) {
      const ranked = exposure.rankCandidates(cluster.members, config.strategy.playbookPriority);
      ranked.forEach((candidate, index) => {
        candidate.exposureKey = cluster.exposureKey;
        candidate.exposureCurrency = cluster.currency;
        candidate.exposureDirection = cluster.direction;
        if (index < maxPerCluster) cleared.add(candidate);
      });
      for (const loser of ranked.slice(maxPerCluster)) {
        const entry = publishable.find((p) => p.candidate === loser);
        if (entry) {
          withheld.push({
            reason: "correlated_currency_exposure",
            candidate: loser,
            plan: entry.gate.plan,
            playbookId: loser.playbookId,
            symbol: entry.symbol,
          });
        }
      }
    }
    report.exposureClusters = clusters.length;
    report.withheld = withheld.length;

    for (const entry of publishable) {
      if (dryRun || !cleared.has(entry.candidate)) continue;
      await publish(entry.candidate, entry.gate, entry.symbol, asOf);
      report.published += 1;
    }

    if (!dryRun && shadow) {
      for (const item of withheld) {
        const symbolMeta = item.symbol || symbolById(item.candidate.symbol);
        shadow.track({
          candidate: item.candidate,
          plan: item.plan,
          reason: item.reason,
          symbol: symbolMeta,
          sentAt: asOf,
          costs: outcomes.estimateCosts({
            observedSpread: item.candidate.observedSpread,
            r: item.plan.r,
            strategy: config.strategy,
            symbol: symbolMeta,
          }),
          configHash: config.configHash,
          quality: {
            score: item.candidate.qualityScore,
            familyCount: item.candidate.familyCount,
            coveragePct: item.candidate.coveragePct,
          },
        });
      }
      // Reuse the M1 histories already fetched for this scan. Shadow research
      // must not quietly exceed the provider budget as its ledger grows.
      await shadow.poll(asOf, loadedMarkets);
    }

    if (!dryRun) {
      runtimeState = runtimeStore.save({
        ...runtimeState,
        lastScanAt: new Date(asOf).toISOString(),
        lastEvaluatedM5: lastEvaluated,
      });
      if (monitorOutcomes) await pollOutcomes({ markets: loadedMarkets, at: asOf });
    }
      return report;
    } finally {
      scanning = false;
    }
  }

  /** Persist the plan, then attempt its alert. Never the other way round. */
  async function publish(candidate, gate, symbol, at) {
    const costs = outcomes.estimateCosts({
      observedSpread: candidate.observedSpread,
      r: gate.plan.r,
      strategy: config.strategy,
      symbol,
    });

    candidate.session = gate.session;
    candidate.newsStatus = "unknown";

    const record = outcomes.createRecord({
      candidate,
      plan: gate.plan,
      id: makeAlertId(candidate, records, at),
      dedupeKey: gate.key,
      groupKey: gate.group,
      sentAt: at,
      costs,
      configHash: config.configHash,
      provider: provider.name,
    });

    records.unshift(record);
    persistRecords();
    journal({ kind: "published", id: record.id, symbol: record.symbol, playbookId: record.playbookId });

    // Research candidates are only sent when explicitly enabled; measurement
    // continues either way.
    if (!config.sendResearchAlerts || !client) return record;

    const text = telegram.formatEntryAlert({
      record,
      symbol,
      researchMode: config.researchMode,
      newsStatus: "unknown",
    });
    for (const chatId of targets.list()) {
      try {
        await client.sendMessage(chatId, text, { reply_markup: telegram.alertButtons(symbol) });
      } catch (err) {
        noteError(`entry alert to ${chatId} failed: ${err.message}`);
      }
    }
    return record;
  }

  /** Resolve open plans against closed M1 candles. */
  async function pollOutcomes({ markets = null, at = now() } = {}) {
    const open = records.filter((r) => r.status === "pending_entry" || r.status === "entered");
    const expiryMs = config.outcomeExpiryHours * 3600 * 1000;
    const fetchedBySymbol = new Map();

    for (const record of open) {
      const symbol = symbolById(record.symbol);
      if (!symbol) continue;

      let fetched;
      try {
        if (markets && markets.has(record.symbol)) {
          const loaded = markets.get(record.symbol);
          fetched = {
            candles: (loaded.candles && loaded.candles.M1) || [],
            error: (loaded.errors || []).find((e) => e.timeframe === "M1") || null,
          };
        } else if (fetchedBySymbol.has(record.symbol)) {
          fetched = fetchedBySymbol.get(record.symbol);
        } else {
          fetched = await provider.fetchCandles(record.symbol, "M1", {
            count: CANDLE_COUNTS.M1,
            asOf: at,
          });
          fetchedBySymbol.set(record.symbol, fetched);
        }
      } catch (err) {
        record.dataGaps += 1;
        persistRecords();
        noteError(`outcome fetch failed for ${record.id}: ${err.message}`);
        continue;
      }
      if (fetched.error || !fetched.candles.length) {
        // Rule 10: a fetch failure resolves nothing.
        record.dataGaps += 1;
        persistRecords();
        continue;
      }

      const checked = usableCandles(fetched.candles, { timeframe: "M1", asOf: at });
      const fresh = checked.candles.filter((c) => c.time >= record.watchFromMs
        && (!Number.isFinite(record.lastCandleTime) || c.time > record.lastCandleTime));

      // A window longer than one fetch can cover means minutes we will never
      // see. Flag it rather than assuming they were uneventful.
      const expectedFrom = Number.isFinite(record.lastCandleTime)
        ? record.lastCandleTime + TIMEFRAME_MS.M1
        : record.watchFromMs;
      let gapped = false;
      if (fresh.length && fresh[0].time > expectedFrom + TIMEFRAME_MS.M1) gapped = true;

      const applied = outcomes.applyCandles(record, fresh, { now: at, expiryMs });
      if (gapped) applied.record.dataGaps += 1;

      const index = records.findIndex((r) => r.id === record.id);
      if (index >= 0) records[index] = applied.record;
      // Persist BEFORE notifying: the flags are already set on the record.
      persistRecords();

      for (const event of applied.events) {
        journal({ kind: "outcome", id: applied.record.id, event: event.type });
        if (!client || !config.sendResearchAlerts) continue;
        const text = telegram.formatOutcome({ event, record: applied.record, symbol });
        for (const chatId of targets.list()) {
          try {
            await client.sendMessage(chatId, text);
          } catch (err) {
            noteError(`outcome message to ${chatId} failed: ${err.message}`);
          }
        }
      }
    }
  }

  function summary() {
    return results.summarise(records, {
      configHash: config.configHash,
      alertMode: config.alertMode,
    });
  }

  function statusText() {
    const memoryMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    const life = summary().lifecycle;
    return [
      "<b>Consensus FX Sentinel — Status</b>",
      "",
      `Mode: <b>${config.alertMode === "research" ? "Research (measuring only)" : "Normal"}</b>`,
      `Sending setup messages: <b>${config.sendResearchAlerts ? "yes" : "no"}</b>`,
      `Instruments: <b>${config.symbolIds.join(", ")}</b>`,
      "Price source: <b>Tiingo Forex</b>",
      `Economic news protection: <b>unavailable</b>`,
      `Last scan: <code>${telegram.esc(runtimeState.lastScanAt || "never")}</code>`,
      `Waiting for entry price: <b>${life.pending_entry}</b>`,
      `Entered and still being monitored: <b>${life.entered_unresolved}</b>`,
      `Completed setups: <b>${life.complete}</b>`,
      `Memory in use: <b>${memoryMb} MB</b>`,
      `Settings fingerprint: <code>${telegram.esc(config.configHash)}</code>`,
    ].join("\n");
  }

  function resultsText() {
    return telegram.formatResults(summary());
  }

  /** Owner-only research view of setups that were withheld, never sent. */
  function shadowText() {
    return telegram.formatShadowResults(shadowLedger.summarise(shadow.records, {
      summariseLeg: results.summariseLeg,
      lifecycleOf: results.lifecycleOf,
    }));
  }

  /** Memory guard: pause new scans rather than restarting in a loop. */
  function memoryOk() {
    const rssMb = process.memoryUsage().rss / (1024 * 1024);
    if (rssMb > config.memoryCeilingMb) {
      if (!runtimeState.pausedForMemory) {
        runtimeState = runtimeStore.save({ ...runtimeState, pausedForMemory: true });
        noteError(`memory ${Math.round(rssMb)}MB exceeded ceiling ${config.memoryCeilingMb}MB; scanning paused`);
      }
      return false;
    }
    if (runtimeState.pausedForMemory) {
      runtimeState = runtimeStore.save({ ...runtimeState, pausedForMemory: false });
    }
    return true;
  }

  function schedule(fn, stepMs) {
    if (stopping) return;
    const delay = msUntilNextBoundary(now(), stepMs, safetyDelayMs);
    const timer = setTimeout(async () => {
      timers.delete(timer);
      try {
        await fn();
      } catch (err) {
        noteError(err.message);
        logger.error(`scheduled task failed: ${err.message}`);
      }
      schedule(fn, stepMs);
    }, delay);
    timers.add(timer);
    if (typeof timer.unref === "function" && stopping) timer.unref();
  }

  async function processUpdates(onScan) {
    if (!client) return;
    const offset = Number(runtimeState.offset) || 0;
    const updates = await client.getUpdates(offset);
    for (const update of updates) {
      runtimeState = runtimeStore.save({ ...runtimeState, offset: update.update_id + 1 });
      const reply = telegram.handleCommand({
        update,
        targets,
        ownerUserId: config.telegram.ownerUserId,
        statusText,
        resultsText,
        shadowText,
        onScan,
      });
      if (!reply) continue;
      try {
        await client.sendMessage(reply.chatId, reply.text);
      } catch (err) {
        noteError(`reply failed: ${err.message}`);
      }
      if (reply.scan) await reply.scan();
    }
  }

  return {
    get records() {
      return records;
    },
    get shadowRecords() {
      return shadow.records;
    },
    shadowSummary() {
      return shadowLedger.summarise(shadow.records, {
        summariseLeg: results.summariseLeg,
        lifecycleOf: results.lifecycleOf,
      });
    },
    targets,
    journalPath,
    scanOnce,
    pollOutcomes,
    processUpdates,
    summary,
    statusText,
    resultsText,
    memoryOk,
    async start() {
      // One quota-bounded Tiingo pass supplies both strategy evaluation and
      // outcome monitoring. Outcomes still use closed M1 candles, but a
      // notification can arrive up to one scan interval after the level hit.
      schedule(async () => {
        if (memoryOk()) await scanOnce({ monitorOutcomes: true, enforceCadence: true });
      }, config.scanIntervalSeconds * 1000);
    },
    async stop() {
      stopping = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      persistRecords();
    },
  };
}

module.exports = { CANDLE_COUNTS, TIMEFRAMES, createScanner, msUntilNextBoundary };
