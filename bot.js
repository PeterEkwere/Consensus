/**
 * Consensus Reaper
 *
 * Lean crypto market-structure alert bot for MAJOR exchange pairs.
 *
 * Data sources (free, official, no API key, no wallet, no trading):
 * - Binance Spot   : https://api.binance.com/api/v3
 * - Binance Futures: https://fapi.binance.com/fapi/v1  (USDⓈ-M perpetuals)
 * - Bybit v5       : https://api.bybit.com/v5/market   (fallback if Binance is geo-blocked)
 *
 * Signals use a multi-timeframe consensus: the 15m chart is the primary setup
 * timeframe, the 1h chart gates the trade direction, and the 5m chart adds a
 * momentum trigger. Pairs are shown as TradingView symbols with chart links.
 *
 * Commands:
 *   /start, /help        - command list
 *   /id                  - show current chat id
 *   /activate            - owner only, add this chat/group to alerts
 *   /deactivate          - owner only, remove this chat/group from alerts
 *   /status              - show runtime config
 *   /scan                - owner only, run a manual scan now
 *   /testalert           - owner only, send a sample alert to this chat
 *   /pause, /resume      - owner only, pause/resume auto alerts
 *   /pairs               - list tracked pairs
 *   /addpair BTCUSDT           - owner only, add a spot pair
 *   /addpair BTCUSDT futures   - owner only, add a futures (perp) pair
 *   /addpair BINANCE:BTCUSDT.P - owner only, TradingView form also accepted
 *   /removepair BTCUSDT  - owner only, remove a pair
 *   /resetpairs          - owner only, restore the default major pairs
 *   /exchange binance|bybit - owner only, set the primary data source
 *   /threshold <score>   - owner only, set alert score threshold
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const TelegramBot = require("node-telegram-bot-api");

loadLocalEnv(path.join(__dirname, ".env"));

const BOT_NAME = "Consensus Reaper";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const OWNER_ID = 7059352737;
const DEFAULT_OWNER_CHAT_ID = 7059352737;

const BINANCE_SPOT = "https://api.binance.com/api/v3";
const BINANCE_FUT = "https://fapi.binance.com/fapi/v1";
const BYBIT_BASE = "https://api.bybit.com/v5/market";

const STATE_FILE = path.join(__dirname, "state.json");
const SIGNALS_FILE = path.join(__dirname, "signals.json");
const ALERTS_FILE = path.join(__dirname, "alerts.json");

// Default universe: major, liquid pairs. Majors are tracked on futures so that
// SHORT setups are actionable and TradingView links open the perpetual chart.
const DEFAULT_PAIRS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TRXUSDT",
  "TONUSDT", "SUIUSDT", "LTCUSDT", "BCHUSDT", "DOTUSDT",
  "NEARUSDT", "APTUSDT", "ARBUSDT", "OPUSDT", "UNIUSDT",
].map((symbol) => makePair(symbol, "futures"));

const DEFAULT_STATE = {
  paused: false,
  alertChatIds: [DEFAULT_OWNER_CHAT_ID],
  exchange: "binance",        // primary data source: binance | bybit
  pairs: DEFAULT_PAIRS,
  scanIntervalMinutes: 5,
  alertThreshold: 65,
  cooldownMinutes: 30,
  useHtfGate: true,           // require the 1h trend to agree with the trade side
  minQuoteVolume24h: 5000000, // skip thin books: 24h quote volume floor (USDT)
  lastAlerts: {},
};

const EXCHANGE_LABELS = {
  binance: "Binance",
  bybit: "Bybit",
};

const MARKET_LABELS = {
  spot: "Spot",
  futures: "Futures",
};

let state = loadJson(STATE_FILE, DEFAULT_STATE);
state = migrateState(state);
saveJson(STATE_FILE, state);

const dryRun = process.argv.includes("--dry-run");
const sendTest = process.argv.includes("--send-test");
if (!dryRun && !TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Set it in consensus_reaper/.env or as an environment variable.");
  process.exit(1);
}
const bot = dryRun ? null : new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: !sendTest });

// ---------------------------------------------------------------------------
// State + env helpers
// ---------------------------------------------------------------------------

function makePair(symbol, market) {
  const api = String(symbol).toUpperCase();
  const suffix = market === "futures" ? ".P" : "";
  return {
    api,
    market: market === "futures" ? "futures" : "spot",
    tv: `BINANCE:${api}${suffix}`,
    label: labelFromSymbol(api),
  };
}

function labelFromSymbol(symbol) {
  const quotes = ["USDT", "USDC", "FDUSD", "USD", "BTC", "ETH"];
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
  // Drop legacy DEX fields if a pre-existing state.json is present.
  for (const key of ["networks", "minLiquidityUsd", "minVolumeH1Usd", "minTxH1", "maxPoolsPerNetwork", "watchedPools"]) {
    delete next[key];
  }
  // Seed / normalise the pair universe.
  if (!Array.isArray(next.pairs) || !next.pairs.length) {
    next.pairs = DEFAULT_PAIRS;
  } else {
    next.pairs = next.pairs
      .map((p) => {
        if (p && p.api && p.market) {
          return {
            api: String(p.api).toUpperCase(),
            market: p.market === "futures" ? "futures" : "spot",
            tv: p.tv || makePair(p.api, p.market).tv,
            label: p.label || labelFromSymbol(p.api),
          };
        }
        if (typeof p === "string") return makePair(p, "futures");
        return null;
      })
      .filter(Boolean);
  }
  next.alertChatIds = Array.isArray(next.alertChatIds) && next.alertChatIds.length
    ? next.alertChatIds
    : [DEFAULT_OWNER_CHAT_ID];
  // Cooldown keys changed format with the DEX -> exchange move; start clean.
  if (!loaded || loaded.watchedPools !== undefined) next.lastAlerts = {};
  else next.lastAlerts = next.lastAlerts || {};
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
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function appendJsonArray(file, item, maxItems = 500) {
  const rows = loadJson(file, []);
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
  if (!bot) return Promise.resolve();
  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  }).catch((err) => {
    console.error("Telegram send failed:", err.message);
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

function fmtPct(n) {
  const value = Number(n) || 0;
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function parseAmount(input) {
  const raw = String(input || "").trim().toLowerCase().replace(/[$,\s]/g, "");
  if (!raw) return NaN;
  const mult = raw.endsWith("m") ? 1e6 : raw.endsWith("k") ? 1e3 : 1;
  const num = Number(raw.replace(/[km]$/, ""));
  return Number.isFinite(num) ? num * mult : NaN;
}

function pctChange(from, to) {
  if (!from) return 0;
  return ((to - from) / from) * 100;
}

function median(values) {
  const sorted = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function avg(values) {
  const nums = values.filter((n) => Number.isFinite(n));
  if (!nums.length) return 0;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function exchangeLabel(exchange) {
  return EXCHANGE_LABELS[exchange] || exchange;
}

function marketLabel(pair) {
  return `${exchangeLabel(state.exchange)} ${MARKET_LABELS[pair.market] || pair.market}`;
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

  // TradingView form: "BINANCE:BTCUSDT" or "BINANCE:BTCUSDT.P"
  const tvMatch = token.match(/^[A-Z]+:([A-Z0-9]+?)(\.P)?$/);
  if (tvMatch) {
    token = tvMatch[1];
    if (tvMatch[2]) market = market || "futures";
  }

  if (!/^[A-Z0-9]{5,20}$/.test(token)) return null;
  return makePair(token, market || "spot");
}

// ---------------------------------------------------------------------------
// Exchange data adapter (Binance primary, Bybit fallback)
// ---------------------------------------------------------------------------

const BINANCE_INTERVAL = { "5m": "5m", "15m": "15m", "1h": "1h" };
const BYBIT_INTERVAL = { "5m": "5", "15m": "15", "1h": "60" };

function normalizeCandles(rows) {
  return rows
    .filter((c) => Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.time - b.time);
}

// Drops the final, still-forming candle so analysis only sees closed bars.
function dropOpenCandle(candles) {
  if (candles.length && candles[candles.length - 1].closeTime > Date.now()) {
    return candles.slice(0, -1);
  }
  return candles;
}

async function fetchBinanceKlines(market, symbol, frame, limit) {
  const base = market === "futures" ? BINANCE_FUT : BINANCE_SPOT;
  const interval = BINANCE_INTERVAL[frame] || "15m";
  const url = `${base}/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit + 1}`;
  const json = await httpGetJson(url);
  if (!Array.isArray(json)) return null;
  return normalizeCandles(json.map((row) => ({
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5] || 0),
    closeTime: Number(row[6]),
  })));
}

async function fetchBybitKlines(market, symbol, frame, limit) {
  const category = market === "futures" ? "linear" : "spot";
  const interval = BYBIT_INTERVAL[frame] || "15";
  const url = `${BYBIT_BASE}/kline?category=${category}&symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit + 1}`;
  const json = await httpGetJson(url);
  const list = json && json.result && json.result.list;
  if (!Array.isArray(list)) return null;
  // Bybit returns newest-first; each row: [start, open, high, low, close, volume, turnover].
  return normalizeCandles(list.map((row) => ({
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5] || 0),
    closeTime: Number(row[0]) + frameMs(frame),
  })));
}

function frameMs(frame) {
  if (frame === "5m") return 5 * 60 * 1000;
  if (frame === "1h") return 60 * 60 * 1000;
  return 15 * 60 * 1000;
}

async function fetchKlines(pair, frame, limit = 150) {
  const order = state.exchange === "bybit"
    ? [fetchBybitKlines, fetchBinanceKlines]
    : [fetchBinanceKlines, fetchBybitKlines];
  for (const fetcher of order) {
    const candles = await fetcher(pair.market, pair.api, frame, limit);
    if (candles && candles.length) return dropOpenCandle(candles);
  }
  return [];
}

async function fetchBinanceTicker(market, symbol) {
  const base = market === "futures" ? BINANCE_FUT : BINANCE_SPOT;
  const url = `${base}/ticker/24hr?symbol=${encodeURIComponent(symbol)}`;
  const json = await httpGetJson(url);
  if (!json || !json.lastPrice) return null;
  return {
    priceUsd: Number(json.lastPrice),
    changeH24: Number(json.priceChangePercent || 0),
    volumeH24Usd: Number(json.quoteVolume || 0),
    txH24: Number(json.count || 0),
  };
}

async function fetchBybitTicker(market, symbol) {
  const category = market === "futures" ? "linear" : "spot";
  const url = `${BYBIT_BASE}/tickers?category=${category}&symbol=${encodeURIComponent(symbol)}`;
  const json = await httpGetJson(url);
  const row = json && json.result && json.result.list && json.result.list[0];
  if (!row || !row.lastPrice) return null;
  return {
    priceUsd: Number(row.lastPrice),
    changeH24: Number(row.price24hPcnt || 0) * 100,
    volumeH24Usd: Number(row.turnover24h || 0),
    txH24: 0,
  };
}

async function fetchTicker(pair) {
  const order = state.exchange === "bybit"
    ? [fetchBybitTicker, fetchBinanceTicker]
    : [fetchBinanceTicker, fetchBybitTicker];
  for (const fetcher of order) {
    const ticker = await fetcher(pair.market, pair.api);
    if (ticker) return ticker;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Technical analysis engine (timeframe-agnostic; unchanged from v1)
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
  const supports = swings.lows.map((s) => s.price).filter((p) => p <= last.close);
  const resistances = swings.highs.map((s) => s.price).filter((p) => p >= last.close);
  const support = supports.length ? Math.max(...supports) : Math.min(...candles.slice(-20).map((c) => c.low));
  const resistance = resistances.length ? Math.min(...resistances) : Math.max(...candles.slice(-20).map((c) => c.high));
  return {
    support,
    resistance,
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
  const priorResistance = previousHighs.length ? Math.max(...previousHighs.map((s) => s.price)) : levels.resistance;
  const priorSupport = previousLows.length ? Math.min(...previousLows.map((s) => s.price)) : levels.support;
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

function analyzePair(pair, ticker, tf) {
  const candles = tf["15m"];
  if (!candles || candles.length < 55) return null;
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
  if (winner.score < 45) return null;

  // 1h consensus gate: never fight the higher timeframe when it clearly opposes.
  const opposesH1 = (winner.side === "long" && trendH1 === "bearish")
    || (winner.side === "short" && trendH1 === "bullish");
  if (state.useHtfGate && opposesH1) return null;

  // Attach exchange / pair identity + market context for the alert.
  winner.exchange = state.exchange;
  winner.market = pair.market;
  winner.symbol = pair.api;
  winner.tvSymbol = pair.tv;
  winner.name = pair.label;
  winner.url = tvChartUrl(pair.tv);
  winner.trendH1 = trendH1;
  winner.trendM5 = trendM5;
  winner.changeM15 = lastMovePct;
  winner.changeH1 = tf["1h"] && tf["1h"].length >= 2
    ? pctChange(tf["1h"][tf["1h"].length - 2].close, tf["1h"][tf["1h"].length - 1].close)
    : 0;
  winner.changeH24 = ticker ? ticker.changeH24 : 0;
  winner.volumeH24Usd = ticker ? ticker.volumeH24Usd : 0;
  winner.price = ticker && ticker.priceUsd ? ticker.priceUsd : last.close;
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

  const rawScore = Math.min(100, score.reduce((sum, n) => sum + n, 0));
  const stop = long
    ? Math.max(0, Math.min(ctx.levels.support || last.close - ctx.volatility, last.close - ctx.volatility * 1.25))
    : Math.max(ctx.levels.resistance || last.close + ctx.volatility, last.close + ctx.volatility * 1.25);
  const risk = Math.abs(last.close - stop) || ctx.volatility;
  const target1 = long ? last.close + risk * 1.5 : last.close - risk * 1.5;
  const target2 = long ? last.close + risk * 2.2 : last.close - risk * 2.2;
  const entryLow = long ? last.close - ctx.volatility * 0.25 : last.close - ctx.volatility * 0.1;
  const entryHigh = long ? last.close + ctx.volatility * 0.1 : last.close + ctx.volatility * 0.25;

  confirmations.push(...reasons);
  return {
    side,
    score: Math.round(rawScore),
    price: last.close,
    entryLow,
    entryHigh,
    stop,
    target1,
    target2,
    rsi: ctx.rsiValue,
    trend: ctx.trend,
    confirmations,
    time: new Date(last.time).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Scan loop
// ---------------------------------------------------------------------------

async function scanMarkets(manual = false) {
  const started = Date.now();
  const signals = [];
  const errors = [];

  for (const pair of state.pairs) {
    try {
      const ticker = await fetchTicker(pair);
      if (ticker && ticker.volumeH24Usd < Number(state.minQuoteVolume24h || 0)) {
        continue; // skip thin books
      }
      const [c15, c5, c1h] = await Promise.all([
        fetchKlines(pair, "15m", 150),
        fetchKlines(pair, "5m", 120),
        fetchKlines(pair, "1h", 120),
      ]);
      const signal = analyzePair(pair, ticker, { "15m": c15, "5m": c5, "1h": c1h });
      if (signal) signals.push(signal);
    } catch (err) {
      errors.push(`${pair.api}: ${err.message}`);
    }
    await sleep(250);
  }

  signals.sort((a, b) => b.score - a.score);
  const accepted = signals.filter((s) => s.score >= state.alertThreshold);
  const fresh = accepted.filter((s) => !isCoolingDown(s));

  const summary = {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    exchange: state.exchange,
    pairs: state.pairs.length,
    candidates: signals.length,
    accepted: accepted.length,
    fresh: fresh.length,
    errors,
    top: signals.slice(0, 10),
  };
  appendJsonArray(SIGNALS_FILE, summary, 200);

  if (dryRun) {
    printDryRun(summary);
  } else if (!state.paused) {
    for (const signal of fresh) {
      await broadcastSignal(signal);
      markCooldown(signal);
      await sleep(750);
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
  return `${signal.exchange}:${signal.market}:${signal.symbol}:${signal.side}`;
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

async function broadcastSignal(signal) {
  const text = formatSignal(signal);
  const alert = {
    sentAt: new Date().toISOString(),
    chatIds: state.alertChatIds,
    signal,
  };
  appendJsonArray(ALERTS_FILE, alert, 500);
  for (const chatId of state.alertChatIds) {
    await sendHtml(chatId, text, {
      reply_markup: {
        inline_keyboard: [[
          { text: "Open chart", url: signal.url },
        ]],
      },
    });
  }
}

function trendGlyph(trend) {
  if (trend === "bullish") return "bullish";
  if (trend === "bearish") return "bearish";
  return "mixed";
}

function formatSignal(signal) {
  const direction = signal.side === "long" ? "LONG SETUP" : "SHORT SETUP";
  const conf = signal.confirmations.slice(0, 6)
    .map((c) => `- ${esc(c)}`)
    .join("\n");
  const time = new Date(signal.time).toLocaleString("en-GB", {
    timeZone: "Africa/Lagos",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const marketName = `${exchangeLabel(signal.exchange)} ${MARKET_LABELS[signal.market] || signal.market}`;

  return `<b>${BOT_NAME}</b>\n\n` +
    `<b>${esc(signal.name)} | ${direction}</b>\n` +
    `Exchange: <b>${esc(marketName)}</b>\n` +
    `Timeframe: <b>15m</b> (multi-TF consensus)\n` +
    `Time: <b>${esc(time)} WAT</b>\n\n` +
    `<b>Setup Quality</b>\n` +
    `Confidence: <b>${signal.score}%</b>\n` +
    `Trend: <b>${esc(signal.trend)}</b>\n` +
    `RSI: <b>${signal.rsi.toFixed(1)}</b>\n\n` +
    `<b>Timeframe Consensus</b>\n` +
    `5m: <b>${esc(trendGlyph(signal.trendM5))}</b>\n` +
    `15m: <b>${esc(trendGlyph(signal.trend))}</b>\n` +
    `1h: <b>${esc(trendGlyph(signal.trendH1))}</b>\n\n` +
    `<b>Confluence</b>\n${conf}\n\n` +
    `<b>Market Context</b>\n` +
    `Price: <code>${fmtPrice(signal.price)}</code>\n` +
    `15m change: <b>${fmtPct(signal.changeM15)}</b>\n` +
    `1h change: <b>${fmtPct(signal.changeH1)}</b>\n` +
    `24h change: <b>${fmtPct(signal.changeH24)}</b>\n` +
    `24h volume: <b>${fmtUsd(signal.volumeH24Usd)}</b>\n\n` +
    `<b>Trade Map</b>\n` +
    `Entry zone: <code>${fmtPrice(signal.entryLow)} - ${fmtPrice(signal.entryHigh)}</code>\n` +
    `Invalidation: <code>${fmtPrice(signal.stop)}</code>\n` +
    `Targets: <code>${fmtPrice(signal.target1)}</code> / <code>${fmtPrice(signal.target2)}</code>\n\n` +
    `<b>TradingView</b>\n<code>${esc(signal.tvSymbol)}</code>\n\n` +
    `<i>Manual execution only. This is a scanner alert, not financial advice.</i>`;
}

function printDryRun(summary) {
  console.log(`${BOT_NAME} dry run`);
  console.log(`Exchange: ${summary.exchange}`);
  console.log(`Pairs: ${summary.pairs}`);
  console.log(`Duration: ${(summary.durationMs / 1000).toFixed(1)}s`);
  console.log(`Candidates: ${summary.candidates}`);
  console.log(`Above threshold: ${summary.accepted}`);
  console.log(`Fresh alerts: ${summary.fresh}`);
  if (summary.errors.length) {
    console.log(`Errors: ${summary.errors.join(" | ")}`);
  }
  for (const s of summary.top.slice(0, 8)) {
    console.log(`- ${s.score}% ${s.side.toUpperCase()} ${s.name} [${s.market}] price=${fmtPrice(s.price)} ` +
      `5m/15m/1h=${trendGlyph(s.trendM5)}/${trendGlyph(s.trend)}/${trendGlyph(s.trendH1)}`);
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
    `Exchange: <b>${esc(exchangeLabel(state.exchange))}</b>\n` +
    `Paused: <b>${state.paused ? "yes" : "no"}</b>\n` +
    `Pairs: <b>${state.pairs.length}</b> (spot ${spot}, futures ${futures})\n` +
    `Timeframes: <b>5m / 15m / 1h</b>\n` +
    `1h trend gate: <b>${state.useHtfGate ? "on" : "off"}</b>\n` +
    `Threshold: <b>${state.alertThreshold}%</b>\n` +
    `Cooldown: <b>${state.cooldownMinutes} min</b>\n` +
    `Scan interval: <b>${state.scanIntervalMinutes} min</b>\n` +
    `Min 24h volume: <b>${fmtUsd(state.minQuoteVolume24h)}</b>\n\n` +
    `<b>Alerts</b>\n` +
    `Chats: ${chats || "none"}\n` +
    `Stored alerts: <b>${alerts.length}</b>\n` +
    `Last scan: <code>${esc(lastScan)}</code>`;
}

function commandPattern(command) {
  return new RegExp(`\\/${command}(?:@\\w+)?(?:\\s+(.*))?$`, "i");
}

function helpText() {
  return `<b>${BOT_NAME}</b>\n\n` +
    `Multi-timeframe market-structure scanner for major exchange pairs.\n` +
    `Spot and futures, 5m/15m/1h consensus, TradingView links.\n\n` +
    `<b>Commands</b>\n` +
    `/id - show this chat id\n` +
    `/activate - owner only, enable alerts here\n` +
    `/deactivate - owner only, disable alerts here\n` +
    `/status - scanner status\n` +
    `/scan - owner only, manual scan\n` +
    `/testalert - owner only, preview alert rendering\n` +
    `/pause - owner only, pause alerts\n` +
    `/resume - owner only, resume alerts\n` +
    `/pairs - list tracked pairs\n` +
    `/addpair BTCUSDT - owner only, add spot pair\n` +
    `/addpair BTCUSDT futures - owner only, add futures pair\n` +
    `/removepair BTCUSDT - owner only\n` +
    `/resetpairs - owner only, restore defaults\n` +
    `/exchange binance - owner only, set data source (binance/bybit)\n` +
    `/threshold 65 - owner only\n\n` +
    `<i>Manual execution only. No wallet. No trading.</i>`;
}

function sampleSignal() {
  return {
    exchange: "binance",
    market: "futures",
    symbol: "BTCUSDT",
    tvSymbol: "BINANCE:BTCUSDT.P",
    name: "BTC / USDT",
    side: "long",
    score: 84,
    price: 64250,
    entryLow: 64180,
    entryHigh: 64320,
    stop: 63680,
    target1: 65100,
    target2: 65850,
    rsi: 58.4,
    trend: "bullish",
    trendH1: "bullish",
    trendM5: "bullish",
    changeM15: 1.24,
    changeH1: 3.18,
    changeH24: 9.72,
    volumeH24Usd: 5200000000,
    confirmations: [
      "Format preview only",
      "Bullish market structure",
      "Break and retest above prior resistance",
      "1h trend aligned",
      "5m momentum aligned",
    ],
    time: new Date().toISOString(),
    url: "https://www.tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT.P",
  };
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

if (!dryRun) {
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
        `<code>/addpair BINANCE:BTCUSDT.P</code>`
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
    const token = String(match[1] || "").trim().toUpperCase().replace(/^[A-Z]+:/, "").replace(/\.P$/, "");
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

  bot.onText(commandPattern("exchange"), (msg, match) => {
    if (!ownerGuard(msg)) return;
    const choice = String(match[1] || "").trim().toLowerCase();
    if (choice !== "binance" && choice !== "bybit") {
      return sendHtml(msg.chat.id, "Usage: <code>/exchange binance</code> or <code>/exchange bybit</code>");
    }
    state.exchange = choice;
    saveJson(STATE_FILE, state);
    sendHtml(msg.chat.id, `Primary data source set to <b>${esc(exchangeLabel(choice))}</b>.`);
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

  bot.onText(commandPattern("testalert"), (msg) => {
    if (!ownerGuard(msg)) return;
    const text = `<b>TEST ALERT - FORMAT PREVIEW</b>\n\n` + formatSignal(sampleSignal());
    sendHtml(msg.chat.id, text);
  });

  bot.on("polling_error", (err) => {
    console.error("Polling error:", err.message);
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function autoLoop() {
  if (sendTest) {
    await sendToOwner(`<b>TEST ALERT - FORMAT PREVIEW</b>\n\n${formatSignal(sampleSignal())}`);
    console.log("Test alert sent to Telegram.");
    return;
  }
  if (dryRun) {
    await scanMarkets(false);
    return;
  }
  console.log(`${BOT_NAME} is running.`);
  console.log(`Owner ID: ${OWNER_ID}`);
  console.log(`Alert chats: ${state.alertChatIds.join(", ")}`);
  console.log(`Exchange: ${state.exchange}, pairs: ${state.pairs.length}`);

  await sendToOwner(`<b>${BOT_NAME}</b>\n\nBot started.\nUse /id in your group, then /activate to enable group alerts.`);

  while (true) {
    try {
      if (!state.paused) await scanMarkets(false);
    } catch (err) {
      console.error("Scan failed:", err.message);
    }
    await sleep(Math.max(1, Number(state.scanIntervalMinutes || 5)) * 60 * 1000);
  }
}

autoLoop().catch((err) => {
  console.error(err);
  process.exit(1);
});
