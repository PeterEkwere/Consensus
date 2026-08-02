"""Historical data validation.

Catches the data-quality problems that silently corrupt a backtest: invalid OHLC,
duplicate/gap/unordered timestamps, and missing or extreme spreads.
"""
from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import Sequence

from domain.models import Candle
from domain.time_utils import ensure_utc, timeframe_minutes


def validate_ohlc(candles: Sequence[Candle]) -> list[str]:
    """Return errors for structurally invalid OHLC rows."""
    errors: list[str] = []
    for i, c in enumerate(candles):
        hi, lo = c.high, c.low
        if hi < lo:
            errors.append(f"row {i} {c.time}: high {hi} < low {lo}")
        if not (lo <= c.open <= hi):
            errors.append(f"row {i} {c.time}: open {c.open} outside [{lo}, {hi}]")
        if not (lo <= c.close <= hi):
            errors.append(f"row {i} {c.time}: close {c.close} outside [{lo}, {hi}]")
        if any(v <= 0 for v in (c.open, c.high, c.low, c.close)):
            errors.append(f"row {i} {c.time}: non-positive price")
    return errors


def validate_time_index(candles: Sequence[Candle], timeframe: str) -> list[str]:
    """Return duplicate, ordering, and gap errors for the timestamp index."""
    errors: list[str] = []
    if not candles:
        return ["empty series"]
    step = timedelta(minutes=timeframe_minutes(timeframe))
    prev = None
    seen = set()
    for c in candles:
        t = ensure_utc(c.time)
        if t in seen:
            errors.append(f"duplicate timestamp {t}")
        seen.add(t)
        if prev is not None:
            if t < prev:
                errors.append(f"non-monotonic timestamp {t} after {prev}")
            else:
                gap = t - prev
                # Flag gaps larger than a step, ignoring normal weekend breaks.
                if gap > step and gap < timedelta(days=2):
                    missing = int(gap / step) - 1
                    if missing > 0:
                        errors.append(f"gap of {missing} bar(s) between {prev} and {t}")
        prev = t
    return errors


def validate_spread(candles: Sequence[Candle], symbol_meta) -> list[str]:
    """Flag missing or implausibly large spread observations."""
    errors: list[str] = []
    missing = sum(1 for c in candles if c.spread_points is None)
    if missing:
        errors.append(f"{missing}/{len(candles)} bars missing spread_points")
    # Extreme spread: > 20x the typical spread for the symbol.
    limit_points = symbol_meta.typical_spread_pips * (symbol_meta.pip_size / symbol_meta.point_size) * 20
    for c in candles:
        if c.spread_points is not None and c.spread_points > limit_points:
            errors.append(f"{c.time}: extreme spread {c.spread_points} pts (> {limit_points:.0f})")
    return errors


def build_validation_report(
    data_dir: str | Path,
    symbols: list[str],
    timeframes: Sequence[str],
    symbol_meta_lookup,
) -> list[dict]:
    """Return one summary row per symbol/timeframe found under ``data_dir``."""
    from data.storage import DataStore  # local import to avoid cycles

    store = DataStore(data_dir)
    rows: list[dict] = []
    for symbol in symbols:
        meta = symbol_meta_lookup(symbol)
        for tf in timeframes:
            if not store.has(symbol, tf):
                rows.append({"symbol": symbol, "timeframe": tf, "bars": 0,
                             "ohlc_errors": 0, "time_errors": 0, "spread_errors": 0,
                             "status": "MISSING"})
                continue
            candles = store.load(symbol, tf)
            ohlc = validate_ohlc(candles)
            time_err = validate_time_index(candles, tf)
            spread = validate_spread(candles, meta)
            too_few = len(candles) < 200
            status = "OK"
            if ohlc or any("non-monotonic" in e or "duplicate" in e for e in time_err):
                status = "FAIL"
            elif too_few:
                status = "THIN"
            elif time_err or spread:
                status = "WARN"
            rows.append({
                "symbol": symbol, "timeframe": tf, "bars": len(candles),
                "ohlc_errors": len(ohlc), "time_errors": len(time_err),
                "spread_errors": len(spread), "status": status,
            })
    return rows
