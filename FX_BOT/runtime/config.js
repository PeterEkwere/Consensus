/**
 * Consensus FX Sentinel - configuration.
 *
 * Every numeric buffer and window the detectors use lives in ONE frozen object
 * here. A stable `configHash` is derived from it and stored with every
 * candidate, so a result can always be traced back to the exact rules that
 * produced it. Changing any tuning value changes the hash and therefore starts
 * a new research cohort rather than silently rewriting old ones.
 *
 * Importing this module reads nothing and writes nothing. `loadEnv` and
 * `loadConfig` are explicit calls.
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const budget = require("./budget");

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

/**
 * Instrument metadata. `precision` is the number of decimals a price is
 * displayed and tracked at; `pip` is one pip in price units. Levels are rounded
 * to `precision` once, at final construction, and that rounded value is both
 * displayed and tracked.
 */
const BASE_SYMBOLS = {
  EUR_USD: Object.freeze({
    id: "EUR_USD",
    tiingo: "eurusd",
    display: "EUR / USD",
    tradingView: "OANDA:EURUSD",
    precision: 5,
    pip: 0.0001,
    maxSpreadPips: 2.0,
    minStopPips: 3.0,
    maxStopPips: 40.0,
  }),
  GBP_USD: Object.freeze({
    id: "GBP_USD",
    tiingo: "gbpusd",
    display: "GBP / USD",
    tradingView: "OANDA:GBPUSD",
    precision: 5,
    pip: 0.0001,
    maxSpreadPips: 2.5,
    minStopPips: 4.0,
    maxStopPips: 50.0,
  }),
  USD_JPY: Object.freeze({
    id: "USD_JPY",
    tiingo: "usdjpy",
    display: "USD / JPY",
    tradingView: "OANDA:USDJPY",
    precision: 3,
    pip: 0.01,
    maxSpreadPips: 2.0,
    minStopPips: 3.0,
    maxStopPips: 40.0,
  }),
  XAU_USD: Object.freeze({
    id: "XAU_USD",
    tiingo: "xauusd",
    display: "Gold / US Dollar",
    tradingView: "OANDA:XAUUSD",
    precision: 2,
    pip: 0.1,
    maxSpreadPips: 6.0,
    minStopPips: 10.0,
    maxStopPips: 200.0,
  }),
};

/**
 * Additional supported instruments.
 *
 * These are SUPPORTED, not active. Activating them is a separate decision with
 * a hard cost: one scan already needs `1 + 4 * instruments` Tiingo requests, so
 * all twenty-four would exceed the documented free hourly allowance in a single
 * scan. See budget.js.
 *
 * Metadata is derived mechanically from the pair's own currencies rather than
 * hand-picked per pair. Nothing here is tuned to any observed result - there is
 * no result to tune to, because none of these has ever been traded or measured.
 */
const ADDITIONAL_PAIRS = Object.freeze([
  "EUR_CAD", "EUR_GBP", "EUR_JPY", "EUR_CHF", "EUR_AUD", "EUR_NZD",
  "GBP_CAD", "GBP_JPY", "GBP_CHF", "GBP_AUD", "GBP_NZD",
  "AUD_USD", "AUD_JPY", "AUD_CAD", "AUD_NZD", "AUD_CHF",
  "NZD_USD", "NZD_JPY",
  "USD_CAD", "USD_CHF",
]);

/**
 * Spread and stop-distance policy by pair class, extended mechanically from the
 * three existing currency pairs:
 *
 *   usdMajor  <- EUR_USD / USD_JPY  (2.0 / 3.0 / 40.0)
 *   usdSterling <- GBP_USD          (2.5 / 4.0 / 50.0)
 *   cross     <- one step wider than a USD major, because crosses are quoted
 *                through two USD legs and carry both spreads
 *   crossSterling <- the same step applied to the sterling baseline
 */
const PAIR_CLASS_POLICY = Object.freeze({
  usdMajor: Object.freeze({ maxSpreadPips: 2.0, minStopPips: 3.0, maxStopPips: 40.0 }),
  usdSterling: Object.freeze({ maxSpreadPips: 2.5, minStopPips: 4.0, maxStopPips: 50.0 }),
  cross: Object.freeze({ maxSpreadPips: 3.5, minStopPips: 5.0, maxStopPips: 60.0 }),
  crossSterling: Object.freeze({ maxSpreadPips: 4.0, minStopPips: 6.0, maxStopPips: 70.0 }),
});

function classifyPair(base, quote) {
  const hasUsd = base === "USD" || quote === "USD";
  const hasGbp = base === "GBP" || quote === "GBP";
  if (hasUsd) return hasGbp ? "usdSterling" : "usdMajor";
  return hasGbp ? "crossSterling" : "cross";
}

/** Build one instrument's metadata from its currency pair alone. */
function buildSymbol(id) {
  const [base, quote] = id.split("_");
  const flat = `${base}${quote}`;
  // The established conventions: yen quotes carry two fewer decimals.
  const isJpyQuote = quote === "JPY";
  const policy = PAIR_CLASS_POLICY[classifyPair(base, quote)];
  return Object.freeze({
    id,
    tiingo: flat.toLowerCase(),
    display: `${base} / ${quote}`,
    tradingView: `OANDA:${flat}`,
    precision: isJpyQuote ? 3 : 5,
    pip: isJpyQuote ? 0.01 : 0.0001,
    base,
    quote,
    ...policy,
  });
}

for (const id of ADDITIONAL_PAIRS) {
  BASE_SYMBOLS[id] = buildSymbol(id);
}

/** Every instrument the runtime knows how to request and price. */
const SYMBOLS = Object.freeze(BASE_SYMBOLS);

const SUPPORTED_SYMBOLS = Object.freeze(Object.keys(SYMBOLS));

/**
 * The active universe when `FX_SYMBOLS` is absent.
 *
 * Deliberately NOT "everything supported": adding instruments must be an
 * explicit decision, because it changes both the request budget and the cohort.
 */
const DEFAULT_SYMBOL_IDS = Object.freeze(["EUR_USD", "GBP_USD", "USD_JPY", "XAU_USD"]);

// ---------------------------------------------------------------------------
// Frozen strategy tuning
// ---------------------------------------------------------------------------

/**
 * Detector tuning. Distances are in pips unless the name says otherwise;
 * fractions are of the referenced candle's body or range.
 *
 * These values are starting points chosen to express each playbook's rule
 * clearly. They are NOT fitted to any historical result and must not be tuned
 * in response to backtest or test output.
 */
const STRATEGY = deepFreeze({
  version: 1,

  // Frozen normalization denominator for the evidence families the six
  // playbooks actually emit. Keeping this inside STRATEGY makes any future
  // scoring change visible in the configuration fingerprint.
  qualityFamilyMax: {
    structure: 24,
    location: 22,
    liquidity: 24,
    candle: 16,
  },

  // Swing detection: a fractal needs this many candles either side to confirm.
  swingLeft: 2,
  swingRight: 2,

  // How far back detectors look, in candles, per timeframe.
  lookback: { M1: 240, M5: 180, M15: 120, H1: 120 },

  // A level counts as "touched" within this distance.
  levelProximityPips: 3.0,

  // Buffer added beyond a structural extreme when placing a stop.
  stopBufferPips: 1.5,
  // Multiplier applied to the observed spread when padding a stop.
  stopSpreadMultiple: 1.0,

  p1: {
    // Minimum distance the sweep candle must trade beyond the level.
    minSweepPips: 1.0,
    // Confirmation must close this far through the rejection candle's range.
    minConfirmFraction: 0.5,
    // Confirmation must arrive within this many M5 candles of the sweep.
    maxConfirmBars: 3,
  },

  p2: {
    // A body close must clear the level by this much; a wick is not a breakout.
    breakoutBufferPips: 1.0,
    // Retest must occur within this many M5 candles of the breakout close.
    maxRetestBars: 12,
    // Retest must come back within this distance of the broken level.
    retestProximityPips: 4.0,
  },

  p3: {
    // H1 must show at least this many confirmed directional swing sequences.
    minStructureLegs: 2,
    // Pullback must retrace at least this fraction of the last impulse.
    minPullbackFraction: 0.3,
    // ...and no more than this, or the move is considered broken.
    maxPullbackFraction: 0.9,
  },

  p4: {
    // Internal M5 break must close beyond the opposing swing by this much.
    minBreakPips: 0.8,
    maxRetestBars: 8,
    retestProximityPips: 3.0,
  },

  p5: {
    // A range needs this many confirmed touches of each boundary.
    minBoundaryTouches: 2,
    // Range width bounds, in pips, scaled by the instrument's pip size.
    minWidthPips: 8.0,
    maxWidthPips: 120.0,
    // Window, in M15 candles, over which the range must hold.
    windowBars: 24,
  },

  p6: {
    // The failed breakout must close back through the level within this many
    // candles of the breakout close.
    maxFailureBars: 6,
    // The close back inside must clear the level by this much.
    reentryBufferPips: 0.5,
  },

  // Hard gates.
  gates: {
    // Publication is refused if the latest quote has drifted this fraction of R
    // away from the canonical entry (no chasing).
    maxChaseFractionOfR: 0.25,
    // A live top-of-book quote older than this cannot support a new alert.
    maxQuoteAgeMinutes: 15,
    // Nearest opposing structure must leave at least this many R of room.
    minStructuralRoomR: 3.0,
    // Maximum published plans sharing one dominant currency exposure in a
    // single scan. One as exposure control, not as an optimised value: a
    // long-EUR view expressed through three crosses is still one view.
    maxPerExposureCluster: 1,
    // UTC hours during which setups may be published, inclusive start.
    sessionWindowsUtc: [
      { name: "london", startHour: 7, endHour: 16 },
      { name: "newYork", startHour: 12, endHour: 21 },
    ],
  },

  costs: {
    // Slippage assumed per side, in pips, added on top of the observed spread.
    slippagePips: 0.2,
    // Commission expressed in pips-equivalent for the round trip.
    commissionPips: 0.0,
  },

  // Playbook priority when several fire on the same symbol/side/candle.
  // Lower number wins. Deliberately explicit rather than emergent.
  playbookPriority: { P1: 1, P2: 2, P3: 3, P4: 4, P5: 5, P6: 6 },
});

// ---------------------------------------------------------------------------
// Freezing and hashing
// ---------------------------------------------------------------------------

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * Stable JSON: object keys are emitted in sorted order at every depth, so the
 * hash depends on values only, never on property insertion order.
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** Short, stable fingerprint of every setting that changes a decision cohort. */
function configHashOf(strategy, symbols, runtime = {}) {
  const canonicalSymbols = (symbols || [])
    .slice()
    .sort((a, b) => String(a.id || a).localeCompare(String(b.id || b)));
  const payload = stableStringify({ strategy, symbols: canonicalSymbols, runtime });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function strategyHashOf(strategy) {
  return crypto.createHash("sha256").update(stableStringify(strategy)).digest("hex").slice(0, 16);
}

function universeHashOf(symbols) {
  const ids = (symbols || []).map((symbol) => typeof symbol === "string" ? symbol : symbol.id).sort();
  return crypto.createHash("sha256").update(stableStringify(ids)).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const REQUIRED_LIVE_VARS = Object.freeze([
  "FX_TELEGRAM_BOT_TOKEN",
  "FX_TELEGRAM_CHAT_ID",
  "FX_OWNER_TELEGRAM_USER_ID",
  "FX_TIINGO_API_TOKEN",
]);

/**
 * Strict .env reader: blank lines, `#` comments and literal KEY=VALUE only.
 * No shell evaluation, no variable expansion, no multi-line values. Values
 * already present in `process.env` (for example from PM2) always win.
 */
function loadEnv(file, env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return env; // The file is optional; PM2 may supply everything.
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

function asBool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

function asInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Build the runtime configuration.
 *
 * `requireLive` makes missing credentials fatal. Errors name the variable and
 * never contain its value, so a stack trace can be pasted safely.
 */
function loadConfig(options = {}) {
  const env = options.env || process.env;
  const requireLive = options.requireLive === true;
  const requiredVars = Array.isArray(options.requiredVars)
    ? options.requiredVars
    : requireLive ? REQUIRED_LIVE_VARS : [];

  // Absent FX_SYMBOLS activates only the original four instruments. Supporting
  // an instrument and activating it are deliberately different decisions.
  const symbolIds = String(env.FX_SYMBOLS || DEFAULT_SYMBOL_IDS.join(","))
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const unknown = symbolIds.filter((id) => !SYMBOLS[id]);
  if (unknown.length) {
    throw new Error(`FX_SYMBOLS contains unsupported instrument(s): ${unknown.join(", ")}. ` +
      `Supported: ${SUPPORTED_SYMBOLS.join(", ")}`);
  }

  const researchMode = asBool(env.FX_RESEARCH_MODE, true);
  const sendResearchAlerts = asBool(env.FX_SEND_RESEARCH_ALERTS, false);

  // There is no authenticated economic-calendar provider in this version.
  // Allowing normal-mode messages would contradict the fail-safe news gate.
  if (!researchMode) {
    throw new Error("FX_RESEARCH_MODE must remain true until a live economic-news provider is configured.");
  }

  if (requiredVars.length) {
    const missing = requiredVars.filter((name) => !env[name]);
    if (missing.length) {
      // Names only. Never echo a value, not even a partial one.
      throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
    }
  }

  const scanIntervalSeconds = asInt(env.FX_SCAN_INTERVAL_SECONDS, 1800);
  const outcomeExpiryHours = asInt(env.FX_OUTCOME_EXPIRY_HOURS, 24);

  // Request-budget validation happens HERE, before any socket, poll or write,
  // so an over-subscribed configuration can never quietly degrade a live trial.
  const limits = {
    hourly: asInt(env.FX_PROVIDER_HOURLY_LIMIT, budget.FREE_TIER.hourly),
    daily: asInt(env.FX_PROVIDER_DAILY_LIMIT, budget.FREE_TIER.daily),
  };
  const budgetCheck = budget.validate({
    instrumentCount: symbolIds.length,
    scanIntervalSeconds,
    limits,
  });
  if (!budgetCheck.ok && options.enforceBudget !== false) {
    throw new Error(
      `Provider request budget exceeded: ${budgetCheck.problems.join(" ")}`,
    );
  }

  const stateDir = env.FX_STATE_DIR || "state";
  const config = {
    researchMode,
    sendResearchAlerts,
    symbols: symbolIds.map((id) => SYMBOLS[id]),
    symbolIds,
    scanIntervalSeconds,
    budget: budgetCheck.projection,
    outcomeExpiryHours,
    stateDir: path.isAbsolute(stateDir) ? stateDir : path.join(__dirname, "..", stateDir),
    tiingo: {
      baseUrl: "https://api.tiingo.com",
      token: env.FX_TIINGO_API_TOKEN || "",
    },
    telegram: {
      token: env.FX_TELEGRAM_BOT_TOKEN || "",
      seedChatId: env.FX_TELEGRAM_CHAT_ID ? String(env.FX_TELEGRAM_CHAT_ID) : "",
      ownerUserId: env.FX_OWNER_TELEGRAM_USER_ID ? String(env.FX_OWNER_TELEGRAM_USER_ID) : "",
    },
    strategy: STRATEGY,
    // Safety ceiling; scanning pauses above it rather than restarting.
    memoryCeilingMb: asInt(env.FX_MEMORY_CEILING_MB, 400),
  };

  config.alertMode = researchMode ? "research" : "normal";
  config.configHash = configHashOf(STRATEGY, symbolIds.map((id) => SYMBOLS[id]), {
    alertMode: config.alertMode,
    outcomeExpiryHours,
    scanIntervalSeconds,
  });
  config.strategyHash = strategyHashOf(STRATEGY);
  config.universeHash = universeHashOf(symbolIds);

  // Research mode is a floor, not a preference: live-style messaging cannot be
  // reached while it is on.
  // Redacted view for logs, status output and persisted diagnostics.
  config.describe = () => ({
    alertMode: config.alertMode,
    researchMode: config.researchMode,
    sendResearchAlerts: config.sendResearchAlerts,
    symbols: config.symbolIds,
    scanIntervalSeconds: config.scanIntervalSeconds,
    outcomeExpiryHours: config.outcomeExpiryHours,
    marketDataProvider: "tiingo",
    requestBudget: budget.describe(config.budget),
    configHash: config.configHash,
    strategyVersion: STRATEGY.version,
  });

  return config;
}

module.exports = {
  ADDITIONAL_PAIRS,
  DEFAULT_SYMBOL_IDS,
  PAIR_CLASS_POLICY,
  REQUIRED_LIVE_VARS,
  buildSymbol,
  classifyPair,
  STRATEGY,
  SYMBOLS,
  SUPPORTED_SYMBOLS,
  configHashOf,
  deepFreeze,
  loadConfig,
  loadEnv,
  stableStringify,
  strategyHashOf,
  universeHashOf,
};
