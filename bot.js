/**
 * Consensus Reaper
 *
 * Lean, single-file crypto market-structure alert bot for MAJOR exchange pairs.
 *
 * Data source (free, official, no API key, no wallet, no trading):
 * - OKX v5 market: https://www.okx.com/api/v5/market
 *   Spot instId    : BTC-USDT
 *   Perp instId    : BTC-USDT-SWAP
 *
 * Signals use a multi-timeframe consensus: the 15m chart is the primary setup
 * timeframe, the 1h chart gates the trade direction, and the 5m chart adds a
 * momentum trigger. Pairs are shown as TradingView symbols with chart links.
 *
 * Every published alert is registered with the outcome tracker (outcomes.js),
 * which resolves it against closed OKX 1m candles and reports how the setup
 * behaved. The bot never reads or touches a trading account.
 *
 * Commands:
 *   /start, /help        - command list
 *   /id                  - show current chat id
 *   /activate            - owner only, add this chat/group to alerts
 *   /deactivate          - owner only, remove this chat/group from alerts
 *   /status              - show runtime config
 *   /results             - owner only, trial statistics
 *   /scan                - owner only, run a manual scan now
 *   /testalert           - owner only, send a sample alert to this chat
 *   /pause, /resume      - owner only, pause/resume auto alerts
 *   /pairs               - list tracked pairs
 *   /addpair BTCUSDT           - owner only, add a spot pair
 *   /addpair BTCUSDT futures   - owner only, add a futures (perp) pair
 *   /removepair BTCUSDT  - owner only, remove a pair
 *   /resetpairs          - owner only, restore the default major pairs
 *   /threshold <score>   - owner only, set alert score threshold
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const telegramApi = require("node-telegram-bot-api");
const TelegramBot = telegramApi.TelegramBot || telegramApi;
const outcomeModule = require("./outcomes");
const { buildTradePlan, createOutcomeTracker, DEFAULT_COSTS } = outcomeModule;
const strategy = require("./strategy");
const execution = require("./execution");
const shadowModule = require("./shadow");
const { evidenceVerdict } = require("./stats");

// Runtime ledgers can contain operational details. Keep every newly-created
// file private even when the process manager itself was started with umask 022.
process.umask(0o077);

loadLocalEnv(path.join(__dirname, ".env"));

const BOT_NAME = "Consensus Reaper";
// The frozen decision rules. Changing anything inside changes the strategy
// hash and therefore starts a new research cohort.
const STRATEGY = strategy.STRATEGY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const OWNER_ID = 7059352737;
const DEFAULT_OWNER_CHAT_ID = 7059352737;

const EXCHANGE = "OKX";
const OKX_BASE = "https://www.okx.com/api/v5/market";

const STATE_FILE = path.join(__dirname, "state.json");
const SIGNALS_FILE = path.join(__dirname, "signals.json");
const ALERTS_FILE = path.join(__dirname, "alerts.json");
const OUTCOMES_FILE = path.join(__dirname, "outcomes.json");
const SHADOW_FILE = path.join(__dirname, "shadow-outcomes.json");
// A cohort is only worth a verdict once it has this many INDEPENDENT market
// events. Chosen as a sample-size floor, not from any observed result.
const TRIAL_MIN_CLUSTERS = 50;
const TRIAL_DAYS = 30;
const RISK_REWARD_RATIO = 3;
const SETUP_TIMEFRAME = "15m";
const SETUP_TIMEFRAME_LABEL = "15 minutes";
// How often unresolved setups are checked against closed OKX 1m candles.
const OUTCOME_POLL_MINUTES = 1;

// Default universe: major, liquid pairs. Majors are tracked on futures so that
// SHORT setups are actionable and TradingView links open the perpetual chart.
const DEFAULT_PAIRS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TRXUSDT",
  "SUIUSDT", "LTCUSDT", "BCHUSDT", "DOTUSDT",
  "NEARUSDT", "APTUSDT", "ARBUSDT", "OPUSDT", "UNIUSDT",
].map((symbol) => makePair(symbol, "futures"));

const DEFAULT_STATE = {
  paused: false,
  alertChatIds: [DEFAULT_OWNER_CHAT_ID],
  pairs: DEFAULT_PAIRS,
  scanIntervalMinutes: 5,
  alertThreshold: 65,
  cooldownMinutes: 30,
  useHtfGate: true,           // require the 1h trend to agree with the trade side
  minQuoteVolume24h: 5000000, // skip thin books: 24h quote volume floor (USDT)
  lastAlerts: {},
  // Outcome monitoring. Unresolved setups are closed out after this many hours
  // and reported separately, never counted as a win or a loss.
  outcomeExpiryHours: 24,
  feeRatePerSide: DEFAULT_COSTS.feeRatePerSide,
  slippageRatePerSide: DEFAULT_COSTS.slippageRatePerSide,
  // Short-lived scheduled invocations replace an unsupported permanent PM2
  // process on shared hosting. These cursors make each invocation idempotent.
  telegramOffset: 0,
  lastScheduledScanAt: 0,
};

const MARKET_LABELS = {
  spot: "Spot",
  futures: "Futures",
};

let state = loadJson(STATE_FILE, DEFAULT_STATE);
state = migrateState(state);

const dryRun = process.argv.includes("--dry-run");
const sendTest = process.argv.includes("--send-test");
const scheduledRun = process.argv.includes("--scheduled-run");

// Assigned by main(). Left null when this file is required by a test so that
// nothing polls Telegram and no token is needed.
let bot = null;
let outcomes = null;
let shadow = null;

// ---------------------------------------------------------------------------
// State + env helpers
// ---------------------------------------------------------------------------

function makePair(symbol, market) {
  const api = String(symbol).toUpperCase();
  const suffix = market === "futures" ? ".P" : "";
  return {
    api,
    market: market === "futures" ? "futures" : "spot",
    tv: `OKX:${api}${suffix}`,
    label: labelFromSymbol(api),
  };
}

function labelFromSymbol(symbol) {
  const quotes = ["USDT", "USDC", "USD", "BTC", "ETH"];
  const sym = String(symbol).toUpperCase();
  for (const q of quotes) {
    if (sym.endsWith(q) && sym.length > q.length) {
      return `${sym.slice(0, sym.length - q.length)} / ${q}`;
    }
  }
  return sym;
}

function migrateState(loaded) {
  const next = { ...DEFAULT_STATE, ...(loaded || {}) };
  // Drop legacy fields from older (DEX / multi-exchange) versions.
  for (const key of [
    "networks", "minLiquidityUsd", "minVolumeH1Usd", "minTxH1",
    "maxPoolsPerNetwork", "watchedPools", "exchange",
  ]) {
    delete next[key];
  }
  // Seed / normalise the pair universe, refreshing TradingView symbols to OKX.
  if (!Array.isArray(next.pairs) || !next.pairs.length) {
    next.pairs = DEFAULT_PAIRS;
  } else {
    next.pairs = next.pairs
      .map((p) => {
        if (p && p.api && p.market) return makePair(p.api, p.market);
        if (typeof p === "string") return makePair(p, "futures");
        return null;
      })
      .filter(Boolean);
  }
  next.alertChatIds = Array.isArray(next.alertChatIds) && next.alertChatIds.length
    ? next.alertChatIds
    : [DEFAULT_OWNER_CHAT_ID];
  next.lastAlerts = next.lastAlerts || {};
  return next;
}

function loadLocalEnv(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // .env is optional. Production can use real environment variables.
  }
}

function loadJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    throw new Error(`Could not read private state file: ${file}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === undefined || parsed === null) throw new Error("empty");
    return parsed;
  } catch {
    throw new Error(`Private state file is not valid JSON: ${file}`);
  }
}

function saveJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  const fd = fs.openSync(tmp, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function appendJsonArray(file, item, maxItems = 500) {
  const rows = loadJson(file, []);
  if (!Array.isArray(rows)) throw new Error(`Private history file did not contain an array: ${file}`);
  rows.unshift(item);
  saveJson(file, rows.slice(0, maxItems));
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGetJson(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      timeout: timeoutMs,
      headers: {
        accept: "application/json",
        "user-agent": "ConsensusReaper/2.0",
      },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return resolve(null);
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function isOwner(msg) {
  return msg.from && msg.from.id === OWNER_ID;
}

function ownerGuard(msg) {
  if (isOwner(msg)) return true;
  sendHtml(msg.chat.id, "Not authorized. This command is owner-only.");
  return false;
}

function sendHtml(chatId, text, extra = {}) {
  if (!bot) return Promise.resolve(false);
  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...extra,
  }).then(() => true).catch((err) => {
    console.error("Telegram send failed:", err.message);
    return false;
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtUsd(n) {
  const value = Number(n) || 0;
  if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function fmtPrice(n) {
  const value = Number(n) || 0;
  if (value === 0) return "0";
  if (Math.abs(value) < 0.000001) return value.toExponential(2);
  if (Math.abs(value) < 0.001) return value.toFixed(8);
  if (Math.abs(value) < 1) return value.toFixed(6);
  if (Math.abs(value) < 100) return value.toFixed(4);
  return value.toFixed(2);
}

function pctChange(from, to) {
  if (!from) return 0;
  return ((to - from) / from) * 100;
}

function avg(values) {
  const nums = values.filter((n) => Number.isFinite(n));
  if (!nums.length) return 0;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function marketLabel(pair) {
  return `${EXCHANGE} ${MARKET_LABELS[pair.market] || pair.market}`;
}

function tvChartUrl(tvSymbol) {
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}`;
}

function parsePairInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/).filter(Boolean);
  let token = parts[0].toUpperCase();
  let market = null;

  // Explicit market word: "/addpair BTCUSDT futures"
  if (parts[1]) {
    const m = parts[1].toLowerCase();
    if (m === "futures" || m === "perp" || m === "perps") market = "futures";
    if (m === "spot") market = "spot";
  }

  // TradingView form: "OKX:BTCUSDT" or "OKX:BTCUSDT.P"; also tolerate dashes.
  const tvMatch = token.match(/^[A-Z]+:([A-Z0-9-]+?)(\.P)?$/);
  if (tvMatch) {
    token = tvMatch[1].replace(/-/g, "");
    if (tvMatch[2]) market = market || "futures";
  }
  token = token.replace(/-/g, "");

  if (!/^[A-Z0-9]{5,20}$/.test(token)) return null;
  return makePair(token, market || "spot");
}

// ---------------------------------------------------------------------------
// OKX data adapter
// ---------------------------------------------------------------------------

const OKX_BAR = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H" };

// "BTCUSDT" -> "BTC-USDT" (OKX uses dashed instrument ids).
function okxInstId(pair) {
  const quotes = ["USDT", "USDC", "USD"];
  const sym = pair.api.toUpperCase();
  let dashed = sym;
  for (const q of quotes) {
    if (sym.endsWith(q) && sym.length > q.length) {
      dashed = `${sym.slice(0, sym.length - q.length)}-${q}`;
      break;
    }
  }
  return pair.market === "futures" ? `${dashed}-SWAP` : dashed;
}

// OKX candle row: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]; newest first.
async function fetchCandles(pair, frame, limit = 200) {
  const bar = OKX_BAR[frame] || "15m";
  const url = `${OKX_BASE}/candles?instId=${encodeURIComponent(okxInstId(pair))}&bar=${bar}&limit=${limit}`;
  const json = await httpGetJson(url);
  const data = json && json.code === "0" && Array.isArray(json.data) ? json.data : null;
  if (!data) return [];
  const rows = data.map((r) => ({
    time: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[7] || 0), // quote-currency volume, works for spot and swap
    confirm: r[8],
  })).filter((c) => Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.time - b.time);
  // Drop the still-forming candle so analysis only sees closed bars.
  if (rows.length && rows[rows.length - 1].confirm === "0") rows.pop();
  return rows;
}

function quoteVolume24h(candles) {
  if (!candles.length) return 0;
  const lookback = Math.min(96, candles.length); // 96 x 15m = 24h
  let sum = 0;
  for (let i = candles.length - lookback; i < candles.length; i++) {
    sum += candles[i].volume || 0;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Technical analysis engine (timeframe-agnostic)
// ---------------------------------------------------------------------------

function ema(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = avg(values.slice(0, period));
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
    } else if (i === period - 1) {
      out.push(prev);
    } else {
      prev = values[i] * k + prev * (1 - k);
      out.push(prev);
    }
  }
  return out;
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close),
    ));
  }
  return avg(trs.slice(-period));
}

function rsi(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  const rows = candles.slice(-(period + 1));
  for (let i = 1; i < rows.length; i++) {
    const diff = rows[i].close - rows[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function candleBody(c) {
  return Math.abs(c.close - c.open);
}

function candleRange(c) {
  return Math.max(c.high - c.low, Number.EPSILON);
}

function isBull(c) {
  return c.close > c.open;
}

function isBear(c) {
  return c.open > c.close;
}

function candlePatterns(candles) {
  const out = [];
  if (candles.length < 3) return out;
  const a = candles[candles.length - 3];
  const b = candles[candles.length - 2];
  const c = candles[candles.length - 1];
  const body = candleBody(c);
  const range = candleRange(c);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);

  if (isBull(c) && isBear(b) && c.close >= b.open && c.open <= b.close) {
    out.push({ name: "Bullish engulfing", side: "long", weight: 16 });
  }
  if (isBear(c) && isBull(b) && c.open >= b.close && c.close <= b.open) {
    out.push({ name: "Bearish engulfing", side: "short", weight: 16 });
  }
  if (lowerWick > body * 2 && upperWick < range * 0.35 && body / range < 0.45) {
    out.push({ name: "Hammer rejection", side: "long", weight: 12 });
  }
  if (upperWick > body * 2 && lowerWick < range * 0.35 && body / range < 0.45) {
    out.push({ name: "Shooting star rejection", side: "short", weight: 12 });
  }
  if (isBear(a) && candleBody(b) < candleBody(a) * 0.7 && isBull(c) && c.close > (a.open + a.close) / 2) {
    out.push({ name: "Morning star", side: "long", weight: 14 });
  }
  if (isBull(a) && candleBody(b) < candleBody(a) * 0.7 && isBear(c) && c.close < (a.open + a.close) / 2) {
    out.push({ name: "Evening star", side: "short", weight: 14 });
  }
  return out;
}

function swingPoints(candles, radius = 2) {
  const highs = [];
  const lows = [];
  for (let i = radius; i < candles.length - radius; i++) {
    const c = candles[i];
    let high = true;
    let low = true;
    for (let j = i - radius; j <= i + radius; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) high = false;
      if (candles[j].low <= c.low) low = false;
    }
    if (high) highs.push({ index: i, price: c.high, time: c.time });
    if (low) lows.push({ index: i, price: c.low, time: c.time });
  }
  return { highs, lows };
}

function trendFromSwings(swings) {
  const highs = swings.highs.slice(-3);
  const lows = swings.lows.slice(-3);
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
    const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
    const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
    const ll = lows[lows.length - 1].price < lows[lows.length - 2].price;
    if (hh && hl) return "bullish";
    if (lh && ll) return "bearish";
  }
  return "mixed";
}

function nearestLevels(candles, swings, volatility) {
  const last = candles[candles.length - 1];
  const tolerance = Math.max(volatility * 0.75, last.close * 0.006);
  const supportSwing = swings.lows.filter((s) => s.price <= last.close)
    .sort((a, b) => b.price - a.price)[0] || null;
  const resistanceSwing = swings.highs.filter((s) => s.price >= last.close)
    .sort((a, b) => a.price - b.price)[0] || null;
  const recent = candles.slice(-20);
  const supportFallback = recent.reduce((best, candle) => candle.low < best.low ? candle : best, recent[0]);
  const resistanceFallback = recent.reduce((best, candle) => candle.high > best.high ? candle : best, recent[0]);
  const support = supportSwing ? supportSwing.price : supportFallback.low;
  const resistance = resistanceSwing ? resistanceSwing.price : resistanceFallback.high;
  return {
    support,
    resistance,
    supportTime: supportSwing ? supportSwing.time : supportFallback.time,
    resistanceTime: resistanceSwing ? resistanceSwing.time : resistanceFallback.time,
    nearSupport: support > 0 && Math.abs(last.close - support) <= tolerance,
    nearResistance: resistance > 0 && Math.abs(last.close - resistance) <= tolerance,
    tolerance,
  };
}

function breakAndRetest(candles, swings, levels, volatility) {
  const last = candles[candles.length - 1];
  const recent = candles.slice(-12);
  const previousHighs = swings.highs.filter((s) => s.index < candles.length - 6).slice(-5);
  const previousLows = swings.lows.filter((s) => s.index < candles.length - 6).slice(-5);
  const resistanceSwing = previousHighs.sort((a, b) => b.price - a.price)[0] || null;
  const supportSwing = previousLows.sort((a, b) => a.price - b.price)[0] || null;
  const priorResistance = resistanceSwing ? resistanceSwing.price : levels.resistance;
  const priorSupport = supportSwing ? supportSwing.price : levels.support;
  const tolerance = Math.max(volatility * 0.9, last.close * 0.008);

  const brokeUp = priorResistance > 0 && recent.some((c) => c.close > priorResistance + tolerance * 0.2);
  const retestedUp = brokeUp && last.low <= priorResistance + tolerance && last.close >= priorResistance - tolerance;
  const brokeDown = priorSupport > 0 && recent.some((c) => c.close < priorSupport - tolerance * 0.2);
  const retestedDown = brokeDown && last.high >= priorSupport - tolerance && last.close <= priorSupport + tolerance;

  return {
    long: retestedUp,
    short: retestedDown,
    longLevel: priorResistance,
    shortLevel: priorSupport,
    longLevelTime: resistanceSwing ? resistanceSwing.time : levels.resistanceTime,
    shortLevelTime: supportSwing ? supportSwing.time : levels.supportTime,
  };
}

function compressionBreakout(candles, side) {
  if (candles.length < 30) return false;
  const box = candles.slice(-24, -1);
  const last = candles[candles.length - 1];
  const firstHalf = box.slice(0, 12);
  const secondHalf = box.slice(12);
  const firstRange = Math.max(...firstHalf.map((c) => c.high)) - Math.min(...firstHalf.map((c) => c.low));
  const secondRange = Math.max(...secondHalf.map((c) => c.high)) - Math.min(...secondHalf.map((c) => c.low));
  const recentHigh = Math.max(...box.map((c) => c.high));
  const recentLow = Math.min(...box.map((c) => c.low));
  if (!(secondRange < firstRange * 0.85)) return false;
  if (side === "long") return last.close > recentHigh;
  return last.close < recentLow;
}

function bosSignal(candles, swings) {
  const last = candles[candles.length - 1];
  const high = swings.highs.slice(-3, -1).map((s) => s.price).pop();
  const low = swings.lows.slice(-3, -1).map((s) => s.price).pop();
  return {
    long: high ? last.close > high : false,
    short: low ? last.close < low : false,
  };
}

// Lightweight higher/lower timeframe trend read used for consensus.
function timeframeTrend(candles) {
  if (candles.length < 55) return "mixed";
  const closes = candles.map((c) => c.close);
  const e20 = ema(closes, 20).pop();
  const e50 = ema(closes, 50).pop();
  const structure = trendFromSwings(swingPoints(candles, 2));
  const last = candles[candles.length - 1].close;
  if (structure === "bullish" && last > e20 && e20 > e50) return "bullish";
  if (structure === "bearish" && last < e20 && e20 < e50) return "bearish";
  if (e20 && e50) {
    if (last > e20 && e20 > e50) return "bullish";
    if (last < e20 && e20 < e50) return "bearish";
  }
  return "mixed";
}

// ---------------------------------------------------------------------------
// Multi-timeframe signal build
// ---------------------------------------------------------------------------

function analyzePair(pair, tf) {
  const candles = tf["15m"];
  if (!candles || candles.length < 55) return null;

  const vol24 = quoteVolume24h(candles);
  if (vol24 < Number(state.minQuoteVolume24h || 0)) return null; // thin book

  const closes = candles.map((c) => c.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const e20 = ema20[ema20.length - 1];
  const e50 = ema50[ema50.length - 1];
  const volatility = atr(candles, 14) || last.close * 0.02;
  const swings = swingPoints(candles, 2);
  const trend = trendFromSwings(swings);
  const levels = nearestLevels(candles, swings, volatility);
  const retest = breakAndRetest(candles, swings, levels, volatility);
  const bos = bosSignal(candles, swings);
  const patterns = candlePatterns(candles);
  const rsiValue = rsi(candles, 14);
  const avgVol = avg(candles.slice(-21, -1).map((c) => c.volume));
  const volExpansion = avgVol > 0 && last.volume > avgVol * 1.25;
  const lastMovePct = pctChange(prev.close, last.close);

  const trendH1 = timeframeTrend(tf["1h"] || []);
  const trendM5 = timeframeTrend(tf["5m"] || []);

  const baseCtx = {
    pair, candles, last, trend, levels, retest, bos, patterns,
    e20, e50, rsiValue, volExpansion, lastMovePct, volatility,
    trendH1, trendM5,
  };
  const long = scoreSide("long", baseCtx);
  const short = scoreSide("short", baseCtx);
  const winner = long.score >= short.score ? long : short;

  // Reject anything that cannot be published and monitored deterministically:
  // missing, non-finite, zero or directionally invalid entry/stop/target.
  const plan = buildTradePlan(winner);
  if (!plan) return null;
  winner.entry = plan.entry;
  winner.tp1 = plan.tp1;
  winner.tp3 = plan.tp3;
  winner.r = plan.r;
  winner.target = plan.tp3;

  // 1h consensus gate: never fight the higher timeframe when it clearly opposes.
  const opposesH1 = (winner.side === "long" && trendH1 === "bearish")
    || (winner.side === "short" && trendH1 === "bullish");
  if (state.useHtfGate && opposesH1) return null;

  const lookback = Math.min(96, candles.length - 1);
  winner.exchange = EXCHANGE;
  winner.market = pair.market;
  winner.symbol = pair.api;
  winner.tvSymbol = pair.tv;
  winner.name = pair.label;
  winner.url = tvChartUrl(pair.tv);
  winner.timeframe = SETUP_TIMEFRAME;
  winner.trendH1 = trendH1;
  winner.trendM5 = trendM5;
  winner.changeM15 = lastMovePct;
  winner.changeH1 = tf["1h"] && tf["1h"].length >= 2
    ? pctChange(tf["1h"][tf["1h"].length - 2].close, tf["1h"][tf["1h"].length - 1].close)
    : 0;
  winner.changeH24 = pctChange(candles[candles.length - 1 - lookback].close, last.close);
  winner.volumeH24Usd = vol24;
  winner.price = last.close;
  return winner;
}

function scoreSide(side, ctx) {
  const score = [];
  const reasons = [];
  const confirmations = [];
  const last = ctx.last;
  const long = side === "long";

  function add(points, label) {
    score.push(points);
    reasons.push(label);
  }

  if (long && ctx.trend === "bullish") add(18, "Bullish market structure");
  if (!long && ctx.trend === "bearish") add(18, "Bearish market structure");

  if (long && ctx.retest.long) add(24, "Break and retest above prior resistance");
  if (!long && ctx.retest.short) add(24, "Break and retest below prior support");

  if (long && ctx.levels.nearSupport) add(14, "Demand/support reaction");
  if (!long && ctx.levels.nearResistance) add(14, "Supply/resistance reaction");

  const sidePatterns = ctx.patterns.filter((p) => p.side === side);
  if (sidePatterns.length) {
    const best = sidePatterns.sort((a, b) => b.weight - a.weight)[0];
    add(best.weight, best.name);
  }

  if (long && ctx.bos.long) add(14, "Bullish break of structure");
  if (!long && ctx.bos.short) add(14, "Bearish break of structure");

  if (long && ctx.e20 && ctx.e50 && last.close > ctx.e20 && ctx.e20 > ctx.e50) {
    add(10, "Price aligned above 20/50 EMA");
  }
  if (!long && ctx.e20 && ctx.e50 && last.close < ctx.e20 && ctx.e20 < ctx.e50) {
    add(10, "Price aligned below 20/50 EMA");
  }

  if (long && ctx.rsiValue >= 45 && ctx.rsiValue <= 72) add(5, "RSI momentum supportive");
  if (!long && ctx.rsiValue <= 55 && ctx.rsiValue >= 28) add(5, "RSI momentum supportive");

  if (ctx.volExpansion) add(5, "Volume expansion on signal candle");
  if (long && compressionBreakout(ctx.candles, "long")) add(10, "Compression breakout");
  if (!long && compressionBreakout(ctx.candles, "short")) add(10, "Compression breakdown");

  // Multi-timeframe consensus bonuses.
  const agreeWord = long ? "bullish" : "bearish";
  if (ctx.trendH1 === agreeWord) add(12, "1h trend aligned");
  if (ctx.trendM5 === agreeWord) add(6, "5m momentum aligned");

  const stop = long
    ? Math.max(0, Math.min(ctx.levels.support || last.close - ctx.volatility, last.close - ctx.volatility * 1.25))
    : Math.max(ctx.levels.resistance || last.close + ctx.volatility, last.close + ctx.volatility * 1.25);
  // R is measured from the exact entry to invalidation, with no fallback: a
  // setup whose risk cannot be measured is rejected rather than guessed at, so
  // the published 1:1 and 3:1 targets are always consistent with the entry.
  const risk = Math.abs(last.close - stop);
  const target = long
    ? last.close + risk * RISK_REWARD_RATIO
    : last.close - risk * RISK_REWARD_RATIO;

  confirmations.push(...reasons);

  // Every observation, paired with its weight. The family-aware score is
  // computed from these rather than by summing them, so several correlated
  // descriptions of one price move cannot each add to the total.
  const observations = reasons.map((label, i) => ({ label, points: score[i] }));
  const evidence = strategy.scoreEvidence(observations, STRATEGY);

  // The structural level that defines this thesis. Carried through so the
  // thesis key is built from real level provenance, never from formatted text.
  const thesisLevel = long
    ? (ctx.retest.long ? ctx.retest.longLevel : ctx.levels.support)
    : (ctx.retest.short ? ctx.retest.shortLevel : ctx.levels.resistance);
  const thesisAnchorTime = long
    ? (ctx.retest.long ? ctx.retest.longLevelTime : ctx.levels.supportTime)
    : (ctx.retest.short ? ctx.retest.shortLevelTime : ctx.levels.resistanceTime);

  return {
    side,
    score: evidence.score,
    rawFamilyScore: evidence.raw,
    scoreDenominator: evidence.denominator,
    familyCount: evidence.familyCount,
    // The structural floor deliberately excludes publication-time execution:
    // a cheap fresh quote can improve quality, but it cannot supply WHERE,
    // WHAT-shape or WHY-now evidence that the chart thesis lacks.
    thesisFamilyCount: evidence.familyCount,
    evidence,
    price: last.close,
    stop,
    target,
    thesisLevel,
    thesisAnchorTime,
    riskRewardRatio: RISK_REWARD_RATIO,
    rsi: ctx.rsiValue,
    trend: ctx.trend,
    confirmations,
    // Kept for internal diagnostics and ranking, never shown in Telegram.
    confirmationDetails: observations,
    time: new Date(last.time).toISOString(),
  };
}

/**
 * The reader-facing reasons: the strongest observation from each of the top
 * families, so three lines describe three genuinely different things.
 */
function topConfirmations(signal, count = 3) {
  if (signal.evidence && Array.isArray(signal.evidence.winners) && signal.evidence.winners.length) {
    return strategy.topReasons(signal.evidence, count);
  }
  const details = Array.isArray(signal.confirmationDetails) ? signal.confirmationDetails : null;
  if (details && details.length) {
    return details.slice()
      .sort((a, b) => b.points - a.points)
      .slice(0, count)
      .map((d) => d.label);
  }
  return (signal.confirmations || []).slice(0, count);
}

// ---------------------------------------------------------------------------
// Scan loop
// ---------------------------------------------------------------------------

/** Cohort identity for everything published by the current configuration. */
function activeCohortId() {
  return strategy.cohortId({
    strategy: STRATEGY,
    threshold: state.alertThreshold,
    useHtfGate: state.useHtfGate,
    pairs: state.pairs,
    costs: { feeRatePerSide: state.feeRatePerSide, slippageRatePerSide: state.slippageRatePerSide },
  });
}

async function scanMarkets(manual = false) {
  const started = Date.now();
  const signals = [];
  const errors = [];
  const reads = [];
  let liveDataPairs = 0;

  for (const pair of state.pairs) {
    try {
      const [c15, c5, c1h] = await Promise.all([
        fetchCandles(pair, "15m", 200),
        fetchCandles(pair, "5m", 120),
        fetchCandles(pair, "1h", 120),
      ]);
      if (!c15.length || !c5.length || !c1h.length) {
        errors.push(`${pair.api}: missing closed candles (15m=${c15.length}, 5m=${c5.length}, 1h=${c1h.length})`);
        continue;
      }
      liveDataPairs += 1;
      // Breadth is computed from every usable pair, not only the ones that
      // produced a signal, so it describes the market rather than the alerts.
      reads.push({
        symbol: pair.api,
        trend: timeframeTrend(c15),
        trendH1: timeframeTrend(c1h),
      });
      const signal = analyzePair(pair, { "15m": c15, "5m": c5, "1h": c1h });
      if (signal) signals.push(signal);
    } catch (err) {
      errors.push(`${pair.api}: ${err.message}`);
    }
    await sleep(250);
  }

  const context = strategy.marketContext(reads, STRATEGY);
  const cohort = activeCohortId();

  // Stamp identity on every candidate before any filtering, so shadow records
  // carry the same provenance as published ones.
  for (const signal of signals) {
    signal.cohortId = cohort;
    signal.strategyHash = strategy.strategyHash(STRATEGY);
    signal.strategyVersion = STRATEGY.version;
    signal.universeHash = strategy.universeHash(state.pairs);
    signal.thresholdAtAlert = state.alertThreshold;
    signal.context = context;
    signal.regime = strategy.pairRegime(signal);
    signal.scoreBin = strategy.scoreBin(signal.score);
    signal.clusterId = strategy.clusterKey(signal, context, STRATEGY);
    signal.thesisKey = strategy.thesisKey(signal, STRATEGY);
  }

  signals.sort((a, b) => b.score - a.score);
  const selection = await selectPublishableCandidates(signals, context);
  const accepted = selection.accepted;
  const fresh = selection.fresh;
  const withheld = selection.withheld;
  const clusters = selection.clusters;
  errors.push(...selection.errors);

  const summary = {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    exchange: EXCHANGE,
    pairs: state.pairs.length,
    liveDataPairs,
    candidates: signals.length,
    accepted: accepted.length,
    fresh: fresh.length,
    withheld: withheld.length,
    clusters: clusters.size,
    cohortId: cohort,
    context,
    errors,
    top: signals.slice(0, 10),
  };
  appendJsonArray(SIGNALS_FILE, summary, 200);

  if (dryRun) {
    printDryRun(summary);
  } else if (!state.paused) {
    for (const item of fresh) {
      const record = await broadcastSignal(item.signal, { prepared: item.prepared });
      if (record) markCooldown(item.signal);
      await sleep(750);
    }
    for (const item of withheld) {
      await recordShadow(item.signal, [item.reason], item.execution || null);
    }
    saveJson(STATE_FILE, state);
  }

  if (manual && !fresh.length && !dryRun) {
    const text = `<b>${BOT_NAME}</b>\n\nManual scan complete.\n` +
      `Candidates: <b>${signals.length}</b>\n` +
      `Above threshold: <b>${accepted.length}</b>\n` +
      `Fresh alerts: <b>0</b>\n\n` +
      `No clean setup cleared the current threshold of <b>${state.alertThreshold}</b>.`;
    await sendToOwner(text);
  }

  return summary;
}

function cooldownKey(signal) {
  return `${signal.market}:${signal.symbol}:${signal.side}`;
}

function isCoolingDown(signal) {
  const key = cooldownKey(signal);
  const last = Number(state.lastAlerts[key] || 0);
  const cooldownMs = Number(state.cooldownMinutes || 30) * 60 * 1000;
  return Date.now() - last < cooldownMs;
}

function markCooldown(signal) {
  state.lastAlerts[cooldownKey(signal)] = Date.now();
}

/**
 * True while an earlier setup expressing the same thesis is still unresolved.
 *
 * The 30-minute cooldown alone was not enough: as candles advance, the same
 * structural idea re-qualifies under a new signal time and is published again.
 * A thesis is released once its earlier setup reaches a terminal state, or when
 * a genuinely different structural level produces a different key.
 */
function hasOpenThesis(signal) {
  if (!outcomes || !signal.thesisKey) return false;
  return outcomes.records.some((record) => record.thesisKey === signal.thesisKey
    && !strategy.thesisIsSettled(record));
}

/** Journal a withheld-but-valid candidate. Never sends anything. */
async function recordShadow(signal, reasons, executionSnapshot = null) {
  if (!shadow) return null;
  const plan = buildTradePlan(signal);
  if (!plan) return null; // Never shadow a setup we could not have measured.
  return shadow.track({
    signal,
    plan,
    baseId: outcomeModule.makeAlertId(signal, shadow.records),
    sentAt: new Date().toISOString(),
    costs: {
      feeRatePerSide: state.feeRatePerSide,
      slippageRatePerSide: state.slippageRatePerSide,
    },
    reasons,
    context: signal.context,
    evidence: signal.evidence,
    execution: executionSnapshot,
  });
}

/**
 * Take a fresh public execution snapshot for one candidate.
 *
 * Returns `{ ok }` with the snapshot, or a typed refusal. A data failure is a
 * refusal to publish, never a fabricated price and never a losing outcome.
 */
async function checkExecution(signal, plan, getJson = httpGetJson) {
  const quote = await execution.fetchQuote(okxInstId({ api: signal.symbol, market: signal.market }), getJson);
  if (!quote.ok) return { ok: false, reason: quote.reason, snapshot: null };
  return execution.evaluateExecution({
    signal,
    plan,
    quote: quote.quote,
    now: Date.now(),
    strategy: STRATEGY,
    costs: {
      feeRatePerSide: state.feeRatePerSide,
      slippageRatePerSide: state.slippageRatePerSide,
    },
  });
}

/**
 * Attach the publication-time quote and recompute the final score.
 * Pure apart from the injected quote check; it never persists or notifies.
 */
async function prepareSignalExecution(signal, checker = checkExecution, threshold = state.alertThreshold) {
  const plan = buildTradePlan(signal);
  if (!plan) return { ok: false, reason: "invalid_plan", snapshot: null, plan: null };

  const exec = await checker(signal, plan);
  if (!exec.ok) return { ...exec, plan };

  // Execution quality is real evidence, so it re-scores the setup in its own
  // family. A setup that only cleared the threshold on paper can fall below it
  // once the true cost of trading it is included.
  const withExecution = strategy.scoreEvidence(
    [...(signal.confirmationDetails || []), ...execution.executionObservations(exec.snapshot, STRATEGY)],
    STRATEGY,
  );
  signal.evidence = withExecution;
  signal.score = withExecution.score;
  signal.familyCount = withExecution.familyCount;
  signal.scoreBin = strategy.scoreBin(withExecution.score);
  signal.execution = exec.snapshot;
  signal.costR = exec.snapshot.costR;

  if (signal.score < threshold) {
    return {
      ok: false,
      reason: shadowModule.SHADOW_REASONS.BELOW_THRESHOLD,
      snapshot: exec.snapshot,
      plan,
    };
  }
  return { ok: true, snapshot: exec.snapshot, plan };
}

/**
 * Apply the publication gates and cluster cap to one scan's valid plans.
 * Extracted so the complete gate-to-shadow wiring is deterministic in tests.
 */
async function selectPublishableCandidates(signals, context, dependencies = {}) {
  const cooling = dependencies.isCoolingDown || isCoolingDown;
  const openThesis = dependencies.hasOpenThesis || hasOpenThesis;
  const prepare = dependencies.prepareSignalExecution || prepareSignalExecution;
  const threshold = Number.isFinite(dependencies.threshold)
    ? dependencies.threshold
    : state.alertThreshold;
  const withheld = [];
  const ready = [];
  const errors = [];

  for (const signal of signals) {
    if (cooling(signal)) continue; // Operational rate limiter, not gate evidence.
    const thesisFamilies = Number.isFinite(signal.thesisFamilyCount)
      ? signal.thesisFamilyCount
      : signal.familyCount;
    if (thesisFamilies < STRATEGY.minFamilies) {
      withheld.push({ signal, reason: shadowModule.SHADOW_REASONS.INSUFFICIENT_FAMILIES });
      continue;
    }
    if (openThesis(signal)) {
      withheld.push({ signal, reason: shadowModule.SHADOW_REASONS.DUPLICATE_THESIS });
      continue;
    }
    if (strategy.contradictsRegime(signal.side, context, STRATEGY)) {
      withheld.push({ signal, reason: shadowModule.SHADOW_REASONS.REGIME_CONTRADICTION });
      continue;
    }

    const prepared = await prepare(signal, checkExecution, threshold);
    if (!prepared.ok) {
      if (shadowModule.isShadowable(prepared.reason)) {
        withheld.push({ signal, reason: prepared.reason, execution: prepared.snapshot || null });
      } else {
        errors.push(`${signal.symbol}: execution refused (${prepared.reason})`);
      }
      continue;
    }
    ready.push({ signal, prepared });
  }

  // Execution is measured before ranking, so the documented lower-cost
  // tie-break is real rather than an always-missing field.
  const clusters = new Map();
  for (const item of ready) {
    if (!clusters.has(item.signal.clusterId)) clusters.set(item.signal.clusterId, []);
    clusters.get(item.signal.clusterId).push(item);
  }
  const fresh = [];
  for (const group of clusters.values()) {
    const rankedSignals = strategy.rankCandidates(group.map((item) => item.signal));
    const bySignal = new Map(group.map((item) => [item.signal, item]));
    fresh.push(...rankedSignals.slice(0, STRATEGY.publication.maxPerCluster).map((s) => bySignal.get(s)));
    for (const loser of rankedSignals.slice(STRATEGY.publication.maxPerCluster)) {
      withheld.push({
        signal: loser,
        reason: shadowModule.SHADOW_REASONS.CORRELATED_LOWER_RANK,
        execution: loser.execution || null,
      });
    }
  }

  return { accepted: ready.map((item) => item.signal), fresh, withheld, clusters, errors };
}

async function broadcastSignal(signal, options = {}) {
  const prepared = options.prepared
    || await prepareSignalExecution(signal, options.checkExecution || checkExecution, options.threshold);
  if (!prepared.ok) {
    if (shadowModule.isShadowable(prepared.reason)) {
      await (options.recordShadow || recordShadow)(signal, [prepared.reason], prepared.snapshot);
    } else {
      (options.logger || console).error(`execution refused ${signal.symbol}: ${prepared.reason}`);
    }
    return null;
  }

  const sentAt = new Date().toISOString();
  const tracker = options.outcomes === undefined ? outcomes : options.outcomes;
  const record = tracker ? tracker.track(signal, sentAt) : null;
  if (tracker && !record) {
    // buildTradePlan already logged the reason. Never publish a setup we cannot
    // measure: an untrackable alert would pollute the trial.
    return null;
  }
  const alertId = record ? record.id : null;
  const text = formatSignal(signal, alertId);
  const chatIds = options.chatIds || state.alertChatIds;
  const appendAlert = options.appendAlert || ((row) => appendJsonArray(ALERTS_FILE, row, 500));
  appendAlert({ sentAt, alertId, chatIds, signal });
  const sender = options.sendSignalAlert || sendSignalAlert;
  for (const chatId of chatIds) {
    await sender(chatId, signal, text);
  }
  return record;
}

function signalButtons(signal) {
  return { inline_keyboard: [[{ text: "Open TradingView", url: signal.url }]] };
}

function sendSignalAlert(chatId, signal, text = formatSignal(signal)) {
  return sendHtml(chatId, text, {
    reply_markup: signalButtons(signal),
  });
}

// Plain-language direction wording. Readers are not assumed to know what a
// long, a short, a stop loss or an R multiple is.
function directionWords(side) {
  return side === "long"
    ? { emoji: "🟢", action: "BUY", expectation: "Price is expected to rise" }
    : { emoji: "🔴", action: "SELL", expectation: "Price is expected to fall" };
}

function formatSignal(signal, alertId = signal.alertId || null) {
  const plan = buildTradePlan(signal);
  if (!plan) return `<b>${BOT_NAME}</b>\n\nThis setup was rejected: its entry, stop loss and targets are not consistent.`;

  const words = directionWords(plan.side);
  const marketName = `${EXCHANGE} ${MARKET_LABELS[signal.market] || signal.market}`;
  const why = topConfirmations(signal, 3).map((reason) => esc(reason)).join("\n");

  return `${words.emoji} <b>${esc(signal.name)} — ${words.action}</b>\n` +
    `${words.expectation}\n\n` +
    `Exchange: <b>${esc(marketName)}</b>\n` +
    `Chart timeframe: <b>${SETUP_TIMEFRAME_LABEL}</b>\n\n` +
    `Entry Price: <code>${fmtPrice(plan.entry)}</code>\n` +
    `Stop Loss: <code>${fmtPrice(plan.stop)}</code>\n` +
    `First Profit Target (1:1): <code>${fmtPrice(plan.tp1)}</code>\n` +
    `Final Profit Target (3:1): <code>${fmtPrice(plan.tp3)}</code>\n\n` +
    `Why this setup:\n${why}\n\n` +
    (alertId ? `Alert ID: <code>${esc(alertId)}</code>\n\n` : "") +
    `<i>1:1 means the target distance equals the amount risked.\n` +
    `3:1 means the target distance is three times the amount risked.\n` +
    `Tracking uses OKX market prices and does not read your trading account.</i>`;
}

// ---------------------------------------------------------------------------
// Outcome notifications
// ---------------------------------------------------------------------------

const RESULT_WORDS = {
  tp: "TARGET REACHED",
  sl: "STOP LOSS REACHED",
  open: "still being monitored",
  void: "no result recorded",
};

function formatOutcome(event, record) {
  const words = directionWords(record.side);
  const head = `<b>${esc(record.name)} — ${words.action}</b>`;
  const id = `Alert ID: <code>${esc(record.id)}</code>`;

  if (event.type === "first_target") {
    return `✅ <b>FIRST PROFIT TARGET REACHED</b>\n\n` +
      `${head}\n` +
      `Entry Price: <code>${fmtPrice(record.entry)}</code>\n` +
      `First Profit Target (1:1): <code>${fmtPrice(record.tp1)}</code>\n\n` +
      `1:1 setup result: <b>${RESULT_WORDS.tp}</b>\n` +
      `The final 3:1 target is still being monitored.\n\n` +
      `${id}`;
  }

  const r1 = RESULT_WORDS[record.r1Status] || RESULT_WORDS.void;
  const r3 = RESULT_WORDS[record.r3Status] || RESULT_WORDS.void;
  let banner = "⚠️ <b>SETUP MONITORING COMPLETE</b>";
  if (record.r1Status === "tp" && record.r3Status === "tp") banner = "🏆 <b>FINAL PROFIT TARGET REACHED</b>";
  else if (record.r1Status === "sl" && record.r3Status === "sl") banner = "❌ <b>STOP LOSS REACHED</b>";

  return `${banner}\n\n` +
    `${head}\n\n` +
    `1:1 setup result: <b>${r1}</b>\n` +
    `3:1 setup result: <b>${r3}</b>\n\n` +
    `${id}`;
}

async function broadcastOutcome(event, record) {
  const text = formatOutcome(event, record);
  for (const chatId of state.alertChatIds) {
    await sendHtml(chatId, text);
  }
}

function printDryRun(summary) {
  console.log(`${BOT_NAME} dry run`);
  console.log(`Exchange: ${summary.exchange}`);
  console.log(`Pairs: ${summary.pairs}`);
  console.log(`Pairs with live closed candles: ${summary.liveDataPairs}/${summary.pairs}`);
  console.log(`Duration: ${(summary.durationMs / 1000).toFixed(1)}s`);
  console.log(`Candidates: ${summary.candidates}`);
  console.log(`Above threshold: ${summary.accepted}`);
  console.log(`Fresh alerts: ${summary.fresh}`);
  if (summary.errors.length) {
    console.log(`Errors: ${summary.errors.join(" | ")}`);
  }
  for (const s of summary.top.slice(0, 8)) {
    console.log(`- ${s.score}% ${s.side.toUpperCase()} ${s.name} [${s.market}] price=${fmtPrice(s.price)} ` +
      `5m/15m/1h=${s.trendM5}/${s.trend}/${s.trendH1}`);
    console.log(`  ${s.confirmations.slice(0, 4).join("; ")}`);
  }
}

async function sendToOwner(text) {
  return sendHtml(DEFAULT_OWNER_CHAT_ID, text);
}

// ---------------------------------------------------------------------------
// Telegram text
// ---------------------------------------------------------------------------

function statusText() {
  const chats = state.alertChatIds.map((id) => `<code>${esc(id)}</code>`).join(", ");
  const alerts = loadJson(ALERTS_FILE, []);
  const signals = loadJson(SIGNALS_FILE, []);
  const lastScan = signals[0] && signals[0].scannedAt ? signals[0].scannedAt : "never";
  const spot = state.pairs.filter((p) => p.market === "spot").length;
  const futures = state.pairs.filter((p) => p.market === "futures").length;
  return `<b>${BOT_NAME} Status</b>\n\n` +
    `Mode: <b>Major exchange pairs</b>\n` +
    `Exchange: <b>${EXCHANGE}</b>\n` +
    `Paused: <b>${state.paused ? "yes" : "no"}</b>\n` +
    `Pairs: <b>${state.pairs.length}</b> (spot ${spot}, futures ${futures})\n` +
    `Timeframes: <b>5m / 15m / 1h</b>\n` +
    `1h trend gate: <b>${state.useHtfGate ? "on" : "off"}</b>\n` +
    `Threshold: <b>${state.alertThreshold}%</b>\n` +
    `Reward/risk: <b>${RISK_REWARD_RATIO}:1</b>\n` +
    `Cooldown: <b>${state.cooldownMinutes} min</b>\n` +
    `Scan interval: <b>${state.scanIntervalMinutes} min</b>\n` +
    `Min 24h volume: <b>${fmtUsd(state.minQuoteVolume24h)}</b>\n\n` +
    `<b>Alerts</b>\n` +
    `Chats: ${chats || "none"}\n` +
    `Stored alerts: <b>${alerts.length}</b>\n` +
    `Setups being monitored: <b>${outcomes ? outcomes.summary().stillMonitoring : 0}</b>\n` +
    `Last scan: <code>${esc(lastScan)}</code>`;
}

// ---------------------------------------------------------------------------
// Trial results
// ---------------------------------------------------------------------------

function fmtDay(iso) {
  if (!iso) return "not started";
  return new Date(iso).toISOString().slice(0, 10);
}

function fmtR(value) {
  const n = Number(value) || 0;
  return `${n >= 0 ? "+" : ""}${n.toFixed(3)}`;
}

/**
 * One leg, reported with BOTH sample sizes.
 *
 * The success rate and expectancy describe every published setup. The
 * t-statistic is quoted only on the market-event series, because ten correlated
 * alerts from one sell-off are one piece of evidence, not ten.
 */
function legText(title, leg, stats) {
  if (!leg.resolved) return `<b>${title}</b>\nNo completed setups yet.`;
  const t = stats.tStatistic === null ? "not enough independent data" : stats.tStatistic.toFixed(2);
  return `<b>${title}</b>\n` +
    `Target hits: <b>${leg.tp}</b>\n` +
    `Stop losses: <b>${leg.sl}</b>\n` +
    `Success rate: <b>${leg.winRate.toFixed(1)}%</b>\n` +
    `Average result after estimated trading costs: <b>${fmtR(leg.netExpectancyR)}</b> times the amount risked\n` +
    `Independent market events: <b>${stats.clusterCount}</b> (from ${stats.rawCount} setups)\n` +
    `Average per market event: <b>${fmtR(stats.clusterNetExpectancyR)}</b>\n` +
    `Statistical confidence (t-statistic): <b>${t}</b>`;
}

function resultsText(tracker = outcomes) {
  if (!tracker) return `<b>${BOT_NAME}</b>\n\nOutcome monitoring is not running.`;
  const cohort = activeCohortId();
  const s = tracker.summary({ cohortId: cohort });
  const costPct = ((s.costs.feeRatePerSide + s.costs.slippageRatePerSide) * 2 * 100).toFixed(2);
  const days = s.firstAlertAt
    ? Math.floor((Date.now() - Date.parse(s.firstAlertAt)) / 86400000) + 1
    : 0;

  const requirement = { minClusters: TRIAL_MIN_CLUSTERS, minTStat: 2 };
  const oneVerdict = evidenceVerdict(s.oneRStats, requirement);
  const threeVerdict = evidenceVerdict(s.threeRStats, requirement);

  return `<b>${BOT_NAME} — Results</b>\n\n` +
    `Settings fingerprint: <code>${esc(cohort)}</code>\n` +
    `Alert threshold: <b>${state.alertThreshold}</b>\n` +
    `Trial period: <b>${fmtDay(s.firstAlertAt)}</b> to <b>${fmtDay(s.lastAlertAt)}</b>\n` +
    `Day <b>${days}</b> of <b>${TRIAL_DAYS}</b>\n\n` +
    `Total alerts published: <b>${s.total}</b>\n` +
    `Independent market events: <b>${s.clusters}</b> of <b>${TRIAL_MIN_CLUSTERS}</b> needed\n` +
    `Awaiting Entry Price: <b>${s.awaitingEntry}</b>\n` +
    `Entered and still being monitored: <b>${s.enteredMonitoring}</b>\n` +
    `Cancelled before entry: <b>${s.cancelled}</b>\n` +
    `Expired before entry: <b>${s.expiredBeforeEntry}</b>\n` +
    `Expired after entry: <b>${s.expiredAfterEntry}</b>\n` +
    `Completed setups: <b>${s.completed}</b>\n\n` +
    `${legText("First Profit Target (1:1)", s.oneR, s.oneRStats)}\n` +
    `Verdict: <b>${oneVerdict.verdict}</b>\n\n` +
    `${legText("Final Profit Target (3:1)", s.threeR, s.threeRStats)}\n` +
    `Verdict: <b>${threeVerdict.verdict}</b>\n\n` +
    `<i>Several alerts from one market move count as one piece of evidence. ` +
    `A t-statistic above 2 is stronger evidence that a result may not be random.</i>\n\n` +
    `Estimated trading costs assumed: <b>${costPct}%</b> per completed setup ` +
    `(${(s.costs.feeRatePerSide * 100).toFixed(3)}% fee and ${(s.costs.slippageRatePerSide * 100).toFixed(3)}% slippage on entry and exit), ` +
    `plus the spread observed at publication.\n` +
    `Setups expire after <b>${s.expiryHours} hours</b> without a result.` +
    (s.dataGaps ? `\nSetups with incomplete monitoring data: <b>${s.dataGaps}</b>` : "") +
    (s.legacyCount ? `\n\n<i>${s.legacyCount} older alert(s) were published under an unknown ` +
      `configuration and are excluded from the figures above.</i>` : "");
}

/**
 * Owner-only detail: score bins and, when asked, every cohort separately.
 * Cohorts are always labelled and never merged.
 */
function detailedResultsText(tracker = outcomes) {
  if (!tracker) return `<b>${BOT_NAME}</b>\n\nOutcome monitoring is not running.`;
  const cohort = activeCohortId();
  const s = tracker.summary({ cohortId: cohort });

  const binLines = strategy.SCORE_BINS.map((bin) => {
    const row = s.scoreBins[bin.id];
    if (!row || !row.total) return `${bin.label}: none`;
    const one = row.oneR;
    const rate = one.rawCount ? `${((one.wins / one.rawCount) * 100).toFixed(0)}%` : "no result";
    return `${bin.label}: <b>${row.total}</b> setups, first target ${rate}, ` +
      `${fmtR(one.clusterNetExpectancyR)} per market event`;
  }).join("\n");

  const cohortLines = tracker.summaryAllCohorts
    ? tracker.summaryAllCohorts().map((c) => {
      const label = c.cohortId === strategy.LEGACY_COHORT_ID
        ? "legacy / unknown configuration"
        : c.cohortId;
      return `<code>${esc(label)}</code>: ${c.total} alerts, ${c.clusters} market events, ` +
        `${c.completed} completed`;
    }).join("\n")
    : "unavailable";

  return `<b>${BOT_NAME} — Detailed results</b>\n\n` +
    `Active settings fingerprint: <code>${esc(cohort)}</code>\n\n` +
    `<b>By setup quality score</b>\n${binLines}\n\n` +
    `<b>All configurations, reported separately</b>\n${cohortLines}\n\n` +
    `<i>Different configurations are never combined. Each one is its own trial.</i>`;
}

/** Owner-only shadow research view. Shadow setups were never sent to anyone. */
function shadowResultsText(ledger = shadow) {
  if (!ledger) return `<b>${BOT_NAME}</b>\n\nShadow research tracking is not running.`;
  const byReason = shadowModule.summariseByReason(
    ledger.records,
    (rows, field, multiple) => require("./stats").legStatistics(
      outcomeModule.legSamples(rows, field, multiple),
    ),
  );
  const entries = Object.values(byReason);
  if (!entries.length) {
    return `<b>${BOT_NAME} — Withheld setups</b>\n\nNothing has been withheld yet.`;
  }
  const lines = entries.map((row) => {
    const one = row.oneR;
    return `<b>${esc(row.reason)}</b>\n` +
      `Withheld: ${row.total}, completed: ${row.completed}\n` +
      `First target: ${one.wins} reached / ${one.losses} stopped, ` +
      `${fmtR(one.clusterNetExpectancyR)} per market event`;
  }).join("\n\n");

  return `<b>${BOT_NAME} — Withheld setups</b>\n\n` +
    `These setups were never sent to anyone. They are measured only to check ` +
    `whether the rule that withheld them is helping.\n\n${lines}`;
}

function commandPattern(command) {
  return new RegExp(`\\/${command}(?:@\\w+)?(?:\\s+(.*))?$`, "i");
}

function parseTelegramCommand(text) {
  const match = String(text || "").trim().match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    argument: String(match[2] || "").trim(),
  };
}

function scheduledScanDue(currentState, now = Date.now()) {
  const intervalMs = Math.max(1, Number(currentState.scanIntervalMinutes || 5)) * 60 * 1000;
  const last = Number(currentState.lastScheduledScanAt || 0);
  if (!Number.isFinite(last) || last <= 0) return true;
  if (!Number.isFinite(now) || now < last) return false;
  return Math.floor(now / intervalMs) > Math.floor(last / intervalMs);
}

function helpText() {
  return `<b>${BOT_NAME}</b>\n\n` +
    `Clear crypto setup alerts using closed ${SETUP_TIMEFRAME_LABEL} candles from ${EXCHANGE}.\n\n` +
    `<b>Receive alerts in a group</b>\n` +
    `1. Add this bot to the group.\n` +
    `2. From your own account, send /activate in the group.\n` +
    `3. The bot will save the group automatically.\n\n` +
    `<b>Main commands</b>\n` +
    `/activate - send future alerts to this chat or group\n` +
    `/deactivate - stop alerts in this chat or group\n` +
    `/status - check whether the scanner is running\n` +
    `/results - see how published setups performed\n` +
    `/scan - check the market now\n` +
    `/pause - pause automatic alerts\n` +
    `/resume - resume automatic alerts\n` +
    `/id - show this chat or group's Telegram number\n\n` +
    `<b>Reading an alert</b>\n` +
    `BUY means the setup expects price to rise.\n` +
    `SELL means the setup expects price to fall.\n` +
    `The Entry Price is the planned starting price.\n` +
    `The Stop Loss is where the setup becomes invalid.\n` +
    `The 1:1 target offers a potential reward equal to the planned risk.\n` +
    `The 3:1 target offers a potential reward three times the planned risk.\n` +
    `Results track the published setup using OKX prices, not your personal trading account.\n\n` +
    `<i>Alerts are read-only. No wallet. No automatic trading.</i>`;
}

function sampleSignal() {
  const signal = {
    exchange: EXCHANGE,
    market: "futures",
    symbol: "BTCUSDT",
    tvSymbol: "OKX:BTCUSDT.P",
    name: "BTC / USDT",
    side: "long",
    score: 84,
    price: 64250,
    stop: 63680,
    riskRewardRatio: RISK_REWARD_RATIO,
    timeframe: SETUP_TIMEFRAME,
    rsi: 58.4,
    trend: "bullish",
    trendH1: "bullish",
    trendM5: "bullish",
    changeM15: 1.24,
    changeH1: 3.18,
    changeH24: 9.72,
    volumeH24Usd: 5200000000,
    confirmations: [
      "Break and retest above prior resistance",
      "Bullish market structure",
      "1h trend aligned",
      "5m momentum aligned",
    ],
    confirmationDetails: [
      { label: "Break and retest above prior resistance", points: 24 },
      { label: "Bullish market structure", points: 18 },
      { label: "1h trend aligned", points: 12 },
      { label: "5m momentum aligned", points: 6 },
    ],
    time: new Date().toISOString(),
    url: "https://www.tradingview.com/chart/?symbol=OKX%3ABTCUSDT.P",
    alertId: "CR-BTC-PREVIEW-001",
  };
  const plan = buildTradePlan(signal);
  return { ...signal, entry: plan.entry, tp1: plan.tp1, tp3: plan.tp3, r: plan.r, target: plan.tp3 };
}

function pairsText() {
  if (!state.pairs.length) return `<b>${BOT_NAME}</b>\n\nNo pairs tracked. Use /addpair BTCUSDT.`;
  const rows = state.pairs.map((p, i) =>
    `${i + 1}. <b>${esc(p.label)}</b> <code>${esc(p.api)}</code> [${esc(p.market)}]`
  ).join("\n");
  return `<b>Tracked Pairs (${state.pairs.length})</b>\n\n${rows}`;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function registerCommands() {
  bot.onText(commandPattern("start"), (msg) => {
    sendHtml(msg.chat.id, helpText());
  });

  bot.onText(commandPattern("help"), (msg) => {
    sendHtml(msg.chat.id, helpText());
  });

  bot.onText(commandPattern("id"), (msg) => {
    sendHtml(msg.chat.id,
      `<b>Chat ID</b>\n\n` +
      `Current chat: <code>${esc(msg.chat.id)}</code>\n` +
      `Your user ID: <code>${esc(msg.from.id)}</code>\n\n` +
      `Use /activate in the group to make this bot alert there.`
    );
  });

  bot.onText(commandPattern("activate"), (msg) => {
    if (!ownerGuard(msg)) return;
    if (!state.alertChatIds.includes(msg.chat.id)) {
      state.alertChatIds.push(msg.chat.id);
      saveJson(STATE_FILE, state);
    }
    sendHtml(msg.chat.id, `<b>${BOT_NAME}</b>\n\nAlerts are now active in this chat.`);
  });

  bot.onText(commandPattern("deactivate"), (msg) => {
    if (!ownerGuard(msg)) return;
    state.alertChatIds = state.alertChatIds.filter((id) => id !== msg.chat.id);
    if (!state.alertChatIds.length) state.alertChatIds = [DEFAULT_OWNER_CHAT_ID];
    saveJson(STATE_FILE, state);
    sendHtml(msg.chat.id, `<b>${BOT_NAME}</b>\n\nAlerts removed from this chat.`);
  });

  bot.onText(commandPattern("status"), (msg) => {
    sendHtml(msg.chat.id, statusText());
  });

  bot.onText(commandPattern("results"), (msg) => {
    if (!ownerGuard(msg)) return;
    sendHtml(msg.chat.id, resultsText());
  });

  bot.onText(commandPattern("detail"), (msg) => {
    if (!ownerGuard(msg)) return;
    sendHtml(msg.chat.id, detailedResultsText());
  });

  bot.onText(commandPattern("withheld"), (msg) => {
    if (!ownerGuard(msg)) return;
    sendHtml(msg.chat.id, shadowResultsText());
  });

  bot.onText(commandPattern("pause"), (msg) => {
    if (!ownerGuard(msg)) return;
    state.paused = true;
    saveJson(STATE_FILE, state);
    sendHtml(msg.chat.id, `<b>${BOT_NAME}</b>\n\nAuto alerts paused.`);
  });

  bot.onText(commandPattern("resume"), (msg) => {
    if (!ownerGuard(msg)) return;
    state.paused = false;
    saveJson(STATE_FILE, state);
    sendHtml(msg.chat.id, `<b>${BOT_NAME}</b>\n\nAuto alerts resumed.`);
  });

  bot.onText(commandPattern("pairs"), (msg) => {
    sendHtml(msg.chat.id, pairsText());
  });

  bot.onText(commandPattern("addpair"), (msg, match) => {
    if (!ownerGuard(msg)) return;
    const pair = parsePairInput(match[1]);
    if (!pair) {
      return sendHtml(msg.chat.id,
        `Usage:\n` +
        `<code>/addpair BTCUSDT</code> (spot)\n` +
        `<code>/addpair BTCUSDT futures</code> (perp)\n` +
        `<code>/addpair OKX:BTCUSDT.P</code>`
      );
    }
    const exists = state.pairs.some((p) => p.api === pair.api && p.market === pair.market);
    if (exists) {
      return sendHtml(msg.chat.id, `<b>${esc(pair.label)}</b> [${pair.market}] is already tracked.`);
    }
    state.pairs.push(pair);
    saveJson(STATE_FILE, state);
    sendHtml(msg.chat.id,
      `<b>Pair Added</b>\n\n` +
      `${esc(pair.label)} <code>${esc(pair.api)}</code> [${esc(pair.market)}]\n` +
      `TradingView: <code>${esc(pair.tv)}</code>\n\n` +
      `Now tracking <b>${state.pairs.length}</b> pairs.`
    );
  });

  bot.onText(commandPattern("removepair"), (msg, match) => {
    if (!ownerGuard(msg)) return;
    const token = String(match[1] || "").trim().toUpperCase().replace(/^[A-Z]+:/, "").replace(/\.P$/, "").replace(/-/g, "");
    if (!token) return sendHtml(msg.chat.id, "Usage: <code>/removepair BTCUSDT</code>");
    const before = state.pairs.length;
    state.pairs = state.pairs.filter((p) => p.api !== token);
    saveJson(STATE_FILE, state);
    sendHtml(msg.chat.id,
      before === state.pairs.length
        ? `<code>${esc(token)}</code> was not tracked.`
        : `<b>Pair Removed</b>\n\nRemoved <code>${esc(token)}</code>. Now tracking <b>${state.pairs.length}</b> pairs.`
    );
  });

  bot.onText(commandPattern("resetpairs"), (msg) => {
    if (!ownerGuard(msg)) return;
    state.pairs = DEFAULT_PAIRS.map((p) => ({ ...p }));
    saveJson(STATE_FILE, state);
    sendHtml(msg.chat.id, `<b>${BOT_NAME}</b>\n\nPairs reset to the ${state.pairs.length} default majors.`);
  });

  bot.onText(commandPattern("threshold"), (msg, match) => {
    if (!ownerGuard(msg)) return;
    const score = Number(String(match[1] || "").trim());
    if (!Number.isFinite(score) || score < 45 || score > 95) {
      return sendHtml(msg.chat.id, "Usage: <code>/threshold 65</code>\nAllowed range: 45-95.");
    }
    state.alertThreshold = Math.round(score);
    saveJson(STATE_FILE, state);
    sendHtml(msg.chat.id, `Alert threshold set to <b>${state.alertThreshold}%</b>.`);
  });

  bot.onText(commandPattern("scan"), async (msg) => {
    if (!ownerGuard(msg)) return;
    sendHtml(msg.chat.id, `<b>${BOT_NAME}</b>\n\nManual scan started. This can take about 15-40 seconds.`);
    const summary = await scanMarkets(true);
    if (summary.fresh > 0) {
      sendHtml(msg.chat.id, `<b>${BOT_NAME}</b>\n\nManual scan sent <b>${summary.fresh}</b> fresh alert(s).`);
    }
  });

  bot.onText(commandPattern("testalert"), async (msg) => {
    if (!ownerGuard(msg)) return;
    const signal = sampleSignal();
    const text = `<b>TEST ALERT - FORMAT PREVIEW</b>\n\n` + formatSignal(signal);
    await sendSignalAlert(msg.chat.id, signal, text);
  });

  bot.on("polling_error", (err) => {
    console.error("Polling error:", err.message);
  });
}

/**
 * Scheduled invocations cannot leave Telegram long-polling in the background.
 * Fetch the queued updates once and execute the small reader-facing command set
 * directly, then persist the offset before the process exits.
 */
async function handleScheduledMessage(msg) {
  const command = parseTelegramCommand(msg && msg.text);
  if (!command || !msg.chat || !msg.from) return { forceScan: false, scanChatId: null };

  const chatId = msg.chat.id;
  const owner = isOwner(msg);
  const ownerOnly = async (action) => {
    if (!owner) {
      await sendHtml(chatId, "Not authorized. This command is owner-only.");
      return false;
    }
    await action();
    return true;
  };

  if (command.name === "start" || command.name === "help") {
    await sendHtml(chatId, helpText());
  } else if (command.name === "id") {
    await sendHtml(chatId,
      `<b>Chat ID</b>\n\n` +
      `Current chat: <code>${esc(chatId)}</code>\n` +
      `Your user ID: <code>${esc(msg.from.id)}</code>\n\n` +
      `Use /activate in the group to make this bot alert there.`
    );
  } else if (command.name === "activate") {
    await ownerOnly(async () => {
      if (!state.alertChatIds.includes(chatId)) state.alertChatIds.push(chatId);
      saveJson(STATE_FILE, state);
      await sendHtml(chatId, `<b>${BOT_NAME}</b>\n\nAlerts are now active in this chat.`);
    });
  } else if (command.name === "deactivate") {
    await ownerOnly(async () => {
      state.alertChatIds = state.alertChatIds.filter((id) => id !== chatId);
      if (!state.alertChatIds.length) state.alertChatIds = [DEFAULT_OWNER_CHAT_ID];
      saveJson(STATE_FILE, state);
      await sendHtml(chatId, `<b>${BOT_NAME}</b>\n\nAlerts removed from this chat.`);
    });
  } else if (command.name === "status") {
    await sendHtml(chatId, statusText());
  } else if (command.name === "results") {
    await ownerOnly(() => sendHtml(chatId, resultsText()));
  } else if (command.name === "detail") {
    await ownerOnly(() => sendHtml(chatId, detailedResultsText()));
  } else if (command.name === "withheld") {
    await ownerOnly(() => sendHtml(chatId, shadowResultsText()));
  } else if (command.name === "pause") {
    await ownerOnly(async () => {
      state.paused = true;
      saveJson(STATE_FILE, state);
      await sendHtml(chatId, `<b>${BOT_NAME}</b>\n\nAuto alerts paused.`);
    });
  } else if (command.name === "resume") {
    await ownerOnly(async () => {
      state.paused = false;
      saveJson(STATE_FILE, state);
      await sendHtml(chatId, `<b>${BOT_NAME}</b>\n\nAuto alerts resumed.`);
    });
  } else if (command.name === "pairs") {
    await sendHtml(chatId, pairsText());
  } else if (command.name === "scan") {
    const accepted = await ownerOnly(() => sendHtml(
      chatId,
      `<b>${BOT_NAME}</b>\n\nManual scan started. This can take about 15-40 seconds.`,
    ));
    if (accepted) return { forceScan: true, scanChatId: chatId };
  }

  return { forceScan: false, scanChatId: null };
}

async function pollScheduledCommands() {
  const updates = await bot.getUpdates({
    offset: Math.max(0, Number(state.telegramOffset || 0)),
    limit: 100,
    timeout: 0,
    allowed_updates: ["message"],
  });
  let forceScan = false;
  const scanChatIds = new Set();
  let processed = 0;

  for (const update of Array.isArray(updates) ? updates : []) {
    if (!Number.isFinite(update.update_id)) continue;
    // At-most-once command handling. A crash may lose a response, but cannot
    // replay a state-changing owner command on the next minute.
    state.telegramOffset = Math.max(Number(state.telegramOffset || 0), update.update_id + 1);
    saveJson(STATE_FILE, state);
    if (!update.message) continue;
    const result = await handleScheduledMessage(update.message);
    processed += 1;
    forceScan = forceScan || result.forceScan;
    if (result.scanChatId !== null) scanChatIds.add(result.scanChatId);
  }
  return { forceScan, scanChatIds: [...scanChatIds], processed };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function createTracker() {
  return createOutcomeTracker({
    file: OUTCOMES_FILE,
    expiryHours: state.outcomeExpiryHours,
    costs: {
      feeRatePerSide: state.feeRatePerSide,
      slippageRatePerSide: state.slippageRatePerSide,
    },
    fetchCandles: (pair, frame, limit) => fetchCandles(pair, frame, limit),
    notify: broadcastOutcome,
  });
}

/**
 * The shadow ledger reuses the published state machine, so withheld setups are
 * measured by exactly the same rules. It has no notifier: nothing here can ever
 * reach Telegram.
 */
function createShadow() {
  return shadowModule.createShadowLedger({
    file: SHADOW_FILE,
    createRecord: outcomeModule.createRecord,
    applyCandles: outcomeModule.applyCandles,
    fetchCandles: (pair, frame, limit) => fetchCandles(pair, frame, limit),
    expiryMs: Number(state.outcomeExpiryHours) * 3600 * 1000,
  });
}

/**
 * Resolve published setups against closed OKX 1m candles. Runs independently of
 * the scan loop so outcomes land promptly, and survives its own failures: a
 * monitoring error is logged, never turned into a result.
 */
async function monitorLoop() {
  while (true) {
    try {
      await outcomes.poll();
      await shadow.poll();
    } catch (err) {
      console.error("Outcome monitoring failed:", err.message);
    }
    await sleep(OUTCOME_POLL_MINUTES * 60 * 1000);
  }
}

async function scanLoop() {
  while (true) {
    try {
      if (!state.paused) await scanMarkets(false);
    } catch (err) {
      console.error("Scan failed:", err.message);
    }
    await sleep(Math.max(1, Number(state.scanIntervalMinutes || 5)) * 60 * 1000);
  }
}

async function scheduledMain() {
  saveJson(STATE_FILE, state);
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN. Set it in the private repo .env file.");
  }

  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
  outcomes = createTracker();
  shadow = createShadow();

  let commands = { forceScan: false, scanChatIds: [], processed: 0 };
  try {
    commands = await pollScheduledCommands();
  } catch (err) {
    // Market scanning and outcome tracking must continue through a temporary
    // Telegram getUpdates failure. Alert sends retain their own error handling.
    console.error("Scheduled Telegram command check failed:", err.message);
  }

  let outcomeEvents = [];
  try {
    outcomeEvents = await outcomes.poll();
    await shadow.poll();
  } catch (err) {
    console.error("Scheduled outcome monitoring failed:", err.message);
  }

  const now = Date.now();
  let scanSummary = null;
  if (!state.paused && (commands.forceScan || scheduledScanDue(state, now))) {
    scanSummary = await scanMarkets(false);
    if (scanSummary.liveDataPairs <= 0) {
      throw new Error("Scheduled scan received no live closed candles for any configured pair.");
    }
    state.lastScheduledScanAt = now;
    saveJson(STATE_FILE, state);
  }

  if (commands.scanChatIds.length) {
    const response = scanSummary
      ? `<b>${BOT_NAME}</b>\n\nManual scan complete.\n` +
        `Markets checked: <b>${scanSummary.liveDataPairs}</b>\n` +
        `Candidates: <b>${scanSummary.candidates}</b>\n` +
        `Fresh alerts: <b>${scanSummary.fresh}</b>`
      : `<b>${BOT_NAME}</b>\n\nThe scanner is paused. Use /resume before requesting a scan.`;
    for (const chatId of commands.scanChatIds) await sendHtml(chatId, response);
  }

  console.log(
    `scheduled consensus run complete: commands=${commands.processed} ` +
    `outcomeEvents=${outcomeEvents.length} scanned=${scanSummary ? scanSummary.liveDataPairs : 0}`,
  );
}

async function main() {
  saveJson(STATE_FILE, state);

  if (dryRun) {
    await scanMarkets(false);
    return;
  }

  if (scheduledRun) {
    await scheduledMain();
    return;
  }

  if (!TELEGRAM_BOT_TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN. Set it in consensus_reaper/.env or as an environment variable.");
    process.exit(1);
  }
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: !sendTest });
  outcomes = createTracker();
  shadow = createShadow();

  if (sendTest) {
    const signal = sampleSignal();
    const delivered = await sendSignalAlert(
      DEFAULT_OWNER_CHAT_ID,
      signal,
      `<b>TEST ALERT - FORMAT PREVIEW</b>\n\n${formatSignal(signal, signal.alertId)}`,
    );
    if (!delivered) throw new Error("Telegram did not accept the controlled test alert.");
    console.log("Test alert sent to Telegram.");
    return;
  }

  registerCommands();

  console.log(`${BOT_NAME} is running.`);
  console.log(`Owner ID: ${OWNER_ID}`);
  console.log(`Alert chats: ${state.alertChatIds.join(", ")}`);
  console.log(`Exchange: ${EXCHANGE}, pairs: ${state.pairs.length}`);
  console.log(`Monitoring ${outcomes.summary().stillMonitoring} unresolved setup(s) from disk.`);

  await sendToOwner(`<b>${BOT_NAME}</b>\n\nBot started.\nUse /id in your group, then /activate to enable group alerts.`);

  await Promise.all([scanLoop(), monitorLoop()]);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Exported for the test suites. Requiring this file starts nothing.
module.exports = {
  BOT_NAME,
  activeCohortId,
  analyzePair,
  broadcastSignal,
  checkExecution,
  createShadow,
  createTracker,
  detailedResultsText,
  hasOpenThesis,
  directionWords,
  formatOutcome,
  formatSignal,
  helpText,
  resultsText,
  sampleSignal,
  shadowResultsText,
  parseTelegramCommand,
  prepareSignalExecution,
  scheduledMain,
  scheduledScanDue,
  signalButtons,
  selectPublishableCandidates,
  topConfirmations,
};
