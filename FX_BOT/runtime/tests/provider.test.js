"use strict";

/** Tiingo provider contract: normalization, retries, redaction and inert imports. */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TICKERS,
  createFixtureProvider,
  createTiingoProvider,
  normalizeCandle,
  normalizeTop,
  observedSpread,
  redact,
} = require("../provider");

const FAKE_TOKEN = "1111111111111111111111111111111111111111";
const BAR_TIME = Date.parse("2026-01-07T12:00:00.000Z");

function tiingoCandle(overrides = {}) {
  return {
    date: "2026-01-07T12:00:00.000Z",
    ticker: "eurusd",
    open: 1.09,
    high: 1.092,
    low: 1.089,
    close: 1.091,
    ...overrides,
  };
}

function tiingoTop(overrides = {}) {
  return {
    ticker: "eurusd",
    quoteTimestamp: "2026-01-07T12:05:01.000Z",
    bidPrice: 1.09096,
    askPrice: 1.09104,
    midPrice: 1.091,
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("importing the provider performs no network request", () => {
  const saved = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network touched at import time"); };
  try {
    delete require.cache[require.resolve("../provider")];
    const mod = require("../provider");
    assert.equal(typeof mod.createTiingoProvider, "function");
  } finally {
    globalThis.fetch = saved;
    delete require.cache[require.resolve("../provider")];
  }
});

test("a Tiingo bar is usable only after its full timeframe has closed", () => {
  assert.equal(normalizeCandle(tiingoCandle(), { timeframe: "M5", asOf: BAR_TIME + 299999 }), null);
  assert.ok(normalizeCandle(tiingoCandle(), { timeframe: "M5", asOf: BAR_TIME + 300000 }));
});

test("Tiingo OHLC becomes the canonical candle without fabricating volume or spread", () => {
  const c = normalizeCandle(tiingoCandle(), { timeframe: "M5", asOf: BAR_TIME + 300000 });
  assert.equal(c.open, 1.09);
  assert.equal(c.close, 1.091);
  assert.equal(c.time, BAR_TIME);
  assert.equal(c.volume, 0);
  assert.equal(c.spread, undefined);
  assert.equal(c.complete, true);
});

test("non-finite, non-positive or malformed OHLC is rejected", () => {
  assert.equal(normalizeCandle(tiingoCandle({ open: "x" })), null);
  assert.equal(normalizeCandle(tiingoCandle({ open: 0 })), null);
  assert.equal(normalizeCandle(tiingoCandle({ date: "not-a-date" })), null);
  assert.equal(normalizeCandle(tiingoCandle({ high: 1, low: 2 })), null);
});

test("top-of-book supplies current midpoint and observed spread", () => {
  const quote = normalizeTop(tiingoTop());
  assert.equal(quote.symbol, "EUR_USD");
  assert.equal(quote.mid, 1.091);
  assert.ok(Math.abs(quote.spread - 0.00008) < 1e-9);
  assert.equal(normalizeTop(tiingoTop({ askPrice: null })), null);
  assert.equal(normalizeTop(tiingoTop({ ticker: "unknown" })), null);
});

test("an unobserved candle spread remains unknown rather than zero", () => {
  assert.equal(observedSpread([{ close: 1 }, { close: 2 }]), null);
  assert.equal(observedSpread([{ spread: 0.0001 }, { close: 2 }]), 0.0001);
});

test("redaction removes the token and anything token-shaped", () => {
  const leak = `Authorization: Token ${FAKE_TOKEN}`;
  const safe = redact(leak, [FAKE_TOKEN]);
  assert.ok(!safe.includes(FAKE_TOKEN));
  assert.ok(safe.includes("[redacted]"));
  assert.ok(!redact(leak, []).includes(FAKE_TOKEN));
});

test("a 401 is not retried and never leaks the token", async () => {
  let calls = 0;
  const provider = createTiingoProvider({
    baseUrl: "https://example.invalid",
    token: FAKE_TOKEN,
    maxAttempts: 3,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(`Invalid token ${FAKE_TOKEN}`, 401);
    },
  });
  const result = await provider.fetchCandles("EUR_USD", "M5", { count: 10, asOf: BAR_TIME + 300000 });
  assert.equal(calls, 1);
  assert.deepEqual(result.candles, []);
  assert.equal(result.error.status, 401);
  assert.ok(!JSON.stringify(result).includes(FAKE_TOKEN));
});

test("retryable failures are retried to the bound and become a data gap", async () => {
  for (const status of [429, 500, 503]) {
    let calls = 0;
    const provider = createTiingoProvider({
      baseUrl: "https://example.invalid",
      token: FAKE_TOKEN,
      maxAttempts: 2,
      random: () => 0,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse("busy", status);
      },
    });
    const result = await provider.fetchCandles("EUR_USD", "M5", { asOf: BAR_TIME + 300000 });
    assert.equal(calls, 2, `status ${status}`);
    assert.equal(result.error.retryable, true);
    assert.deepEqual(result.candles, []);
  }
});

test("a transient failure followed by success returns closed candles", async () => {
  let calls = 0;
  const provider = createTiingoProvider({
    baseUrl: "https://example.invalid",
    token: FAKE_TOKEN,
    maxAttempts: 2,
    random: () => 0,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? jsonResponse("busy", 503) : jsonResponse([tiingoCandle()]);
    },
  });
  const result = await provider.fetchCandles("EUR_USD", "M5", {
    count: 10,
    asOf: BAR_TIME + 300000,
  });
  assert.equal(result.error, null);
  assert.equal(result.candles.length, 1);
});

test("a network failure becomes a data gap, not a price", async () => {
  const provider = createTiingoProvider({
    baseUrl: "https://example.invalid",
    token: FAKE_TOKEN,
    maxAttempts: 1,
    fetchImpl: async () => { throw new Error("aborted"); },
  });
  const result = await provider.fetchCandles("EUR_USD", "M5", {});
  assert.deepEqual(result.candles, []);
  assert.equal(result.error.retryable, true);
});

test("only mapped instruments and timeframes may be requested", async () => {
  const provider = createTiingoProvider({ baseUrl: "https://example.invalid", token: FAKE_TOKEN });
  await assert.rejects(() => provider.fetchCandles("DOGE_USD", "M5", {}), /Unmapped instrument/);
  await assert.rejects(() => provider.fetchCandles("EUR_USD", "M3", {}), /Unmapped timeframe/);
});

test("historical requests use only the read-only Forex prices endpoint and header auth", async () => {
  let request = null;
  const provider = createTiingoProvider({
    baseUrl: "https://example.invalid",
    token: FAKE_TOKEN,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse([]);
    },
  });
  await provider.fetchCandles("EUR_USD", "M15", { count: 50, asOf: BAR_TIME });
  assert.match(request.url, /\/tiingo\/fx\/eurusd\/prices/);
  assert.match(request.url, /resampleFreq=15min/);
  assert.equal(request.options.headers.Authorization, `Token ${FAKE_TOKEN}`);
  assert.ok(!request.url.includes(FAKE_TOKEN), "the token never enters a URL");
  for (const forbidden of ["/accounts", "/orders", "/positions", "/trades", "/transactions"]) {
    assert.ok(!request.url.includes(forbidden));
  }

  // The live adapter must use the same complete map accepted by config.
  assert.equal(TICKERS.EUR_CAD, "eurcad");
  assert.equal(TICKERS.GBP_JPY, "gbpjpy");
  assert.equal(Object.keys(TICKERS).length, 24);
  await provider.fetchCandles("EUR_CAD", "M5", { count: 10, asOf: BAR_TIME });
  assert.match(request.url, /\/tiingo\/fx\/eurcad\/prices/);
});

test("one top-of-book request batches every configured ticker", async () => {
  let seenUrl = null;
  const provider = createTiingoProvider({
    baseUrl: "https://example.invalid",
    token: FAKE_TOKEN,
    fetchImpl: async (url) => {
      seenUrl = url;
      return jsonResponse([tiingoTop(), tiingoTop({ ticker: "gbpusd" })]);
    },
  });
  const result = await provider.fetchQuotes(["EUR_USD", "GBP_USD"]);
  assert.match(seenUrl, /\/tiingo\/fx\/top\?tickers=eurusd%2Cgbpusd/);
  assert.equal(Object.keys(result.quotes).length, 2);
  assert.equal(result.error, null);
});

test("the fixture provider serves only candles closed by the decision time", async () => {
  const base = Date.UTC(2026, 0, 7, 12, 0, 0);
  const data = { EUR_USD: { M5: [
    { time: base, open: 1, high: 1, low: 1, close: 1, complete: true },
    { time: base + 300000, open: 1, high: 1, low: 1, close: 1, complete: true },
  ] } };
  const provider = createFixtureProvider(data);
  const early = await provider.fetchCandles("EUR_USD", "M5", { asOf: base + 300000 });
  assert.equal(early.candles.length, 1);
  const later = await provider.fetchCandles("EUR_USD", "M5", { asOf: base + 600000 });
  assert.equal(later.candles.length, 2);
});
