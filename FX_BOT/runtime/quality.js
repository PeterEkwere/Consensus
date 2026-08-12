/**
 * Consensus FX Sentinel - setup quality score.
 *
 * The engine already collapses confirmations to one per family, which is the
 * hard part. This module only makes the result auditable: a raw family-weight
 * total, a normalized 0-100 score, how many families contributed, and what
 * share of the possible families were covered.
 *
 * Deliberately NOT a gate. The playbook definitions and the ten hard gates stay
 * authoritative; this score exists to rank competing candidates, to slice
 * research by quality, and to be measured. Copying the crypto bot's threshold
 * number would be meaningless here - the scales measure different things, and
 * the FX bot has published zero setups, so there is no sample to choose a
 * threshold from.
 *
 * Pure. No I/O.
 */

"use strict";

const { STRATEGY } = require("./config");

/**
 * The frozen denominator: the highest weight each family can contribute.
 *
 * Taken from the weights the playbooks already emit, not invented. Using a
 * frozen denominator rather than "the families that happened to appear" means a
 * candidate with less evidence scores lower, instead of scoring full marks on a
 * smaller exam.
 */
const FAMILY_MAX = STRATEGY.qualityFamilyMax;

const FAMILY_IDS = Object.freeze(Object.keys(FAMILY_MAX));

const DENOMINATOR = FAMILY_IDS.reduce((sum, id) => sum + FAMILY_MAX[id], 0);

/**
 * Score an already-collapsed confirmation list.
 *
 * `confirmations` is expected to hold at most one entry per family, which is
 * what `engine.collapseConfirmations` guarantees. If a caller passes an
 * uncollapsed list, only the strongest per family is used anyway, so the score
 * can never be inflated by correlated evidence.
 */
function scoreConfirmations(confirmations) {
  const winners = new Map();
  for (const item of confirmations || []) {
    if (!item || !item.family) continue;
    const max = FAMILY_MAX[item.family];
    if (!Number.isFinite(max)) continue; // Unknown family contributes nothing.
    const weight = Number(item.weight);
    if (!Number.isFinite(weight)) continue;
    const capped = Math.min(weight, max);
    const current = winners.get(item.family);
    if (!current || capped > current.weight) {
      winners.set(item.family, { family: item.family, text: item.text, weight: capped });
    }
  }

  const raw = [...winners.values()].reduce((sum, w) => sum + w.weight, 0);
  return {
    raw,
    denominator: DENOMINATOR,
    score: DENOMINATOR > 0 ? Math.round((raw / DENOMINATOR) * 100) : 0,
    familyCount: winners.size,
    coveragePct: Math.round((winners.size / FAMILY_IDS.length) * 100),
    winners: [...winners.values()].sort((a, b) => b.weight - a.weight),
  };
}

/** Attach quality fields to a candidate without changing its gate outcome. */
function annotate(candidate) {
  const quality = scoreConfirmations(candidate.confirmations);
  candidate.qualityRaw = quality.raw;
  candidate.qualityScore = quality.score;
  candidate.familyCount = quality.familyCount;
  candidate.coveragePct = quality.coveragePct;
  candidate.qualityWinners = quality.winners.map((w) => ({ family: w.family, text: w.text }));
  return candidate;
}

module.exports = { DENOMINATOR, FAMILY_IDS, FAMILY_MAX, annotate, scoreConfirmations };
