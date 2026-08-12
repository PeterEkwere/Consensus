/**
 * Consensus FX Sentinel - market data providers.
 *
 * The live adapter uses only Tiingo's read-only Forex REST endpoints:
 * historical OHLC bars and batched top-of-book quotes. Tokens stay in request
 * headers and never enter URLs, returned objects, diagnostics, or logs.
 */

"use strict";

const { TIMEFRAME_MS } = require("./market");
const { SYMBOLS } = require("./config");

const RESAMPLE = Object.freeze({ M1: "1min", M5: "5min", M15: "15min", H1: "1hour" });
// One canonical map for every supported instrument. Keeping a second hard-
// coded four-pair list here made configuration accept pairs the live provider
// could never request.
const TICKERS = Object.freeze(Object.fromEntries(
  Object.values(SYMBOLS).map((symbol) => [symbol.id, symbol.tiingo]),
));
const SYMBOL_BY_TICKER = Object.freeze(
  Object.fromEntries(Object.entries(TICKERS).map(([symbol, ticker]) => [ticker, symbol])),
);

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

class ProviderError extends Error {
  constructor(message, { status = null, retryable = false, symbol = null } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.retryable = retryable;
    this.symbol = symbol;
  }
}

function redact(text, secrets = []) {
  let out = typeof text === "string" ? text : JSON.stringify(text);
  if (typeof out !== "string") return "";
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  out = out.replace(/\b[0-9a-f]{40}\b/gi, "[redacted]");
  out = out.replace(/(authorization\s*[:=]\s*(?:token|bearer)\s+)\S+/gi, "$1[redacted]");
  out = out.replace(/((?:token|authToken)=)[^&\s]+/gi, "$1[redacted]");
  return out.slice(0, 500);
}

function normalizeCandle(raw, { timeframe = "M1", asOf = Infinity } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const time = Date.parse(raw.date);
  const candle = {
    time,
    open: Number(raw.open),
    high: Number(raw.high),
    low: Number(raw.low),
    close: Number(raw.close),
    volume: 0,
    complete: true,
  };
  if (!Number.isFinite(time)) return null;
  if (![candle.open, candle.high, candle.low, candle.close]
    .every((n) => Number.isFinite(n) && n > 0)) return null;
  if (candle.high < candle.low || candle.high < candle.open || candle.high < candle.close
    || candle.low > candle.open || candle.low > candle.close) return null;
  const duration = TIMEFRAME_MS[timeframe];
  if (!duration || time + duration > asOf) return null;
  return candle;
}

function normalizeTop(raw) {
  if (!raw || typeof raw !== "object") return null;
  const ticker = String(raw.ticker || "").toLowerCase();
  const symbol = SYMBOL_BY_TICKER[ticker];
  const bid = Number(raw.bidPrice);
  const ask = Number(raw.askPrice);
  const suppliedMid = Number(raw.midPrice);
  const quoteTime = Date.parse(raw.quoteTimestamp);
  if (!symbol || !Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid
    || !Number.isFinite(quoteTime)) return null;
  const mid = Number.isFinite(suppliedMid) ? suppliedMid : (bid + ask) / 2;
  if (!(mid > 0)) return null;
  return { symbol, ticker, bid, ask, mid, spread: ask - bid, quoteTime };
}

function observedSpread(candles) {
  for (let i = (candles || []).length - 1; i >= 0; i--) {
    if (Number.isFinite(candles[i].spread)) return candles[i].spread;
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFixtureProvider(data, options = {}) {
  const name = options.name || "fixtures";
  return {
    name,
    async fetchCandles(symbolId, timeframe, { count = 200, asOf = null } = {}) {
      const bySymbol = data[symbolId] || {};
      const series = bySymbol[timeframe] || [];
      const usable = asOf === null
        ? series
        : series.filter((c) => c.time + TIMEFRAME_MS[timeframe] <= asOf);
      return {
        symbol: symbolId,
        timeframe,
        provider: name,
        candles: usable.slice(-count).map((c) => ({ ...c })),
        error: null,
      };
    },
  };
}

function createTiingoProvider({ baseUrl = "https://api.tiingo.com", token,
  timeoutMs = DEFAULT_TIMEOUT_MS, maxAttempts = DEFAULT_MAX_ATTEMPTS,
  fetchImpl = globalThis.fetch, random = Math.random } = {}) {
  if (!baseUrl) throw new Error("Tiingo provider requires a base URL.");

  async function request(url, symbolId = null) {
    let attempt = 0;
    let lastError = null;
    while (attempt < maxAttempts) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers: {
            Authorization: `Token ${token}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        });
        if (response.ok) return await response.json();
        const bodyText = await response.text().catch(() => "");
        const retryable = RETRYABLE_STATUS.has(response.status);
        lastError = new ProviderError(
          `Tiingo responded ${response.status}: ${redact(bodyText, [token])}`,
          { status: response.status, retryable, symbol: symbolId },
        );
        if (!retryable) throw lastError;
      } catch (err) {
        if (err instanceof ProviderError && !err.retryable) throw err;
        lastError = err instanceof ProviderError ? err : new ProviderError(
          `Tiingo request failed: ${redact(err && err.message, [token])}`,
          { retryable: true, symbol: symbolId },
        );
      } finally {
        clearTimeout(timer);
      }
      if (attempt < maxAttempts) {
        await sleep(Math.round((2 ** attempt) * 100 * (0.5 + random() * 0.5)));
      }
    }
    throw lastError || new ProviderError("Tiingo request failed", { retryable: true, symbol: symbolId });
  }

  return {
    name: "tiingo",

    /** One request supplies current bid/ask for every configured instrument. */
    async fetchQuotes(symbolIds) {
      const ids = [...new Set(symbolIds || [])];
      const tickers = ids.map((id) => TICKERS[id]);
      if (tickers.some((ticker) => !ticker)) {
        return { quotes: {}, error: { message: "Unmapped Tiingo instrument", status: null, retryable: false } };
      }
      const url = `${baseUrl}/tiingo/fx/top?tickers=${encodeURIComponent(tickers.join(","))}`;
      try {
        const payload = await request(url);
        const quotes = {};
        for (const row of Array.isArray(payload) ? payload : []) {
          const quote = normalizeTop(row);
          if (quote) quotes[quote.symbol] = quote;
        }
        return { quotes, error: null };
      } catch (err) {
        return {
          quotes: {},
          error: {
            message: redact(err && err.message, [token]),
            status: (err && err.status) || null,
            retryable: Boolean(err && err.retryable),
          },
        };
      }
    },

    async fetchCandles(symbolId, timeframe, { count = 200, asOf = Date.now() } = {}) {
      const ticker = TICKERS[symbolId];
      const resample = RESAMPLE[timeframe];
      const duration = TIMEFRAME_MS[timeframe];
      if (!ticker) throw new Error(`Unmapped instrument: ${symbolId}`);
      if (!resample || !duration) throw new Error(`Unmapped timeframe: ${timeframe}`);

      // Allow for weekends/holidays without downloading unbounded history.
      const wanted = Math.min(Math.max(Number(count) || 1, 1), 5000);
      const lookbackMs = duration * wanted * 2 + 4 * DAY_MS;
      const startDate = new Date(asOf - lookbackMs).toISOString();
      const endDate = new Date(asOf).toISOString();
      const url = `${baseUrl}/tiingo/fx/${ticker}/prices`
        + `?startDate=${encodeURIComponent(startDate)}`
        + `&endDate=${encodeURIComponent(endDate)}`
        + `&resampleFreq=${encodeURIComponent(resample)}`;

      try {
        const payload = await request(url, symbolId);
        const candles = (Array.isArray(payload) ? payload : [])
          .map((row) => normalizeCandle(row, { timeframe, asOf }))
          .filter(Boolean)
          .sort((a, b) => a.time - b.time)
          .slice(-wanted);
        return { symbol: symbolId, timeframe, provider: "tiingo", candles, error: null };
      } catch (err) {
        return {
          symbol: symbolId,
          timeframe,
          provider: "tiingo",
          candles: [],
          error: {
            message: redact(err && err.message, [token]),
            status: (err && err.status) || null,
            retryable: Boolean(err && err.retryable),
          },
        };
      }
    },
  };
}

module.exports = {
  ProviderError,
  RESAMPLE,
  RETRYABLE_STATUS,
  TICKERS,
  createFixtureProvider,
  createTiingoProvider,
  normalizeCandle,
  normalizeTop,
  observedSpread,
  redact,
};
