/**
 * Consensus Reaper - frozen strategy identity and family-aware scoring.
 *
 * Why this module exists
 * ----------------------
 * The original additive score summed every observation it could find. Market
 * structure, moving-average alignment, higher-timeframe alignment, break of
 * structure and a compression breakout are frequently five descriptions of ONE
 * price move, so summing them inflated confidence and drove the score to
 * saturate at 100. In the first live ledger, 45 alerts scored exactly 100 in
 * under two days, which means the top of the scale stopped discriminating.
 *
 * This module replaces the sum with a family-aware score: within one family of
 * correlated evidence only the strongest observation counts. The non-winning
 * observations are still kept, for audit, but they are not scored twice.
 *
 * Nothing here is tuned to the live ledger. The weights are the ones the bot
 * already used; only the aggregation changed.
 *
 * Everything is pure. Importing this module reads nothing and writes nothing.
 */

"use strict";

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Evidence families
// ---------------------------------------------------------------------------

/**
 * Seven families of evidence. Observations inside one family are correlated by
 * construction, so only the strongest eligible one may score.
 *
 * `max` is the highest weight any observation in that family can contribute and
 * is the family's share of the normalization denominator. It comes from the
 * frozen table below, never from whichever observations happen to be present -
 * otherwise a setup with missing evidence would look stronger than one with
 * weak evidence.
 */
const FAMILIES = Object.freeze({
  structure: Object.freeze({ id: "structure", label: "Market structure", max: 18 }),
  location: Object.freeze({ id: "location", label: "Level location", max: 24 }),
  trend: Object.freeze({ id: "trend", label: "Trend alignment", max: 12 }),
  trigger: Object.freeze({ id: "trigger", label: "Entry trigger", max: 16 }),
  momentum: Object.freeze({ id: "momentum", label: "Momentum", max: 5 }),
  participation: Object.freeze({ id: "participation", label: "Participation", max: 5 }),
  execution: Object.freeze({ id: "execution", label: "Execution quality", max: 10 }),
});

const FAMILY_IDS = Object.freeze(Object.keys(FAMILIES));

/**
 * Which family each observation belongs to.
 *
 * Read this as the answer to "if I already know the strongest item in this
 * family, does this item tell me anything genuinely new?". Break of structure
 * and swing structure both describe the shape of recent swings, so they share
 * `structure`. The 20/50 EMA stack and the 1h/5m timeframe reads all describe
 * trend direction, so they share `trend`.
 */
const OBSERVATION_FAMILIES = Object.freeze({
  "Bullish market structure": "structure",
  "Bearish market structure": "structure",
  "Bullish break of structure": "structure",
  "Bearish break of structure": "structure",

  "Break and retest above prior resistance": "location",
  "Break and retest below prior support": "location",
  "Demand/support reaction": "location",
  "Supply/resistance reaction": "location",

  "Price aligned above 20/50 EMA": "trend",
  "Price aligned below 20/50 EMA": "trend",
  "1h trend aligned": "trend",
  "5m momentum aligned": "trend",

  "Bullish engulfing": "trigger",
  "Bearish engulfing": "trigger",
  "Hammer rejection": "trigger",
  "Shooting star rejection": "trigger",
  "Morning star": "trigger",
  "Evening star": "trigger",
  "Compression breakout": "trigger",
  "Compression breakdown": "trigger",

  "RSI momentum supportive": "momentum",

  "Volume expansion on signal candle": "participation",

  "Fresh quote within no-chase limit": "execution",
  "Round-trip cost is a small fraction of risk": "execution",
});

/** The family an observation belongs to, or null when it is unmapped. */
function familyOf(label) {
  return OBSERVATION_FAMILIES[label] || null;
}

// ---------------------------------------------------------------------------
// Frozen strategy configuration
// ---------------------------------------------------------------------------

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * Every decision constant needed to reproduce a publication decision.
 *
 * Changing ANY value here changes `strategyHash`, which starts a new research
 * cohort rather than silently blending old and new evidence.
 */
const STRATEGY = deepFreeze({
  version: 2,

  families: {
    structure: 18,
    location: 24,
    trend: 12,
    trigger: 16,
    momentum: 5,
    participation: 5,
    execution: 10,
  },

  // A setup must show evidence from at least this many independent families.
  //
  // Chosen structurally, not from performance: a tradable thesis needs to say
  // WHERE it is (location), WHAT shape the market is in (structure or trend),
  // and WHY now (trigger). Three is the smallest number that can express those
  // three distinct questions. It is deliberately not tuned against the live
  // ledger, and it is not a probability statement.
  minFamilies: 3,

  execution: {
    // A published entry is abandoned if price has already moved this fraction
    // of R away from the canonical entry by publication time.
    maxChaseFractionOfR: 0.25,
    // Reject when the quoted spread alone exceeds this fraction of R.
    maxSpreadFractionOfR: 0.15,
    // Reject when the full modelled round trip exceeds this fraction of R.
    maxCostFractionOfR: 0.35,
    // A quote older than this cannot authorise a new alert.
    maxQuoteAgeMs: 60_000,
    // Scoring thresholds for the execution family (quality, not a gate).
    goodDriftFractionOfR: 0.10,
    goodCostFractionOfR: 0.15,
  },

  publication: {
    // Maximum published alerts per market-event cluster.
    //
    // Set to 1 as exposure control, not as an optimised value: ten correlated
    // altcoin shorts in one sell-off are one bet expressed ten times, and the
    // live ledger already shows clusters of that shape. Lower-ranked valid
    // candidates are shadow-tracked so the choice can be audited later.
    maxPerCluster: 1,
    // Cluster identity groups decisions inside this window.
    clusterWindowMinutes: 5,
  },

  thesis: {
    // A thesis may be republished once its prior setup reaches a terminal
    // state, or once the structural level that defined it genuinely changes.
    resetOnTerminalOutcome: true,
    // Level identity is quantised so that floating-point noise in a swing does
    // not read as a brand-new structural level.
    levelQuantumFractionOfR: 0.25,
  },

  regime: {
    // Breadth strong enough to call the whole market one-directional.
    decisiveBreadthPct: 70,
    // Only a genuinely unambiguous benchmark contradiction blocks publication.
    // Everything else stays diagnostic, so the trial measures rather than
    // pre-judges.
    blockOnBenchmarkContradiction: true,
  },

  costs: {
    feeRatePerSide: 0.0005,
    slippageRatePerSide: 0.0005,
  },
});

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** Key-order-independent JSON, so a hash depends on values only. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

const HASH_LENGTH = 16;

function shortHash(payload) {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex").slice(0, HASH_LENGTH);
}

/** Fingerprint of the frozen decision rules and their numeric tuning. */
function strategyHash(strategy = STRATEGY) {
  return shortHash({ strategy, observationFamilies: OBSERVATION_FAMILIES });
}

/** Stable fingerprint of the active instrument universe. */
function universeHash(pairs) {
  const ids = (pairs || [])
    .map((p) => (typeof p === "string" ? p : `${p.market}:${p.api}`))
    .sort();
  return shortHash(ids);
}

/**
 * Cohort identity: everything that changes the publication POLICY, not just the
 * rules. Two alerts may share a strategy hash and still belong to different
 * cohorts if the threshold or the tracked universe moved between them.
 */
function cohortId(options) {
  const { strategy = STRATEGY, threshold, useHtfGate, pairs, costs } = options;
  return shortHash({
    strategyHash: strategyHash(strategy),
    strategyVersion: strategy.version,
    threshold,
    useHtfGate: Boolean(useHtfGate),
    universeHash: universeHash(pairs),
    costs: {
      feeRatePerSide: Number(costs && costs.feeRatePerSide),
      slippageRatePerSide: Number(costs && costs.slippageRatePerSide),
    },
  });
}

/** Records written before cohort tracking existed. Never rewritten. */
const LEGACY_COHORT_ID = "legacy-unknown";

/** The cohort a persisted record belongs to, without inventing information. */
function cohortOf(record) {
  return record && typeof record.cohortId === "string" && record.cohortId
    ? record.cohortId
    : LEGACY_COHORT_ID;
}

// ---------------------------------------------------------------------------
// Family-aware scoring
// ---------------------------------------------------------------------------

/**
 * Collapse observations to the strongest one per family and normalize.
 *
 * `raw` is the sum of the winning per-family weights, used for audit.
 * `score` is that raw value as a percentage of the FROZEN denominator, so the
 * absence of evidence lowers the score instead of being invisible.
 */
function scoreEvidence(observations, strategy = STRATEGY) {
  const winners = new Map();
  const unscored = [];

  for (const item of observations || []) {
    if (!item || typeof item.label !== "string") continue;
    const family = familyOf(item.label);
    const points = Number(item.points);
    if (!family || !Number.isFinite(points)) {
      unscored.push({ label: item.label, reason: family ? "non_finite_points" : "unmapped_family" });
      continue;
    }
    // Never let one observation exceed its family's frozen ceiling.
    const capped = Math.min(points, strategy.families[family]);
    const current = winners.get(family);
    if (!current || capped > current.points) {
      if (current) unscored.push({ label: current.label, family, reason: "same_family_weaker" });
      winners.set(family, { family, label: item.label, points: capped });
    } else {
      unscored.push({ label: item.label, family, reason: "same_family_weaker" });
    }
  }

  const denominator = FAMILY_IDS.reduce((sum, id) => sum + strategy.families[id], 0);
  const raw = [...winners.values()].reduce((sum, w) => sum + w.points, 0);
  const score = denominator > 0 ? Math.round((raw / denominator) * 100) : 0;

  return {
    raw,
    denominator,
    score,
    familyCount: winners.size,
    families: Object.fromEntries([...winners].map(([id, w]) => [id, w])),
    winners: [...winners.values()].sort((a, b) => b.points - a.points),
    unscored,
  };
}

/** Reader-facing reasons: the strongest observation from each of the top families. */
function topReasons(evidence, count = 3) {
  return (evidence.winners || []).slice(0, count).map((w) => w.label);
}

// ---------------------------------------------------------------------------
// Market-event clusters
// ---------------------------------------------------------------------------

/**
 * Deterministic cluster identity.
 *
 * A raw alert count is not a sample size. One broad sell-off can produce ten
 * correlated short alerts; treating those as ten independent observations
 * overstates statistical confidence enormously. Alerts emitted in the same
 * decision window, in the same direction, under the same benchmark regime,
 * belong to one market event.
 */
function clusterKey(signal, context, strategy = STRATEGY) {
  const windowMs = strategy.publication.clusterWindowMinutes * 60 * 1000;
  const at = Date.parse(signal.time);
  const bucket = Number.isFinite(at) ? Math.floor(at / windowMs) : 0;
  const benchmark = (context && context.benchmarkDirection) || "unknown";
  return shortHash({ bucket, side: signal.side, benchmark });
}

/**
 * Rank same-cluster candidates deterministically.
 *
 * Quality first, then execution cost, then liquidity, then a stable symbol
 * ordering so the result never depends on scan order.
 */
function rankCandidates(candidates) {
  return candidates.slice().sort((a, b) => {
    const scoreDiff = (b.score || 0) - (a.score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    const aCost = Number.isFinite(a.costR) ? a.costR : Infinity;
    const bCost = Number.isFinite(b.costR) ? b.costR : Infinity;
    if (aCost !== bCost) return aCost - bCost;
    const volDiff = (b.volumeH24Usd || 0) - (a.volumeH24Usd || 0);
    if (volDiff !== 0) return volDiff;
    return String(a.symbol).localeCompare(String(b.symbol));
  });
}

// ---------------------------------------------------------------------------
// Thesis identity
// ---------------------------------------------------------------------------

/**
 * Stable identity for "the same idea".
 *
 * A 30-minute cooldown is not enough: as candles advance, the same structural
 * thesis re-qualifies and is published again under a new signal time. The
 * thesis key is built from the structural level that defines the setup, so a
 * genuinely new level produces a new thesis while a drifting candle does not.
 *
 * The level is quantised by a fraction of R so that floating-point wobble in a
 * swing price does not read as a new structure.
 */
function thesisKey(signal, strategy = STRATEGY) {
  const level = Number(signal.thesisLevel);
  const r = Number(signal.r);
  const anchorTime = Number(signal.thesisAnchorTime);
  let bucket = "none";
  if (Number.isFinite(level) && Number.isFinite(anchorTime)) {
    // A confirmed swing's candle time is stable across rescans even if ATR or
    // the eventual stop distance changes. Keep price as a collision guard.
    bucket = `${anchorTime}:${level.toPrecision(12)}`;
  } else if (Number.isFinite(level) && Number.isFinite(r) && r > 0) {
    const quantum = r * strategy.thesis.levelQuantumFractionOfR;
    bucket = quantum > 0 ? String(Math.round(level / quantum)) : String(level);
  }
  return shortHash({
    market: signal.market,
    symbol: String(signal.symbol || "").toUpperCase(),
    side: signal.side,
    level: bucket,
    strategyHash: strategyHash(strategy),
  });
}

/** True when a record no longer blocks republication of its thesis. */
function thesisIsSettled(record) {
  return Boolean(record) && record.status !== "open";
}

// ---------------------------------------------------------------------------
// Regime and benchmark context
// ---------------------------------------------------------------------------

/**
 * Deterministic market context from data the scan already fetched.
 * Purely descriptive: no threshold here was chosen from performance.
 */
function marketContext(reads, strategy = STRATEGY) {
  const rows = (reads || []).filter((r) => r && r.trend);
  const total = rows.length;
  const count = (dir) => rows.filter((r) => r.trend === dir).length;
  const bullish = count("bullish");
  const bearish = count("bearish");
  const pct = (n) => (total > 0 ? (n / total) * 100 : 0);

  const btc = rows.find((r) => r.symbol === "BTCUSDT") || null;
  const eth = rows.find((r) => r.symbol === "ETHUSDT") || null;

  const bullishPct = pct(bullish);
  const bearishPct = pct(bearish);
  const decisive = strategy.regime.decisiveBreadthPct;

  let breadthDirection = "mixed";
  if (bullishPct >= decisive) breadthDirection = "bullish";
  else if (bearishPct >= decisive) breadthDirection = "bearish";

  return {
    benchmarkDirection: btc ? btc.trend : "unknown",
    benchmarkTrendH1: btc ? btc.trendH1 : "unknown",
    ethDirection: eth ? eth.trend : "unknown",
    trackedPairs: total,
    bullishPct: Number(bullishPct.toFixed(1)),
    bearishPct: Number(bearishPct.toFixed(1)),
    mixedPct: Number(pct(total - bullish - bearish).toFixed(1)),
    breadthDirection,
  };
}

/**
 * The single, deliberately narrow contradiction rule.
 *
 * It blocks only the case where a setup fights an unambiguous market: the
 * benchmark disagrees on BOTH its timeframes AND breadth is decisively the
 * other way. Everything softer stays measurable rather than pre-judged, so the
 * trial can still say whether those setups were fine.
 */
function contradictsRegime(side, context, strategy = STRATEGY) {
  if (!strategy.regime.blockOnBenchmarkContradiction) return false;
  if (!context) return false;
  const opposing = side === "long" ? "bearish" : "bullish";
  const benchmarkOpposes = context.benchmarkDirection === opposing
    && context.benchmarkTrendH1 === opposing;
  const breadthOpposes = context.breadthDirection === opposing;
  return benchmarkOpposes && breadthOpposes;
}

/** Coarse per-pair regime label, recorded for later slicing. */
function pairRegime(signal) {
  if (!signal) return "unknown";
  const has = (label) => (signal.confirmations || []).includes(label);
  if (has("Compression breakout") || has("Compression breakdown")) return "breakout";
  if (signal.trend === "bullish" || signal.trend === "bearish") {
    return signal.trendH1 === signal.trend ? "trend" : "disorder";
  }
  if (signal.trend === "mixed") return "range";
  return "unknown";
}

/** Deterministic score bins used by the detailed report. */
const SCORE_BINS = Object.freeze([
  { id: "lt70", label: "below 70", min: -Infinity, max: 69 },
  { id: "70-79", label: "70-79", min: 70, max: 79 },
  { id: "80-89", label: "80-89", min: 80, max: 89 },
  { id: "90-94", label: "90-94", min: 90, max: 94 },
  { id: "95-99", label: "95-99", min: 95, max: 99 },
  { id: "100", label: "100", min: 100, max: Infinity },
]);

function scoreBin(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return "unknown";
  const found = SCORE_BINS.find((bin) => n >= bin.min && n <= bin.max);
  return found ? found.id : "unknown";
}

module.exports = {
  FAMILIES,
  FAMILY_IDS,
  HASH_LENGTH,
  LEGACY_COHORT_ID,
  OBSERVATION_FAMILIES,
  SCORE_BINS,
  STRATEGY,
  clusterKey,
  cohortId,
  cohortOf,
  contradictsRegime,
  deepFreeze,
  familyOf,
  marketContext,
  pairRegime,
  rankCandidates,
  scoreBin,
  scoreEvidence,
  shortHash,
  stableStringify,
  strategyHash,
  thesisIsSettled,
  thesisKey,
  topReasons,
  universeHash,
};
