/**
 * Consensus Reaper - honest sample size and expectancy.
 *
 * The problem this solves
 * ----------------------
 * One broad cryptocurrency sell-off can publish ten correlated short alerts.
 * Counting those as ten independent observations inflates the t-statistic by
 * roughly sqrt(10) and can make noise look like an edge. The live ledger already
 * shows clusters of exactly that shape: 27 of 33 recent alerts were shorts.
 *
 * So statistics are reported twice:
 *
 *   - raw     : one row per setup, useful for describing activity;
 *   - cluster : one row per market event, used for INFERENCE.
 *
 * The cluster rule is deliberately simple and documented rather than clever:
 * take the mean net R of the resolved legs inside each cluster, and treat that
 * mean as a single observation. It is conservative because averaging correlated
 * outcomes removes the false precision that repeated near-copies create.
 *
 * Pure. No I/O.
 */

"use strict";

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

/**
 * One-sample t-statistic against a zero-expectancy null.
 * Null when n < 2, when variance is zero, or when anything is non-finite:
 * an infinite t is not evidence.
 */
function tStatistic(values) {
  const clean = (values || []).filter((n) => Number.isFinite(n));
  if (clean.length !== (values || []).length) return null;
  if (clean.length < 2) return null;
  const m = mean(clean);
  const variance = clean.reduce((sum, n) => sum + (n - m) ** 2, 0) / (clean.length - 1);
  if (!Number.isFinite(variance) || variance <= 0) return null;
  const t = m / (Math.sqrt(variance) / Math.sqrt(clean.length));
  return Number.isFinite(t) ? t : null;
}

/**
 * Collapse per-setup net results into one observation per cluster.
 *
 * `samples` is `[{ clusterId, net }]`. Rows without a cluster id are treated as
 * their own singleton cluster, which is the conservative reading: we never
 * merge things we cannot prove belong together.
 */
function clusterSeries(samples) {
  const byCluster = new Map();
  let index = 0;
  for (const sample of samples || []) {
    if (!sample || !Number.isFinite(sample.net)) continue;
    index += 1;
    const key = sample.clusterId || `singleton:${index}`;
    if (!byCluster.has(key)) byCluster.set(key, []);
    byCluster.get(key).push(sample.net);
  }
  const series = [];
  for (const [clusterId, nets] of byCluster) {
    series.push({ clusterId, size: nets.length, net: mean(nets) });
  }
  // Stable ordering keeps the output reproducible.
  series.sort((a, b) => String(a.clusterId).localeCompare(String(b.clusterId)));
  return series;
}

/**
 * Raw and cluster-adjusted statistics for one leg.
 *
 * The t-statistic is reported ONLY on the cluster series. Reporting one on the
 * raw series would be describing correlated rows as independent evidence, which
 * is the exact mistake this module exists to prevent.
 */
function legStatistics(samples) {
  const rows = (samples || []).filter((s) => s && Number.isFinite(s.net));
  const nets = rows.map((s) => s.net);
  const grosses = rows.map((s) => s.gross).filter(Number.isFinite);
  const series = clusterSeries(rows);
  const clusterNets = series.map((c) => c.net);

  return {
    rawCount: rows.length,
    clusterCount: series.length,
    wins: rows.filter((s) => s.win === true).length,
    losses: rows.filter((s) => s.win === false).length,
    grossExpectancyR: grosses.length ? mean(grosses) : null,
    netExpectancyR: nets.length ? mean(nets) : null,
    clusterNetExpectancyR: clusterNets.length ? mean(clusterNets) : null,
    // Inference uses the cluster series only.
    tStatistic: tStatistic(clusterNets),
    largestClusterSize: series.reduce((max, c) => Math.max(max, c.size), 0),
  };
}

/**
 * Has this cohort collected enough independent evidence to say anything?
 *
 * Returns a verdict that is allowed to be "insufficient". A trial that cannot
 * say "we do not know yet" will always eventually claim an edge.
 */
function evidenceVerdict(stats, requirement) {
  const minClusters = Number(requirement && requirement.minClusters) || 0;
  const minTStat = Number(requirement && requirement.minTStat) || 2;

  if (!stats || stats.clusterCount < minClusters) {
    return {
      verdict: "insufficient evidence",
      reason: `needs ${minClusters} independent market events, has ${stats ? stats.clusterCount : 0}`,
    };
  }
  if (stats.tStatistic === null) {
    return { verdict: "insufficient evidence", reason: "the t-statistic is not defined for this sample" };
  }
  if (stats.clusterNetExpectancyR > 0 && stats.tStatistic > minTStat) {
    return { verdict: "positive evidence", reason: "positive expectancy after costs with adequate confidence" };
  }
  if (stats.clusterNetExpectancyR < 0 && stats.tStatistic < -minTStat) {
    return { verdict: "negative evidence", reason: "negative expectancy after costs with adequate confidence" };
  }
  return { verdict: "insufficient evidence", reason: "expectancy is not distinguishable from zero" };
}

module.exports = { clusterSeries, evidenceVerdict, legStatistics, mean, tStatistic };
