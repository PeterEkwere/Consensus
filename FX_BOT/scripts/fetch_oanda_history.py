#!/usr/bin/env python3
"""Download real candle history from OANDA v20 into the data cache (Mac-friendly).

Setup:
  1. Create a free OANDA practice account -> https://www.oanda.com/
  2. Generate an API token (Account -> "Manage API Access").
  3. export OANDA_API_TOKEN=your_token   (and OANDA_ENV=practice by default)

Example:
    python scripts/fetch_oanda_history.py \
      --symbols EURUSD GBPUSD USDJPY XAUUSD \
      --timeframes M5 M15 \
      --start 2024-01-01 --end 2025-06-30 \
      --out data_cache/raw/mt5

Output drops into the SAME layout the backtest already reads, so afterwards just run
validate_history.py / run_backtest.py / run_walk_forward.py unchanged (use a real
strategy profile like --strategy-profile default rather than 'synthetic').
"""
import _bootstrap  # noqa: F401
import argparse
import os
from datetime import datetime, timezone

from config.symbols import get_symbol_meta
from data.oanda_feed import fetch_symbol_timeframe
from data.storage import save_candles


def _date(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", nargs="+", default=["EURUSD", "GBPUSD", "USDJPY", "XAUUSD"])
    ap.add_argument("--timeframes", nargs="+", default=["M5", "M15"])
    ap.add_argument("--start", type=_date, required=True)
    ap.add_argument("--end", type=_date, required=True)
    ap.add_argument("--out", default="data_cache/raw/mt5")
    ap.add_argument("--env", choices=["practice", "live"], default=os.environ.get("OANDA_ENV", "practice"))
    args = ap.parse_args()

    token = os.environ.get("OANDA_API_TOKEN", "")
    if not token:
        print("ERROR: set OANDA_API_TOKEN in your environment (see script header).")
        return 2

    print(f"Fetching OANDA history ({args.env}) -> {args.out}")
    total = 0
    for symbol in args.symbols:
        meta = get_symbol_meta(symbol)
        for tf in args.timeframes:
            candles = fetch_symbol_timeframe(
                symbol, tf, args.start, args.end, token, env=args.env, point_size=meta.point_size,
            )
            path = save_candles(candles, args.out, symbol, tf, source="oanda")
            total += len(candles)
            print(f"  {symbol} {tf}: {len(candles)} candles -> {path}")
    print(f"Done. {total} candles written. Next: validate_history.py then run_backtest.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
