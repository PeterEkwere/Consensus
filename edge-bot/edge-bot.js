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
 *   node edge-bot.js evaluate-scalps    evaluate journal outcomes after 5/15/60 minutes
 *   node edge-bot.js selftest           verify the engine math on synthetic data (audit mode)
 *
 * Setup (only needed for `run`):
 *   export TELEGRAM_BOT_TOKEN="123:abc"   (from @BotFather)
 *   export TELEGRAM_CHAT_ID="123456789"   (message your bot, then see /getUpdates, or use @userinfobot)
 */

'use strict';
const fs = require('fs');
const path = require('path');

// Journals and wallet-cohort state stay private regardless of the parent
// process manager's default file-creation mask.
process.umask(0o077);

/* ============================== CONFIG ============================== */

const CONFIG = {
  coins: ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'HYPE', 'SUI', 'AVAX', 'LINK', 'WIF'], // what to scan — mid-caps matter: funding dislocations are rare on majors
  trackedWallets: [                       // Hyperliquid addresses you follow (fill from the leaderboard:
    // '0x...',                           //   https://app.hyperliquid.xyz/leaderboard — pick consistent PnL, not one lucky trade)
  ],
  liquidityProviderWallets: [             // high-turnover / possible market makers, researched separately
    // '0x...',                           // never added directly to the directional witness
  ],
  fundingZWindow: 168,                    // hours of history used to judge "extreme" funding (7 days)
  fundingZThreshold: 2.0,                 // |z| >= this => funding witness testifies
  minAbsFundingRate: 0.00004,             // AND |rate| must exceed this (0.004%/h ≈ 35% APR).
                                          // Guards against junk z-scores when funding flatlines at the
                                          // default rate and window variance collapses to ~0.
  oiLookbackMin: 15,                      // scalping context: OI expansion over the last 15m
  oiChangePct: 0.25,                      // |OI change| >= this % in the lookback => crowd is building
  minPriceChangePct: 0.10,                // ...and price must have actually moved to give that build a direction
  liqClusterBandPct: 2,                   // scalping map: nearby clusters within +/- 2%
  liqClusterBinPct: 0.25,                 // tighter cluster bins for short-horizon moves
  minClusterUsd: 250_000,                 // ignore small cohort liquidation pockets
  minLiqResearchUsd: 50_000,              // unscored lower bar used only to measure the hypothesis
  // Only these witnesses contribute to the score. `liq` is computed and journaled
  // but stays unscored: it is built from the tracked cohort's own liquidation
  // prices, so it samples 8 accounts rather than the market. Across 63,900 scans
  // it never produced a single pocket of any size, which means a scored `liq`
  // is a permanent zero that silently raises the bar for every other witness.
  scoredWitnesses: ['funding', 'oi', 'whales'],
  researchWitnesses: ['liq'],
  alertScore: 2,                          // agreeing witnesses needed to alert (max 3)
  // Collect and journal, but never send trade alerts. The threshold above is now
  // actually reachable (it was not before), and on the first 4.8 days of real
  // data the score is noise: 47% agreement, gross returns ~20x smaller than the
  // 0.10% round-trip fee. Set false only when a witness has earned it on
  // out-of-sample data. Alerts are logged either way so the stream stays visible.
  researchMode: true,
  alertCooldownMin: 30,                   // scalps can reset faster than swing setups
  scanEveryMin: 1,                        // observe directional scalpers before their books change
  scalpEvaluationMin: [5, 15, 60],        // forward horizons for journal-based scalp research
  walletFlowLookbackMin: [5, 15],         // real size changes, not repeated held-position snapshots
  minWalletFlowUsd: 25_000,               // research threshold; never contributes to alerts yet
  liquidityFlowLookbackMin: [5, 15],      // measure high-turnover cohort inventory changes
  minLiquidityFlowUsd: 50_000,            // research threshold on actual size delta, not USD repricing
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

// Keep server-only wallet addresses in .env so a git pull cannot overwrite them.
// Addresses are public, but the tracked cohort is research configuration rather
// than source code and will change as the cohort is reviewed.
const envWallets = (process.env.HYPERLIQUID_TRACKED_WALLETS || '')
  .split(',')
  .map((w) => w.trim().toLowerCase())
  .filter((w) => /^0x[a-f0-9]{40}$/.test(w));
CONFIG.trackedWallets = [...new Set([...CONFIG.trackedWallets, ...envWallets])];
const envLiquidityWallets = (process.env.HYPERLIQUID_LP_WALLETS || '')
  .split(',')
  .map((w) => w.trim().toLowerCase())
  .filter((w) => /^0x[a-f0-9]{40}$/.test(w));
const directionalWalletSet = new Set(CONFIG.trackedWallets);
CONFIG.liquidityProviderWallets = [...new Set([
  ...CONFIG.liquidityProviderWallets,
  ...envLiquidityWallets,
])].filter((w) => !directionalWalletSet.has(w));

// A separate Edge Bot token avoids two processes competing for Telegram
// getUpdates. The shared token remains a send-only fallback when no Edge Bot
// chat id is configured.
const TG_TOKEN = process.env.EDGE_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.EDGE_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';

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

function readJournal(file = CONFIG.journalFile) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return { rows: [], invalid: 0, missing: true }; }
  const rows = [];
  let invalid = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (Number.isFinite(row.time) && row.coin && Number.isFinite(row.markPx) && row.dirs) rows.push(row);
      else invalid++;
    } catch { invalid++; }
  }
  rows.sort((a, b) => a.time - b.time);
  return { rows, invalid, missing: false };
}

function selectNonOverlapping(rows, gapMs) {
  const selected = [];
  const lastByCoin = {};
  for (const row of [...rows].sort((a, b) => a.time - b.time)) {
    const last = lastByCoin[row.coin] ?? -Infinity;
    if (row.time - last < gapMs) continue;
    selected.push(row);
    lastByCoin[row.coin] = row.time;
  }
  return selected;
}

function mapValues(obj, fn) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}

/**
 * Always derive the score from `dirs` rather than trusting a row's stored
 * `score`. Journals span schema versions with different scoring rules, and
 * recomputing keeps every row on today's definition so old and new windows
 * stay comparable. A witness that is absent from an older row counts as
 * silent, which is what it actually was.
 */
function scoreOf(row) {
  return CONFIG.scoredWitnesses.reduce((sum, w) => sum + Number((row.dirs || {})[w] || 0), 0);
}

const maxScore = () => CONFIG.scoredWitnesses.length;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function observedJournalCadenceMin(rows) {
  const lastByCoin = {};
  const gaps = [];
  for (const row of rows) {
    const last = lastByCoin[row.coin];
    if (Number.isFinite(last) && row.time > last) gaps.push((row.time - last) / 60e3);
    lastByCoin[row.coin] = row.time;
  }
  return median(gaps);
}

function journalStatus(file = CONFIG.journalFile) {
  const { rows, invalid, missing } = readJournal(file);
  if (missing) { console.log(`No journal found at ${file}`); return; }
  if (!rows.length) { console.log(`Journal at ${file} has no valid rows (${invalid} malformed).`); return; }

  const first = rows[0].time;
  const last = rows[rows.length - 1].time;
  const durationDays = (last - first) / 86400e3;
  const coinCounts = {};
  for (const row of rows) coinCounts[row.coin] = (coinCounts[row.coin] || 0) + 1;
  const witnessCalls = {};
  for (const witness of [...CONFIG.scoredWitnesses, ...CONFIG.researchWitnesses]) {
    witnessCalls[witness] = rows.filter((r) => Number(r.dirs[witness] || 0) !== 0).length;
  }
  const observedCadenceMin = observedJournalCadenceMin(rows) || CONFIG.scanEveryMin;
  const expected = Math.max(1, Math.round(((last - first) / (observedCadenceMin * 60e3) + 1) * Object.keys(coinCounts).length));
  const mature = rows.filter((r) => r.time + CONFIG.backtest.holdHours * 3600e3 < nowMs()).length;
  const sizeFlowRows = rows.filter((r) => Number(r.schemaVersion || 1) >= 2).length;
  const walletSamples = rows.filter((r) => r.walletDirs && Object.keys(r.walletDirs).length).length;
  const liquiditySamples = rows.filter((r) => r.lpWalletUsd && Object.keys(r.lpWalletUsd).length).length;

  console.log('Edge Bot research journal');
  console.log(`File: ${file}`);
  console.log(`Valid rows: ${rows.length}${invalid ? ` (${invalid} malformed skipped)` : ''}`);
  console.log(`Period: ${new Date(first).toISOString()} -> ${new Date(last).toISOString()} (${durationDays.toFixed(1)} days)`);
  console.log(`Observed scan cadence: ${observedCadenceMin.toFixed(1)}m (current config ${CONFIG.scanEveryMin}m)`);
  console.log(`Approx scan coverage: ${(Math.min(rows.length / expected, 1) * 100).toFixed(1)}% at observed cadence`);
  console.log(`Mature ${CONFIG.backtest.holdHours}h outcomes: ${mature}`);
  console.log(`Size-flow schema rows: ${sizeFlowRows} (need these to test real wallet inventory changes)`);
  console.log(`Directional scalper wallets configured here: ${CONFIG.trackedWallets.length} (${walletSamples} rows with active positions)`);
  console.log(`High-turnover/LP wallets configured here: ${CONFIG.liquidityProviderWallets.length} (${liquiditySamples} rows with active inventory)`);
  console.log(`Coins: ${Object.entries(coinCounts).map(([coin, n]) => `${coin}=${n}`).join(', ')}`);
  console.log(`Scored witnesses: ${CONFIG.scoredWitnesses.join(', ')} (max |score| ${maxScore()}); unscored research: ${CONFIG.researchWitnesses.join(', ')}`);
  console.log(`Non-zero witness calls: ${Object.entries(witnessCalls).map(([w, n]) => `${w}=${n}`).join(', ')}`);
  console.log(`Threshold events (|score| >= ${CONFIG.alertScore}): ${rows.filter((r) => Math.abs(scoreOf(r)) >= CONFIG.alertScore).length}`);

  // A tracked cohort that never changes size cannot produce flow research no
  // matter how long collection runs. Surface it here rather than after a week.
  const v2 = rows.filter((r) => Number(r.schemaVersion || 1) >= 2);
  const changed = (key) => v2.filter((r) => Math.abs(Number((r.meta || {})[key]) || 0) > 0).length;
  if (v2.length) {
    const wallet5 = changed('walletSizeFlow5mUsd');
    const lp5 = changed('lpSizeFlow5mUsd');
    console.log(
      `Cohort activity (5m size changes): directional ${wallet5}/${v2.length} scans (${(wallet5 / v2.length * 100).toFixed(2)}%), `
      + `high-turnover ${lp5}/${v2.length} (${(lp5 / v2.length * 100).toFixed(2)}%)`,
    );
    if (wallet5 / v2.length < 0.02) {
      console.log('  WARNING: the directional cohort changes size in under 2% of scans. These wallets are too'
        + ' inactive on these coins to produce a flow sample — re-screen with `screen-wallets` before collecting further.');
    }
  }

  const silentWitnesses = CONFIG.scoredWitnesses.filter((w) => witnessCalls[w] === 0);
  const observedVotingCapacity = CONFIG.scoredWitnesses.length - silentWitnesses.length;
  if (witnessCalls.whales === 0 && !rows.some((r) => r.walletDirs && Object.keys(r.walletDirs).length)) {
    console.log('READINESS: no tracked-wallet data in this window. Configure wallets and collect a new one.');
  } else if (sizeFlowRows === 0) {
    console.log('READINESS: held-position data exists, but real wallet size changes were not recorded in this legacy window.');
  } else if (observedVotingCapacity < CONFIG.alertScore) {
    console.log(`READINESS: pipeline healthy, but only ${observedVotingCapacity} scored witness(es) made calls in this window, so the observed data could not reach threshold ${CONFIG.alertScore}. Diagnose before collecting further.`);
  } else if (durationDays < 14) {
    const silentNote = silentWitnesses.length
      ? ` ${silentWitnesses.join('/')} made no call yet, but the other ${observedVotingCapacity} observed witnesses can still reach threshold ${CONFIG.alertScore}.`
      : ' All scored witnesses have made calls.';
    console.log(`READINESS: pipeline healthy; this is an early diagnostic window.${silentNote} Keep collecting for several weeks.`);
  } else {
    const silentNote = silentWitnesses.length ? ` Scored witness(es) ${silentWitnesses.join('/')} remained silent and should be reviewed.` : '';
    console.log(`READINESS: enough elapsed time for a first evaluation; statistical confidence still depends on non-overlapping signal counts.${silentNote}`);
  }
}

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

/**
 * OKX provides paginated hourly history from recent years. Hyperliquid's candle
 * endpoint only exposes the most recent 5000 candles (~208 days), so OKX is the
 * price-history fallback for longer funding backtests. No API key is required.
 */
async function okxCandlesForInstrument(instId, startMs, endMs = nowMs()) {
  const all = [];
  let cursor = endMs + 1;
  for (let i = 0; i < 100 && cursor > startMs; i++) {
    const qs = new URLSearchParams({ instId, bar: '1H', after: String(cursor), limit: '300' });
    const json = await http(`https://www.okx.com/api/v5/market/history-candles?${qs}`);
    if (!json || json.code !== '0') throw new Error(`OKX ${instId}: ${json && json.msg || 'invalid response'}`);
    const batch = Array.isArray(json.data) ? json.data : [];
    if (!batch.length) break;
    for (const c of batch) {
      const time = Number(c[0]);
      if (time >= startMs && time <= endMs) all.push({ time, open: Number(c[1]), close: Number(c[4]) });
    }
    const oldest = Math.min(...batch.map((c) => Number(c[0])));
    if (!Number.isFinite(oldest) || oldest <= startMs || batch.length < 300) break;
    cursor = oldest;
    await sleep(120);
  }
  return [...new Map(all.map((c) => [c.time, c])).values()].sort((a, b) => a.time - b.time);
}

async function okxCandles(coin, startMs, endMs = nowMs()) {
  const attempts = [`${coin}-USDT-SWAP`, `${coin}-USDT`];
  const errors = [];
  for (const instId of attempts) {
    try {
      const candles = await okxCandlesForInstrument(instId, startMs, endMs);
      if (candles.length) return { candles, source: instId.endsWith('-SWAP') ? 'okx-swap' : 'okx-spot' };
    } catch (e) { errors.push(e.message); }
  }
  throw new Error(errors.join(' | ') || `no OKX candles for ${coin}`);
}

/** Open positions (with exact liquidation prices) for one wallet. */
async function hlPositions(wallet) {
  const st = await hl({ type: 'clearinghouseState', user: wallet });
  return (st.assetPositions || [])
    .map((p) => p.position)
    .filter((p) => p && parseFloat(p.szi) !== 0)
    .map((p) => ({
      wallet,
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

/**
 * OI testifies on its own from the price/OI regime, rather than only confirming
 * funding. The previous version returned dir=0 unless the funding witness had
 * already fired, so it could never speak independently: over 63,900 live scans
 * 4,451 rows showed a qualifying OI expansion but OI recorded zero calls,
 * because funding fired 72 times and never once coincided with them.
 *
 * The reading is the standard one: OI expanding while price moves means new
 * money is entering in the direction of the move (crowd building). OI expanding
 * is required — a move on shrinking OI is position closing, not fresh conviction,
 * and gets no vote.
 *
 * Note this can legitimately OPPOSE the funding witness, which fades a crowded
 * side. That is two different hypotheses (momentum vs mean reversion) disagreeing,
 * not a bug — the score cancelling is the correct outcome, and the journal
 * measures which one is right.
 */
function oiWitness(oiNow, oiPast, markPxNow, markPxPast) {
  if (!oiPast) return { dir: 0, note: `OI: no ${CONFIG.oiLookbackMin}m-old snapshot yet` };
  const chg = ((oiNow - oiPast) / oiPast) * 100;
  const priceChg = Number.isFinite(markPxPast) && markPxPast
    ? ((markPxNow - markPxPast) / markPxPast) * 100
    : null;
  const expanding = chg >= CONFIG.oiChangePct;
  const moved = Number.isFinite(priceChg) && Math.abs(priceChg) >= CONFIG.minPriceChangePct;
  if (expanding && moved) {
    const dir = Math.sign(priceChg);
    return {
      dir, chg, priceChg,
      note: `OI up ${fmtPct(chg)} with price ${fmtPct(priceChg)} in ${CONFIG.oiLookbackMin}m`
        + ` → new ${dir > 0 ? 'longs' : 'shorts'} building, argues ${dir > 0 ? 'UP' : 'DOWN'}`,
    };
  }
  const why = !expanding
    ? (chg <= -CONFIG.oiChangePct ? 'positions closing, not fresh conviction' : 'flat crowd')
    : 'OI expanding but price has not moved enough to give it a direction';
  return { dir: 0, chg, priceChg, note: `OI ${fmtPct(chg)} in ${CONFIG.oiLookbackMin}m → ${why}` };
}

/**
 * UNSCORED (see CONFIG.researchWitnesses). This builds a liquidation map from
 * the tracked cohort's own liqPx values, so it describes 8 accounts, not the
 * market. Hyperliquid exposes no market-wide liquidation heatmap, and these
 * accounts run low enough leverage that their liquidation prices sit far
 * outside the scalp band — 63,900 live scans produced zero pockets at any size.
 * Kept computed and journaled so the cohort can be re-checked after re-screening,
 * but it must not sit in the score as a permanent zero.
 */
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
  let best = null, observed = null;
  for (const [bin, usd] of Object.entries(bins)) {
    if (!observed || usd > observed.usd) observed = { bin: Number(bin), usd };
    if (usd >= CONFIG.minClusterUsd && (!best || usd > best.usd)) best = { bin: Number(bin), usd };
  }
  if (!best) return {
    dir: 0,
    usd: 0,
    pct: null,
    observedUsd: observed ? observed.usd : 0,
    observedPct: observed ? observed.bin * CONFIG.liqClusterBinPct : null,
    note: 'liq map: no significant tracked-wallet cluster in scalp band',
  };
  const pct = best.bin * CONFIG.liqClusterBinPct;
  const dir = pct < 0 ? -1 : 1; // magnet below → argues down; above → argues up
  return {
    dir,
    usd: best.usd,
    pct,
    observedUsd: best.usd,
    observedPct: pct,
    note: `liq cluster ${fmtUsd(best.usd)} at ${fmtPct(pct, 2)} from price → magnet ${dir < 0 ? 'BELOW' : 'ABOVE'}`,
  };
}

function whaleWitness(positions) {
  if (!positions.length) return { dir: 0, note: 'whales: no tracked positions (add wallets to CONFIG)' };
  // Equal-wallet voting prevents one very large account from dictating the
  // entire cohort. Liquidation clustering remains notional-weighted because
  // actual dollars at risk are what matter there.
  const votes = new Map();
  for (const p of positions) votes.set(p.wallet, Math.sign(p.size));
  const dirs = [...votes.values()];
  const longs = dirs.filter((d) => d > 0).length;
  const shorts = dirs.filter((d) => d < 0).length;
  const lean = (longs - shorts) / dirs.length;
  const dir = dirs.length >= 2 && Math.abs(lean) + Number.EPSILON >= 1 / 3 ? Math.sign(lean) : 0;
  return {
    dir, longs, shorts, active: dirs.length, lean,
    note: dir === 0
      ? `scalper cohort mixed (${longs}L/${shorts}S)`
      : `scalper cohort ${dir > 0 ? 'LONG' : 'SHORT'} (${longs}L/${shorts}S) → argues ${dir > 0 ? 'UP' : 'DOWN'}`,
  };
}

/**
 * High-turnover accounts are deliberately not a directional witness. A maker
 * can become long by absorbing aggressive sells, so the useful hypothesis is
 * whether a large position-size CHANGE predicts continuation or mean reversion.
 * Measuring base size avoids mistaking mark-price movement for wallet flow.
 */
function cohortPositionFlow(positions, snapshots, time, markPx, lookbacks, complete = true) {
  const walletSizes = {};
  for (const p of positions) {
    walletSizes[p.wallet] = (walletSizes[p.wallet] || 0) + p.size;
  }
  const netSize = Object.values(walletSizes).reduce((sum, n) => sum + n, 0);
  const grossSize = Object.values(walletSizes).reduce((sum, n) => sum + Math.abs(n), 0);
  const flowUsd = {};
  for (const minutes of lookbacks) {
    const past = snapshots.filter((s) => s.time <= time - minutes * 60e3).pop();
    flowUsd[minutes] = complete && past && Number.isFinite(past.netSize)
      ? (netSize - past.netSize) * markPx
      : null;
  }
  if (complete) {
    snapshots.push({ time, netSize, grossSize });
    const keepMs = (Math.max(...lookbacks) * 4 + 5) * 60e3;
    while (snapshots.length && snapshots[0].time < time - keepMs) snapshots.shift();
  }
  return {
    available: complete,
    netSize,
    grossSize,
    netUsd: netSize * markPx,
    grossUsd: grossSize * markPx,
    active: Object.keys(walletSizes).length,
    flowUsd,
    walletSizes,
    walletUsd: Object.fromEntries(Object.entries(walletSizes).map(([wallet, size]) => [wallet, size * markPx])),
  };
}

/* ============================== SCAN + CONFLUENCE ============================== */

const liveFundingCache = {};
async function liveFundingHistory(coin) {
  const cached = liveFundingCache[coin];
  if (cached && nowMs() - cached.time < 55 * 60e3) return cached.rows;
  const rows = await hlFundingHistory(coin, nowMs() - (CONFIG.fundingZWindow + 2) * 3600e3);
  liveFundingCache[coin] = { time: nowMs(), rows };
  return rows;
}

async function scanOnce(state, { silent = false } = {}) {
  const market = await hlMarketState();

  // Keep directional scalpers and high-turnover liquidity providers separate.
  const byCoin = {};
  const lpByCoin = {};
  const directionalObserved = new Set();
  const liquidityObserved = new Set();
  const walletTypes = new Map([
    ...CONFIG.trackedWallets.map((w) => [w, 'directional']),
    ...CONFIG.liquidityProviderWallets.map((w) => [w, 'liquidity']),
  ]);
  for (const [w, walletType] of walletTypes) {
    try {
      for (const p of await hlPositions(w)) {
        const target = walletType === 'directional' ? byCoin : lpByCoin;
        (target[p.coin] = target[p.coin] || []).push(p);
      }
      (walletType === 'directional' ? directionalObserved : liquidityObserved).add(w);
    } catch (e) { if (!silent) console.error(`wallet ${w}: ${e.message}`); }
    await sleep(120);
  }
  state.liquidityProviderSnapshots = state.liquidityProviderSnapshots || {};
  state.directionalWalletSnapshots = state.directionalWalletSnapshots || {};

  const results = [];
  for (const coin of CONFIG.coins) {
    const m = market[coin];
    if (!m) continue;

    const hist = await liveFundingHistory(coin);
    const wFund = fundingWitness(m.funding, hist.slice(0, -1)); // window excludes latest print

    const snaps = state.oiSnapshots[coin] || [];
    const oiPast = snaps.filter((s) => s.time <= nowMs() - CONFIG.oiLookbackMin * 60e3).pop();
    const wOi = oiWitness(
      m.oiUsd,
      oiPast ? oiPast.oiUsd : null,
      m.markPx,
      oiPast ? oiPast.markPx : null,
    );

    const positions = byCoin[coin] || [];
    const lpPositions = lpByCoin[coin] || [];
    const wLiq = liqMapWitness(positions, m.markPx);
    const wWhale = whaleWitness(positions);
    const scanTime = nowMs();
    const lpSnaps = state.liquidityProviderSnapshots[coin] || [];
    const lpFlow = cohortPositionFlow(
      lpPositions,
      lpSnaps,
      scanTime,
      m.markPx,
      CONFIG.liquidityFlowLookbackMin,
      liquidityObserved.size === CONFIG.liquidityProviderWallets.length,
    );
    state.liquidityProviderSnapshots[coin] = lpSnaps;
    const walletSnaps = state.directionalWalletSnapshots[coin] || [];
    const walletFlow = cohortPositionFlow(
      positions,
      walletSnaps,
      scanTime,
      m.markPx,
      CONFIG.walletFlowLookbackMin,
      directionalObserved.size === CONFIG.trackedWallets.length,
    );
    state.directionalWalletSnapshots[coin] = walletSnaps;

    // The unscored price/OI research series predates the scored OI witness and
    // uses |OI change| rather than expansion-only. It is kept computing the
    // original way so its numbers stay comparable across the schema change;
    // the scored witness above is the stricter expansion-only version.
    const oiResearchChangePct = Number.isFinite(wOi.chg) ? wOi.chg : null;
    const priceResearchChangePct = Number.isFinite(wOi.priceChg) ? wOi.priceChg : null;
    const oiPriceDir = Number.isFinite(oiResearchChangePct)
      && Number.isFinite(priceResearchChangePct)
      && Math.abs(oiResearchChangePct) >= CONFIG.oiChangePct
      && Math.abs(priceResearchChangePct) >= CONFIG.minPriceChangePct
      ? Math.sign(priceResearchChangePct)
      : 0;

    // Keep enough minute snapshots for several lookback comparisons.
    snaps.push({ time: scanTime, oiUsd: m.oiUsd, markPx: m.markPx });
    state.oiSnapshots[coin] = snaps.filter((s) => s.time > scanTime - Math.max(6 * 3600e3, CONFIG.oiLookbackMin * 4 * 60e3));

    const witnesses = { funding: wFund, oi: wOi, liq: wLiq, whales: wWhale };
    const score = scoreOf({ dirs: mapValues(witnesses, (w) => w.dir) });
    results.push({ coin, markPx: m.markPx, score, witnesses });

    // journal every scan (not just alerts) — this is the dataset that makes
    // the liq-map and whale witnesses backtestable via `evaluate`
    fs.appendFileSync(CONFIG.journalFile, JSON.stringify({
      schemaVersion: 3,
      time: scanTime, coin, markPx: m.markPx, score,
      dirs: { funding: wFund.dir, oi: wOi.dir, liq: wLiq.dir, whales: wWhale.dir },
      meta: {
        oiChangePct: Number.isFinite(wOi.chg) ? wOi.chg : null,
        liqUsd: wLiq.usd || 0,
        liqDistancePct: wLiq.pct,
        liqObservedUsd: wLiq.observedUsd || 0,
        liqObservedDistancePct: wLiq.observedPct,
        whaleLongs: wWhale.longs || 0,
        whaleShorts: wWhale.shorts || 0,
        walletNetUsd: walletFlow.netUsd,
        walletGrossUsd: walletFlow.grossUsd,
        walletSizeFlow5mUsd: walletFlow.flowUsd[5] ?? null,
        walletSizeFlow15mUsd: walletFlow.flowUsd[15] ?? null,
        lpNetUsd: lpFlow.netUsd,
        lpGrossUsd: lpFlow.grossUsd,
        lpActive: lpFlow.active,
        lpSizeFlow5mUsd: lpFlow.flowUsd[5] ?? null,
        lpSizeFlow15mUsd: lpFlow.flowUsd[15] ?? null,
        oiResearchChangePct,
        priceResearchChangePct,
        oiPriceDir,
      },
      walletDirs: Object.fromEntries(positions.map((p) => [p.wallet, Math.sign(p.size)])),
      walletSizes: walletFlow.walletSizes,
      walletUsd: walletFlow.walletUsd,
      walletMissing: CONFIG.trackedWallets.filter((wallet) => !directionalObserved.has(wallet)),
      lpWalletSizes: lpFlow.walletSizes,
      lpWalletUsd: lpFlow.walletUsd,
      lpWalletMissing: CONFIG.liquidityProviderWallets.filter((wallet) => !liquidityObserved.has(wallet)),
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
  await tgSend(`edge-bot online. Watching ${CONFIG.coins.join(', ')}. Alert threshold: ${CONFIG.alertScore}/${maxScore()} witnesses.`
    + (CONFIG.researchMode ? '\nRESEARCH MODE: journaling only, no trade alerts will be sent.' : ''));

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
          if (CONFIG.researchMode) {
            console.log(`[research-mode, not sent] confluence ${r.coin} score ${r.score}`);
            continue;
          }
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
  let skippedNoAdjacentCandle = 0;

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
    // Never pair an old funding signal with the first candle from a much later
    // limited history window. Entry must be the immediately following hourly bar.
    if (eIdx >= candles.length || candles[eIdx].time - funding[i].time > 2 * 3600e3) {
      skippedNoAdjacentCandle++;
      continue;
    }
    const xIdx = nextCandleIdxAfter(candles[eIdx].time + holdHours * 3600e3 - 1);
    if (xIdx >= candles.length) break;
    if (candles[xIdx].time - candles[eIdx].time > (holdHours + 2) * 3600e3) {
      skippedNoAdjacentCandle++;
      continue;
    }
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
    skippedNoAdjacentCandle,
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
  const fundingCovers = cache && cache.funding && cache.funding.length
    && cache.funding[0].time <= startMs + 2 * 3600e3;
  const candleCovers = cache && cache.candles && cache.candles.length
    && cache.candles[0].time <= startMs + 2 * 3600e3;
  let funding, candles, candleSource = cache && cache.candleSource || 'hyperliquid';
  if (fundingCovers) {
    funding = cache.funding.concat(await hlFundingHistory(coin, cache.funding[cache.funding.length - 1].time + 1));
  } else {
    funding = await hlFundingHistory(coin, startMs);
  }
  if (candleCovers) {
    let tail = [];
    const tailStart = cache.candles[cache.candles.length - 1].time + 1;
    if (candleSource.startsWith('okx')) {
      try { ({ candles: tail } = await okxCandles(coin, tailStart)); } catch { /* no completed tail yet */ }
    } else {
      tail = await hlCandles(coin, tailStart);
    }
    candles = cache.candles.concat(tail);
  } else {
    // Use complete OKX history first for long tests. If the instrument is not
    // listed there, retain Hyperliquid's limited window; the engine will skip
    // every signal that lacks an adjacent candle instead of fabricating a match.
    try {
      ({ candles, source: candleSource } = await okxCandles(coin, startMs));
    } catch {
      candles = await hlCandles(coin, startMs);
      candleSource = 'hyperliquid-limited';
    }
  }
  // dedupe by timestamp (an in-progress candle can reappear on the next fetch)
  const uniq = (arr) => [...new Map(arr.map((x) => [x.time, x])).values()].sort((a, b) => a.time - b.time);
  funding = uniq(funding); candles = uniq(candles);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ funding, candles, candleSource }));
  return {
    funding: funding.filter((f) => f.time >= startMs),
    candles: candles.filter((c) => c.time >= startMs),
    candleSource,
  };
}

async function backtestOne(coin, days) {
  const startMs = nowMs() - days * 24 * 3600e3;
  const pad = CONFIG.fundingZWindow * 3600e3;
  let funding, candles, source = 'hyperliquid', candleSource = 'hyperliquid', window = CONFIG.fundingZWindow;
  try {
    ({ funding, candles, candleSource } = await getSeries(coin, startMs - pad));
  } catch (hlErr) {
    source = 'binance';
    candleSource = 'binance';
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
  return {
    coin, source, candleSource, res, base, nFunding: funding.length, nCandles: candles.length,
    candleStart: candles.length ? candles[0].time : null,
    candleEnd: candles.length ? candles[candles.length - 1].time : null,
  };
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
      const coverage = r.candleStart && r.candleEnd
        ? `${new Date(r.candleStart).toISOString().slice(0, 10)}..${new Date(r.candleEnd).toISOString().slice(0, 10)}`
        : 'no candle coverage';
      console.log(`${r.nFunding} funding (${r.source}), ${r.nCandles} candles (${r.candleSource}, ${coverage})`);
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
    if (res.skippedNoAdjacentCandle) console.log(`       skipped ${res.skippedNoAdjacentCandle} signals without adjacent hourly price data`);
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
    // 3. Correlation: same-window signals across coins are one portfolio bet.
    const ordered = [...allTrades].sort((a, b) => a.time - b.time);
    const clusters = [];
    for (const trade of ordered) {
      const current = clusters[clusters.length - 1];
      if (!current || trade.time - current.start >= CONFIG.backtest.holdHours * 3600e3) {
        clusters.push({ start: trade.time, returns: [trade.net] });
      } else current.returns.push(trade.net);
    }
    const clusterReturns = clusters.map((c) => mean(c.returns));
    const clusterAvg = clusterReturns.length ? mean(clusterReturns) : 0;
    const clusterSe = clusterReturns.length > 1 ? std(clusterReturns) / Math.sqrt(clusterReturns.length) : 0;
    const clusterT = clusterSe > 0 ? clusterAvg / clusterSe : 0;
    console.log(`  Independent ${CONFIG.backtest.holdHours}h signal windows: ${clusters.length} of ${allTrades.length} trades; equal-weight portfolio avg ${fmtPct(clusterAvg * 100)}, cluster t-stat ${clusterT.toFixed(2)}.`);
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
async function evaluate(file = CONFIG.journalFile) {
  const { rows: journalRows, invalid, missing } = readJournal(file);
  if (missing || !journalRows.length) {
    console.log(`No usable journal at ${file}. Run \`scan\` or \`run\` first — every scan adds rows.`);
    return;
  }
  const holdMs = CONFIG.backtest.holdHours * 3600e3;
  const mature = journalRows.filter((l) => l.time + holdMs < nowMs());
  console.log(`Journal: ${journalRows.length} valid rows${invalid ? `, ${invalid} malformed skipped` : ''}; ${mature.length} old enough to evaluate (need ${CONFIG.backtest.holdHours}h of hindsight).`);
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

  // A 15-minute journal evaluated on a 24-hour horizon contains 96 heavily
  // overlapping outcomes per coin. Treating those as independent would inflate
  // confidence, so headline statistics use observations at least one full hold
  // period apart for each coin.
  const independent = selectNonOverlapping(rows, holdMs);
  const independentBuckets = new Set(independent.map((r) => Math.floor(r.time / holdMs))).size;
  console.log(`Usable price outcomes: ${rows.length} raw; ${independent.length} non-overlapping per-coin observations across ${independentBuckets} time buckets.`);
  console.log(`\nForward ${CONFIG.backtest.holdHours}h returns by confluence score (non-overlapping sample):`);
  console.log('score   n     avg fwd ret   agree%  (agree = price moved in the score\'s direction)');
  for (let s = -maxScore(); s <= maxScore(); s++) {
    const g = independent.filter((r) => scoreOf(r) === s);
    if (!g.length) continue;
    const avg = mean(g.map((r) => r.fwdRet));
    const agree = s === 0 ? null : g.filter((r) => Math.sign(r.fwdRet) === Math.sign(s)).length / g.length;
    console.log(`${String(s).padStart(3)}    ${String(g.length).padEnd(5)} ${fmtPct(avg * 100).padEnd(13)} ${agree === null ? '—' : (agree * 100).toFixed(0) + '%'}`);
  }

  const actionable = selectNonOverlapping(
    rows.filter((r) => Math.abs(scoreOf(r)) >= CONFIG.alertScore),
    holdMs,
  );
  if (actionable.length) {
    const net = actionable.map((r) => Math.sign(scoreOf(r)) * r.fwdRet - 2 * CONFIG.backtest.feePerSide);
    const avgNet = mean(net);
    const se = net.length > 1 ? std(net) / Math.sqrt(net.length) : 0;
    const tStat = se > 0 ? avgNet / se : 0;
    const buckets = new Set(actionable.map((r) => Math.floor(r.time / holdMs))).size;
    console.log(`\nActionable confluence (|score| >= ${CONFIG.alertScore}, after ${(2 * CONFIG.backtest.feePerSide * 100).toFixed(2)}% round-trip fees):`);
    console.log(`  ${actionable.length} non-overlapping per-coin signals in ${buckets} time buckets; hit ${(net.filter((r) => r > 0).length / net.length * 100).toFixed(1)}%; avg ${fmtPct(avgNet * 100)}; t-stat ${tStat.toFixed(2)}`);
  } else {
    console.log(`\nActionable confluence: no non-overlapping |score| >= ${CONFIG.alertScore} events.`);
  }

  console.log('\nPer-witness results use non-overlapping non-zero calls:');
  for (const w of [...CONFIG.scoredWitnesses, ...CONFIG.researchWitnesses]) {
    const g = selectNonOverlapping(rows.filter((r) => Number(r.dirs[w] || 0) !== 0), holdMs);
    if (!g.length) { console.log(`  ${w}: no non-zero calls yet`); continue; }
    const agree = g.filter((r) => Math.sign(r.fwdRet) === r.dirs[w]).length / g.length;
    const directional = g.map((r) => r.dirs[w] * r.fwdRet - 2 * CONFIG.backtest.feePerSide);
    console.log(`  ${w}: ${g.length} calls, ${(agree * 100).toFixed(1)}% agreement, avg directional return after fees ${fmtPct(mean(directional) * 100)}`);
  }
  console.log('\nInterpretation: one week is a pipeline check, not proof. Look for repeatable results over several non-overlapping time buckets and market regimes.');
}

function journalForwardRows(journalRows, horizonMs, toleranceMs = Math.max(2, CONFIG.scanEveryMin * 2) * 60e3) {
  const byCoin = {};
  for (const row of journalRows) (byCoin[row.coin] = byCoin[row.coin] || []).push(row);
  const outcomes = [];
  for (const entries of Object.values(byCoin)) {
    entries.sort((a, b) => a.time - b.time);
    for (const row of entries) {
      const target = row.time + horizonMs;
      let lo = 0, hi = entries.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (entries[mid].time < target) lo = mid + 1;
        else hi = mid;
      }
      const later = entries[lo];
      if (!later || later.time - target > toleranceMs) continue;
      outcomes.push({
        ...row,
        outcomeTime: later.time,
        fwdRet: (later.markPx - row.markPx) / row.markPx,
      });
    }
  }
  return outcomes;
}

function printScalpSample(label, rows, directionOf) {
  if (!rows.length) {
    console.log(`  ${label}: no qualifying calls yet`);
    return;
  }
  const gross = rows.map((row) => directionOf(row) * row.fwdRet);
  const net = gross.map((ret) => ret - 2 * CONFIG.backtest.feePerSide);
  console.log(
    `  ${label}: ${rows.length} calls, ${(gross.filter((r) => r > 0).length / gross.length * 100).toFixed(1)}% directional agreement, `
    + `avg gross ${fmtPct(mean(gross) * 100)}, avg after fees ${fmtPct(mean(net) * 100)}`,
  );
}

/**
 * Short-horizon evaluation uses prices already captured in the journal. That
 * avoids another market-data source, candle-boundary mismatch, and lookahead.
 */
function evaluateScalps(file = CONFIG.journalFile, horizonsMin = CONFIG.scalpEvaluationMin) {
  const { rows: journalRows, invalid, missing } = readJournal(file);
  if (missing || !journalRows.length) {
    console.log(`No usable journal at ${file}. Run \`scan\` or \`run\` first — every scan adds rows.`);
    return;
  }
  const observedCadence = observedJournalCadenceMin(journalRows) || CONFIG.scanEveryMin;
  const toleranceMs = Math.max(2, observedCadence * 0.35) * 60e3;
  console.log(
    `Scalper journal: ${journalRows.length} valid rows${invalid ? `, ${invalid} malformed skipped` : ''}; `
    + `observed cadence ${observedCadence.toFixed(1)}m. Prices come from later journal snapshots.`,
  );
  console.log(`Real size-flow rows (schema v2+): ${journalRows.filter((r) => Number(r.schemaVersion || 1) >= 2).length}. Legacy USD-flow fields are excluded from flow conclusions.`);

  for (const horizonMin of horizonsMin) {
    const horizonMs = horizonMin * 60e3;
    const rows = journalForwardRows(journalRows, horizonMs, toleranceMs);
    const independent = selectNonOverlapping(rows, horizonMs);
    const buckets = new Set(independent.map((r) => Math.floor(r.time / horizonMs))).size;
    console.log(`\n=== ${horizonMin}m forward outcome: ${rows.length} raw; ${independent.length} non-overlapping per-coin calls across ${buckets} time buckets ===`);
    if (!independent.length) {
      console.log('No matched future journal prices yet.');
      continue;
    }

    console.log('score   n     avg fwd ret   agree%');
    for (let score = -maxScore(); score <= maxScore(); score++) {
      const group = independent.filter((r) => scoreOf(r) === score);
      if (!group.length) continue;
      const avg = mean(group.map((r) => r.fwdRet));
      const agree = score === 0
        ? '—'
        : `${(group.filter((r) => Math.sign(r.fwdRet) === Math.sign(score)).length / group.length * 100).toFixed(0)}%`;
      console.log(`${String(score).padStart(3)}    ${String(group.length).padEnd(5)} ${fmtPct(avg * 100).padEnd(13)} ${agree}`);
    }

    const actionable = selectNonOverlapping(
      rows.filter((r) => Math.abs(scoreOf(r)) >= CONFIG.alertScore),
      horizonMs,
    );
    console.log(`\nConfluence (|score| >= ${CONFIG.alertScore} of max ${maxScore()}):`);
    printScalpSample('combined', actionable, (r) => Math.sign(scoreOf(r)));

    console.log(`Witnesses (scored: ${CONFIG.scoredWitnesses.join(', ')}; unscored: ${CONFIG.researchWitnesses.join(', ')}):`);
    for (const witness of [...CONFIG.scoredWitnesses, ...CONFIG.researchWitnesses]) {
      const group = selectNonOverlapping(
        rows.filter((r) => Number(r.dirs[witness] || 0) !== 0),
        horizonMs,
      );
      printScalpSample(witness, group, (r) => Number(r.dirs[witness]));
    }

    const wallets = [...new Set(rows.flatMap((r) => Object.keys(r.walletDirs || {})))];
    console.log('Held-position baseline (context only, not an entry trigger):');
    if (!wallets.length) console.log('  no wallet positions were journaled');
    for (const wallet of wallets) {
      const group = selectNonOverlapping(
        rows.filter((r) => Number((r.walletDirs || {})[wallet] || 0) !== 0),
        horizonMs,
      );
      const short = `${wallet.slice(0, 8)}…${wallet.slice(-4)}`;
      printScalpSample(short, group, (r) => Number(r.walletDirs[wallet]));
    }

    console.log('Directional-wallet real SIZE-flow hypotheses (unscored):');
    for (const lookbackMin of CONFIG.walletFlowLookbackMin) {
      const key = `walletSizeFlow${lookbackMin}mUsd`;
      const group = selectNonOverlapping(
        rows.filter((r) => Number(r.schemaVersion || 1) >= 2
          && Math.abs(Number((r.meta || {})[key])) >= CONFIG.minWalletFlowUsd),
        horizonMs,
      );
      if (!group.length) {
        console.log(`  ${lookbackMin}m size flow: no changes >= ${fmtUsd(CONFIG.minWalletFlowUsd)} yet`);
        continue;
      }
      printScalpSample(`${lookbackMin}m size flow CONTINUATION`, group, (r) => Math.sign(Number(r.meta[key])));
      printScalpSample(`${lookbackMin}m size flow FADE`, group, (r) => -Math.sign(Number(r.meta[key])));
    }

    console.log('High-turnover/LP real SIZE-flow hypotheses (unscored):');
    for (const lookbackMin of CONFIG.liquidityFlowLookbackMin) {
      const key = `lpSizeFlow${lookbackMin}mUsd`;
      const group = selectNonOverlapping(
        rows.filter((r) => Number(r.schemaVersion || 1) >= 2
          && Math.abs(Number((r.meta || {})[key])) >= CONFIG.minLiquidityFlowUsd),
        horizonMs,
      );
      if (!group.length) {
        console.log(`  ${lookbackMin}m flow: no changes >= ${fmtUsd(CONFIG.minLiquidityFlowUsd)} yet`);
        continue;
      }
      printScalpSample(`${lookbackMin}m flow CONTINUATION`, group, (r) => Math.sign(Number(r.meta[key])));
      printScalpSample(`${lookbackMin}m flow FADE`, group, (r) => -Math.sign(Number(r.meta[key])));
    }

    console.log('Price/OI regime hypothesis (unscored continuation):');
    const oiPrice = selectNonOverlapping(
      rows.filter((r) => Number(r.schemaVersion || 1) >= 2 && Number((r.meta || {}).oiPriceDir || 0) !== 0),
      horizonMs,
    );
    printScalpSample(`${CONFIG.oiLookbackMin}m price+OI change (abs, includes shrinking OI)`, oiPrice, (r) => Number(r.meta.oiPriceDir));

    console.log('Observed liquidation-pocket hypothesis (unscored):');
    const observedLiq = selectNonOverlapping(
      rows.filter((r) => Number(r.schemaVersion || 1) >= 2
        && Number((r.meta || {}).liqObservedUsd || 0) >= CONFIG.minLiqResearchUsd
        && Number((r.meta || {}).liqObservedDistancePct || 0) !== 0),
      horizonMs,
    );
    printScalpSample(`pockets >= ${fmtUsd(CONFIG.minLiqResearchUsd)}`, observedLiq, (r) => Math.sign(Number(r.meta.liqObservedDistancePct)));
  }
  console.log('\nInterpretation: compare gross and fee-adjusted returns. Do not promote LP flow into the alert score until one orientation repeats across many independent time buckets and market regimes.');
}

/* ============================== COHORT SCREENING ============================== */

/**
 * Walk a wallet's fills into per-coin signed size, then count how many
 * non-overlapping windows contain a size change large enough for the collector
 * to record. This measures the thing that actually matters — whether the
 * collector can SEE this wallet trade — instead of leaderboard PnL.
 *
 * The previous cohort was screened for LOW fill frequency so positions would
 * stay observable at a 1-minute cadence. That selected for wallets which barely
 * trade: the live journal caught a size change in 0.27% of scans. This screen
 * reports both ends so the trade-off is explicit rather than accidental.
 */
function screenFills(fills, coins, windowMin, minFlowUsd, windowStartMs, windowEndMs) {
  const wanted = new Set(coins);
  const all = [...fills].sort((a, b) => a.time - b.time);
  const relevant = all.filter((f) => wanted.has(f.coin));

  // The rate must be measured over the window we ASKED for, not the span between
  // matching fills. Dividing by the latter turns a wallet that traded twice in
  // one minute into thousands of events per day.
  //
  // The API caps a response at 2000 fills. When that happens we only received
  // the start of the window, so coverage ends at the last fill we actually got.
  const truncated = all.length >= 2000;
  const coveredEnd = truncated && all.length ? all[all.length - 1].time : windowEndMs;
  const coveredDays = Math.max((coveredEnd - windowStartMs) / 86400e3, 0);

  const windowMs = windowMin * 60e3;
  // Bucket signed notional by (coin, window). A window is an "event" when the
  // wallet's net size moved enough in it to clear the collector's threshold.
  const buckets = new Map();
  for (const f of relevant) {
    const signed = (f.side === 'B' ? 1 : -1) * Number(f.sz) * Number(f.px);
    const key = `${f.coin}:${Math.floor(f.time / windowMs)}`;
    buckets.set(key, (buckets.get(key) || 0) + signed);
  }
  const events = [...buckets.values()].filter((usd) => Math.abs(usd) >= minFlowUsd).length;
  return {
    fills: relevant.length,
    totalFills: all.length,
    events,
    coveredDays,
    truncated,
    perDay: coveredDays > 0 ? events / coveredDays : 0,
    coins: [...new Set(relevant.map((f) => f.coin))],
  };
}

async function screenWallets(arg) {
  // Keep each candidate's cohort attached. The directional and high-turnover
  // cohorts are deliberately separate — a suggestion that merged them would
  // quietly put market-maker inventory into the directional vote.
  const cohortOf = new Map([
    ...CONFIG.trackedWallets.map((w) => [w, 'directional']),
    ...CONFIG.liquidityProviderWallets.map((w) => [w, 'high-turnover']),
  ]);
  const candidates = (arg
    ? arg.split(',').map((w) => w.trim().toLowerCase()).filter((w) => /^0x[a-f0-9]{40}$/.test(w))
    : [...CONFIG.trackedWallets, ...CONFIG.liquidityProviderWallets]);
  if (!candidates.length) {
    console.log('No wallets to screen. Pass addresses, or configure HYPERLIQUID_TRACKED_WALLETS / HYPERLIQUID_LP_WALLETS.');
    return;
  }
  const windowMin = Math.min(...CONFIG.walletFlowLookbackMin);
  const lookbackDays = 14;
  const windowStart = nowMs() - lookbackDays * 86400e3;
  const windowEnd = nowMs();
  console.log(`Screening ${candidates.length} wallet(s) against ${CONFIG.coins.join(', ')} over the last ${lookbackDays} days`);
  console.log(`Observability test: does net size move >= ${fmtUsd(CONFIG.minWalletFlowUsd)} within a ${windowMin}m window?\n`);
  console.log('wallet              our/all fills  covered  events  ev/day  coins traded');

  const scored = [];
  for (const wallet of candidates) {
    let fills;
    try {
      // Ask for a known window so the rate has a real denominator. `userFills`
      // returns only "recent" fills with no stated period, which is unusable here.
      fills = await hl({ type: 'userFillsByTime', user: wallet, startTime: windowStart, endTime: windowEnd });
    } catch (e) {
      console.log(`${wallet.slice(0, 10)}…${wallet.slice(-4)}  fetch failed: ${e.message}`);
      await sleep(250);
      continue;
    }
    const r = screenFills(
      Array.isArray(fills) ? fills : [], CONFIG.coins, windowMin, CONFIG.minWalletFlowUsd, windowStart, windowEnd,
    );
    scored.push({ wallet, cohort: cohortOf.get(wallet) || 'unclassified', ...r });
    console.log(
      `${wallet.slice(0, 10)}…${wallet.slice(-4)}  ${`${r.fills}/${r.totalFills}`.padEnd(13)} `
      + `${(r.coveredDays.toFixed(1) + 'd').padEnd(8)} ${String(r.events).padEnd(7)} `
      + `${r.perDay.toFixed(1).padEnd(7)} ${r.coins.join(',') || '(none on our coins)'}`
      + `${r.truncated ? '  [hit 2000-fill cap: rate is a lower bound]' : ''}`,
    );
    await sleep(250);
  }

  console.log('\nVerdict — a wallet is useful to us only if it trades OUR coins often enough to sample:');
  const useful = scored.filter((s) => s.perDay >= 1 && s.coins.length);
  const idle = scored.filter((s) => s.coins.length && s.perDay < 1);
  const offCoin = scored.filter((s) => !s.coins.length);
  for (const s of useful) console.log(`  KEEP    [${s.cohort}] ${s.wallet}  ${s.perDay.toFixed(1)} observable events/day`);
  for (const s of idle) console.log(`  DROP    [${s.cohort}] ${s.wallet}  only ${s.perDay.toFixed(2)} events/day on our coins — too quiet to measure`);
  for (const s of offCoin) console.log(`  DROP    [${s.cohort}] ${s.wallet}  trades none of our coins`);
  console.log(`\n${useful.length} of ${scored.length} candidates produce a usable flow sample.`);

  const byCohort = (name) => useful.filter((s) => s.cohort === name).map((s) => s.wallet);
  const directional = byCohort('directional');
  const highTurnover = byCohort('high-turnover');
  const unclassified = byCohort('unclassified');
  if (directional.length) console.log('\nHYPERLIQUID_TRACKED_WALLETS=' + directional.join(','));
  if (highTurnover.length) console.log('HYPERLIQUID_LP_WALLETS=' + highTurnover.join(','));
  if (unclassified.length) {
    console.log('\nNot yet assigned to a cohort — decide directional vs high-turnover before adding:');
    for (const w of unclassified) console.log(`  ${w}`);
  }
  console.log('\nNote: this measures observability, not profitability. Screen candidates for repeatable'
    + ' performance first, then run this to check we can actually see them trade.');
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

  const limitedCandles = candles.filter((c) => c.time >= t0 + 350 * 3600e3);
  const limited = runBacktestCore(funding, limitedCandles, { window: 168, zThreshold: 2, holdHours: 24, feePerSide: 0.0005, minAbsRate: 0.00004 });
  check('signal before available candle history is skipped, never paired to a later candle', limited.n === 0 && limited.skippedNoAdjacentCandle === 1);

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
  // 5b. OI must testify without funding. The old version returned dir=0 unless
  //     funding had already fired, which made it permanently silent in production.
  console.log('[5b] OI witness is independent of funding');
  const oiUp = oiWitness(110, 100, 101, 100);   // OI +10%, price +1%
  check('OI expanding into a rising price argues UP with no funding call', oiUp.dir === 1);
  const oiDown = oiWitness(110, 100, 99, 100);  // OI +10%, price -1%
  check('OI expanding into a falling price argues DOWN', oiDown.dir === -1);
  check('OI shrinking is position closing, not conviction → neutral', oiWitness(90, 100, 101, 100).dir === 0);
  check('OI expanding on a flat price has no direction', oiWitness(110, 100, 100.01, 100).dir === 0);
  check('no prior snapshot yields no call instead of a fake one', oiWitness(110, null, 101, 100).dir === 0);
  check('OI change below threshold stays neutral', oiWitness(100.1, 100, 101, 100).dir === 0);

  // 5c. Scoring must come from the scored witnesses only, so an always-silent
  //     research witness cannot raise the bar for the rest.
  console.log('[5c] score excludes unscored research witnesses');
  check('liq is not scored', !CONFIG.scoredWitnesses.includes('liq'));
  check('a liq call alone does not move the score',
    scoreOf({ dirs: { funding: 0, oi: 0, liq: 1, whales: 0 } }) === 0);
  check('funding + oi + whales agreeing reaches the max score',
    scoreOf({ dirs: { funding: 1, oi: 1, liq: -1, whales: 1 } }) === maxScore());
  check('alert threshold is reachable by the scored witnesses', CONFIG.alertScore <= maxScore());
  check('one silent witness does not falsely make a 2-of-3 threshold unreachable',
    CONFIG.scoredWitnesses.length - 1 >= CONFIG.alertScore);
  check('unproven witnesses cannot send trade alerts', CONFIG.researchMode === true);
  check('opposing witnesses cancel rather than accumulate',
    scoreOf({ dirs: { funding: -1, oi: 1, whales: 1 } }) === 1);
  check('a row missing a witness counts it as silent, not as a crash',
    scoreOf({ dirs: { whales: -1 } }) === -1 && scoreOf({}) === 0);

  const liq = liqMapWitness([{ coin: 'BTC', size: 5, notionalUsd: 500_000, liqPx: 98.5 }], 100);
  check('big liq cluster below price → magnet argues DOWN', liq.dir === -1);
  const weakLiq = liqMapWitness([{ coin: 'BTC', size: 1, notionalUsd: 100_000, liqPx: 99 }], 100);
  check('smaller liquidation pocket is recorded for research but stays neutral',
    weakLiq.dir === 0 && weakLiq.observedUsd === 100_000 && weakLiq.observedPct === -1);
  const whale = whaleWitness([
    { wallet: '0x1', size: 10, notionalUsd: 1_000_000 },
    { wallet: '0x2', size: 2, notionalUsd: 200_000 },
    { wallet: '0x3', size: -1, notionalUsd: 100_000 },
  ]);
  check('two long wallets vs one short → argues UP', whale.dir === 1);
  const equalVote = whaleWitness([
    { wallet: '0x1', size: 100, notionalUsd: 10_000_000 },
    { wallet: '0x2', size: -1, notionalUsd: 100_000 },
    { wallet: '0x3', size: -1, notionalUsd: 100_000 },
  ]);
  check('wallet vote is equal-weighted: two shorts beat one huge long', equalVote.dir === -1);

  // 6. Forward evaluation must not count overlapping 24h outcomes as
  //    independent observations. The gap is enforced separately per coin.
  console.log('[6] non-overlapping forward samples');
  const day = 24 * 3600e3;
  const overlap = [
    { coin: 'BTC', time: 0 }, { coin: 'ETH', time: 0 },
    { coin: 'BTC', time: day - 1 }, { coin: 'BTC', time: day },
  ];
  const sampled = selectNonOverlapping(overlap, day);
  check('overlapping BTC outcome is dropped', sampled.filter((r) => r.coin === 'BTC').length === 2);
  check('sampling gap is tracked independently per coin', sampled.filter((r) => r.coin === 'ETH').length === 1);

  // 7. The scalp evaluator must use a later journal snapshot at the requested
  //    horizon, without pairing to a distant row after a collection gap.
  console.log('[7] journal-based scalp outcomes');
  const minute = 60e3;
  const scalpRows = [
    { coin: 'BTC', time: 0, markPx: 100, score: 1, dirs: {} },
    { coin: 'BTC', time: 5 * minute, markPx: 102, score: 0, dirs: {} },
    { coin: 'ETH', time: 0, markPx: 100, score: -1, dirs: {} },
    { coin: 'ETH', time: 20 * minute, markPx: 80, score: 0, dirs: {} },
  ];
  const scalpOutcomes = journalForwardRows(scalpRows, 5 * minute, 2 * minute);
  check('5m BTC outcome uses the 5m journal price', scalpOutcomes.length === 1 && Math.abs(scalpOutcomes[0].fwdRet - 0.02) < 1e-9);
  check('distant ETH row is rejected instead of creating lookahead', !scalpOutcomes.some((r) => r.coin === 'ETH'));

  // 8. High-turnover cohort inventory is recorded as a raw change and never
  //    converted to a directional witness before forward evidence exists.
  console.log('[8] high-turnover inventory flow');
  const lpSnaps = [{ time: 0, netSize: 1, grossSize: 3 }];
  const lp = cohortPositionFlow([
    { wallet: '0xmaker1', size: 5, notionalUsd: 500_000 },
    { wallet: '0xmaker2', size: -1, notionalUsd: 100_000 },
  ], lpSnaps, 15 * minute, 100, [5, 15], true);
  check('aggregate signed size and marked inventory are computed',
    lp.netSize === 4 && lp.grossSize === 6 && lp.netUsd === 400 && lp.grossUsd === 600);
  check('15m inventory change is computed without assigning direction', lp.flowUsd[15] === 300 && lp.dir === undefined);
  const snapshotsBeforeFailure = lpSnaps.length;
  const unavailable = cohortPositionFlow([], lpSnaps, 16 * minute, 100, [5, 15], false);
  check('incomplete wallet fetch cannot create a fake zero-position flow',
    unavailable.available === false && unavailable.flowUsd[5] === null && lpSnaps.length === snapshotsBeforeFailure);

  // 9. Cohort screening must count windows the collector could actually observe,
  //    not raw fill counts — that is the check the old leaderboard screen lacked.
  console.log('[9] cohort observability screen');
  // Align to a window boundary so the fixture tests the netting rule rather
  // than which side of an arbitrary boundary each fill happens to land on.
  const t9 = 1_700_000_000_000 - (1_700_000_000_000 % (5 * 60e3));
  const screenWindow = { start: t9 - 86400e3, end: t9 + 86400e3 };
  const screened = screenFills([
    // two fills inside one 5m window that net out to a big change on BTC
    { coin: 'BTC', time: t9, sz: '1', px: '50000', side: 'B' },
    { coin: 'BTC', time: t9 + 60e3, sz: '1', px: '50000', side: 'B' },
    // an offsetting pair in the next window: the collector would see ~no change
    { coin: 'BTC', time: t9 + 6 * 60e3, sz: '1', px: '50000', side: 'B' },
    { coin: 'BTC', time: t9 + 7 * 60e3, sz: '1', px: '50000', side: 'A' },
    // a coin we do not track must be ignored entirely
    { coin: 'PEPE', time: t9 + 12 * 60e3, sz: '9999', px: '50000', side: 'B' },
  ], ['BTC', 'ETH'], 5, 25_000, screenWindow.start, screenWindow.end);
  check('offsetting fills inside one window are not counted as observable flow', screened.events === 1);
  check('fills on untracked coins are excluded', !screened.coins.includes('PEPE') && screened.fills === 4);
  check('rate uses the requested window, not the span between matching fills',
    Math.abs(screened.coveredDays - 2) < 1e-9 && Math.abs(screened.perDay - 0.5) < 1e-9);
  const quiet = screenFills([{ coin: 'BTC', time: t9, sz: '0.01', px: '50000', side: 'B' }], ['BTC'], 5, 25_000,
    screenWindow.start, screenWindow.end);
  check('a change below the collector threshold is not an observable event', quiet.events === 0);
  check('a wallet trading none of our coins screens as empty',
    screenFills([{ coin: 'PEPE', time: t9, sz: '1', px: '1', side: 'B' }], ['BTC'], 5, 25_000,
      screenWindow.start, screenWindow.end).events === 0);
  // A capped response only covers up to its last fill; crediting the full
  // requested window would understate an HFT account's true rate.
  const capped = screenFills(
    Array.from({ length: 2000 }, (_, i) => ({ coin: 'BTC', time: t9 + i, sz: '1', px: '50000', side: 'B' })),
    ['BTC'], 5, 25_000, t9 - 86400e3, t9 + 10 * 86400e3,
  );
  check('a truncated response is flagged and shortens the covered window',
    capped.truncated && capped.coveredDays > 0.99 && capped.coveredDays < 1.01);

  console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED ✔' : failed + ' CHECK(S) FAILED ✘'}`);
  process.exit(failed === 0 ? 0 : 1);
}

/* ============================== MAIN ============================== */

const [, , cmd, arg1, arg2] = process.argv;
(async () => {
  if (cmd === 'selftest') selftest();
  else if (cmd === 'backtest') await backtest((arg1 || 'BTC').toUpperCase(), parseInt(arg2 || '120', 10));
  else if (cmd === 'evaluate') await evaluate(arg1 || CONFIG.journalFile);
  else if (cmd === 'evaluate-scalps') {
    const horizons = arg2 ? [parseInt(arg2, 10)] : CONFIG.scalpEvaluationMin;
    if (horizons.some((n) => !Number.isFinite(n) || n <= 0)) throw new Error('scalp horizon must be a positive number of minutes');
    evaluateScalps(arg1 || CONFIG.journalFile, horizons);
  }
  else if (cmd === 'journal-status') journalStatus(arg1 || CONFIG.journalFile);
  else if (cmd === 'screen-wallets') await screenWallets(arg1);
  else if (cmd === 'scan') {
    const results = await scanOnce(loadState(), { silent: false });
    console.log(results.map(formatReport).join('\n\n'));
  }
  else if (cmd === 'run') await runLive();
  else console.log('Usage: node edge-bot.js [scan | run | backtest COIN|ALL DAYS | journal-status [FILE] | screen-wallets [ADDR,ADDR] | evaluate [FILE] | evaluate-scalps [FILE] [MINUTES] | selftest]');
})().catch((e) => { console.error('fatal:', e.message); process.exit(1); });
