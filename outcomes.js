/**
 * Consensus Reaper - outcome monitoring.
 *
 * Owns the canonical tracked trade plan for every published alert and resolves
 * it against closed OKX 1m candles. No exchange keys, no wallet, no orders: the
 * ledger only records how the *published setup* behaved.
 *
 * Design rules that keep the research honest:
 *
 * - One exact entry price per setup. R = abs(entry - stop). Targets are derived
 *   from R, never carried over from an upstream field, so 1:1 and 3:1 are always
 *   mathematically consistent.
 * - Candles that opened before the alert was sent are never evaluated. A setup
 *   cannot be resolved by price action its reader could not have traded.
 * - OHLC ambiguity rule: a single 1m candle records only open/high/low/close, so
 *   when one unresolved candle contains both the stop and a target the true
 *   sequence is unknowable. We always record the stop first. This understates
 *   performance rather than inventing wins.
 * - Entry activation is separate from resolution. A setup whose exact entry is
 *   never traded through is cancelled or expired, never counted as a win or loss.
 * - Expiry closes unresolved setups after a configurable window (default 24h)
 *   and is reported separately from resolved outcomes.
 *
 * Internal field names use the trading shorthand (r1/r3/tp/sl). Every
 * user-facing string is built in bot.js in plain language.
 */

"use strict";

const fs = require("fs");

const DEFAULT_EXPIRY_HOURS = 24;
const DEFAULT_MAX_RECORDS = 1000;
const MINUTE_MS = 60 * 1000;

// Cost assumptions applied to every setup, both sides of the round trip.
// OKX futures taker fee is 0.05%; slippage is a deliberately pessimistic guess.
const DEFAULT_COSTS = {
  feeRatePerSide: 0.0005,
  slippageRatePerSide: 0.0005,
};

const QUOTE_ASSETS = ["USDT", "USDC", "USD", "BTC", "ETH"];
const ENTRY_STATUSES = ["pending", "entered", "cancelled", "expired"];
const LEG_STATUSES = ["open", "tp", "sl", "void"];
const RECORD_STATUSES = ["open", "complete", "cancelled", "expired"];

// ---------------------------------------------------------------------------
// Trade plan
// ---------------------------------------------------------------------------

function baseAsset(symbol) {
  const sym = String(symbol || "").toUpperCase();
  for (const quote of QUOTE_ASSETS) {
    if (sym.endsWith(quote) && sym.length > quote.length) {
      return sym.slice(0, sym.length - quote.length);
    }
  }
  return sym;
}

/**
 * Derive the canonical tracked levels from a signal.
 * Returns null for any setup that cannot be monitored deterministically.
 */
function buildTradePlan(signal) {
  if (!signal) return null;
  const side = signal.side === "long" ? "long" : signal.side === "short" ? "short" : null;
  if (!side) return null;

  const entry = Number(signal.price);
  const stop = Number(signal.stop);
  if (!Number.isFinite(entry) || !Number.isFinite(stop)) return null;
  if (entry <= 0) return null;

  const r = Math.abs(entry - stop);
  if (!Number.isFinite(r) || r <= 0) return null;

  const tp1 = side === "long" ? entry + r : entry - r;
  const tp3 = side === "long" ? entry + r * 3 : entry - r * 3;
  if (![tp1, tp3].every((n) => Number.isFinite(n) && n > 0)) return null;

  // Directional sanity: a long must risk downside and target upside.
  if (side === "long" && !(stop < entry && entry < tp1 && tp1 < tp3)) return null;
  if (side === "short" && !(stop > entry && entry > tp1 && tp1 > tp3)) return null;

  return { side, entry, stop, tp1, tp3, r };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function utcDateStamp(value) {
  const date = new Date(value);
  const ms = date.getTime();
  const safe = Number.isFinite(ms) ? date : new Date();
  const year = safe.getUTCFullYear();
  const month = String(safe.getUTCMonth() + 1).padStart(2, "0");
  const day = String(safe.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

/**
 * Stable identity for a setup: the same 15m signal always maps to the same key,
 * so a restart mid-broadcast reuses the existing alert id instead of minting a
 * second one for the same setup.
 */
function dedupeKey(signal) {
  return [
    signal.market || "",
    String(signal.symbol || "").toUpperCase(),
    signal.side || "",
    signal.time || "",
  ].join(":");
}

/**
 * Readable, deterministic alert id: CR-BTC-20260808-001.
 * The sequence is the highest number already used for that symbol and day plus
 * one, so ids stay unique even after old records are pruned.
 */
function makeAlertId(signal, records) {
  const prefix = `CR-${baseAsset(signal.symbol)}-${utcDateStamp(signal.time)}`;
  let highest = 0;
  for (const record of records || []) {
    if (!record || typeof record.id !== "string") continue;
    if (!record.id.startsWith(`${prefix}-`)) continue;
    const seq = Number(record.id.slice(prefix.length + 1));
    if (Number.isFinite(seq) && seq > highest) highest = seq;
  }
  return `${prefix}-${String(highest + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Record shape
// ---------------------------------------------------------------------------

function createRecord(options) {
  const { signal, plan, id, sentAt, costs } = options;
  const sentMs = Date.parse(sentAt);
  return {
    id,
    key: dedupeKey(signal),
    exchange: signal.exchange || "OKX",
    market: signal.market,
    symbol: signal.symbol,
    name: signal.name || signal.symbol,
    side: plan.side,
    timeframe: signal.timeframe || "15m",

    signalTime: signal.time,
    sentAt,
    watchFromMs: Number.isFinite(sentMs) ? sentMs : Date.now(),

    entry: plan.entry,
    stop: plan.stop,
    tp1: plan.tp1,
    tp3: plan.tp3,
    r: plan.r,

    entryStatus: "pending",
    entryTime: null,
    r1Status: "open",
    r1ResolvedAt: null,
    r3Status: "open",
    r3ResolvedAt: null,
    status: "open",
    finalisedAt: null,

    notified: { firstTarget: false, final: false },
    costs: {
      feeRatePerSide: costs.feeRatePerSide,
      slippageRatePerSide: costs.slippageRatePerSide,
    },

    // Enough raw context to audit the decision later without re-running a scan.
    diagnostics: {
      score: signal.score,
      trend: signal.trend,
      trendM5: signal.trendM5,
      trendH1: signal.trendH1,
      rsi: signal.rsi,
      volumeH24Usd: signal.volumeH24Usd,
      confirmations: Array.isArray(signal.confirmations) ? signal.confirmations.slice(0, 12) : [],
      tvSymbol: signal.tvSymbol,
    },
    lastCandleTime: null,
    candlesSeen: 0,
    dataGaps: 0,
  };
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function nearlyEqual(a, b) {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Accept a persisted row only if it can still be reasoned about. Anything
 * missing its identity or its price levels is dropped rather than repaired,
 * because a half-known setup would silently corrupt the statistics.
 */
function sanitizeRecord(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  if (typeof row.id !== "string" || !row.id) return null;
  if (typeof row.symbol !== "string" || !row.symbol) return null;

  const side = row.side === "long" || row.side === "short" ? row.side : null;
  if (!side) return null;

  const numbers = ["entry", "stop", "tp1", "tp3", "r"].map((field) => Number(row[field]));
  if (!numbers.every((n) => Number.isFinite(n))) return null;
  const [entry, stop, tp1, tp3, r] = numbers;
  if (entry <= 0 || r <= 0) return null;
  if (side === "long" && !(stop < entry && entry < tp1 && tp1 < tp3)) return null;
  if (side === "short" && !(stop > entry && entry > tp1 && tp1 > tp3)) return null;
  const canonical = buildTradePlan({ side, price: entry, stop });
  if (!canonical
    || !nearlyEqual(r, canonical.r)
    || !nearlyEqual(tp1, canonical.tp1)
    || !nearlyEqual(tp3, canonical.tp3)) return null;

  const watchFromMs = Number(row.watchFromMs);
  const notified = row.notified && typeof row.notified === "object" ? row.notified : {};
  const costs = row.costs && typeof row.costs === "object" ? row.costs : {};
  const fee = Number(costs.feeRatePerSide);
  const slip = Number(costs.slippageRatePerSide);

  return {
    ...row,
    side,
    entry,
    stop,
    tp1,
    tp3,
    r,
    market: row.market === "spot" ? "spot" : "futures",
    watchFromMs: Number.isFinite(watchFromMs) ? watchFromMs : Date.parse(row.sentAt) || 0,
    entryStatus: oneOf(row.entryStatus, ENTRY_STATUSES, "pending"),
    r1Status: oneOf(row.r1Status, LEG_STATUSES, "open"),
    r3Status: oneOf(row.r3Status, LEG_STATUSES, "open"),
    status: oneOf(row.status, RECORD_STATUSES, "open"),
    notified: {
      firstTarget: notified.firstTarget === true,
      final: notified.final === true,
    },
    costs: {
      feeRatePerSide: Number.isFinite(fee) ? fee : DEFAULT_COSTS.feeRatePerSide,
      slippageRatePerSide: Number.isFinite(slip) ? slip : DEFAULT_COSTS.slippageRatePerSide,
    },
    lastCandleTime: Number.isFinite(Number(row.lastCandleTime)) ? Number(row.lastCandleTime) : null,
    candlesSeen: Number(row.candlesSeen) || 0,
    dataGaps: Number(row.dataGaps) || 0,
  };
}

// ---------------------------------------------------------------------------
// Resolution state machine (pure)
// ---------------------------------------------------------------------------

function touches(candle, price) {
  return candle.low <= price && price <= candle.high;
}

function hitsStop(record, candle) {
  return record.side === "long" ? candle.low <= record.stop : candle.high >= record.stop;
}

function hitsTarget(record, candle, target) {
  return record.side === "long" ? candle.high >= target : candle.low <= target;
}

/**
 * Advance one record over a batch of closed 1m candles.
 *
 * Pure: returns a new record plus the notification events that fired. Callers
 * persist the record before sending anything, so a crash can never replay a
 * notification.
 */
function applyCandles(record, candles, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const expiryMs = Number.isFinite(options.expiryMs) ? options.expiryMs : DEFAULT_EXPIRY_HOURS * 3600 * 1000;
  const next = { ...record, notified: { ...record.notified } };
  const events = [];

  if (next.status !== "open") return { record: next, events };

  const usable = (candles || [])
    .filter((c) => c
      && Number.isFinite(c.time)
      && Number.isFinite(c.high)
      && Number.isFinite(c.low)
      && c.high >= c.low)
    // Never resolve a setup with price action that predates its own alert.
    .filter((c) => c.time >= next.watchFromMs)
    .filter((c) => !Number.isFinite(next.lastCandleTime) || c.time > next.lastCandleTime)
    .sort((a, b) => a.time - b.time);

  for (const candle of usable) {
    next.lastCandleTime = candle.time;
    next.candlesSeen += 1;

    if (next.entryStatus === "pending") {
      if (touches(candle, next.entry)) {
        next.entryStatus = "entered";
        next.entryTime = new Date(candle.time).toISOString();
      } else if (hitsStop(next, candle)) {
        // Price reached invalidation without ever trading the exact entry.
        next.entryStatus = "cancelled";
        next.status = "cancelled";
        next.r1Status = "void";
        next.r3Status = "void";
        next.finalisedAt = new Date(candle.time).toISOString();
        break;
      } else {
        continue;
      }
    }

    const at = new Date(candle.time).toISOString();
    const stopped = hitsStop(next, candle);

    if (next.r1Status === "open") {
      if (stopped) {
        // OHLC ambiguity rule: stop first, even if a target is in this candle.
        next.r1Status = "sl";
        next.r1ResolvedAt = at;
        next.r3Status = "sl";
        next.r3ResolvedAt = at;
        next.status = "complete";
        next.finalisedAt = at;
        events.push({ type: "final", at });
        break;
      }
      if (hitsTarget(next, candle, next.tp1)) {
        next.r1Status = "tp";
        next.r1ResolvedAt = at;
        if (hitsTarget(next, candle, next.tp3)) {
          next.r3Status = "tp";
          next.r3ResolvedAt = at;
          next.status = "complete";
          next.finalisedAt = at;
          events.push({ type: "final", at });
          break;
        }
        events.push({ type: "first_target", at });
        continue;
      }
      continue;
    }

    if (next.r3Status === "open") {
      if (stopped) {
        next.r3Status = "sl";
        next.r3ResolvedAt = at;
        next.status = "complete";
        next.finalisedAt = at;
        events.push({ type: "final", at });
        break;
      }
      if (hitsTarget(next, candle, next.tp3)) {
        next.r3Status = "tp";
        next.r3ResolvedAt = at;
        next.status = "complete";
        next.finalisedAt = at;
        events.push({ type: "final", at });
        break;
      }
    }
  }

  // Expiry never invents an outcome: unresolved legs are voided, not scored.
  if (next.status === "open" && now - next.watchFromMs >= expiryMs) {
    next.status = "expired";
    next.finalisedAt = new Date(now).toISOString();
    if (next.entryStatus === "pending") next.entryStatus = "expired";
    if (next.r1Status === "open") next.r1Status = "void";
    if (next.r3Status === "open") next.r3Status = "void";
  }

  return { record: next, events: dedupeEvents(next, events) };
}

/**
 * Collapse the emitted events into at most one first-target and one final
 * notification, and drop anything this record has already announced. The flags
 * live on the record, so dedup survives a restart.
 */
function dedupeEvents(record, events) {
  const out = [];
  for (const event of events) {
    if (event.type === "first_target") {
      if (record.notified.firstTarget || record.notified.final) continue;
      record.notified.firstTarget = true;
      out.push(event);
    } else if (event.type === "final") {
      if (record.notified.final) continue;
      // A setup that ran straight to 3:1 in one candle sends only the final
      // message; the intermediate first-target ping would be noise.
      record.notified.firstTarget = true;
      record.notified.final = true;
      out.push({ ...event, r1Status: record.r1Status, r3Status: record.r3Status });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Round-trip cost expressed in R, using the configured fee/slippage. */
function costInR(record) {
  const fee = Number(record.costs && record.costs.feeRatePerSide) || 0;
  const slip = Number(record.costs && record.costs.slippageRatePerSide) || 0;
  const perSide = fee + slip;
  const costPrice = record.entry * perSide * 2;
  return record.r > 0 ? costPrice / record.r : 0;
}

function legResult(status, multiple, record) {
  if (status === "tp") return multiple - costInR(record);
  if (status === "sl") return -1 - costInR(record);
  return null;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

/**
 * One-sample t-statistic against a zero-expectancy null. Needs at least two
 * observations and some variance, otherwise it is not defined.
 */
function tStat(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  const variance = values.reduce((sum, n) => sum + (n - m) ** 2, 0) / (values.length - 1);
  const sd = Math.sqrt(variance);
  if (!Number.isFinite(sd) || sd === 0) return null;
  return m / (sd / Math.sqrt(values.length));
}

function legSummary(records, statusField, multiple) {
  const nets = [];
  const grosses = [];
  let tp = 0;
  let sl = 0;
  for (const record of records) {
    const status = record[statusField];
    if (status !== "tp" && status !== "sl") continue;
    if (status === "tp") tp += 1;
    else sl += 1;
    grosses.push(status === "tp" ? multiple : -1);
    nets.push(legResult(status, multiple, record));
  }
  const resolved = tp + sl;
  return {
    tp,
    sl,
    resolved,
    winRate: resolved ? (tp / resolved) * 100 : 0,
    grossExpectancyR: resolved ? mean(grosses) : 0,
    netExpectancyR: resolved ? mean(nets) : 0,
    tStat: tStat(nets),
  };
}

function summarise(records, options = {}) {
  const rows = Array.isArray(records) ? records : [];
  const sent = rows.filter((r) => r && r.sentAt);
  const times = sent.map((r) => Date.parse(r.sentAt)).filter(Number.isFinite).sort((a, b) => a - b);

  const entered = rows.filter((r) => r.entryStatus === "entered");
  const awaitingEntry = rows.filter((r) => r.status === "open" && r.entryStatus === "pending");
  const enteredMonitoring = rows.filter((r) => r.status === "open" && r.entryStatus === "entered");
  const cancelled = rows.filter((r) => r.status === "cancelled");
  const expired = rows.filter((r) => r.status === "expired");
  const expiredBeforeEntry = expired.filter((r) => r.entryStatus === "expired");
  const expiredAfterEntry = expired.filter((r) => r.entryStatus === "entered");
  const openNow = rows.filter((r) => r.status === "open");
  const neverActivated = rows.filter((r) => r.entryStatus === "pending" || r.entryStatus === "cancelled" || r.entryStatus === "expired");
  const complete = rows.filter((r) => r.status === "complete");

  return {
    total: rows.length,
    firstAlertAt: times.length ? new Date(times[0]).toISOString() : null,
    lastAlertAt: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    entered: entered.length,
    neverActivated: neverActivated.length,
    awaitingEntry: awaitingEntry.length,
    enteredMonitoring: enteredMonitoring.length,
    cancelled: cancelled.length,
    stillMonitoring: openNow.length,
    expired: expired.length,
    expiredBeforeEntry: expiredBeforeEntry.length,
    expiredAfterEntry: expiredAfterEntry.length,
    completed: complete.length,
    dataGaps: rows.filter((r) => Number(r.dataGaps) > 0).length,
    // Score each leg independently. If the first target was reached and the
    // final leg later expired, the valid first-target result still belongs in
    // the 1:1 sample while the unresolved 3:1 leg remains excluded.
    oneR: legSummary(rows, "r1Status", 1),
    threeR: legSummary(rows, "r3Status", 3),
    costs: options.costs || DEFAULT_COSTS,
  };
}

// ---------------------------------------------------------------------------
// Persistence + tracker
// ---------------------------------------------------------------------------

function loadRecords(file, logger) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error(`outcomes: ${file} is not valid JSON (${err.message}). Continuing with an empty ledger.`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.error(`outcomes: ${file} did not contain an array. Continuing with an empty ledger.`);
    return [];
  }
  const clean = [];
  let dropped = 0;
  for (const row of parsed) {
    const record = sanitizeRecord(row);
    if (record) clean.push(record);
    else dropped += 1;
  }
  if (dropped) {
    logger.error(`outcomes: ignored ${dropped} malformed record(s) in ${file}.`);
  }
  return clean;
}

/** Atomic write: a torn file would take the whole trial down with it. */
function saveRecords(file, records) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
  fs.renameSync(tmp, file);
}

function createOutcomeTracker(options = {}) {
  const file = options.file;
  const maxRecords = Number(options.maxRecords) || DEFAULT_MAX_RECORDS;
  const logger = options.logger || console;
  const fetchCandles = options.fetchCandles;
  const notify = options.notify || (async () => {});
  const costs = { ...DEFAULT_COSTS, ...(options.costs || {}) };
  const expiryHours = Number(options.expiryHours) > 0 ? Number(options.expiryHours) : DEFAULT_EXPIRY_HOURS;
  const expiryMs = expiryHours * 3600 * 1000;
  const candleLimit = Number(options.candleLimit) || 300;

  let records = loadRecords(file, logger);

  function persist() {
    // Keep every unresolved setup; prune only finished history past the cap.
    if (records.length > maxRecords) {
      const open = records.filter((r) => r.status === "open");
      const closed = records.filter((r) => r.status !== "open");
      records = open.concat(closed.slice(0, Math.max(0, maxRecords - open.length)));
    }
    saveRecords(file, records);
  }

  function find(id) {
    return records.find((r) => r.id === id) || null;
  }

  /**
   * Register a published setup. Returns the record (existing one if this exact
   * signal was already tracked) or null if the plan is not monitorable.
   */
  function track(signal, sentAt = new Date().toISOString()) {
    const plan = buildTradePlan(signal);
    if (!plan) {
      logger.error(`outcomes: rejected ${signal && signal.symbol} - entry/stop/target are missing or invalid.`);
      return null;
    }
    const key = dedupeKey(signal);
    const existing = records.find((r) => r.key === key);
    if (existing) return existing;

    const record = createRecord({
      signal,
      plan,
      id: makeAlertId(signal, records),
      sentAt,
      costs,
    });
    records.unshift(record);
    persist();
    return record;
  }

  function replace(record) {
    const index = records.findIndex((r) => r.id === record.id);
    if (index === -1) records.unshift(record);
    else records[index] = record;
  }

  /** Advance one record. Persists before notifying so dedup survives a crash. */
  async function advance(record, now) {
    const pair = { api: record.symbol, market: record.market };
    let candles;
    try {
      candles = await fetchCandles(pair, "1m", candleLimit);
    } catch (err) {
      logger.error(`outcomes: candle fetch failed for ${record.id}: ${err.message}`);
      return [];
    }
    if (!Array.isArray(candles) || !candles.length) {
      logger.error(`outcomes: no 1m candles returned for ${record.id} (${record.symbol}).`);
      return [];
    }

    const fresh = candles
      .filter((c) => c && Number.isFinite(c.time) && c.time >= record.watchFromMs)
      .filter((c) => !Number.isFinite(record.lastCandleTime) || c.time > record.lastCandleTime)
      .sort((a, b) => a.time - b.time);

    // A window longer than the fetch can cover means minutes we will never see.
    // Flag it instead of pretending the missing minutes were uneventful.
    const expectedFrom = Number.isFinite(record.lastCandleTime)
      ? record.lastCandleTime + MINUTE_MS
      : record.watchFromMs;
    let gapped = false;
    if (fresh.length && fresh[0].time > expectedFrom + MINUTE_MS) {
      gapped = true;
      logger.error(`outcomes: monitoring gap for ${record.id}: missing 1m candles from ` +
        `${new Date(expectedFrom).toISOString()} to ${new Date(fresh[0].time).toISOString()}.`);
    }

    const result = applyCandles(record, fresh, { now, expiryMs });
    if (gapped) result.record.dataGaps += 1;
    replace(result.record);
    persist();

    for (const event of result.events) {
      try {
        await notify(event, result.record);
      } catch (err) {
        logger.error(`outcomes: notification failed for ${record.id}: ${err.message}`);
      }
    }
    return result.events;
  }

  /** Sweep every unresolved setup once. */
  async function poll(now = Date.now()) {
    const open = records.filter((r) => r.status === "open");
    const events = [];
    for (const record of open) {
      try {
        events.push(...await advance(record, now));
      } catch (err) {
        logger.error(`outcomes: monitoring ${record.id} failed: ${err.message}`);
      }
    }
    return events;
  }

  return {
    track,
    poll,
    advance,
    find,
    persist,
    get records() {
      return records;
    },
    summary(now = Date.now()) {
      return { ...summarise(records, { costs }), now, expiryHours };
    },
    costs,
    expiryHours,
  };
}

module.exports = {
  DEFAULT_COSTS,
  DEFAULT_EXPIRY_HOURS,
  applyCandles,
  baseAsset,
  buildTradePlan,
  createOutcomeTracker,
  createRecord,
  dedupeKey,
  loadRecords,
  makeAlertId,
  sanitizeRecord,
  saveRecords,
  summarise,
  tStat,
};
