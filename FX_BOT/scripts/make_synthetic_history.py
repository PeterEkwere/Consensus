#!/usr/bin/env python3
"""Generate synthetic candle history so the Phase-2 pipeline runs without MT5.

Example:
    python scripts/make_synthetic_history.py \
      --symbols EURUSD GBPUSD USDJPY XAUUSD \
      --start 2025-01-01 --end 2025-06-30 \
      --out data_cache/raw/mt5
"""
import _bootstrap  # noqa: F401
import argparse
from datetime import datetime, timezone
from pathlib import Path

from config.symbols import get_symbol_meta
from data.storage import save_candles
from data.synthetic import generate_candles, resample


def _date(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", nargs="+", default=["EURUSD", "GBPUSD", "USDJPY", "XAUUSD"])
    ap.add_argument("--ltf", default="M5")
    ap.add_argument("--htf", default="M15")
    ap.add_argument("--start", type=_date, default=_date("2025-01-01"))
    ap.add_argument("--end", type=_date, default=_date("2025-06-30"))
    ap.add_argument("--out", default="data_cache/raw/mt5")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    print(f"Synthetic history -> {args.out}  (DEMO DATA, not market data)")
    total = 0
    for symbol in args.symbols:
        meta = get_symbol_meta(symbol)
        m5 = generate_candles(symbol, args.ltf, args.start, args.end, meta.pip_size, seed=args.seed)
        htf = resample(m5, args.htf)
        p1 = save_candles(m5, args.out, symbol, args.ltf, source="synthetic")
        p2 = save_candles(htf, args.out, symbol, args.htf, source="synthetic")
        total += len(m5) + len(htf)
        print(f"  {symbol}: {len(m5)} {args.ltf} + {len(htf)} {args.htf}  -> {p1.parent}")
    print(f"Done. {total} candles written.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
