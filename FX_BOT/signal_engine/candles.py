"""Reversal candle classification: pin bars and engulfing candles.

Operates on the last CLOSED candle (and its predecessor for engulfing). Pure and
deterministic — given the same tail it always returns the same ``Rejection``.
"""
from __future__ import annotations

from typing import Sequence

from domain.enums import Direction
from domain.models import Candle, Rejection
from domain.series import CandleSeries, as_series


def classify_rejection(
    candles: Sequence[Candle] | CandleSeries,
    direction: Direction,
    cfg,
) -> Rejection | None:
    """Return a ``Rejection`` if the last candle rejects in ``direction``, else None.

    Pin bar (for a long reversal): a long LOWER wick.
      - lower wick >= ``cfg.pin_wick_body_ratio`` * body
      - close sits in the outer (upper) third of the candle range
    Engulfing (for a long reversal): current bullish body fully covers the prior
    body and closes upward. Mirror logic for short reversals.
    """
    s = as_series(candles)
    if len(s) < 1:
        return None
    c = s.last
    rng = c.range
    if rng <= 0:
        return None

    body = c.body
    ratio = cfg.pin_wick_body_ratio
    third = cfg.rejection_close_third

    if direction == "long":
        wick = c.lower_wick
        # close in the outer (upper) third of the range
        close_pos_ok = c.close >= c.low + (1 - third) * rng
        if body > 0 and wick >= ratio * body and close_pos_ok:
            return Rejection(time=c.time, kind="pin", direction="long", strength=wick / rng)
    else:
        wick = c.upper_wick
        close_pos_ok = c.close <= c.high - (1 - third) * rng
        if body > 0 and wick >= ratio * body and close_pos_ok:
            return Rejection(time=c.time, kind="pin", direction="short", strength=wick / rng)

    # Engulfing needs a previous candle.
    if len(s) >= 2:
        prev = s[-2]
        prev_hi = max(prev.open, prev.close)
        prev_lo = min(prev.open, prev.close)
        cur_hi = max(c.open, c.close)
        cur_lo = min(c.open, c.close)
        covers = cur_hi >= prev_hi and cur_lo <= prev_lo
        if direction == "long" and c.is_bullish and prev.is_bearish and covers:
            strength = (c.body / prev.body) if prev.body > 0 else 1.0
            return Rejection(time=c.time, kind="engulfing", direction="long", strength=strength)
        if direction == "short" and c.is_bearish and prev.is_bullish and covers:
            strength = (c.body / prev.body) if prev.body > 0 else 1.0
            return Rejection(time=c.time, kind="engulfing", direction="short", strength=strength)

    return None
