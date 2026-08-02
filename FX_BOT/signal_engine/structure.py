"""Market structure: fractal swings, trend state, and break-of-structure.

Look-ahead safety lives here. A fractal swing at index ``i`` is only KNOWN after
``right`` further candles have closed, so ``swing_points`` never returns a swing
whose confirmation candle is not present in the supplied data.
"""
from __future__ import annotations

from typing import Sequence

from domain.enums import Direction, Trend
from domain.models import BOS, Candle, Swing
from domain.series import CandleSeries, as_series


def swing_points(
    candles: Sequence[Candle] | CandleSeries,
    left: int = 2,
    right: int = 2,
) -> list[Swing]:
    """Return CONFIRMED fractal swing highs and lows only.

    A swing high at index ``i`` requires ``high[i]`` to be strictly greater than
    the ``left`` highs before it and the ``right`` highs after it. It is not
    confirmed — and therefore not returned — until candle ``i + right`` exists in
    the data. ``Swing.confirmed_at`` is the timestamp of that confirmation candle.
    """
    s = as_series(candles)
    n = len(s)
    swings: list[Swing] = []
    if n < left + right + 1:
        return swings

    highs = s.highs
    lows = s.lows
    # Only indices with `right` candles after them can be confirmed.
    for i in range(left, n - right):
        window_l = range(i - left, i)
        window_r = range(i + 1, i + right + 1)

        is_high = all(highs[i] > highs[j] for j in window_l) and all(
            highs[i] > highs[j] for j in window_r
        )
        if is_high:
            swings.append(
                Swing(
                    time=s[i].time,
                    index=i,
                    kind="high",
                    price=highs[i],
                    confirmed_at=s[i + right].time,
                )
            )
            continue

        is_low = all(lows[i] < lows[j] for j in window_l) and all(
            lows[i] < lows[j] for j in window_r
        )
        if is_low:
            swings.append(
                Swing(
                    time=s[i].time,
                    index=i,
                    kind="low",
                    price=lows[i],
                    confirmed_at=s[i + right].time,
                )
            )
    return swings


def trend_state(swings: list[Swing], min_pairs: int = 2) -> Trend:
    """Classify trend from the sequence of confirmed swings.

    bull: the most recent highs are rising AND the most recent lows are rising.
    bear: the most recent highs are falling AND the most recent lows are falling.
    range: anything else (or insufficient data).
    """
    highs = [sw.price for sw in swings if sw.kind == "high"]
    lows = [sw.price for sw in swings if sw.kind == "low"]
    if len(highs) < min_pairs or len(lows) < min_pairs:
        return "range"

    rh = highs[-min_pairs:]
    rl = lows[-min_pairs:]
    rising_highs = all(rh[k] > rh[k - 1] for k in range(1, len(rh)))
    rising_lows = all(rl[k] > rl[k - 1] for k in range(1, len(rl)))
    falling_highs = all(rh[k] < rh[k - 1] for k in range(1, len(rh)))
    falling_lows = all(rl[k] < rl[k - 1] for k in range(1, len(rl)))

    if rising_highs and rising_lows:
        return "bull"
    if falling_highs and falling_lows:
        return "bear"
    return "range"


def break_of_structure(
    candles: Sequence[Candle] | CandleSeries,
    swings: list[Swing],
    direction: Direction,
    min_close_buffer_pips: float,
    pip_size: float,
) -> BOS | None:
    """Detect a break of structure confirmed by the last CLOSED candle.

    Bullish BOS: the last candle CLOSES above the most recent confirmed swing
    high (plus a pip buffer). Bearish BOS: the last candle closes below the most
    recent confirmed swing low. Wick-only breaks do not count — only the close.
    """
    s = as_series(candles)
    if s.is_empty():
        return None
    last = s.last
    buffer_price = min_close_buffer_pips * pip_size

    if direction == "long":
        highs = [sw for sw in swings if sw.kind == "high" and sw.confirmed_at < last.time]
        if not highs:
            return None
        target = max(highs, key=lambda sw: sw.time)  # most recent confirmed swing high
        if last.close > target.price + buffer_price:
            clean = last.close - target.price >= 2 * buffer_price
            return BOS(
                time=last.time,
                direction="long",
                broken_swing=target,
                close_price=last.close,
                clean_break=clean,
            )
        return None

    lows = [sw for sw in swings if sw.kind == "low" and sw.confirmed_at < last.time]
    if not lows:
        return None
    target = max(lows, key=lambda sw: sw.time)
    if last.close < target.price - buffer_price:
        clean = target.price - last.close >= 2 * buffer_price
        return BOS(
            time=last.time,
            direction="short",
            broken_swing=target,
            close_price=last.close,
            clean_break=clean,
        )
    return None
