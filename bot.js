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
const TelegramBot = require("node-telegram-bot-api");
const { buildTradePlan, createOutcomeTracker, DEFAULT_COSTS } = require("./outcomes");

loadLocalEnv(path.join(__dirname, ".env"));

const BOT_NAME = "Consensus Reaper";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const OWNER_ID = 7059352737;
const DEFAULT_OWNER_CHAT_ID = 7059352737;

const EXCHANGE = "OKX";
const OKX_BASE = "https://www.okx.com/api/v5/market";

const STATE_FILE = path.join(__dirname, "state.json");
const SIGNALS_FILE = path.join(__dirname, "signals.json");
const ALERTS_FILE = path.join(__dirname, "alerts.json");
const OUTCOMES_FILE = path.join(__dirname, "outcomes.json");
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
};

const MARKET_LABELS = {
  spot: "Spot",
  futures: "Futures",
};

let state = loadJson(STATE_FILE, DEFAULT_STATE);
state = migrateState(state);

const dryRun = process.argv.includes("--dry-run");
const sendTest = process.argv.includes("--send-test");

// Assigned by main(). Left null when this file is required by a test so that
// nothing polls Telegram and no token is needed.
let bot = null;
let outcomes = null;

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
  if (!bot) return Promise.resolve(false);
  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
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
  if (winner.score < 45) return null;

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

  const rawScore = Math.min(100, score.reduce((sum, n) => sum + n, 0));
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
  return {
    side,
    score: Math.round(rawScore),
    price: last.close,
    stop,
    target,
    riskRewardRatio: RISK_REWARD_RATIO,
    rsi: ctx.rsiValue,
    trend: ctx.trend,
    confirmations,
    // Kept for internal diagnostics and ranking, never shown in Telegram.
    confirmationDetails: reasons.map((label, i) => ({ label, points: score[i] })),
    time: new Date(last.time).toISOString(),
  };
}

/** The three highest-weighted reasons, used for the "Why this setup" line. */
function topConfirmations(signal, count = 3) {
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

async function scanMarkets(manual = false) {
  const started = Date.now();
  const signals = [];
  const errors = [];
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
      const signal = analyzePair(pair, { "15m": c15, "5m": c5, "1h": c1h });
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
    exchange: EXCHANGE,
    pairs: state.pairs.length,
    liveDataPairs,
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

async function broadcastSignal(signal) {
  const sentAt = new Date().toISOString();
  const record = outcomes ? outcomes.track(signal, sentAt) : null;
  if (outcomes && !record) {
    // buildTradePlan already logged the reason. Never publish a setup we cannot
    // measure: an untrackable alert would pollute the trial.
    return null;
  }
  const alertId = record ? record.id : null;
  const text = formatSignal(signal, alertId);
  appendJsonArray(ALERTS_FILE, { sentAt, alertId, chatIds: state.alertChatIds, signal }, 500);
  for (const chatId of state.alertChatIds) {
    await sendSignalAlert(chatId, signal, text);
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

const TRIAL_MIN_SETUPS = 50;
const TRIAL_DAYS = 30;

function fmtDay(iso) {
  if (!iso) return "not started";
  return new Date(iso).toISOString().slice(0, 10);
}

function fmtR(value) {
  const n = Number(value) || 0;
  return `${n >= 0 ? "+" : ""}${n.toFixed(3)}`;
}

function legText(title, leg) {
  if (!leg.resolved) return `<b>${title}</b>\nNo completed setups yet.`;
  return `<b>${title}</b>\n` +
    `Target hits: <b>${leg.tp}</b>\n` +
    `Stop losses: <b>${leg.sl}</b>\n` +
    `Success rate: <b>${leg.winRate.toFixed(1)}%</b>\n` +
    `Average result after estimated trading costs: <b>${fmtR(leg.netExpectancyR)}</b> times the amount risked\n` +
    `Statistical confidence (t-statistic): <b>${leg.tStat === null ? "not enough data" : leg.tStat.toFixed(2)}</b>`;
}

function resultsText(tracker = outcomes) {
  if (!tracker) return `<b>${BOT_NAME}</b>\n\nOutcome monitoring is not running.`;
  const s = tracker.summary();
  const costPct = ((s.costs.feeRatePerSide + s.costs.slippageRatePerSide) * 2 * 100).toFixed(2);
  const days = s.firstAlertAt
    ? Math.floor((Date.now() - Date.parse(s.firstAlertAt)) / 86400000) + 1
    : 0;

  return `<b>${BOT_NAME} — Results</b>\n\n` +
    `Trial period: <b>${fmtDay(s.firstAlertAt)}</b> to <b>${fmtDay(s.lastAlertAt)}</b>\n` +
    `Day <b>${days}</b> of <b>${TRIAL_DAYS}</b>, <b>${s.completed}</b> of <b>${TRIAL_MIN_SETUPS}</b> completed setups\n\n` +
    `Total alerts published: <b>${s.total}</b>\n` +
    `Awaiting Entry Price: <b>${s.awaitingEntry}</b>\n` +
    `Entered and still being monitored: <b>${s.enteredMonitoring}</b>\n` +
    `Cancelled before entry: <b>${s.cancelled}</b>\n` +
    `Expired before entry: <b>${s.expiredBeforeEntry}</b>\n` +
    `Expired after entry: <b>${s.expiredAfterEntry}</b>\n` +
    `Completed setups: <b>${s.completed}</b>\n\n` +
    `${legText("First Profit Target (1:1)", s.oneR)}\n\n` +
    `${legText("Final Profit Target (3:1)", s.threeR)}\n\n` +
    `<i>A t-statistic above 2 is stronger evidence that the result may not be random.</i>\n\n` +
    `Estimated trading costs assumed: <b>${costPct}%</b> per completed setup ` +
    `(${(s.costs.feeRatePerSide * 100).toFixed(3)}% fee and ${(s.costs.slippageRatePerSide * 100).toFixed(3)}% slippage on entry and exit).\n` +
    `Setups expire after <b>${s.expiryHours} hours</b> without a result.` +
    (s.dataGaps ? `\nSetups with incomplete monitoring data: <b>${s.dataGaps}</b>` : "");
}

function commandPattern(command) {
  return new RegExp(`\\/${command}(?:@\\w+)?(?:\\s+(.*))?$`, "i");
}

function helpText() {
  return `<b>${BOT_NAME}</b>\n\n` +
    `Multi-timeframe market-structure scanner for major ${EXCHANGE} pairs.\n` +
    `Spot and futures, 5m/15m/1h consensus, with direct TradingView links.\n\n` +
    `<b>Commands</b>\n` +
    `/id - show this chat id\n` +
    `/activate - owner only, enable alerts here\n` +
    `/deactivate - owner only, disable alerts here\n` +
    `/status - scanner status\n` +
    `/results - owner only, how published setups performed\n` +
    `/scan - owner only, manual scan\n` +
    `/testalert - owner only, preview alert rendering\n` +
    `/pause - owner only, pause alerts\n` +
    `/resume - owner only, resume alerts\n` +
    `/pairs - list tracked pairs\n` +
    `/addpair BTCUSDT - owner only, add spot pair\n` +
    `/addpair BTCUSDT futures - owner only, add futures pair\n` +
    `/removepair BTCUSDT - owner only\n` +
    `/resetpairs - owner only, restore defaults\n` +
    `/threshold 65 - owner only\n\n` +
    `<b>What the alerts mean</b>\n` +
    `BUY means the setup expects price to rise.\n` +
    `SELL means the setup expects price to fall.\n` +
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
 * Resolve published setups against closed OKX 1m candles. Runs independently of
 * the scan loop so outcomes land promptly, and survives its own failures: a
 * monitoring error is logged, never turned into a result.
 */
async function monitorLoop() {
  while (true) {
    try {
      await outcomes.poll();
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

async function main() {
  saveJson(STATE_FILE, state);

  if (dryRun) {
    await scanMarkets(false);
    return;
  }

  if (!TELEGRAM_BOT_TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN. Set it in consensus_reaper/.env or as an environment variable.");
    process.exit(1);
  }
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: !sendTest });
  outcomes = createTracker();

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
  analyzePair,
  createTracker,
  directionWords,
  formatOutcome,
  formatSignal,
  helpText,
  resultsText,
  sampleSignal,
  signalButtons,
  topConfirmations,
};
