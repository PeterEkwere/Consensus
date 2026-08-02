"""Synthetic history generator (DEMO ONLY).

MT5 is Windows-only and unavailable here, so this module fabricates candle history
that deterministically contains the SMC reversal motif the engine detects
(sweep -> rejection -> BOS -> retest -> entry -> resolve). It exists solely to run
the full Phase-2 pipeline end-to-end and produce reports. It is NOT market data and
proves nothing about the strategy's real edge.
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta

from domain.models import Candle
from domain.time_utils import ensure_utc, floor_to_timeframe, timeframe_minutes

# Bullish motif as (open, high, low, close) offsets in PIPS from a running base.
# Indices mirror the Phase-1 lifecycle: swing high @2, swing low @6, sweep @9,
# engulfing @10, BOS @11, retest/entry @13. Verified against the state machine.
_BULL_CORE = [
    (20, 22, 18, 21),
    (21, 24, 20, 22),
    (22, 40, 21, 38),   # swing high H = +40
    (38, 39, 20, 22),
    (22, 23, 18, 19),
    (19, 20, 9, 11),
    (11, 12, 0, 1),     # swing low L = 0
    (2, 9, 1, 8),       # open kept >= low (valid OHLC)
    (8, 13, 7, 12),
    (12, 13, -5, 3),    # SWEEP: wick -5, close +3 (within proximity of L)
    (2, 15, 1, 12),     # bullish ENGULFING
    (12, 45, 11, 43),   # BOS: close +43 > H +40  (entry_level +40)
    (43, 46, 38, 42),   # bos_confirmed -> waiting_retest
    (42, 43, 39, 41),   # RETEST: low +39 <= entry +40
]
_BULL_WIN = (41, 135, 40, 130)   # high +135 >= target ~+131
_BULL_LOSS = (41, 42, -6, -5)    # low -6 <= stop ~-5.5


def _mirror(delta: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """Mirror a bullish (o,h,l,c) offset into a bearish one around the base."""
    o, h, l, c = delta
    return (-o, -l, -h, -c)  # swap/negate high<->low to keep high >= low


def _build_motif(base: float, pip: float, direction: str, outcome: str):
    core = _BULL_CORE + [_BULL_WIN if outcome == "win" else _BULL_LOSS]
    if direction == "short":
        core = [_mirror(d) for d in core]
    return [(base + o * pip, base + h * pip, base + l * pip, base + c * pip) for (o, h, l, c) in core]


_START_PRICE = {"EURUSD": 1.10000, "GBPUSD": 1.27000, "USDJPY": 150.000, "XAUUSD": 2000.00}


def generate_candles(
    symbol: str,
    timeframe: str,
    start: datetime,
    end: datetime,
    pip_size: float,
    seed: int = 7,
    win_prob: float = 0.45,
) -> list[Candle]:
    """Generate M-timeframe candles for one symbol across [start, end)."""
    rng = random.Random(f"{seed}-{symbol}")
    step = timedelta(minutes=timeframe_minutes(timeframe))
    start_price = _START_PRICE.get(symbol, 1.0)
    base = start_price
    t = floor_to_timeframe(ensure_utc(start), timeframe)
    end = ensure_utc(end)

    candles: list[Candle] = []
    while t < end:
        direction = "long" if rng.random() < 0.5 else "short"
        outcome = "win" if rng.random() < win_prob else "loss"
        for (o, h, l, c) in _build_motif(base, pip_size, direction, outcome):
            if t >= end:
                break
            candles.append(Candle(symbol, timeframe, t, round(o, 5), round(h, 5),
                                  round(l, 5), round(c, 5), tick_volume=rng.randint(50, 500),
                                  spread_points=8))
            t += step
        # advance base to last close; gently mean-revert to keep prices realistic
        if candles:
            base = candles[-1].close
        if abs(base - start_price) > 300 * pip_size:
            base = start_price
        # a few flat filler bars between motifs
        for _ in range(3):
            if t >= end:
                break
            jitter = rng.uniform(-1, 1) * pip_size
            o = base
            c = base + jitter
            candles.append(Candle(symbol, timeframe, t, round(o, 5), round(max(o, c) + pip_size, 5),
                                  round(min(o, c) - pip_size, 5), round(c, 5),
                                  tick_volume=rng.randint(50, 200), spread_points=8))
            t += step
            base = c
    return candles


def resample(m5: list[Candle], target_tf: str) -> list[Candle]:
    """Aggregate M5 candles into a higher timeframe (e.g. M15) by time bucket."""
    if not m5:
        return []
    symbol = m5[0].symbol
    buckets: dict[datetime, list[Candle]] = {}
    for c in m5:
        key = floor_to_timeframe(c.time, target_tf)
        buckets.setdefault(key, []).append(c)
    out: list[Candle] = []
    for key in sorted(buckets):
        group = sorted(buckets[key], key=lambda c: c.time)
        out.append(Candle(
            symbol=symbol, timeframe=target_tf, time=key,
            open=group[0].open,
            high=max(c.high for c in group),
            low=min(c.low for c in group),
            close=group[-1].close,
            tick_volume=sum(c.tick_volume for c in group),
            spread_points=group[0].spread_points,
        ))
    return out
