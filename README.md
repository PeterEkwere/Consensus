# Consensus Reaper

Lean, single-file crypto market-structure Telegram alert bot for **major exchange pairs**.

- Tracks curated major pairs on **OKX Spot and Futures** (perpetuals). OKX is used because it is reachable from regions where Binance/Bybit are geo-blocked.
- Multi-timeframe consensus: **5m + 15m + 1h**. 15m is the setup timeframe, 1h gates the direction, 5m confirms momentum.
- Alert trade maps use a single **3:1 reward-to-risk target** measured from the signal price to invalidation.
- Every alert can include a one-tap **View complete setup** page that draws fresh candlesticks, the entry zone, invalidation and 3R target.
- The setup viewer is read-only. No wallet, no trading and no exchange API key.

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

To enable one-tap setup pages, give the bot a public HTTPS URL and signing secret:

```bash
SETUP_VIEWER_BASE_URL=https://charts.example.com
SETUP_VIEWER_SECRET=generate_with_openssl_rand_hex_32
SETUP_VIEWER_PORT=3080
```

The viewer listens only on `127.0.0.1`; expose it through an HTTPS reverse proxy. A starting Nginx configuration is in `deploy/consensus-setup-viewer.nginx.conf.example`.

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

Use `/testalert` in Telegram to receive a sample alert with the one-tap setup button.

Useful commands:

```bash
pm2 status
pm2 logs consensus-reaper
pm2 restart consensus-reaper
pm2 stop consensus-reaper
```
