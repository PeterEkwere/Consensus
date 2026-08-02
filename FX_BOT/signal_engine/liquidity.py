"""Liquidity sweep detection.

A sweep is the first ingredient of the reversal setup: price pokes THROUGH a key
level to grab stops, then closes back on the original side. The direction of the
sweep is the direction of the resulting reversal setup.
"""
from __future__ import annotations

from typing import Sequence

from domain.models import Candle, Level, Sweep
from domain.series import CandleSeries, as_series, pips_between


def detect_sweep(
    candles: Sequence[Candle] | CandleSeries,
    levels: list[Level],
    pip_size: float,
    proximity_pips: float,
) -> Sweep | None:
    """Detect a liquidity sweep on the LAST closed candle.

    Bullish reversal (direction "long"): the candle's LOW pokes below a level but
    the candle CLOSES back above it. Bearish reversal (direction "short"): the
    HIGH pokes above a level but the candle CLOSES back below it.

    Only levels within ``proximity_pips`` of the candle close are considered. When
    several levels qualify, the one swept furthest (largest reclaim distance) wins.
    """
    s = as_series(candles)
    if s.is_empty() or not levels:
        return None
    c = s.last
    body_low = min(c.open, c.close)
    body_high = max(c.open, c.close)
    best: Sweep | None = None
    best_reclaim = -1.0

    for level in levels:
        # Bullish sweep: the LOWER WICK pierces the level and the body reclaims
        # above it. Requiring the level to sit at/below the body (not inside it)
        # rejects plain breakdown candles that merely close through a level.
        if c.low < level.price <= body_low and c.close > level.price:
            if pips_between(c.close, level.price, pip_size) > proximity_pips:
                continue
            reclaim = pips_between(c.close, c.low, pip_size)
            if reclaim > best_reclaim:
                best_reclaim = reclaim
                best = Sweep(
                    time=c.time,
                    direction="long",
                    level=level,
                    wick_price=c.low,
                    close_price=c.close,
                    reclaim_distance_pips=reclaim,
                )
        # Bearish sweep: the UPPER WICK pierces the level, body closes back below.
        elif c.high > level.price >= body_high and c.close < level.price:
            if pips_between(c.close, level.price, pip_size) > proximity_pips:
                continue
            reclaim = pips_between(c.high, c.close, pip_size)
            if reclaim > best_reclaim:
                best_reclaim = reclaim
                best = Sweep(
                    time=c.time,
                    direction="short",
                    level=level,
                    wick_price=c.high,
                    close_price=c.close,
                    reclaim_distance_pips=reclaim,
                )
    return best
