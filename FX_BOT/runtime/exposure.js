/**
 * Consensus FX Sentinel - currency exposure and correlation clusters.
 *
 * A foreign-exchange setup is never a bet on a "pair". It is two opposite bets
 * on two currencies:
 *
 *   buy  EUR/USD  ->  long EUR, short USD
 *   sell GBP/EUR  ->  short GBP, long EUR
 *
 * Both of the above add long-EUR exposure. Publishing them together is one
 * conviction expressed twice, and counting their outcomes separately would
 * overstate the independent evidence in exactly the way the crypto ledger
 * already demonstrates.
 *
 * This module maps a side to its currency legs, finds the dominant shared
 * exposure inside a decision window, and ranks competing candidates
 * deterministically.
 *
 * Pure. No I/O.
 */

"use strict";

/**
 * The two currency legs of a side.
 * A buy is long the base and short the quote; a sell is the mirror.
 */
function exposureOf(symbolId, side) {
  const [base, quote] = String(symbolId).split("_");
  if (!base || !quote) return null;
  return side === "buy"
    ? { long: base, short: quote }
    : { long: quote, short: base };
}

/** Signed exposure per currency: +1 long, -1 short. */
function legsOf(symbolId, side) {
  const exposure = exposureOf(symbolId, side);
  if (!exposure) return {};
  return { [exposure.long]: 1, [exposure.short]: -1 };
}

/**
 * True when two sides push the same currency the same way.
 *
 * Deliberately strict about opposites: buy EUR/USD and sell EUR/USD share the
 * same currencies but oppose on both, so they must never be collapsed.
 */
function sharesExposure(a, b) {
  const left = legsOf(a.symbol, a.side);
  const right = legsOf(b.symbol, b.side);
  for (const currency of Object.keys(left)) {
    if (right[currency] === undefined) continue;
    if (right[currency] === left[currency]) return currency;
  }
  return null;
}

/**
 * Group candidates in one decision window by shared currency exposure.
 *
 * The dominant currency is chosen deterministically: the one shared by the most
 * candidates, with ties broken alphabetically so the grouping never depends on
 * scan order. Candidates that share nothing form their own single-member group.
 */
function decisionWindowOf(candidate) {
  const at = Number(candidate && candidate.signalTime);
  return Number.isFinite(at) ? String(at) : "unknown";
}

function clusterOneWindow(rows, decisionWindow) {
  if (!rows.length) return [];

  // Build connected components, not a greedy partition. A bridge such as
  // long-EUR/short-USD, long-EUR/short-JPY, long-GBP/short-JPY is one correlated
  // event: splitting after the EUR match would let two short-JPY plans survive.
  const parent = rows.map((_, index) => index);
  function root(index) {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  }
  function join(a, b) {
    const left = root(a);
    const right = root(b);
    if (left !== right) parent[right] = left;
  }
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (sharesExposure(rows[i], rows[j])) join(i, j);
    }
  }

  const components = new Map();
  rows.forEach((row, index) => {
    const key = root(index);
    if (!components.has(key)) components.set(key, []);
    components.get(key).push(row);
  });

  return [...components.values()].map((members) => {
    const counts = new Map();
    for (const member of members) {
      for (const [currency, direction] of Object.entries(legsOf(member.symbol, member.side))) {
        const key = `${currency}:${direction}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    const shared = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const primaryKey = (shared[0] && shared[0][0])
      || Object.entries(legsOf(members[0].symbol, members[0].side))
        .map(([currency, direction]) => `${currency}:${direction}`)
        .sort()[0];
    const identity = shared.length
      ? shared.map(([key]) => key).sort().join("+")
      : `${members[0].symbol}:${members[0].side}`;
    const [currency, direction] = primaryKey.split(":");
    return {
      currency,
      direction: direction === "1" ? "long" : "short",
      exposureKey: `${decisionWindow}:${identity}`,
      decisionWindow,
      members,
    };
  });
}


function clusterByExposure(candidates) {
  const windows = new Map();
  for (const candidate of candidates || []) {
    const window = decisionWindowOf(candidate);
    if (!windows.has(window)) windows.set(window, []);
    windows.get(window).push(candidate);
  }
  const out = [];
  for (const [window, rows] of [...windows.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(...clusterOneWindow(rows, window));
  }
  return out;
}

/**
 * Rank competing candidates inside one exposure cluster.
 *
 * Quality, then measured cost, then the explicit playbook priority, then a
 * stable symbol ordering. An unknown cost never outranks a measured one.
 */
function rankCandidates(candidates, playbookPriority = {}) {
  return candidates.slice().sort((a, b) => {
    const scoreDiff = (b.qualityScore || 0) - (a.qualityScore || 0);
    if (scoreDiff !== 0) return scoreDiff;

    const aCost = Number.isFinite(a.costR) ? a.costR : Infinity;
    const bCost = Number.isFinite(b.costR) ? b.costR : Infinity;
    if (aCost !== bCost) return aCost - bCost;

    const aPriority = playbookPriority[a.playbookId] ?? 99;
    const bPriority = playbookPriority[b.playbookId] ?? 99;
    if (aPriority !== bPriority) return aPriority - bPriority;

    return String(a.symbol).localeCompare(String(b.symbol));
  });
}

module.exports = {
  clusterByExposure,
  decisionWindowOf,
  exposureOf,
  legsOf,
  rankCandidates,
  sharesExposure,
};
