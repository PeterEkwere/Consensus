#!/usr/bin/env python3
"""Download real candle history from Dukascopy into the data cache.

No account or API key required (works anywhere, including regions where OANDA
blocks signups). Downloads one .bi5 file per hour, so a multi-month pull is SLOW —
that is expected. Ticks carry bid AND ask, so a real spread is stored.

Example:
    python scripts/fetch_dukascopy_history.py \
      --symbols EURUSD GBPUSD USDJPY XAUUSD --timeframes M5 M15 \
      --start 2024-01-01 --end 2025-06-30 --out data_cache/raw/mt5

Then run validate_history.py, then run_backtest.py with a REAL strategy profile
(e.g. --strategy-profile default), NOT 'synthetic'.
"""
import _bootstrap  # noqa: F401
import argparse
from datetime import datetime, timezone

from config.symbols import get_symbol_meta
from data.dukascopy_feed import fetch_symbol_timeframes
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
    ap.add_argument("--polite-delay", type=float, default=0.0,
                    help="seconds to sleep between hourly requests (be nice to the server)")
    ap.add_argument("--insecure", action="store_true",
                    help="disable SSL verification (only if your Python lacks CA certs)")
    args = ap.parse_args()

    days = (args.end - args.start).days
    print(f"Dukascopy download -> {args.out}")
    print(f"Range: {args.start.date()} -> {args.end.date()} (~{days * 24} hourly files/symbol; this is slow)\n")

    total = 0
    for symbol in args.symbols:
        meta = get_symbol_meta(symbol)
        tf_candles = fetch_symbol_timeframes(
            symbol, args.timeframes, args.start, args.end, meta.point_size,
            polite_delay=args.polite_delay, insecure=args.insecure, log=print,
        )
        for tf, candles in tf_candles.items():
            path = save_candles(candles, args.out, symbol, tf, source="dukascopy")
            total += len(candles)
            print(f"  {symbol} {tf}: {len(candles)} candles -> {path}")
    print(f"\nDone. {total} candles written. Next: validate_history.py then run_backtest.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
