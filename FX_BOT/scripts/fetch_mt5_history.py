#!/usr/bin/env python3
"""Extract candle history from MetaTrader 5 into the data cache.

Requires a running MT5 terminal (Windows in practice). On machines without MT5 this
exits with a clear message; use make_synthetic_history.py to run the pipeline, or
export CSV from MT5 and import via data.mt5_export.

Example:
    python scripts/fetch_mt5_history.py \
      --symbols EURUSD GBPUSD USDJPY XAUUSD \
      --timeframes M1 M5 M15 \
      --start 2024-01-01 --end 2026-06-30 \
      --out data_cache/raw/mt5
"""
import _bootstrap  # noqa: F401
import argparse
from datetime import datetime, timezone

from data.storage import save_candles


def _date(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", nargs="+", required=True)
    ap.add_argument("--timeframes", nargs="+", default=["M5", "M15"])
    ap.add_argument("--start", type=_date, required=True)
    ap.add_argument("--end", type=_date, required=True)
    ap.add_argument("--out", default="data_cache/raw/mt5")
    ap.add_argument("--fmt", choices=["csv", "parquet"], default="csv")
    return ap.parse_args()


def main() -> int:
    args = parse_args()
    try:
        from data.mt5_feed import connect, fetch_symbol_timeframe
    except Exception as exc:  # pragma: no cover
        print(f"MT5 unavailable: {exc}")
        return 2

    try:
        mt5 = connect()
    except Exception as exc:  # pragma: no cover
        print(f"Could not connect to MT5: {exc}")
        print("Tip: run on a Windows VPS with MT5, or use make_synthetic_history.py.")
        return 2

    for symbol in args.symbols:
        for tf in args.timeframes:
            candles = fetch_symbol_timeframe(symbol, tf, args.start, args.end, mt5=mt5)
            path = save_candles(candles, args.out, symbol, tf, source="mt5", fmt=args.fmt)
            print(f"{symbol} {tf}: {len(candles)} candles saved -> {path}")
    print(f"Done. Files written to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
