# Consensus Reaper

Lean, single-file crypto market-structure Telegram alert bot for **major exchange pairs**.

- Tracks curated major pairs on **OKX Spot and Futures** (perpetuals). OKX is used because it is reachable from regions where Binance/Bybit are geo-blocked.
- Multi-timeframe consensus: **5m + 15m + 1h**. 15m is the setup timeframe, 1h gates the direction, 5m confirms momentum.
- Each alert publishes one **exact entry price**, a stop loss, a **1:1** target and a **3:1** target, all measured from that entry.
- Every published setup is tracked to a result against closed **OKX 1m candles** and reported by `/results`.
- Every alert includes a direct TradingView link. The bot is read-only: no wallet, trading, or exchange API key.

## How Outcomes Are Measured

Alerts are written in plain language: BUY/SELL, Entry Price, Stop Loss, First Profit Target (1:1) and Final Profit Target (3:1). Internally the ledger uses the usual shorthand.

Risk is defined once per setup:

```text
R    = abs(entry - stop)
BUY  : first target = entry + R,  final target = entry + 3R
SELL : first target = entry - R,  final target = entry - 3R
```

A setup with a missing, non-finite, zero or directionally invalid entry, stop or target is rejected and never published.

Every alert gets a stable id such as `CR-BTC-20260808-001`. Ids are persisted with the record, so a restart never renames a setup.

Monitoring rules, applied to closed OKX 1m candles for the same instrument that produced the signal:

- Candles that opened before the alert was sent are never evaluated.
- The entry activates when a later candle trades through the exact entry price.
- If price reaches invalidation without ever trading the exact entry, the setup is **cancelled before entry** and is not scored.
- After entry, the 1:1 and 3:1 legs are tracked independently against the original stop. The stop is never moved to break-even.
- If the first target is reached and price later hits the stop, the result is `1R=TP` and `3R=SL`.
- **OHLC ambiguity rule:** a 1m candle records only open/high/low/close, so when one unresolved candle contains both the stop and a target the true sequence is unknowable. The stop is always recorded first. This understates performance rather than inventing wins.
- Unresolved setups expire after **24 hours** (configurable) and are reported separately, never counted as a win or a loss.
- Monitoring failures are logged. A failed candle fetch never produces a result.

State lives in `outcomes.json`, written atomically and resumed on restart. Notification flags are persisted, so no message is ever sent twice.

## Frozen Research Trial

This rule is under a **fixed prospective trial**. It is frozen: thresholds, scoring and levels must not be tuned while the trial is running.

- Duration: **30 days**.
- Minimum sample: **50 unique resolved setups**.
- No threshold or rule tuning during the trial.
- **1:1 promotion:** more than **55%** wins, positive expectancy after costs, and t-statistic above **2**.
- **3:1 promotion:** more than **30%** wins, positive expectancy after costs, and t-statistic above **2**.
- If neither leg passes, the rule is declared **no-go**. Collection is not extended indefinitely to search for a pass.
- Any change to the strategy ends this trial and starts a new, separately named forward trial.

Costs are charged to every completed setup: 0.05% fee and 0.05% assumed slippage per side, both on entry and exit. `/results` reports expectancy net of those costs.

## Local Setup

```bash
cd Consensus
npm install
cp .env.example .env
```

Put the Telegram bot token in `.env`:

```bash
TELEGRAM_BOT_TOKEN=your_token_here
```

Run a dry scan (prints candidates, sends nothing):

```bash
npm run scan
```

Start the bot:

```bash
npm start
```

## Telegram Commands

Setup in a group:

```text
/id
/activate
/status
/results
```

Pair management (owner only):

```text
/pairs
/addpair BTCUSDT            # spot
/addpair BTCUSDT futures    # perpetual
/addpair BINANCE:BTCUSDT.P  # TradingView form
/removepair BTCUSDT
/resetpairs
```

Runtime (owner only):

```text
/scan
/testalert
/pause
/resume
/threshold 65
```

## Server Run With PM2

Install Node.js and PM2 on the server:

```bash
npm install -g pm2
```

Clone and install:

```bash
git clone https://github.com/PeterEkwere/Consensus.git
cd Consensus
npm install
cp .env.example .env
```

Edit `.env`, add the bot token, then start:

```bash
pm2 start bot.js --name consensus-reaper
pm2 save
pm2 startup
```

Run the command that `pm2 startup` prints. After that the bot restarts on reboot and keeps running after SSH closes.

### Update an already-deployed server

```bash
cd Consensus
git pull
npm install
pm2 restart consensus-reaper
pm2 logs consensus-reaper --lines 100
```

Use `/testalert` in Telegram to receive a sample alert with its direct TradingView button.

Useful commands:

```bash
pm2 status
pm2 logs consensus-reaper
pm2 restart consensus-reaper
pm2 stop consensus-reaper
```
