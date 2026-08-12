/**
 * Consensus FX Sentinel - private atomic persistence.
 *
 * Plain JSON files, no database. Every file is created 0600 inside a 0700
 * directory, written to a same-directory temporary file, fsynced where
 * practical, then atomically renamed. A torn write would corrupt an entire
 * research cohort, so partial writes must never become visible.
 *
 * Unknown or malformed state fails loudly with a PATH-ONLY error. Silently
 * overwriting a state file the runtime cannot understand would destroy
 * evidence.
 *
 * Importing this module touches no filesystem. All calls are explicit.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

class StateError extends Error {
  constructor(message, filePath) {
    super(message);
    this.name = "StateError";
    this.path = filePath;
  }
}

/** Create the state directory if needed, private to the owner. */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    fs.chmodSync(dir, DIR_MODE);
  } catch {
    // A pre-existing directory owned by another uid cannot be tightened here;
    // the caller's umask still governs the files we create inside it.
  }
  return dir;
}

/**
 * Atomic write: temp file in the same directory (so rename cannot cross a
 * filesystem boundary), fsync, then rename over the target.
 */
function writeFileAtomic(filePath, contents) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  const handle = fs.openSync(tmp, "w", FILE_MODE);
  try {
    fs.writeFileSync(handle, contents);
    try {
      fs.fsyncSync(handle);
    } catch {
      // fsync is unavailable on some shared hosts; the rename is still atomic.
    }
  } finally {
    fs.closeSync(handle);
  }
  fs.chmodSync(tmp, FILE_MODE);
  fs.renameSync(tmp, filePath);
}

/**
 * Read a versioned JSON document.
 *
 * A missing file yields the supplied default. A malformed file or an unknown
 * schema version throws, naming the path only.
 */
function readJson(filePath, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    throw new StateError(`Could not read state file: ${filePath}`, filePath);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StateError(
      `State file is not valid JSON: ${filePath}. Refusing to overwrite it. ` +
      `Move it aside to start fresh.`,
      filePath,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StateError(`State file must contain a JSON object: ${filePath}`, filePath);
  }
  const version = Number(parsed.schemaVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw new StateError(`State file has no usable schemaVersion: ${filePath}`, filePath);
  }
  if (version > SCHEMA_VERSION) {
    throw new StateError(
      `State file ${filePath} was written by a newer version ` +
      `(schemaVersion ${version} > ${SCHEMA_VERSION}). Refusing to downgrade it.`,
      filePath,
    );
  }
  return parsed;
}

/** Write a versioned JSON document atomically. */
function writeJson(filePath, data) {
  const payload = { ...data, schemaVersion: SCHEMA_VERSION };
  writeFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

/**
 * Append one JSON record per line. The journal is append-only research
 * evidence, so it is never rewritten in place.
 */
function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath));
  const line = `${JSON.stringify(record)}\n`;
  const handle = fs.openSync(filePath, "a", FILE_MODE);
  try {
    fs.writeFileSync(handle, line);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.chmodSync(filePath, FILE_MODE);
  } catch {
    // Best effort; the file was created with the right mode.
  }
}

/** Read a JSONL journal, skipping unparseable lines rather than throwing. */
function readJsonl(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { records: [], skipped: 0 };
    throw new StateError(`Could not read journal: ${filePath}`, filePath);
  }
  const records = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

/**
 * A small file-backed store for one bounded JSON document.
 * Construction performs no I/O; `load()` and `save()` are explicit.
 */
function createStore(filePath, defaults) {
  let cache = null;
  return {
    path: filePath,
    load() {
      if (cache === null) {
        cache = readJson(filePath, { ...defaults, schemaVersion: SCHEMA_VERSION });
      }
      return cache;
    },
    save(data) {
      cache = writeJson(filePath, data);
      return cache;
    },
    reset() {
      cache = null;
    },
  };
}

/**
 * Drop completed records older than the retention window.
 *
 * Exposed and tested, but deliberately NOT scheduled: deleting research
 * evidence is a decision a human takes explicitly.
 */
function compactCompleted(records, { now = Date.now(), retentionDays = 90 } = {}) {
  const cutoff = now - retentionDays * 24 * 3600 * 1000;
  const kept = [];
  let removed = 0;
  for (const record of records) {
    const finished = record && ["complete", "cancelled_before_entry", "expired"].includes(record.status);
    const at = Date.parse(record && (record.finalisedAt || record.sentAt));
    if (finished && Number.isFinite(at) && at < cutoff) {
      removed += 1;
      continue;
    }
    kept.push(record);
  }
  return { kept, removed };
}

module.exports = {
  DIR_MODE,
  FILE_MODE,
  SCHEMA_VERSION,
  StateError,
  appendJsonl,
  compactCompleted,
  createStore,
  ensureDir,
  readJson,
  readJsonl,
  writeFileAtomic,
  writeJson,
};
