#!/usr/bin/env node
/**
 * edge-bot.js — single-file crypto edge scanner + Telegram notify bot.
 *
 * The idea (the "courtroom" model):
 *   No single witness convicts. The bot watches 4 independent witnesses per coin
 *   and only messages you when enough of them agree on the same direction:
 *     1. FUNDING  — is one side of the perp market overpaying? (crowded trade)
 *     2. OI       — is the crowd growing? (open interest rising into the crowding)
 *     3. LIQ MAP  — where is the nearest big pool of liquidation liquidity?
 *                   (price tends to gravitate toward it) — from tracked Hyperliquid
 *                   wallets, whose exact liquidation prices are public.
 *     4. WHALES   — which way are your tracked profitable wallets positioned?
 *
 * Zero dependencies. Node 18+. Data: Hyperliquid free public API (primary),
 * Binance public API (backtest fallback).
 *
 * Commands:
 *   node edge-bot.js scan               one-shot scan, prints to console (no Telegram needed)
 *   node edge-bot.js run                live loop: scans + Telegram alerts + interactive commands
 *   node edge-bot.js backtest BTC 120   backtest funding-fade signal on real data (coin, days)
 *   node edge-bot.js selftest           verify the engine math on synthetic data (audit mode)
 *
 * Setup (only needed for `run`):
 *   export TELEGRAM_BOT_TOKEN="123:abc"   (from @BotFather)
 *   export TELEGRAM_CHAT_ID="123456789"   (message your bot, then see /getUpdates, or use @userinfobot)
 */

'use strict';
const fs = require('fs');
const path = require('path');

/* ============================== CONFIG ============================== */

const CONFIG = {
  coins: ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'HYPE', 'SUI', 'AVAX', 'LINK', 'WIF'], // what to scan — mid-caps matter: funding dislocations are rare on majors
  trackedWallets: [                       // Hyperliquid addresses you follow (fill from the leaderboard:
    // '0x...',                           //   https://app.hyperliquid.xyz/leaderboard — pick consistent PnL, not one lucky trade)
  ],
  fundingZWindow: 168,                    // hours of history used to judge "extreme" funding (7 days)
  fundingZThreshold: 2.0,                 // |z| >= this => funding witness testifies
  minAbsFundingRate: 0.00004,             // AND |rate| must exceed this (0.004%/h ≈ 35% APR).
                                          // Guards against junk z-scores when funding flatlines at the
                                          // default rate and window variance collapses to ~0.
  oiChangePct: 5,                         // OI up >= this % in 24h => OI witness testifies
  liqClusterBandPct: 10,                  // look for liq clusters within +/- this % of price
  liqClusterBinPct: 0.5,                  // cluster bin width
  minClusterUsd: 100_000,                 // ignore clusters smaller than this (raise once wallets are added)
  alertScore: 3,                          // witnesses needed to send an alert (max 4)
  alertCooldownMin: 240,                  // don't repeat the same coin+direction alert within this window
  scanEveryMin: 15,                       // live loop scan interval
  backtest: {
    holdHours: 24,                        // exit N hours after entry
    feePerSide: 0.0005,                   // taker fee assumption (0.05% per side)
  },
  stateFile: path.join(__dirname, 'state.json'),
  journalFile: path.join(__dirname, 'journal.jsonl'), // every scan's witness states, for `evaluate`
};

// Load ../.env (the Consensus repo root) so edge-bot reuses bot.js's Telegram creds.
(function loadLocalEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* .env optional; real env vars also work */ }
})(path.join(__dirname, '..', '.env'));

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';

/* ============================== UTILS ============================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtUsd = (n) => '$' + Math.round(n).toLocaleString('en-US');
const fmtPct = (n, d = 2) => (n >= 0 ? '+' : '') + n.toFixed(d) + '%';
const nowMs = () => Date.now();

async function http(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
function std(a) {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
}
/** z-score of `value` against a trailing window (window must NOT include value). */
function zScore(value, window) {
  const s = std(window);
  if (s === 0) return 0;
  return (value - mean(window)) / s;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8')); }
  catch { return { oiSnapshots: {}, lastAlerts: {}, tgOffset: 0 }; }
}
function saveState(s) { fs.writeFileSync(CONFIG.stateFile, JSON.stringify(s, null, 2)); }

/* ============================== DATA: HYPERLIQUID ============================== */

const HL_URL = 'https://api.hyperliquid.xyz/info';
async function hl(body, retries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await http(HL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (i >= retries - 1) throw e;
      if (/HTTP 429/.test(e.message)) {
        const wait = 10_000 * (i + 1); // rate-limited: back off HARD, don't dig the hole deeper
        console.log(`  rate-limited by Hyperliquid, waiting ${wait / 1000}s…`);
        await sleep(wait);
      } else await sleep(500 * 2 ** i); // transient 500s/timeouts: short backoff
    }
  }
}

/** Current funding (hourly rate), open interest (USD), mark price for all coins. */
async function hlMarketState() {
  const [meta, ctxs] = await hl({ type: 'metaAndAssetCtxs' });
  const out = {};
  meta.universe.forEach((u, i) => {
    const c = ctxs[i];
    out[u.name] = {
      funding: parseFloat(c.funding),               // hourly rate, e.g. 0.0000125
      oiUsd: parseFloat(c.openInterest) * parseFloat(c.markPx),
      markPx: parseFloat(c.markPx),
    };
  });
  return out;
}

/** Hourly funding history, paginated (HL returns max ~500 per call). */
async function hlFundingHistory(coin, startMs, endMs = nowMs()) {
  const all = [];
  let cursor = startMs;
  for (let i = 0; i < 40; i++) {
    const batch = await hl({ type: 'fundingHistory', coin, startTime: cursor, endTime: endMs });
    if (!batch.length) break;
    all.push(...batch);
    const last = batch[batch.length - 1].time;
    if (batch.length < 400 || last >= endMs) break;
    cursor = last + 1;
    await sleep(120);
  }
  return all.map((f) => ({ time: f.time, rate: parseFloat(f.fundingRate) }));
}

/** 1h candles, paginated (HL caps ~5000 per call — needed for 365-day backtests). */
async function hlCandles(coin, startMs, endMs = nowMs()) {
  const all = [];
  let cursor = startMs;
  for (let i = 0; i < 10; i++) {
    const raw = await hl({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: cursor, endTime: endMs } });
    if (!raw.length) break;
    for (const c of raw) if (!all.length || c.t > all[all.length - 1].time) all.push({ time: c.t, open: parseFloat(c.o), close: parseFloat(c.c) });
    const last = raw[raw.length - 1].t;
    if (raw.length < 4500 || last >= endMs - 3600e3) break;
    cursor = last + 1;
    await sleep(120);
  }
  return all;
}

/** Open positions (with exact liquidation prices) for one wallet. */
async function hlPositions(wallet) {
  const st = await hl({ type: 'clearinghouseState', user: wallet });
  return (st.assetPositions || [])
    .map((p) => p.position)
    .filter((p) => p && parseFloat(p.szi) !== 0)
    .map((p) => ({
      coin: p.coin,
      size: parseFloat(p.szi),                       // >0 long, <0 short
      notionalUsd: Math.abs(parseFloat(p.positionValue)),
      entryPx: parseFloat(p.entryPx),
      liqPx: p.liquidationPx ? parseFloat(p.liquidationPx) : null,
    }));
}

/* ============================== DATA: BINANCE (backtest fallback) ============================== */

async function binanceFundingHistory(symbol, startMs, endMs = nowMs()) {
  const all = [];
  let cursor = startMs;
  for (let i = 0; i < 20; i++) {
    const batch = await http(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${endMs}&limit=1000`);
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < 1000) break;
    cursor = batch[batch.length - 1].fundingTime + 1;
    await sleep(150);
  }
  return all.map((f) => ({ time: f.fundingTime, rate: parseFloat(f.fundingRate) }));
}

async function binanceCandles(symbol, interval, startMs, endMs = nowMs()) {
  const all = [];
  let cursor = startMs;
  for (let i = 0; i < 40; i++) {
    const batch = await http(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1500`);
    if (!batch.length) break;
    all.push(...batch.map((k) => ({ time: k[0], open: parseFloat(k[1]), close: parseFloat(k[4]) })));
    if (batch.length < 1500) break;
    cursor = batch[batch.length - 1][0] + 1;
    await sleep(150);
  }
  return all;
}

/* ============================== SIGNALS (the 4 witnesses) ============================== */
/* Each witness returns { dir: -1 | 0 | +1, note }. dir is the direction it argues price goes. */

function fundingWitness(currentRate, history) {
  if (history.length < CONFIG.fundingZWindow) return { dir: 0, note: 'funding: not enough history yet' };
  const window = history.slice(-CONFIG.fundingZWindow).map((h) => h.rate);
  const z = zScore(currentRate, window);
  // Both conditions required: statistically unusual (z) AND economically meaningful (abs floor).
  const meaningful = Math.abs(currentRate) >= CONFIG.minAbsFundingRate;
  if (z >= CONFIG.fundingZThreshold && meaningful && currentRate > 0)
    return { dir: -1, z, note: `funding stretched LONG (z=${z.toFixed(1)}, ${(currentRate * 100).toFixed(4)}%/h) → longs overpaying, argues DOWN` };
  if (z <= -CONFIG.fundingZThreshold && meaningful && currentRate < 0)
    return { dir: 1, z, note: `funding stretched SHORT (z=${z.toFixed(1)}, ${(currentRate * 100).toFixed(4)}%/h) → shorts overpaying, argues UP` };
  return { dir: 0, z, note: `funding normal (z=${Math.abs(z) > 100 ? 'flat-window' : z.toFixed(1)})` };
}

function oiWitness(oiNow, oi24hAgo, fundingDir) {
  if (!oi24hAgo) return { dir: 0, note: 'OI: no 24h-ago snapshot yet (needs a day of running)' };
  const chg = ((oiNow - oi24hAgo) / oi24hAgo) * 100;
  // Rising OI only *confirms* the funding witness (the crowd is growing). It has no direction alone.
  if (chg >= CONFIG.oiChangePct && fundingDir !== 0)
    return { dir: fundingDir, chg, note: `OI up ${fmtPct(chg)} in 24h → crowd growing, confirms funding` };
  return { dir: 0, chg, note: `OI ${fmtPct(chg)} in 24h` };
}

function liqMapWitness(positions, markPx) {
  const band = CONFIG.liqClusterBandPct / 100;
  const bins = {}; // binKey -> total USD
  for (const p of positions) {
    if (p.liqPx == null) continue;
    const dist = (p.liqPx - markPx) / markPx;
    if (Math.abs(dist) > band) continue;
    const bin = Math.round(dist / (CONFIG.liqClusterBinPct / 100));
    bins[bin] = (bins[bin] || 0) + p.notionalUsd;
  }
  let best = null;
  for (const [bin, usd] of Object.entries(bins)) {
    if (usd >= CONFIG.minClusterUsd && (!best || usd > best.usd)) best = { bin: Number(bin), usd };
  }
  if (!best) return { dir: 0, note: 'liq map: no significant cluster in band (add tracked wallets)' };
  const pct = best.bin * CONFIG.liqClusterBinPct;
  const dir = pct < 0 ? -1 : 1; // magnet below → argues down; above → argues up
  return { dir, note: `liq cluster ${fmtUsd(best.usd)} at ${fmtPct(pct, 1)} from price → magnet ${dir < 0 ? 'BELOW' : 'ABOVE'}` };
}

function whaleWitness(positions) {
  if (!positions.length) return { dir: 0, note: 'whales: no tracked positions (add wallets to CONFIG)' };
  let net = 0, gross = 0;
  for (const p of positions) { net += Math.sign(p.size) * p.notionalUsd; gross += p.notionalUsd; }
  const lean = net / gross; // -1..1
  if (lean > 0.3) return { dir: 1, note: `whales net LONG ${fmtUsd(net)} → argues UP` };
  if (lean < -0.3) return { dir: -1, note: `whales net SHORT ${fmtUsd(-net)} → argues DOWN` };
  return { dir: 0, note: 'whales roughly balanced' };
}

/* ============================== SCAN + CONFLUENCE ============================== */

async function scanOnce(state, { silent = false } = {}) {
  const market = await hlMarketState();

  // whale positions, grouped by coin
  const byCoin = {};
  for (const w of CONFIG.trackedWallets) {
    try {
      for (const p of await hlPositions(w)) (byCoin[p.coin] = byCoin[p.coin] || []).push(p);
    } catch (e) { if (!silent) console.error(`wallet ${w}: ${e.message}`); }
    await sleep(120);
  }

  const results = [];
  for (const coin of CONFIG.coins) {
    const m = market[coin];
    if (!m) continue;

    const hist = await hlFundingHistory(coin, nowMs() - (CONFIG.fundingZWindow + 2) * 3600e3);
    const wFund = fundingWitness(m.funding, hist.slice(0, -1)); // window excludes latest print

    const snaps = state.oiSnapshots[coin] || [];
    const dayAgo = snaps.filter((s) => s.time <= nowMs() - 24 * 3600e3).pop();
    const wOi = oiWitness(m.oiUsd, dayAgo ? dayAgo.oiUsd : null, wFund.dir);

    const positions = byCoin[coin] || [];
    const wLiq = liqMapWitness(positions, m.markPx);
    const wWhale = whaleWitness(positions);

    // record OI snapshot (keep 3 days)
    snaps.push({ time: nowMs(), oiUsd: m.oiUsd });
    state.oiSnapshots[coin] = snaps.filter((s) => s.time > nowMs() - 72 * 3600e3);

    const witnesses = { funding: wFund, oi: wOi, liq: wLiq, whales: wWhale };
    const score = wFund.dir + wOi.dir + wLiq.dir + wWhale.dir;
    results.push({ coin, markPx: m.markPx, score, witnesses });

    // journal every scan (not just alerts) — this is the dataset that makes
    // the liq-map and whale witnesses backtestable via `evaluate`
    fs.appendFileSync(CONFIG.journalFile, JSON.stringify({
      time: nowMs(), coin, markPx: m.markPx, score,
      dirs: { funding: wFund.dir, oi: wOi.dir, liq: wLiq.dir, whales: wWhale.dir },
    }) + '\n');
  }
  saveState(state);
  return results;
}

function formatReport(r) {
  const arrow = r.score <= -CONFIG.alertScore ? '🔻 SHORT bias' : r.score >= CONFIG.alertScore ? '🔺 LONG bias' : '· neutral';
  const lines = [`${r.coin} @ ${r.markPx.toLocaleString('en-US')}  score ${r.score >= 0 ? '+' : ''}${r.score}  ${arrow}`];
  for (const w of Object.values(r.witnesses)) lines.push(`  • ${w.note}`);
  return lines.join('\n');
}

/* ============================== TELEGRAM ============================== */

const tgApi = (method, params) => http(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(params),
}, 35000);

async function tgSend(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log('[telegram not configured]\n' + text); return; }
  await tgApi('sendMessage', { chat_id: TG_CHAT, text });
}

async function tgPollCommands(state, lastResults) {
  const res = await tgApi('getUpdates', { offset: state.tgOffset, timeout: 25 });
  for (const u of res.result || []) {
    state.tgOffset = u.update_id + 1;
    const text = (u.message && u.message.text || '').trim();
    if (!text.startsWith('/')) continue;
    const [cmd, arg] = text.split(/\s+/);
    if (cmd === '/status') {
      await tgSend(lastResults.length ? lastResults.map(formatReport).join('\n\n') : 'No scan completed yet.');
    } else if (cmd === '/coin' && arg) {
      const r = lastResults.find((x) => x.coin.toUpperCase() === arg.toUpperCase());
      await tgSend(r ? formatReport(r) : `Not scanning ${arg}. Coins: ${CONFIG.coins.join(', ')}`);
    } else if (cmd === '/help') {
      await tgSend('/status — full report\n/coin BTC — one coin\n/help — this');
    }
  }
  saveState(state);
}

/* ============================== LIVE LOOP ============================== */

async function runLive() {
  const state = loadState();
  let lastResults = [];
  console.log(`edge-bot live. Coins: ${CONFIG.coins.join(', ')}. Scan every ${CONFIG.scanEveryMin}m.`);
  await tgSend(`edge-bot online. Watching ${CONFIG.coins.join(', ')}. Alert threshold: ${CONFIG.alertScore}/4 witnesses.`);

  let nextScan = 0;
  while (true) {
    if (nowMs() >= nextScan) {
      try {
        lastResults = await scanOnce(state);
        for (const r of lastResults) {
          if (Math.abs(r.score) < CONFIG.alertScore) continue;
          const key = `${r.coin}:${Math.sign(r.score)}`;
          const last = state.lastAlerts[key] || 0;
          if (nowMs() - last < CONFIG.alertCooldownMin * 60e3) continue;
          state.lastAlerts[key] = nowMs();
          saveState(state);
          await tgSend(`⚡ CONFLUENCE ALERT\n\n${formatReport(r)}\n\nNot financial advice. Check the chart.`);
        }
        console.log(`[${new Date().toISOString()}] scanned ${lastResults.length} coins`);
      } catch (e) { console.error('scan error:', e.message); }
      nextScan = nowMs() + CONFIG.scanEveryMin * 60e3;
    }
    if (TG_TOKEN && TG_CHAT) {
      try { await tgPollCommands(state, lastResults); }
      catch (e) { console.error('telegram error:', e.message); await sleep(5000); }
    } else await sleep(30_000); // no Telegram configured: console-only mode
  }
}

/* ============================== BACKTEST ENGINE ============================== */
/**
 * Core engine — shared by real backtest and selftest so the selftest audits the
 * exact code path used on real data.
 *
 * No-lookahead rules enforced here:
 *   - z-score at funding print i uses ONLY prints [i-window, i)  (strictly before i)
 *   - entry price = open of the FIRST candle that starts AFTER the funding print
 *   - exit price  = open of the candle holdHours later
 */
function runBacktestCore(funding, candles, params) {
  const { window, zThreshold, holdHours, feePerSide, minAbsRate = 0 } = params;
  const candleTimes = candles.map((c) => c.time);
  const trades = [];
  let busyUntil = -Infinity;

  const nextCandleIdxAfter = (t) => {
    let lo = 0, hi = candleTimes.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (candleTimes[mid] <= t) lo = mid + 1; else hi = mid; }
    return lo; // first candle with time > t
  };

  for (let i = window; i < funding.length; i++) {
    const win = funding.slice(i - window, i).map((f) => f.rate);
    const rate = funding[i].rate;
    const z = zScore(rate, win);
    const meaningful = Math.abs(rate) >= minAbsRate;
    let side = 0;
    if (z >= zThreshold && meaningful && rate > 0) side = -1;       // longs overpaying → fade short
    else if (z <= -zThreshold && meaningful && rate < 0) side = 1;  // shorts overpaying → fade long
    if (side === 0 || funding[i].time < busyUntil) continue;

    const eIdx = nextCandleIdxAfter(funding[i].time);
    const xIdx = eIdx + holdHours;
    if (xIdx >= candles.length) break;
    const entry = candles[eIdx].open;
    const exit = candles[xIdx].open;
    const gross = side === 1 ? (exit - entry) / entry : (entry - exit) / entry;
    const net = gross - 2 * feePerSide;
    trades.push({ time: funding[i].time, side, z, entry, exit, net });
    busyUntil = candles[xIdx].time;
  }

  const wins = trades.filter((t) => t.net > 0).length;
  const rets = trades.map((t) => t.net);
  const total = rets.reduce((s, r) => s + r, 0);
  return {
    trades,
    n: trades.length,
    hitRate: trades.length ? wins / trades.length : 0,
    avgRet: trades.length ? mean(rets) : 0,
    totalRet: total,
  };
}

/**
 * Fetch funding + candles with a disk cache: first run downloads the full range,
 * re-runs only fetch the new tail. Cuts API traffic ~99% on repeat backtests
 * (which is what gets an IP rate-limited).
 */
async function getSeries(coin, startMs) {
  const file = path.join(__dirname, 'cache', coin + '.json');
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no cache yet */ }
  const covers = cache && cache.funding.length && cache.candles.length
    && cache.funding[0].time <= startMs + 2 * 3600e3 && cache.candles[0].time <= startMs + 2 * 3600e3;
  let funding, candles;
  if (covers) {
    funding = cache.funding.concat(await hlFundingHistory(coin, cache.funding[cache.funding.length - 1].time + 1));
    candles = cache.candles.concat(await hlCandles(coin, cache.candles[cache.candles.length - 1].time + 1));
  } else {
    funding = await hlFundingHistory(coin, startMs);
    candles = await hlCandles(coin, startMs);
  }
  // dedupe by timestamp (an in-progress candle can reappear on the next fetch)
  const uniq = (arr) => [...new Map(arr.map((x) => [x.time, x])).values()].sort((a, b) => a.time - b.time);
  funding = uniq(funding); candles = uniq(candles);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ funding, candles }));
  return { funding: funding.filter((f) => f.time >= startMs), candles: candles.filter((c) => c.time >= startMs) };
}

async function backtestOne(coin, days) {
  const startMs = nowMs() - days * 24 * 3600e3;
  const pad = CONFIG.fundingZWindow * 3600e3;
  let funding, candles, source = 'hyperliquid', window = CONFIG.fundingZWindow;
  try {
    ({ funding, candles } = await getSeries(coin, startMs - pad));
  } catch (hlErr) {
    source = 'binance';
    window = 21; // Binance funding is 8-hourly → 21 prints = 7 days
    try {
      funding = await binanceFundingHistory(coin + 'USDT', startMs - pad);
      candles = await binanceCandles(coin + 'USDT', '1h', startMs - pad);
    } catch (bnErr) {
      // surface BOTH real errors — never hide the primary failure behind the fallback's
      throw new Error(`hyperliquid: ${hlErr.message} | binance: ${bnErr.message}`);
    }
  }
  if (funding.length < window + 10) throw new Error(`not enough funding history for ${coin}`);
  const res = runBacktestCore(funding, candles, {
    window, zThreshold: CONFIG.fundingZThreshold, minAbsRate: CONFIG.minAbsFundingRate,
    holdHours: CONFIG.backtest.holdHours, feePerSide: CONFIG.backtest.feePerSide,
  });
  const base = [];
  for (let i = 0; i + 24 < candles.length; i += 24) base.push((candles[i + 24].open - candles[i].open) / candles[i].open);
  return { coin, source, res, base, nFunding: funding.length };
}

async function backtest(coin, days) {
  console.log(`Backtest ${coin}, ${days} days. Signal: fade funding when |z| >= ${CONFIG.fundingZThreshold} AND |rate| >= ${CONFIG.minAbsFundingRate * 100}%/h (window ${CONFIG.fundingZWindow} prints), hold ${CONFIG.backtest.holdHours}h, fees ${CONFIG.backtest.feePerSide * 100}%/side.`);
  console.log('NOTE: this backtests the FUNDING witness only — liq-map & whale data are live-state (no history exists). Run the bot to record them, then use `evaluate`.\n');

  // Accepts: one coin ("BTC"), a comma list ("SOL,DOGE,WIF"), or "ALL" (CONFIG.coins)
  let coins = coin === 'ALL' ? CONFIG.coins : coin.split(',').map((c) => c.trim()).filter(Boolean);
  // validate against the live universe so a typo fails clearly instead of cascading
  try {
    const universe = new Set(Object.keys(await hlMarketState()));
    const bad = coins.filter((c) => !universe.has(c));
    if (bad.length) console.log(`Not on Hyperliquid, skipping: ${bad.join(', ')}`);
    coins = coins.filter((c) => universe.has(c));
  } catch { /* universe check is best-effort */ }
  const all = [];
  for (const c of coins) {
    try {
      process.stdout.write(`Fetching ${c}… `);
      const r = await backtestOne(c, days);
      console.log(`${r.nFunding} prints (${r.source})`);
      all.push(r);
    } catch (e) { console.log(`skipped: ${e.message}`); }
  }
  if (!all.length) { console.error('No data.'); process.exit(1); }

  console.log('\ncoin   trades  hit%   avg/trade  total');
  const combined = [];
  const allTrades = [];
  for (const { coin: c, res } of all) {
    combined.push(...res.trades.map((t) => t.net));
    allTrades.push(...res.trades.map((t) => ({ ...t, coin: c })));
    console.log(`${c.padEnd(6)} ${String(res.n).padEnd(7)} ${(res.hitRate * 100).toFixed(1).padEnd(6)} ${fmtPct(res.avgRet * 100).padEnd(10)} ${fmtPct(res.totalRet * 100)}`);
  }
  if (all.length > 1 && combined.length) {
    const hit = combined.filter((r) => r > 0).length / combined.length;
    const avg = mean(combined);
    const se = std(combined) / Math.sqrt(combined.length);
    const tStat = se > 0 ? avg / se : 0;
    console.log(`${'ALL'.padEnd(6)} ${String(combined.length).padEnd(7)} ${(hit * 100).toFixed(1).padEnd(6)} ${fmtPct(avg * 100).padEnd(10)} ${fmtPct(combined.reduce((s, r) => s + r, 0) * 100)}   t-stat ${tStat.toFixed(2)}`);
    console.log('\nt-stat rule of thumb: > 2 means the avg return is unlikely to be luck. Below that, unproven.');

    // --- Diagnostics: the three ways a result like this lies to you ---
    console.log('\nDiagnostics:');
    // 1. Long vs short: is this a real two-sided edge, or just squeeze-catching in one regime?
    for (const [label, side] of [['LONG (fading crowded shorts)', 1], ['SHORT (fading crowded longs)', -1]]) {
      const g = allTrades.filter((t) => t.side === side).map((t) => t.net);
      if (!g.length) { console.log(`  ${label}: 0 trades`); continue; }
      console.log(`  ${label}: ${g.length} trades, hit ${(g.filter((r) => r > 0).length / g.length * 100).toFixed(1)}%, avg ${fmtPct(mean(g) * 100)}`);
    }
    // 2. Outlier dependence: does the edge survive without its best trades?
    const sorted = [...combined].sort((a, b) => b - a);
    const median = sorted[Math.floor(sorted.length / 2)];
    const totalNoTop3 = combined.reduce((s, r) => s + r, 0) - sorted.slice(0, 3).reduce((s, r) => s + r, 0);
    console.log(`  Median trade: ${fmtPct(median * 100)} (vs mean ${fmtPct(avg * 100)} — big gap = outlier-driven)`);
    console.log(`  Total without top 3 winners: ${fmtPct(totalNoTop3 * 100)}`);
    // 3. Correlation: same-day signals across coins are ONE bet, not many.
    const times = allTrades.map((t) => t.time).sort((a, b) => a - b);
    let clusters = 0;
    for (let i = 0; i < times.length; i++) if (i === 0 || times[i] - times[i - 1] > 24 * 3600e3) clusters++;
    console.log(`  Independent signal clusters (>24h apart): ${clusters} of ${allTrades.length} trades — the honest sample size. t-stat overstates confidence by ~sqrt(${(allTrades.length / Math.max(clusters, 1)).toFixed(1)}x).`);
  }
  const last = all[all.length - 1];
  console.log(`\nBaseline (${last.coin}): avg 24h drift ${fmtPct(mean(last.base) * 100)}, avg |24h move| ${(mean(last.base.map(Math.abs)) * 100).toFixed(2)}%`);
  console.log('\nLast 5 trades (' + last.coin + '):');
  for (const t of last.res.trades.slice(-5))
    console.log(`  ${new Date(t.time).toISOString().slice(0, 16)} ${t.side === 1 ? 'LONG ' : 'SHORT'} z=${t.z.toFixed(1)} entry ${t.entry} exit ${t.exit} net ${fmtPct(t.net * 100)}`);
  console.log('\nVerdict guide: edge = hit rate meaningfully > 50% AND avg net/trade > 0 after fees AND t-stat > 2, across coins & periods.');
}

/* ============================== EVALUATE (forward-test the full confluence) ============================== */
/**
 * Reads journal.jsonl (written by every scan) and measures what actually happened
 * `holdHours` after each recorded score. This is how the liq-map and whale witnesses
 * get validated — they have no downloadable history, so the bot builds its own.
 */
async function evaluate() {
  let lines;
  try { lines = fs.readFileSync(CONFIG.journalFile, 'utf8').trim().split('\n').map(JSON.parse); }
  catch { console.log('No journal yet. Run `scan` or `run` for a while first — every scan adds a row.'); return; }

  const holdMs = CONFIG.backtest.holdHours * 3600e3;
  const mature = lines.filter((l) => l.time + holdMs < nowMs());
  console.log(`Journal: ${lines.length} rows, ${mature.length} old enough to evaluate (need ${CONFIG.backtest.holdHours}h of hindsight).`);
  if (!mature.length) return;

  // fetch candles per coin covering the journal span, then look up price holdHours later
  const byCoin = {};
  for (const l of mature) (byCoin[l.coin] = byCoin[l.coin] || []).push(l);
  const rows = [];
  for (const [coin, entries] of Object.entries(byCoin)) {
    const t0 = Math.min(...entries.map((e) => e.time));
    let candles;
    try { candles = await hlCandles(coin, t0 - 3600e3); }
    catch (e) { console.log(`${coin}: candle fetch failed (${e.message}), skipped`); continue; }
    for (const e of entries) {
      const later = candles.find((c) => c.time >= e.time + holdMs);
      if (!later) continue;
      rows.push({ ...e, fwdRet: (later.open - e.markPx) / e.markPx });
    }
  }
  if (!rows.length) { console.log('Nothing evaluable yet.'); return; }

  console.log(`\nForward ${CONFIG.backtest.holdHours}h returns by confluence score (${rows.length} observations):`);
  console.log('score   n     avg fwd ret   agree%  (agree = price moved in the score\'s direction)');
  for (let s = -4; s <= 4; s++) {
    const g = rows.filter((r) => r.score === s);
    if (!g.length) continue;
    const avg = mean(g.map((r) => r.fwdRet));
    const agree = s === 0 ? null : g.filter((r) => Math.sign(r.fwdRet) === Math.sign(s)).length / g.length;
    console.log(`${String(s).padStart(3)}    ${String(g.length).padEnd(5)} ${fmtPct(avg * 100).padEnd(13)} ${agree === null ? '—' : (agree * 100).toFixed(0) + '%'}`);
  }
  console.log('\nWhat you want to see: high |score| rows drifting the way the score points, low scores ~random.');
  console.log('Also per-witness: a witness whose dir matches the forward move more than ~52-53% of the time is earning its seat.');
  for (const w of ['funding', 'oi', 'liq', 'whales']) {
    const g = rows.filter((r) => r.dirs[w] !== 0);
    if (!g.length) { console.log(`  ${w}: no non-zero calls yet`); continue; }
    const agree = g.filter((r) => Math.sign(r.fwdRet) === r.dirs[w]).length / g.length;
    console.log(`  ${w}: ${g.length} calls, ${(agree * 100).toFixed(1)}% agreement with forward move`);
  }
}

/* ============================== SELFTEST (audit mode) ============================== */

function selftest() {
  let failed = 0;
  const check = (name, cond) => { console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}`); if (!cond) failed++; };
  console.log('edge-bot selftest — auditing engine math on synthetic data\n');

  // 1. z-score against hand-computed values: window [1,2,3,4,5] mean=3, std=sqrt(2)
  console.log('[1] zScore math');
  const z = zScore(6, [1, 2, 3, 4, 5]);
  check('z(6 | 1..5) = 3/sqrt(2) ≈ 2.1213', Math.abs(z - 3 / Math.sqrt(2)) < 1e-9);
  check('zero-variance window returns 0 (no crash)', zScore(5, [2, 2, 2]) === 0);

  // 2. Build synthetic market: hourly funding ~0, price flat at 100.
  //    Plant ONE extreme positive funding episode at hour 300; price then falls 3% over next 24h.
  //    A correct engine: exactly 1 trade, SHORT, entered on the candle AFTER the print, profitable.
  console.log('[2] signal detection + no-lookahead on planted episode');
  const H = 500, t0 = 1_700_000_000_000;
  const funding = [], candles = [];
  let px = 100;
  for (let h = 0; h < H; h++) {
    // deterministic small noise, zero-mean-ish
    const noise = 0.00001 * Math.sin(h * 1.7);
    funding.push({ time: t0 + h * 3600e3, rate: h === 300 ? 0.01 : noise });
    candles.push({ time: t0 + h * 3600e3, open: px, close: px });
    if (h >= 301 && h < 325) px *= (1 - 0.03 / 24); // the fall happens strictly AFTER the print
  }
  const res = runBacktestCore(funding, candles, { window: 168, zThreshold: 2, holdHours: 24, feePerSide: 0.0005, minAbsRate: 0.00004 });
  check('exactly 1 trade detected', res.n === 1);
  const t = res.trades[0] || {};
  check('trade is SHORT (fading crowded longs)', t.side === -1);
  check('signal fired at the planted hour (h=300)', t.time === t0 + 300 * 3600e3);
  check('entry is NEXT candle after print (h=301), price still 100', t.entry === 100);
  check('exit 24 candles later, ~3% lower', t.exit < 97.5);
  check('net return ≈ +3% - fees (profitable short)', t.net > 0.025 && t.net < 0.031);

  // 3. Lookahead trap: price falls BEFORE the funding print instead of after.
  //    A leaky engine would still "profit". A correct one enters after the drop and makes ~0.
  console.log('[3] lookahead trap');
  const funding2 = [], candles2 = [];
  let px2 = 100;
  for (let h = 0; h < H; h++) {
    if (h >= 276 && h < 300) px2 *= (1 - 0.03 / 24); // fall happens BEFORE the print at 300
    funding2.push({ time: t0 + h * 3600e3, rate: h === 300 ? 0.01 : 0.00001 * Math.sin(h * 1.7) });
    candles2.push({ time: t0 + h * 3600e3, open: px2, close: px2 });
  }
  const res2 = runBacktestCore(funding2, candles2, { window: 168, zThreshold: 2, holdHours: 24, feePerSide: 0.0005, minAbsRate: 0.00004 });
  check('trade still fires but captures ~none of the pre-print move (|gross| < 0.5%)', res2.n === 1 && Math.abs(res2.trades[0].net + 2 * 0.0005) < 0.005);

  // 4. Cooldown: two extreme prints 2h apart → only one trade (position still open).
  console.log('[4] no overlapping trades');
  const funding3 = funding.map((f) => ({ ...f }));
  funding3[302] = { ...funding3[302], rate: 0.01 };
  const res3 = runBacktestCore(funding3, candles, { window: 168, zThreshold: 2, holdHours: 24, feePerSide: 0.0005, minAbsRate: 0.00004 });
  check('overlapping signal ignored while in a trade', res3.n === 1);

  // 4b. Regression: flat-funding window (variance ~0 from float noise) must NOT fire.
  //     This is the real-world bug where funding pins at the default rate for a week
  //     and a microscopic wobble produced z-scores in the trillions.
  console.log('[4b] flat-window degenerate z regression');
  const flatFunding = [], flatCandles = [];
  for (let h = 0; h < H; h++) {
    // pinned at default rate with float-dust jitter; one tiny wobble at h=300
    const rate = h === 300 ? 0.0000130 : 0.0000125 + 1e-18 * Math.sin(h);
    flatFunding.push({ time: t0 + h * 3600e3, rate });
    flatCandles.push({ time: t0 + h * 3600e3, open: 100, close: 100 });
  }
  const resFlat = runBacktestCore(flatFunding, flatCandles, { window: 168, zThreshold: 2, holdHours: 24, feePerSide: 0.0005, minAbsRate: 0.00004 });
  check('microscopic wobble on flat funding produces ZERO trades', resFlat.n === 0);

  // 5. Witness logic sanity
  console.log('[5] witness direction logic');
  const hist = Array.from({ length: 200 }, (_, i) => ({ time: i, rate: 0.00001 * Math.sin(i) }));
  check('extreme positive funding argues DOWN', fundingWitness(0.01, hist).dir === -1);
  check('extreme negative funding argues UP', fundingWitness(-0.01, hist).dir === 1);
  check('normal funding is neutral', fundingWitness(0.00001, hist).dir === 0);
  const liq = liqMapWitness([{ coin: 'BTC', size: 5, notionalUsd: 500_000, liqPx: 97 }], 100);
  check('big liq cluster below price → magnet argues DOWN', liq.dir === -1);
  const whale = whaleWitness([{ size: 10, notionalUsd: 1_000_000 }, { size: -1, notionalUsd: 100_000 }]);
  check('whales net long → argues UP', whale.dir === 1);

  console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED ✔' : failed + ' CHECK(S) FAILED ✘'}`);
  process.exit(failed === 0 ? 0 : 1);
}

/* ============================== MAIN ============================== */

const [, , cmd, arg1, arg2] = process.argv;
(async () => {
  if (cmd === 'selftest') selftest();
  else if (cmd === 'backtest') await backtest((arg1 || 'BTC').toUpperCase(), parseInt(arg2 || '120', 10));
  else if (cmd === 'evaluate') await evaluate();
  else if (cmd === 'scan') {
    const results = await scanOnce(loadState(), { silent: false });
    console.log(results.map(formatReport).join('\n\n'));
  }
  else if (cmd === 'run') await runLive();
  else console.log('Usage: node edge-bot.js [scan | run | backtest COIN|ALL DAYS | evaluate | selftest]');
})().catch((e) => { console.error('fatal:', e.message); process.exit(1); });
