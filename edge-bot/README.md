# edge-bot

A single-file Telegram bot that watches the crypto perp market and only messages you when several independent signals agree. Free data only (Hyperliquid public API). Zero npm dependencies — just Node 18+.

## The idea: a courtroom, not a siren

Most alert bots are car alarms — they scream at everything and you learn to ignore them. This bot works like a courtroom: **no single witness convicts.** It watches 4 witnesses per coin and only speaks when enough of them tell the same story:

1. **Funding** — is one side overpaying to hold their position? (a crowded trade, measured as a z-score vs the last 7 days)
2. **Open interest** — is that crowd still growing? (confirmation, not a signal on its own)
3. **Liquidation map** — where's the nearest big pool of liquidations? Price gravitates toward liquidity. On Hyperliquid every wallet's exact liquidation price is public — no estimating.
4. **Whales** — which way are the profitable wallets you track actually positioned?

When 3 of 4 agree (configurable), you get one Telegram message. Otherwise: silence. The silence is the noise filter.

## Setup

1. Install Node 18+ (`node --version` to check).
2. Make a Telegram bot: message **@BotFather** → `/newbot` → copy the token.
3. Get your chat id: message **@userinfobot**, it replies with your id.
4. If you want Edge Bot Telegram messages, use a separate Telegram bot from
   Consensus Reaper so the two polling processes do not compete. Set:
   ```
   EDGE_TELEGRAM_BOT_TOKEN="123456:ABC..."
   EDGE_TELEGRAM_CHAT_ID="123456789"
   ```
5. Add whale wallets: open the [Hyperliquid leaderboard](https://app.hyperliquid.xyz/leaderboard), pick wallets with *consistent* PnL over 30/90 days (not one lucky trade), and put their public addresses in the repo-root `.env` so a deployment cannot overwrite the cohort:
   ```
   HYPERLIQUID_TRACKED_WALLETS="0xabc...,0xdef..."
   ```
   All coins and thresholds live in the `CONFIG` block in `edge-bot.js`.

## Commands

```
node edge-bot.js scan               # one-shot scan, prints to console — try this first, no Telegram needed
node edge-bot.js run                # live: scans every 15 min, sends alerts, answers /status and /coin BTC in Telegram
node edge-bot.js backtest BTC 120   # backtest the funding signal on 120 days of real data
node edge-bot.js backtest ALL 120   # same, across every coin in CONFIG, with a combined t-stat
node edge-bot.js journal-status     # audit journal coverage and confirm which witnesses really fired
node edge-bot.js evaluate           # forward-test ALL witnesses using non-overlapping 24h samples
node edge-bot.js selftest           # audit: verifies the engine math on synthetic data with known answers
```

## Verification (read this before trusting it)

- `selftest` plants a fake funding spike in synthetic data and checks the engine finds it, trades the right direction, enters on the *next* candle (no peeking at the future), and computes returns correctly. It also sets a lookahead trap — a price move *before* the signal — and confirms the engine can't profit from it. Run it yourself.
- `backtest` runs the same engine on real history. Honest limits: it only tests the **funding** witness, because liquidation maps and whale positions are live snapshots — nobody stores their history for free.
- Hyperliquid exposes only its most recent 5,000 hourly candles. For longer tests the bot tries paginated OKX history; if full price coverage is unavailable, it reports the actual date range and skips signals without an adjacent candle instead of pairing them to a later price.
- That's what the **journal** is for: every scan appends each coin's witness states to `journal.jsonl`. Use `journal-status` first to confirm the bot stayed online and that wallet-dependent witnesses actually produced calls. After the bot has been alive for several weeks, `evaluate` measures what price did 24h after each score. It reports non-overlapping samples because 15-minute scans inside the same 24-hour outcome are not independent evidence.
- With no tracked wallets, the liquidation and whale witnesses stay neutral, the maximum score is 2, and the default alert threshold of 3 is unreachable. A journal from that configuration only tests funding and OI.
- Funding signals require both an unusual z-score **and** an economically meaningful rate (≥ 0.004%/hour). Without the second check, weeks of flatlined funding make the variance collapse and any microscopic wobble produces absurd z-scores (this was a real bug, caught in the first live backtest — the selftest now has a regression check for it).
- A good backtest = hit rate meaningfully above 50%, positive avg return after fees, **and a t-stat above ~2**, across several coins and time windows. One good run proves nothing.

## Honest limitations

- Liquidation clusters are magnets, not guarantees. Price visits liquidity *often*, not always.
- The liq map only sees wallets you track — it's a sample, not the whole market.
- Signals are context, not orders. The bot finds moments worth looking at; the trade is still your call.
- Not financial advice.
