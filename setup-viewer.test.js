"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createSetupViewer } = require("./setup-viewer");

const signal = {
  symbol: "BTCUSDT",
  market: "futures",
  tvSymbol: "OKX:BTCUSDT.P",
  name: "BTC / USDT",
  side: "long",
  score: 84,
  price: 100,
  entryLow: 99,
  entryHigh: 101,
  stop: 95,
  target: 115,
  riskRewardRatio: 3,
  time: new Date().toISOString(),
  confirmations: ["Synthetic test"],
  url: "https://www.tradingview.com/chart/?symbol=OKX%3ABTCUSDT.P",
};

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "consensus-viewer-"));
  const viewer = createSetupViewer({
    baseUrl: "https://viewer.example",
    secret: "a".repeat(64),
    host: "127.0.0.1",
    port: 0,
    setupsFile: path.join(tempDir, "setups.json"),
    fetchCandles: async () => [
      { time: Date.now() - 900000, open: 98, high: 101, low: 97, close: 100 },
      { time: Date.now(), open: 100, high: 103, low: 99, close: 102 },
    ],
  });

  try {
    assert.strictEqual(viewer.enabled, true);
    const link = new URL(viewer.createSetup(signal));
    const id = link.pathname.split("/").pop();
    const signature = link.searchParams.get("sig");
    assert(viewer.findSetup(id, signature), "signed setup should resolve");
    assert.strictEqual(viewer.findSetup(id, "0".repeat(64)), null, "tampered signature must fail");

    const address = await viewer.start();
    const root = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${root}/health`).then((response) => response.json());
    assert.deepStrictEqual(health, { ok: true, viewer: true });

    const page = await fetch(`${root}${link.pathname}${link.search}`);
    assert.strictEqual(page.status, 200);
    assert((await page.text()).includes("Consensus Reaper Setup"));

    const payload = await fetch(`${root}/api/setup/${id}?sig=${signature}`).then((response) => response.json());
    assert.strictEqual(payload.setup.target, 115);
    assert.strictEqual(payload.candles.length, 2);

    const rejected = await fetch(`${root}/api/setup/${id}?sig=${"0".repeat(64)}`);
    assert.strictEqual(rejected.status, 404);
    console.log("setup-viewer tests passed");
  } finally {
    await viewer.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
