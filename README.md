# Consensus Reaper

Lean crypto market-structure Telegram alert bot.

## Local Setup

```bash
cd consensus_reaper
npm install
cp .env.example .env
```

Put the Telegram bot token in `.env`:

```bash
TELEGRAM_BOT_TOKEN=your_token_here
```

Run a dry scan:

```bash
npm run scan
```

Start the bot:

```bash
npm start
```

## Telegram Setup

Add the bot to your group, then send:

```text
/id
/activate
/status
```

Exact pool watch commands:

```text
/watch solana POOL_ADDRESS
/watch https://www.geckoterminal.com/solana/pools/POOL_ADDRESS
/watch https://dexscreener.com/solana/POOL_ADDRESS
/watchlist
/unwatch solana POOL_ADDRESS
```

## Server Run With PM2

Install Node.js and PM2 on the server:

```bash
npm install -g pm2
```

Clone and install:

```bash
git clone https://github.com/PeterEkwere/memecoin_tracker_twitter.git
cd memecoin_tracker_twitter/consensus_reaper
npm install
cp .env.example .env
```

Edit `.env` and add the bot token, then start:

```bash
pm2 start bot.js --name consensus-reaper
pm2 save
pm2 startup
```

Run the command printed by `pm2 startup`. After that, the bot will restart if the server reboots and will keep running after SSH closes.

Useful commands:

```bash
pm2 status
pm2 logs consensus-reaper
pm2 restart consensus-reaper
pm2 stop consensus-reaper
```
