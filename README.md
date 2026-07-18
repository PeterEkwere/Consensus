# Consensus Reaper

Lean, single-file crypto market-structure Telegram alert bot for **major exchange pairs**.

- Tracks curated major pairs on **Binance Spot and Futures** (Bybit fallback if Binance is geo-blocked).
- Multi-timeframe consensus: **5m + 15m + 1h**. 15m is the setup timeframe, 1h gates the direction, 5m confirms momentum.
- Pairs shown as **TradingView symbols** with chart links. No wallet, no trading, no API key.

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
/exchange binance   # or: /exchange bybit
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

Useful commands:

```bash
pm2 status
pm2 logs consensus-reaper
pm2 restart consensus-reaper
pm2 stop consensus-reaper
```
