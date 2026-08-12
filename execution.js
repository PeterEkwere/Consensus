/**
 * Consensus Reaper - execution snapshot and cost gates.
 *
 * The ledger previously assumed a flat 0.2% round trip and never checked what
 * the book actually looked like at publication time. With a narrow stop, the
 * spread alone can consume a large share of one unit of risk, so a setup can
 * reach its displayed target and still lose money. A displayed target is not
 * expectancy.
 *
 * This module fetches ONE public OKX ticker (best bid/ask, no credentials, no
 * private or trading endpoint) and turns it into an auditable execution record:
 * how stale the quote is, how wide the book is, how far price has already moved
 * from the canonical entry, and what the modelled round trip costs in R.
 *
 * It fails CLOSED: a missing, malformed, mismatched or stale quote does not
 * become a price, and it does not become a losing outcome either. It is a
 * refusal to publish, recorded with a reason.
 *
 * The maths is pure and separately testable; the fetch is injected.
 */

"use strict";

const { STRATEGY } = require("./strategy");

const OKX_TICKER_URL = "https://www.okx.com/api/v5/market/ticker";

/** Reasons a snapshot may refuse to authorise a new alert. */
const REFUSALS = Object.freeze({
  UNAVAILABLE: "quote_unavailable",
  MALFORMED: "quote_malformed",
  WRONG_INSTRUMENT: "quote_wrong_instrument",
  STALE: "quote_stale",
  CHASE: "price_moved_too_far",
  SPREAD: "spread_too_wide",
  COST: "cost_too_high",
  NON_FINITE_COST: "cost_non_finite",
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Normalize one OKX ticker row into a quote, or return a typed refusal.
 * `expectedInstId` guards against a response for a different market.
 */
function parseTicker(payload, expectedInstId) {
  if (!payload || payload.code !== "0" || !Array.isArray(payload.data) || !payload.data.length) {
    return { ok: false, reason: REFUSALS.UNAVAILABLE };
  }
  const row = payload.data[0];
  if (!row || typeof row !== "object") return { ok: false, reason: REFUSALS.MALFORMED };

  if (expectedInstId && row.instId !== expectedInstId) {
    // A quote for the wrong market is worse than no quote: it looks valid.
    return { ok: false, reason: REFUSALS.WRONG_INSTRUMENT };
  }

  const bid = Number(row.bidPx);
  const ask = Number(row.askPx);
  const ts = Number(row.ts);
  if (![bid, ask].every((n) => Number.isFinite(n) && n > 0)) {
    return { ok: false, reason: REFUSALS.MALFORMED };
  }
  if (ask < bid) return { ok: false, reason: REFUSALS.MALFORMED };
  if (!Number.isFinite(ts) || ts <= 0) return { ok: false, reason: REFUSALS.MALFORMED };

  return { ok: true, quote: { bid, ask, mid: (bid + ask) / 2, spread: ask - bid, ts, instId: row.instId } };
}

// ---------------------------------------------------------------------------
// Cost maths (pure)
// ---------------------------------------------------------------------------

/**
 * Modelled round-trip cost in price units.
 *
 *   cost = spread                      (crossing the book once)
 *        + entry * 2 * (fee + slippage) (both sides, entry and exit)
 *
 * The spread is charged once because the entry crosses it; the exit's spread is
 * represented by the slippage assumption rather than double-counted.
 */
function roundTripCost({ entry, spread, feeRatePerSide, slippageRatePerSide }) {
  const rates = Number(feeRatePerSide) + Number(slippageRatePerSide);
  if (!Number.isFinite(entry) || !Number.isFinite(spread) || !Number.isFinite(rates)) return null;
  return spread + entry * 2 * rates;
}

/**
 * Build the full execution record for a candidate.
 *
 * Symmetric by construction: `drift` uses an absolute distance, so a long and a
 * short that have each moved the same distance from entry are treated
 * identically.
 */
function evaluateExecution({ signal, plan, quote, now, strategy = STRATEGY, costs }) {
  const policy = strategy.execution;
  const feeRatePerSide = Number(costs && costs.feeRatePerSide);
  const slippageRatePerSide = Number(costs && costs.slippageRatePerSide);

  const spread = quote.ask - quote.bid;
  const quoteAgeMs = Number(now) - Number(quote.ts);
  // The reference price is the side of the book the trade would actually pay.
  const referencePrice = plan.side === "long" ? quote.ask : quote.bid;
  const drift = Math.abs(referencePrice - plan.entry);
  const driftFractionOfR = plan.r > 0 ? drift / plan.r : Infinity;

  const costPrice = roundTripCost({ entry: plan.entry, spread, feeRatePerSide, slippageRatePerSide });
  const costR = costPrice !== null && plan.r > 0 ? costPrice / plan.r : null;
  const spreadFractionOfR = plan.r > 0 ? spread / plan.r : Infinity;
  const spreadBps = plan.entry > 0 ? (spread / plan.entry) * 10_000 : null;

  const snapshot = {
    quoteTs: quote.ts,
    quoteAgeMs,
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    referencePrice,
    spread,
    spreadBps,
    spreadFractionOfR,
    drift,
    driftFractionOfR,
    costPrice,
    costR,
    feeRatePerSide,
    slippageRatePerSide,
    // True only when every field above was actually observed.
    known: Number.isFinite(costR) && Number.isFinite(driftFractionOfR) && Number.isFinite(quoteAgeMs),
  };

  // Fail closed, in a fixed order so a rejection reason is reproducible.
  if (!Number.isFinite(quoteAgeMs) || quoteAgeMs > policy.maxQuoteAgeMs || quoteAgeMs < -policy.maxQuoteAgeMs) {
    return { ok: false, reason: REFUSALS.STALE, snapshot };
  }
  if (!Number.isFinite(costR)) return { ok: false, reason: REFUSALS.NON_FINITE_COST, snapshot };
  if (driftFractionOfR > policy.maxChaseFractionOfR) {
    return { ok: false, reason: REFUSALS.CHASE, snapshot };
  }
  if (spreadFractionOfR > policy.maxSpreadFractionOfR) {
    return { ok: false, reason: REFUSALS.SPREAD, snapshot };
  }
  if (costR > policy.maxCostFractionOfR) {
    return { ok: false, reason: REFUSALS.COST, snapshot };
  }

  return { ok: true, snapshot };
}

/**
 * Execution-family evidence.
 *
 * Good execution is real evidence about a setup's tradability, so it earns a
 * place in the score - but only in its own family, and only when measured.
 */
function executionObservations(snapshot, strategy = STRATEGY) {
  const out = [];
  if (!snapshot || !snapshot.known) return out;
  const policy = strategy.execution;
  const familyMax = strategy.families.execution;

  if (snapshot.driftFractionOfR <= policy.goodDriftFractionOfR) {
    out.push({ label: "Fresh quote within no-chase limit", points: Math.round(familyMax * 0.5) });
  }
  if (snapshot.costR <= policy.goodCostFractionOfR) {
    out.push({ label: "Round-trip cost is a small fraction of risk", points: familyMax });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch one public OKX ticker. `httpGetJson` is injected so tests never touch
 * the network. No credentials, no signing, no private endpoint.
 */
async function fetchQuote(instId, httpGetJson) {
  const url = `${OKX_TICKER_URL}?instId=${encodeURIComponent(instId)}`;
  let payload = null;
  try {
    payload = await httpGetJson(url);
  } catch {
    return { ok: false, reason: REFUSALS.UNAVAILABLE };
  }
  return parseTicker(payload, instId);
}

module.exports = {
  OKX_TICKER_URL,
  REFUSALS,
  evaluateExecution,
  executionObservations,
  fetchQuote,
  parseTicker,
  roundTripCost,
};
