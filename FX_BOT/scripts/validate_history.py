#!/usr/bin/env python3
"""Validate cached candle history and print a per-symbol/timeframe report.

Example:
    python scripts/validate_history.py --data data_cache/raw/mt5 \
      --symbols EURUSD GBPUSD USDJPY XAUUSD --timeframes M5 M15
"""
import _bootstrap  # noqa: F401
import argparse

from config.symbols import get_symbol_meta
from data.validation import build_validation_report


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data_cache/raw/mt5")
    ap.add_argument("--symbols", nargs="+", required=True)
    ap.add_argument("--timeframes", nargs="+", default=["M5", "M15"])
    args = ap.parse_args()

    rows = build_validation_report(args.data, args.symbols, args.timeframes, get_symbol_meta)

    print(f"Validation report: {args.data}\n")
    header = f"{'symbol':<8} {'tf':<5} {'bars':>8} {'ohlc':>6} {'time':>6} {'spread':>7}  status"
    print(header)
    print("-" * len(header))
    any_fail = False
    for r in rows:
        if r["status"] in ("FAIL", "MISSING"):
            any_fail = True
        print(f"{r['symbol']:<8} {r['timeframe']:<5} {r['bars']:>8} {r['ohlc_errors']:>6} "
              f"{r['time_errors']:>6} {r['spread_errors']:>7}  {r['status']}")
    print()
    print("Legend: OK / THIN (few bars) / WARN (gaps or spread) / FAIL (bad OHLC/time) / MISSING")
    return 1 if any_fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
