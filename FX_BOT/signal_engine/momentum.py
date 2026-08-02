"""Volatility / momentum filter: True Range, ATR, and an ATR-expansion ratio.

Scalping only works when the market is actually moving. ``momentum_ok`` gates
setups on current ATR being at least ``min_ratio`` times its recent mean.

Returns plain Python lists/floats (no pandas) to keep the engine dependency-free.
"""
from __future__ import annotations

from typing import Sequence

from domain.models import Candle
from domain.series import CandleSeries, as_series


def true_range(candles: Sequence[Candle] | CandleSeries) -> list[float]:
    """True Range series. The first bar uses high-low (no prior close)."""
    s = as_series(candles)
    tr: list[float] = []
    prev_close: float | None = None
    for c in s:
        if prev_close is None:
            tr.append(c.high - c.low)
        else:
            tr.append(max(c.high - c.low, abs(c.high - prev_close), abs(c.low - prev_close)))
        prev_close = c.close
    return tr


def atr(candles: Sequence[Candle] | CandleSeries, period: int) -> list[float]:
    """Simple-moving-average ATR aligned to the input candles.

    Positions before ``period`` bars are filled with the running average so the
    series length matches the candle count.
    """
    tr = true_range(candles)
    out: list[float] = []
    for i in range(len(tr)):
        window = tr[max(0, i - period + 1): i + 1]
        out.append(sum(window) / len(window))
    return out


def momentum_score(candles: Sequence[Candle] | CandleSeries, period: int, lookback: int) -> float:
    """Latest ATR divided by the mean ATR over the recent ``lookback`` window."""
    a = atr(candles, period)
    if not a:
        return 0.0
    window = a[-lookback:] if lookback > 0 else a
    mean = sum(window) / len(window)
    if mean == 0:
        return 0.0
    return a[-1] / mean


def momentum_ok(
    candles: Sequence[Candle] | CandleSeries,
    period: int,
    lookback: int,
    min_ratio: float,
) -> bool:
    """True when the ATR-expansion ratio clears the configured threshold."""
    return momentum_score(candles, period, lookback) >= min_ratio
