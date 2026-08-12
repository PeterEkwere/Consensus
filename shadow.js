/**
 * Consensus Reaper - shadow research ledger.
 *
 * A gate that is never measured is a belief, not a rule. When a subjective gate
 * withholds a candidate that had a perfectly valid entry, stop and targets, the
 * only way to learn whether that gate helped is to keep monitoring the setup as
 * if it had been published - without telling anyone about it.
 *
 * Hard boundaries, enforced here and by tests:
 *
 * - Shadow records are NEVER sent to Telegram and never become alerts.
 * - They use a visibly different id namespace (`SH-`), so a shadow id can never
 *   be mistaken for a published one in a log or a report.
 * - They live in a separate file and can never reach published `/results`.
 * - They reuse the SAME candle eligibility and stop-first outcome rules, so
 *   their evidence is comparable with published evidence.
 * - Only candidates with a valid canonical plan are shadowed. Malformed prices,
 *   unavailable data and undefined risk are NOT shadowed: a setup we could not
 *   have traded is not evidence about a gate.
 *
 * Persistence is atomic, 0600, with a schema version.
 */

"use strict";

const fs = require("fs");

const SCHEMA_VERSION = 1;
const FILE_MODE = 0o600;
const ID_PREFIX = "SH";
const DEFAULT_MAX_RECORDS = 2000;

/** Rejection reasons that are worth measuring rather than merely logging. */
const SHADOW_REASONS = Object.freeze({
  CORRELATED_LOWER_RANK: "correlated_lower_rank",
  DUPLICATE_THESIS: "duplicate_thesis",
  BELOW_THRESHOLD: "below_threshold",
  REGIME_CONTRADICTION: "regime_contradiction",
  INSUFFICIENT_FAMILIES: "insufficient_families",
  EXECUTION_COST: "execution_cost",
  EXECUTION_CHASE: "execution_chase",
  EXECUTION_SPREAD: "execution_spread",
});

/**
 * Reasons that must NEVER produce a shadow record.
 *
 * These describe a setup we could not have measured in the first place, so
 * tracking them would pollute the gate evidence with data failures.
 */
const NEVER_SHADOW = Object.freeze([
  "quote_unavailable",
  "quote_malformed",
  "quote_wrong_instrument",
  "quote_stale",
  "cost_non_finite",
  "invalid_plan",
  "missing_candles",
]);

function isShadowable(reason) {
  return Boolean(reason) && !NEVER_SHADOW.includes(reason);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function writeAtomic(file, contents) {
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = fs.openSync(tmp, "w", FILE_MODE);
  try {
    fs.writeFileSync(handle, contents);
    try {
      fs.fsyncSync(handle);
    } catch {
      // Some shared hosts refuse fsync; the rename is still atomic.
    }
  } finally {
    fs.closeSync(handle);
  }
  fs.chmodSync(tmp, FILE_MODE);
  fs.renameSync(tmp, file);
}

function loadShadow(file, logger = console) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { schemaVersion: SCHEMA_VERSION, records: [] };
    throw new Error(`shadow ledger ${file} could not be read; refusing to overwrite it.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`shadow ledger ${file} is not valid JSON; refusing to overwrite it.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`shadow ledger ${file} has an invalid document shape; refusing to overwrite it.`);
  }
  const version = Number(parsed.schemaVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`shadow ledger ${file} has no usable schema version; refusing to overwrite it.`);
  }
  if (Number.isFinite(version) && version > SCHEMA_VERSION) {
    // Refuse to downgrade rather than silently rewrite a newer ledger.
    throw new Error(`shadow ledger ${file} was written by a newer schema (${version}).`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    records: Array.isArray(parsed.records) ? parsed.records : [],
  };
}

function saveShadow(file, records) {
  writeAtomic(file, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, records }, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Create a shadow ledger.
 *
 * `applyCandles` and `createRecord` are injected from the published outcome
 * module so shadow evidence is produced by exactly the same state machine, not
 * by a second implementation that could drift.
 */
function createShadowLedger(options) {
  const {
    file,
    createRecord,
    applyCandles,
    fetchCandles,
    maxRecords = DEFAULT_MAX_RECORDS,
    expiryMs,
    logger = console,
  } = options;

  const loaded = loadShadow(file, logger);
  let records = loaded.records;

  function persist() {
    if (records.length > maxRecords) {
      const open = records.filter((r) => r.status === "open");
      const closed = records.filter((r) => r.status !== "open");
      records = open.concat(closed.slice(0, Math.max(0, maxRecords - open.length)));
    }
    saveShadow(file, records);
  }

  function shadowId(published) {
    // Visibly distinct namespace: a shadow id can never read as an alert id.
    // `baseId` is generated from the public ledger, so it may repeat when the
    // public ledger has no row for this symbol/day. Sequence against shadow
    // rows too, otherwise several withheld BTC setups could all be `...-001`.
    const match = String(published).match(/^(.*)-(\d+)$/);
    if (!match) return `${ID_PREFIX}-${published}`;
    const prefix = `${ID_PREFIX}-${match[1]}`;
    let highest = 0;
    for (const record of records) {
      if (!record || typeof record.id !== "string" || !record.id.startsWith(`${prefix}-`)) continue;
      const sequence = Number(record.id.slice(prefix.length + 1));
      if (Number.isFinite(sequence) && sequence > highest) highest = sequence;
    }
    return `${prefix}-${String(highest + 1).padStart(match[2].length, "0")}`;
  }

  /**
   * Record a withheld candidate. Returns the record, or null when the candidate
   * is not eligible for shadow tracking or is already present.
   */
  function track({ signal, plan, baseId, sentAt, costs, reasons, context, evidence, execution }) {
    const list = Array.isArray(reasons) ? reasons.filter(Boolean) : [reasons].filter(Boolean);
    if (!list.length || !list.every(isShadowable)) return null;
    if (!plan) return null;

    const key = `${signal.market}:${signal.symbol}:${signal.side}:${signal.time}`;
    const existing = records.find((r) => r.key === key);
    if (existing) return existing;

    const base = createRecord({ signal, plan, id: shadowId(baseId), sentAt, costs });
    const record = {
      ...base,
      shadow: true,
      rejectionReasons: list,
      clusterId: signal.clusterId || null,
      thesisKey: signal.thesisKey || null,
      cohortId: signal.cohortId || null,
      score: signal.score,
      familyCount: evidence ? evidence.familyCount : null,
      execution: execution || null,
      context: context || null,
    };
    records.unshift(record);
    persist();
    return record;
  }

  /** Advance every open shadow record. Never notifies: there is no notifier. */
  async function poll(now = Date.now()) {
    const open = records.filter((r) => r.status === "open");
    // Fetch once per instrument, not once per withheld setup. A busy shadow
    // ledger may contain many decisions on the same market; duplicating the
    // same public candle request for every row would waste bandwidth and RAM.
    const groups = new Map();
    for (const record of open) {
      const key = `${record.market}:${record.symbol}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    }
    for (const group of groups.values()) {
      const representative = group[0];
      let candles = [];
      try {
        candles = await fetchCandles(
          { api: representative.symbol, market: representative.market },
          "1m",
          300,
        );
      } catch (err) {
        for (const record of group) record.dataGaps = (record.dataGaps || 0) + 1;
        logger.error(`shadow: candle fetch failed for ${representative.symbol}: ${err.message}`);
        continue;
      }
      if (!Array.isArray(candles) || !candles.length) {
        for (const record of group) record.dataGaps = (record.dataGaps || 0) + 1;
        continue;
      }
      for (const record of group) {
        // Same eligibility and stop-first rules as published outcomes.
        const result = applyCandles(record, candles, { now, expiryMs });
        const index = records.findIndex((r) => r.id === record.id);
        // Events are discarded on purpose: shadow records never notify.
        if (index >= 0) records[index] = { ...result.record, shadow: true };
      }
    }
    persist();
  }

  return {
    get records() {
      return records;
    },
    track,
    poll,
    persist,
    find: (id) => records.find((r) => r.id === id) || null,
  };
}

/**
 * Group shadow outcomes by rejection reason.
 * `legSample` is injected so the caller decides how a leg becomes a net-R row.
 */
function summariseByReason(records, legSample) {
  const groups = new Map();
  for (const record of records || []) {
    for (const reason of record.rejectionReasons || ["unknown"]) {
      if (!groups.has(reason)) groups.set(reason, []);
      groups.get(reason).push(record);
    }
  }
  const out = {};
  for (const [reason, rows] of groups) {
    out[reason] = {
      reason,
      total: rows.length,
      entered: rows.filter((r) => r.entryStatus === "entered").length,
      cancelled: rows.filter((r) => r.status === "cancelled").length,
      expired: rows.filter((r) => r.status === "expired").length,
      completed: rows.filter((r) => r.status === "complete").length,
      oneR: legSample(rows, "r1Status", 1),
      threeR: legSample(rows, "r3Status", 3),
    };
  }
  return out;
}

module.exports = {
  ID_PREFIX,
  NEVER_SHADOW,
  SCHEMA_VERSION,
  SHADOW_REASONS,
  createShadowLedger,
  isShadowable,
  loadShadow,
  saveShadow,
  summariseByReason,
};
