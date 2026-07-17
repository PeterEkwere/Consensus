/**
 * Consensus Reaper
 *
 * Lean crypto market-structure alert bot.
 *
 * Data sources:
 * - GeckoTerminal public API for trending pools and OHLCV candles.
 * - No wallet, no private key, no trading, no paid API key.
 *
 * Commands:
 *   /start, /help       - command list
 *   /id                 - show current chat id
 *   /activate           - owner only, add this chat/group to alerts
 *   /deactivate         - owner only, remove this chat/group from alerts
 *   /status             - show runtime config
 *   /scan               - owner only, run a manual scan now
 *   /testalert          - owner only, send a sample alert to this chat
 *   /pause, /resume     - owner only, pause/resume auto alerts
 *   /networks           - show scanned networks
 *   /addnetwork <id>    - owner only, add GeckoTerminal network id
 *   /removenetwork <id> - owner only, remove network id
 *   /watch <network> <pool>
 *   /watch <geckoterminal pool url>
 *   /watch <dexscreener pool url>
 *   /unwatch <network> <pool>
 *   /watchlist
 *   /threshold <score>  - owner only, set alert score threshold
 *   /filters            - show scan filters
 *   /liquidity <usd>    - owner only, set minimum liquidity
 *   /volume <usd>       - owner only, set minimum 1h volume
 *   /txns <count>       - owner only, set minimum 1h txns
 *   /pools <count>      - owner only, set max pools per network
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

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const STATE_FILE = path.join(__dirname, "state.json");
const SIGNALS_FILE = path.join(__dirname, "signals.json");
const ALERTS_FILE = path.join(__dirname, "alerts.json");

const DEFAULT_STATE = {
  paused: false,
  alertChatIds: [DEFAULT_OWNER_CHAT_ID],
  networks: ["solana", "base"],
  minLiquidityUsd: 25000,
  minVolumeH1Usd: 5000,
  minTxH1: 25,
  maxPoolsPerNetwork: 12,
  scanIntervalMinutes: 5,
  alertThreshold: 72,
  cooldownMinutes: 45,
  watchedPools: [],
  lastAlerts: {},
};

const NETWORK_LABELS = {
  solana: "Solana",
  base: "Base",
  eth: "Ethereum",
  ethereum: "Ethereum",
  bsc: "BNB Chain",
  arbitrum: "Arbitrum",
  polygon_pos: "Polygon",
  optimism: "Optimism",
  avalanche: "Avalanche",
};

let state = loadJson(STATE_FILE, DEFAULT_STATE);
state = {
  ...DEFAULT_STATE,
  ...state,
  watchedPools: Array.isArray(state.watchedPools) ? state.watchedPools : [],
  lastAlerts: state.lastAlerts || {},
};
saveJson(STATE_FILE, state);

const dryRun = process.argv.includes("--dry-run");
const sendTest = process.argv.includes("--send-test");
if (!dryRun && !TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Set it in consensus_reaper/.env or as an environment variable.");
  process.exit(1);
}
const bot = dryRun ? null : new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: !sendTest });

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
        "user-agent": "ConsensusReaper/1.0",
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

function networkLabel(network) {
  return NETWORK_LABELS[network] || network;
}

function poolUrl(network, poolAddress) {
  return `https://www.geckoterminal.com/${network}/pools/${poolAddress}`;
}

function txCount(attrs, bucket) {
  const tx = attrs.transactions && attrs.transactions[bucket];
  if (!tx) return 0;
  return Number(tx.buys || 0) + Number(tx.sells || 0);
}

async function fetchTrendingPools(network) {
  const url = `${GECKO_BASE}/networks/${encodeURIComponent(network)}/trending_pools?page=1`;
  const json = await httpGetJson(url);
  const rows = Array.isArray(json && json.data) ? json.data : [];
  return rows.map((row) => {
    const attrs = row.attributes || {};
    const address = attrs.address || String(row.id || "").replace(`${network}_`, "");
    return {
      id: row.id,
      network,
      address,
      name: attrs.name || "?",
      priceUsd: Number(attrs.base_token_price_usd || 0),
      liquidityUsd: Number(attrs.reserve_in_usd || 0),
      volumeH1Usd: Number(attrs.volume_usd && attrs.volume_usd.h1 || 0),
      volumeH24Usd: Number(attrs.volume_usd && attrs.volume_usd.h24 || 0),
      txH1: txCount(attrs, "h1"),
      txH24: txCount(attrs, "h24"),
      changeM15: Number(attrs.price_change_percentage && attrs.price_change_percentage.m15 || 0),
      changeH1: Number(attrs.price_change_percentage && attrs.price_change_percentage.h1 || 0),
      changeH6: Number(attrs.price_change_percentage && attrs.price_change_percentage.h6 || 0),
      changeH24: Number(attrs.price_change_percentage && attrs.price_change_percentage.h24 || 0),
      createdAt: attrs.pool_created_at || null,
      raw: attrs,
    };
  });
}

async function fetchPool(network, poolAddress) {
  const url = `${GECKO_BASE}/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(poolAddress)}`;
  const json = await httpGetJson(url);
  const row = json && json.data;
  if (!row || !row.attributes) return null;
  const attrs = row.attributes || {};
  return {
    id: row.id,
    network,
    address: attrs.address || poolAddress,
    name: attrs.name || "?",
    priceUsd: Number(attrs.base_token_price_usd || 0),
    liquidityUsd: Number(attrs.reserve_in_usd || 0),
    volumeH1Usd: Number(attrs.volume_usd && attrs.volume_usd.h1 || 0),
    volumeH24Usd: Number(attrs.volume_usd && attrs.volume_usd.h24 || 0),
    txH1: txCount(attrs, "h1"),
    txH24: txCount(attrs, "h24"),
    changeM15: Number(attrs.price_change_percentage && attrs.price_change_percentage.m15 || 0),
    changeH1: Number(attrs.price_change_percentage && attrs.price_change_percentage.h1 || 0),
    changeH6: Number(attrs.price_change_percentage && attrs.price_change_percentage.h6 || 0),
    changeH24: Number(attrs.price_change_percentage && attrs.price_change_percentage.h24 || 0),
    createdAt: attrs.pool_created_at || null,
    watched: true,
    raw: attrs,
  };
}

async function fetchOhlcv(network, poolAddress, frame = "15m", limit = 96) {
  const tf = frameToGecko(frame);
  const url = `${GECKO_BASE}/networks/${encodeURIComponent(network)}` +
    `/pools/${encodeURIComponent(poolAddress)}/ohlcv/${tf.unit}` +
    `?aggregate=${tf.aggregate}&limit=${limit}`;
  const json = await httpGetJson(url);
  const list = json && json.data && json.data.attributes && json.data.attributes.ohlcv_list;
  if (!Array.isArray(list)) return [];
  return list.map((row) => ({
    time: Number(row[0]) * 1000,
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5] || 0),
  })).filter((c) => Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.time - b.time);
}

function frameToGecko(frame) {
  if (frame === "5m") return { unit: "minute", aggregate: 5 };
  if (frame === "15m") return { unit: "minute", aggregate: 15 };
  if (frame === "30m") return { unit: "minute", aggregate: 30 };
  if (frame === "1h") return { unit: "hour", aggregate: 1 };
  if (frame === "4h") return { unit: "hour", aggregate: 4 };
  return { unit: "minute", aggregate: 15 };
}

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

function analyzePool(pool, candles) {
  if (candles.length < 55) return null;
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

  const long = scoreSide("long", {
    pool,
    candles,
    last,
    trend,
    levels,
    retest,
    bos,
    patterns,
    e20,
    e50,
    rsiValue,
    volExpansion,
    lastMovePct,
    volatility,
  });
  const short = scoreSide("short", {
    pool,
    candles,
    last,
    trend,
    levels,
    retest,
    bos,
    patterns,
    e20,
    e50,
    rsiValue,
    volExpansion,
    lastMovePct,
    volatility,
  });
  const winner = long.score >= short.score ? long : short;
  if (winner.score < 45) return null;
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
    network: ctx.pool.network,
    poolAddress: ctx.pool.address,
    name: ctx.pool.name,
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
    liquidityUsd: ctx.pool.liquidityUsd,
    volumeH1Usd: ctx.pool.volumeH1Usd,
    volumeH24Usd: ctx.pool.volumeH24Usd,
    txH1: ctx.pool.txH1,
    changeM15: ctx.pool.changeM15,
    changeH1: ctx.pool.changeH1,
    changeH24: ctx.pool.changeH24,
    confirmations,
    time: new Date(last.time).toISOString(),
    url: poolUrl(ctx.pool.network, ctx.pool.address),
  };
}

function filterPools(pools) {
  return pools
    .filter((p) => p.address)
    .filter((p) => p.priceUsd > 0)
    .filter((p) => p.liquidityUsd >= Number(state.minLiquidityUsd || 0))
    .filter((p) => p.volumeH1Usd >= Number(state.minVolumeH1Usd || 0))
    .filter((p) => p.txH1 >= Number(state.minTxH1 || 0))
    .sort((a, b) => {
      const aScore = a.volumeH1Usd + a.liquidityUsd * 0.2 + a.txH1 * 100;
      const bScore = b.volumeH1Usd + b.liquidityUsd * 0.2 + b.txH1 * 100;
      return bScore - aScore;
    })
    .slice(0, Number(state.maxPoolsPerNetwork || 12));
}

async function scanMarkets(manual = false) {
  const started = Date.now();
  const signals = [];
  const errors = [];

  for (const network of state.networks) {
    let pools = [];
    try {
      pools = filterPools(await fetchTrendingPools(network));
    } catch (err) {
      errors.push(`${network}: ${err.message}`);
    }

    for (const pool of pools) {
      try {
        const candles = await fetchOhlcv(network, pool.address, "15m", 96);
        const signal = analyzePool(pool, candles);
        if (signal) signals.push(signal);
      } catch (err) {
        errors.push(`${pool.name}: ${err.message}`);
      }
      await sleep(550);
    }
  }

  const watched = Array.isArray(state.watchedPools) ? state.watchedPools : [];
  for (const item of watched) {
    try {
      const pool = await fetchPool(item.network, item.address);
      if (!pool || !pool.priceUsd) continue;
      const duplicate = signals.some((s) => s.network === pool.network && s.poolAddress === pool.address);
      const candles = await fetchOhlcv(pool.network, pool.address, "15m", 96);
      const signal = analyzePool(pool, candles);
      if (signal && !duplicate) {
        signal.confirmations.unshift("Manual watchlist pair");
        signal.score = Math.min(100, signal.score + 5);
        signals.push(signal);
      }
    } catch (err) {
      errors.push(`${item.network}:${item.address}: ${err.message}`);
    }
    await sleep(550);
  }

  signals.sort((a, b) => b.score - a.score);
  const accepted = signals.filter((s) => s.score >= state.alertThreshold);
  const fresh = accepted.filter((s) => !isCoolingDown(s));

  const summary = {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    networks: state.networks,
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
  return `${signal.network}:${signal.poolAddress}:${signal.side}`;
}

function isCoolingDown(signal) {
  const key = cooldownKey(signal);
  const last = Number(state.lastAlerts[key] || 0);
  const cooldownMs = Number(state.cooldownMinutes || 45) * 60 * 1000;
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

  return `<b>${BOT_NAME}</b>\n\n` +
    `<b>${esc(signal.name)} | ${direction}</b>\n` +
    `Network: <b>${esc(networkLabel(signal.network))}</b>\n` +
    `Timeframe: <b>15m</b>\n` +
    `Time: <b>${esc(time)} WAT</b>\n\n` +
    `<b>Setup Quality</b>\n` +
    `Confidence: <b>${signal.score}%</b>\n` +
    `Trend: <b>${esc(signal.trend)}</b>\n` +
    `RSI: <b>${signal.rsi.toFixed(1)}</b>\n\n` +
    `<b>Confluence</b>\n${conf}\n\n` +
    `<b>Market Context</b>\n` +
    `Price: <code>${fmtPrice(signal.price)}</code>\n` +
    `15m change: <b>${fmtPct(signal.changeM15)}</b>\n` +
    `1h change: <b>${fmtPct(signal.changeH1)}</b>\n` +
    `Liquidity: <b>${fmtUsd(signal.liquidityUsd)}</b>\n` +
    `1h volume: <b>${fmtUsd(signal.volumeH1Usd)}</b>\n\n` +
    `<b>Trade Map</b>\n` +
    `Entry zone: <code>${fmtPrice(signal.entryLow)} - ${fmtPrice(signal.entryHigh)}</code>\n` +
    `Invalidation: <code>${fmtPrice(signal.stop)}</code>\n` +
    `Targets: <code>${fmtPrice(signal.target1)}</code> / <code>${fmtPrice(signal.target2)}</code>\n\n` +
    `<i>Manual execution only. This is a scanner alert, not financial advice.</i>`;
}

function printDryRun(summary) {
  console.log(`${BOT_NAME} dry run`);
  console.log(`Networks: ${summary.networks.join(", ")}`);
  console.log(`Duration: ${(summary.durationMs / 1000).toFixed(1)}s`);
  console.log(`Candidates: ${summary.candidates}`);
  console.log(`Above threshold: ${summary.accepted}`);
  console.log(`Fresh alerts: ${summary.fresh}`);
  if (summary.errors.length) {
    console.log(`Errors: ${summary.errors.join(" | ")}`);
  }
  for (const s of summary.top.slice(0, 5)) {
    console.log(`- ${s.score}% ${s.side.toUpperCase()} ${s.name} ${s.network} price=${fmtPrice(s.price)} vol1h=${fmtUsd(s.volumeH1Usd)}`);
    console.log(`  ${s.confirmations.slice(0, 4).join("; ")}`);
  }
}

async function sendToOwner(text) {
  return sendHtml(DEFAULT_OWNER_CHAT_ID, text);
}

function statusText() {
  const chats = state.alertChatIds.map((id) => `<code>${esc(id)}</code>`).join(", ");
  const alerts = loadJson(ALERTS_FILE, []);
  const signals = loadJson(SIGNALS_FILE, []);
  const lastScan = signals[0] && signals[0].scannedAt ? signals[0].scannedAt : "never";
  return `<b>${BOT_NAME} Status</b>\n\n` +
    `Paused: <b>${state.paused ? "yes" : "no"}</b>\n` +
    `Networks: <b>${esc(state.networks.join(", "))}</b>\n` +
    `Threshold: <b>${state.alertThreshold}%</b>\n` +
    `Cooldown: <b>${state.cooldownMinutes} min</b>\n` +
    `Scan interval: <b>${state.scanIntervalMinutes} min</b>\n\n` +
    `<b>Filters</b>\n` +
    `Min liquidity: <b>${fmtUsd(state.minLiquidityUsd)}</b>\n` +
    `Min 1h volume: <b>${fmtUsd(state.minVolumeH1Usd)}</b>\n` +
    `Min 1h txns: <b>${state.minTxH1}</b>\n` +
    `Max pools/network: <b>${state.maxPoolsPerNetwork}</b>\n\n` +
    `<b>Alerts</b>\n` +
    `Chats: ${chats || "none"}\n` +
    `Watched pools: <b>${state.watchedPools.length}</b>\n` +
    `Stored alerts: <b>${alerts.length}</b>\n` +
    `Last scan: <code>${esc(lastScan)}</code>`;
}

function commandPattern(command) {
  return new RegExp(`\\/${command}(?:@\\w+)?(?:\\s+(.*))?$`, "i");
}

function helpText() {
  return `<b>${BOT_NAME}</b>\n\n` +
    `Crypto market-structure scanner for group alerts.\n\n` +
    `<b>Commands</b>\n` +
    `/id - show this chat id\n` +
    `/activate - owner only, enable alerts here\n` +
    `/deactivate - owner only, disable alerts here\n` +
    `/status - scanner status\n` +
    `/scan - owner only, manual scan\n` +
    `/testalert - owner only, preview alert rendering\n` +
    `/pause - owner only, pause alerts\n` +
    `/resume - owner only, resume alerts\n` +
    `/networks - show networks\n` +
    `/addnetwork solana - owner only\n` +
    `/removenetwork base - owner only\n` +
    `/watch solana POOL_ADDRESS - owner only\n` +
    `/watch https://www.geckoterminal.com/solana/pools/POOL - owner only\n` +
    `/watch https://dexscreener.com/solana/POOL - owner only\n` +
    `/unwatch solana POOL_ADDRESS - owner only\n` +
    `/watchlist - show exact watched pools\n` +
    `/threshold 72 - owner only\n` +
    `/filters - show scan filters\n` +
    `/liquidity 25k - owner only\n` +
    `/volume 5k - owner only\n` +
    `/txns 25 - owner only\n` +
    `/pools 12 - owner only\n\n` +
    `<i>Manual execution only. No wallet. No trading.</i>`;
}

function parsePoolWatchArgs(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const urlMatch = raw.match(/geckoterminal\.com\/([^/\s]+)\/pools\/([^?\s]+)/i);
  if (urlMatch) {
    return {
      network: urlMatch[1].toLowerCase(),
      address: urlMatch[2],
    };
  }
  const dexMatch = raw.match(/dexscreener\.com\/([^/\s]+)\/([^?\s]+)/i);
  if (dexMatch) {
    return {
      network: dexMatch[1].toLowerCase(),
      address: dexMatch[2],
    };
  }
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return {
      network: parts[0].toLowerCase(),
      address: parts[1],
    };
  }
  return null;
}

function sampleSignal() {
  return {
    network: "solana",
    poolAddress: "preview",
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
    liquidityUsd: 1250000,
    volumeH1Usd: 285000,
    volumeH24Usd: 5200000,
    txH1: 420,
    changeM15: 1.24,
    changeH1: 3.18,
    changeH24: 9.72,
    confirmations: [
      "Format preview only",
      "Bullish market structure",
      "Previous resistance retested as support",
      "Bullish engulfing confirmation",
      "Price aligned above 20/50 EMA",
    ],
    time: new Date().toISOString(),
    url: "https://www.geckoterminal.com/",
  };
}

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

  bot.onText(commandPattern("networks"), (msg) => {
    sendHtml(msg.chat.id,
      `<b>Scanned Networks</b>\n\n` +
      `${esc(state.networks.join(", "))}\n\n` +
      `Common ids: <code>solana</code>, <code>base</code>, <code>eth</code>, <code>bsc</code>, <code>arbitrum</code>.`
    );
  });

  bot.onText(commandPattern("watch"), async (msg, match) => {
    if (!ownerGuard(msg)) return;
    const parsed = parsePoolWatchArgs(match[1]);
    if (!parsed) {
      return sendHtml(msg.chat.id,
        `Usage:\n` +
        `<code>/watch solana POOL_ADDRESS</code>\n` +
        `<code>/watch https://www.geckoterminal.com/solana/pools/POOL_ADDRESS</code>\n` +
        `<code>/watch https://dexscreener.com/solana/POOL_ADDRESS</code>`
      );
    }
    const exists = state.watchedPools.some((p) => p.network === parsed.network && p.address === parsed.address);
    if (!exists) {
      state.watchedPools.push(parsed);
      saveJson(STATE_FILE, state);
    }
    const pool = await fetchPool(parsed.network, parsed.address);
    const label = pool ? pool.name : `${parsed.network}:${parsed.address}`;
    sendHtml(msg.chat.id,
      `<b>Watchlist Updated</b>\n\n` +
      `Added: <b>${esc(label)}</b>\n` +
      `Network: <code>${esc(parsed.network)}</code>\n` +
      `Pool: <code>${esc(parsed.address)}</code>`
    );
  });

  bot.onText(commandPattern("unwatch"), (msg, match) => {
    if (!ownerGuard(msg)) return;
    const parsed = parsePoolWatchArgs(match[1]);
    if (!parsed) return sendHtml(msg.chat.id, "Usage: <code>/unwatch solana POOL_ADDRESS</code>");
    const before = state.watchedPools.length;
    state.watchedPools = state.watchedPools.filter((p) => !(p.network === parsed.network && p.address === parsed.address));
    saveJson(STATE_FILE, state);
    sendHtml(msg.chat.id,
      before === state.watchedPools.length
        ? "That pool was not on the watchlist."
        : `<b>Watchlist Updated</b>\n\nRemoved <code>${esc(parsed.network)}:${esc(parsed.address)}</code>.`
    );
  });

  bot.onText(commandPattern("watchlist"), (msg) => {
    if (!state.watchedPools.length) {
      return sendHtml(msg.chat.id,
        `<b>Exact Pair Watchlist</b>\n\n` +
        `No exact pools added yet.\n\n` +
        `Use:\n<code>/watch solana POOL_ADDRESS</code>`
      );
    }
    const rows = state.watchedPools.map((p, i) =>
      `${i + 1}. <code>${esc(p.network)}</code> ${esc(p.address)}`
    ).join("\n");
    sendHtml(msg.chat.id, `<b>Exact Pair Watchlist</b>\n\n${rows}`);
  });

  bot.onText(commandPattern("addnetwork"), (msg, match) => {
    if (!ownerGuard(msg)) return;
    const network = String(match[1] || "").trim().toLowerCase();
    if (!network) return sendHtml(msg.chat.id, "Usage: <code>/addnetwork solana</code>");
    if (!state.networks.includes(network)) state.networks.push(network);
    saveJson(STATE_FILE, state);
    sendHtml(msg.chat.id, `Added network: <code>${esc(network)}</code>`);
  });

  bot.onText(commandPattern("removenetwork"), (msg, match) => {
    if (!ownerGuard(msg)) return;
    const network = String(match[1] || "").trim().toLowerCase();
    if (!network) return sendHtml(msg.chat.id, "Usage: <code>/removenetwork base</code>");
    state.networks = state.networks.filter((n) => n !== network);
    if (!state.networks.length) state.networks = ["solana"];
    saveJson(STATE_FILE, state);
    sendHtml(msg.chat.id, `Removed network: <code>${esc(network)}</code>`);
  });

  bot.onText(commandPattern("threshold"), (msg, match) => {
    if (!ownerGuard(msg)) return;
    const score = Number(String(match[1] || "").trim());
    if (!Number.isFinite(score) || score < 45 || score > 95) {
      return sendHtml(msg.chat.id, "Usage: <code>/threshold 72</code>\nAllowed range: 45-95.");
    }
    state.alertThreshold = Math.round(score);
    saveJson(STATE_FILE, state);
    sendHtml(msg.chat.id, `Alert threshold set to <b>${state.alertThreshold}%</b>.`);
  });

  bot.onText(commandPattern("filters"), (msg) => {
    sendHtml(msg.chat.id,
      `<b>Scan Filters</b>\n\n` +
      `Min liquidity: <b>${fmtUsd(state.minLiquidityUsd)}</b>\n` +
      `Min 1h volume: <b>${fmtUsd(state.minVolumeH1Usd)}</b>\n` +
      `Min 1h txns: <b>${state.minTxH1}</b>\n` +
      `Max pools/network: <b>${state.maxPoolsPerNetwork}</b>\n` +
      `Alert threshold: <b>${state.alertThreshold}%</b>\n\n` +
      `Examples:\n` +
      `<code>/liquidity 50k</code>\n` +
      `<code>/volume 10k</code>\n` +
      `<code>/txns 40</code>\n` +
      `<code>/pools 20</code>`
    );
  });

  bot.onText(commandPattern("liquidity"), (msg, match) => {
    if (!ownerGuard(msg)) return;
    const amount = parseAmount(match[1]);
    if (!Number.isFinite(amount) || amount < 1000) {
      return sendHtml(msg.chat.id, "Usage: <code>/liquidity 25k</code>");
    }
    state.minLiquidityUsd = Math.round(amount);
    saveJson(STATE_FILE, state);
    sendHtml(msg.chat.id, `Minimum liquidity set to <b>${fmtUsd(state.minLiquidityUsd)}</b>.`);
  });

  bot.onText(commandPattern("volume"), (msg, match) => {
    if (!ownerGuard(msg)) return;
    const amount = parseAmount(match[1]);
    if (!Number.isFinite(amount) || amount < 100) {
      return sendHtml(msg.chat.id, "Usage: <code>/volume 5k</code>");
    }
    state.minVolumeH1Usd = Math.round(amount);
    saveJson(STATE_FILE, state);
    sendHtml(msg.chat.id, `Minimum 1h volume set to <b>${fmtUsd(state.minVolumeH1Usd)}</b>.`);
  });

  bot.onText(commandPattern("txns"), (msg, match) => {
    if (!ownerGuard(msg)) return;
    const count = Number(String(match[1] || "").trim());
    if (!Number.isFinite(count) || count < 1 || count > 5000) {
      return sendHtml(msg.chat.id, "Usage: <code>/txns 25</code>");
    }
    state.minTxH1 = Math.round(count);
    saveJson(STATE_FILE, state);
    sendHtml(msg.chat.id, `Minimum 1h transactions set to <b>${state.minTxH1}</b>.`);
  });

  bot.onText(commandPattern("pools"), (msg, match) => {
    if (!ownerGuard(msg)) return;
    const count = Number(String(match[1] || "").trim());
    if (!Number.isFinite(count) || count < 1 || count > 40) {
      return sendHtml(msg.chat.id, "Usage: <code>/pools 12</code>\nAllowed range: 1-40.");
    }
    state.maxPoolsPerNetwork = Math.round(count);
    saveJson(STATE_FILE, state);
    sendHtml(msg.chat.id, `Max pools per network set to <b>${state.maxPoolsPerNetwork}</b>.`);
  });

  bot.onText(commandPattern("scan"), async (msg) => {
    if (!ownerGuard(msg)) return;
    sendHtml(msg.chat.id, `<b>${BOT_NAME}</b>\n\nManual scan started. This can take about 20-60 seconds.`);
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
  console.log(`Networks: ${state.networks.join(", ")}`);

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
