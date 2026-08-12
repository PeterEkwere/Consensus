/**
 * Consensus FX Sentinel - lifecycle counts and per-leg statistics.
 *
 * Two invariants this module exists to protect:
 *
 * 1. Lifecycle buckets are mutually exclusive and sum back to the number of
 *    unique plans. If they ever disagree, a plan is being double-counted.
 * 2. The 1:1 and 3:1 legs are reported separately and never blended into a
 *    single "strategy win rate". They measure different things: the first leg
 *    risks 1 to make 1, the final leg risks 1 to make 3.
 *
 * Void, pending, cancelled-before-entry and never-entered records are excluded
 * from win/loss denominators and reported on their own.
 *
 * Pure. No I/O.
 */

"use strict";

const { BUCKETS, bucketOf } = require("./outcomes");

// Independent currency events needed before any verdict is offered. Several
// correlated plans inside one event are never allowed to inflate this floor.
const MIN_COMPLETED_FOR_VERDICT = 50;

/**
 * Net result of one resolved leg, in R.
 *
 * Gross is +1R / -1R for the first leg and +3R / -1R for the final leg.
 * Cost is subtracted only when it was actually observed; a record with unknown
 * cost contributes to gross statistics but is counted separately for net.
 */
function legResult(record, leg) {
  const state = leg === "first" ? record.firstLeg : record.finalLeg;
  if (state !== "win" && state !== "loss") return null;
  const multiple = leg === "first" ? 1 : 3;
  const gross = state === "win" ? multiple : -1;
  const costR = record.costs && Number.isFinite(record.costs.costR) ? record.costs.costR : null;
  return {
    state,
    gross,
    costR,
    net: costR === null ? null : gross - costR,
  };
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function clusterKeyOf(record, index) {
  return record.clusterId || record.exposureKey || `singleton:${record.id || index}`;
}

/**
 * One-sample t-statistic against a zero-expectancy null.
 *
 * Returns null when n < 2, variance is zero, or anything is non-finite.
 * An infinite t is not evidence and must never be displayed as though it were.
 */
function tStatistic(values) {
  const clean = values.filter((n) => Number.isFinite(n));
  if (clean.length !== values.length) return null;
  if (clean.length < 2) return null;
  const m = mean(clean);
  const variance = clean.reduce((sum, n) => sum + (n - m) ** 2, 0) / (clean.length - 1);
  if (!Number.isFinite(variance) || variance <= 0) return null;
  const t = m / (Math.sqrt(variance) / Math.sqrt(clean.length));
  return Number.isFinite(t) ? t : null;
}

/** Aggregate one leg over records with a resolved result for that leg. */
function summariseLeg(records, leg) {
  let wins = 0;
  let losses = 0;
  const grossValues = [];
  const netValues = [];
  let unknownCost = 0;
  const clustered = new Map();

  for (const [index, record] of records.entries()) {
    const result = legResult(record, leg);
    if (!result) continue;
    if (result.state === "win") wins += 1;
    else losses += 1;
    grossValues.push(result.gross);
    if (result.net === null) unknownCost += 1;
    else {
      netValues.push(result.net);
      const key = clusterKeyOf(record, index);
      if (!clustered.has(key)) clustered.set(key, []);
      clustered.get(key).push(result.net);
    }
  }

  const resolved = wins + losses;
  const clusterValues = [...clustered.values()].map(mean);
  return {
    wins,
    losses,
    resolved,
    winRate: resolved ? (wins / resolved) * 100 : null,
    grossExpectancyR: grossValues.length ? mean(grossValues) : null,
    netExpectancyR: netValues.length ? mean(netValues) : null,
    netSampleSize: netValues.length,
    unknownCost,
    clusterCount: clusterValues.length,
    clusterNetExpectancyR: clusterValues.length ? mean(clusterValues) : null,
    largestClusterSize: [...clustered.values()].reduce((max, rows) => Math.max(max, rows.length), 0),
    // Statistical inference is only on independent currency events.
    tStatistic: tStatistic(clusterValues),
  };
}

/** Lifecycle counts. Every record lands in exactly one bucket. */
function lifecycleOf(records) {
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  let dataGaps = 0;
  for (const record of records) {
    counts[bucketOf(record)] += 1;
    if (Number(record.dataGaps) > 0) dataGaps += 1;
  }
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { ...counts, dataGaps, total };
}

/**
 * Full report: global figures plus one cohort per playbook.
 *
 * Per-playbook totals reconcile with the global totals by construction, since
 * both are derived from the same partition of the same records.
 */
function summarise(records, { configHash = null, alertMode = "research" } = {}) {
  const rows = Array.isArray(records) ? records : [];
  const unique = new Map();
  for (const record of rows) {
    if (record && typeof record.id === "string") unique.set(record.id, record);
  }
  const every = [...unique.values()];
  // `/results` supplies the active fingerprint. Never label a blended history
  // with current settings; legacy and older cohorts stay outside this report.
  const all = configHash
    ? every.filter((record) => record.configHash === configHash)
    : every;
  const byPlaybook = {};
  for (const record of all) {
    const id = record.playbookId || "unknown";
    if (!byPlaybook[id]) byPlaybook[id] = [];
    byPlaybook[id].push(record);
  }

  const playbooks = {};
  for (const [id, cohort] of Object.entries(byPlaybook)) {
    playbooks[id] = {
      playbookId: id,
      playbookName: cohort[0].playbookName || id,
      lifecycle: lifecycleOf(cohort),
      firstLeg: summariseLeg(cohort, "first"),
      finalLeg: summariseLeg(cohort, "final"),
    };
  }

  const times = all
    .map((r) => Date.parse(r.sentAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const firstVerdict = verdictFor(all, "first");
  const finalVerdict = verdictFor(all, "final");
  return {
    uniquePlans: all.length,
    firstAlertAt: times.length ? new Date(times[0]).toISOString() : null,
    lastAlertAt: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    lifecycle: lifecycleOf(all),
    firstLeg: summariseLeg(all, "first"),
    finalLeg: summariseLeg(all, "final"),
    playbooks,
    configHash,
    alertMode,
    // Raw plan count is not sample size: several plans can share one currency
    // exposure and therefore one underlying conviction.
    exposureClusters: new Set(all.map((r) => r.exposureKey).filter(Boolean)).size,
    legacyCount: every.filter((record) => !record.configHash).length,
    otherCohortCount: configHash
      ? every.filter((record) => record.configHash && record.configHash !== configHash).length
      : 0,
    firstVerdict,
    finalVerdict,
    verdict: firstVerdict === "negative evidence" || finalVerdict === "negative evidence"
      ? "negative evidence"
      : (firstVerdict === "positive evidence" && finalVerdict === "positive evidence"
        ? "positive evidence"
        : "insufficient evidence"),
  };
}

/**
 * An honest verdict, allowed to be "insufficient evidence".
 * A trial that cannot say "not yet" will eventually claim an edge from noise.
 */
function verdictFor(records, leg = "first") {
  const complete = records.filter((r) => r.status === "complete");
  const stats = summariseLeg(complete, leg);
  if (stats.clusterCount < MIN_COMPLETED_FOR_VERDICT) return "insufficient evidence";
  if (stats.tStatistic === null) return "insufficient evidence";
  if (stats.clusterNetExpectancyR > 0 && stats.tStatistic > 2) return "positive evidence";
  if (stats.clusterNetExpectancyR < 0 && stats.tStatistic < -2) return "negative evidence";
  return "insufficient evidence";
}

/**
 * Self-check used by tests and by `/status`: the buckets must partition the
 * unique plans exactly.
 */
function reconciles(summary) {
  const counted = BUCKETS.reduce((sum, bucket) => sum + summary.lifecycle[bucket], 0);
  if (counted !== summary.uniquePlans) return false;
  // A leg can resolve before final lifecycle completion (for example, 1:1 won
  // and the 3:1 leg later expired), but never more than once per unique plan.
  if (summary.firstLeg.resolved > summary.uniquePlans) return false;
  if (summary.finalLeg.resolved > summary.uniquePlans) return false;
  return true;
}

module.exports = {
  MIN_COMPLETED_FOR_VERDICT,
  legResult,
  verdictFor,
  lifecycleOf,
  mean,
  reconciles,
  summarise,
  summariseLeg,
  tStatistic,
};
