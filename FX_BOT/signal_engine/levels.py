"""Key level construction: prior-day, session, round-number, equal-highs/lows.

Levels are the liquidity pools the sweep detector hunts. Everything here uses only
completed periods (previous day, closed sessions) to stay look-ahead-safe.
"""
from __future__ import annotations

from datetime import datetime
from typing import Sequence

from domain.models import Candle, Level
from domain.series import CandleSeries, as_series
from domain.time_utils import ensure_utc, in_session


def prior_day_levels(htf_candles: Sequence[Candle] | CandleSeries) -> list[Level]:
    """Previous completed calendar day's high and low (UTC day buckets)."""
    s = as_series(htf_candles)
    if s.is_empty():
        return []
    by_day: dict[str, list[Candle]] = {}
    for c in s:
        key = ensure_utc(c.time).strftime("%Y-%m-%d")
        by_day.setdefault(key, []).append(c)
    days = sorted(by_day)
    if len(days) < 2:
        return []
    prev = by_day[days[-2]]  # the last *completed* day
    hi = max(prev, key=lambda c: c.high)
    lo = min(prev, key=lambda c: c.low)
    created = ensure_utc(prev[-1].time)
    return [
        Level(name="prev_day_high", price=hi.high, kind="day_high", created_at=created),
        Level(name="prev_day_low", price=lo.low, kind="day_low", created_at=created),
    ]


def session_levels(
    ltf_candles: Sequence[Candle] | CandleSeries,
    session_tz: str = "UTC",
) -> list[Level]:
    """Highs/lows of the most recent completed London / New York / Asia sessions.

    ``session_tz`` is accepted for interface compatibility; windows are evaluated
    in UTC (see ``domain.time_utils.SESSION_WINDOWS_UTC``).
    """
    s = as_series(ltf_candles)
    levels: list[Level] = []
    for session in ("asia", "london", "new_york"):
        members = [c for c in s if in_session(c.time, session)]
        if not members:
            continue
        hi = max(members, key=lambda c: c.high)
        lo = min(members, key=lambda c: c.low)
        created = ensure_utc(members[-1].time)
        levels.append(Level(name=f"{session}_high", price=hi.high, kind="session_high", created_at=created))
        levels.append(Level(name=f"{session}_low", price=lo.low, kind="session_low", created_at=created))
    return levels


def round_number_levels(
    current_price: float,
    pip_size: float,
    step_pips: int,
    bands: int = 5,
    now: datetime | None = None,
) -> list[Level]:
    """Psychological round-number levels stepped around the current price."""
    step = step_pips * pip_size
    if step <= 0:
        return []
    base = round(current_price / step) * step
    created = ensure_utc(now) if now else ensure_utc(datetime.utcnow())
    levels: list[Level] = []
    for k in range(-bands, bands + 1):
        price = base + k * step
        if price <= 0:
            continue
        levels.append(
            Level(name=f"round_{price:.5f}", price=round(price, 8), kind="round", created_at=created)
        )
    return levels


def equal_high_low_levels(
    candles: Sequence[Candle] | CandleSeries,
    pip_size: float,
    tolerance_pips: float,
) -> list[Level]:
    """Highs/lows revisited at least twice within ``tolerance_pips`` (equal liquidity)."""
    s = as_series(candles)
    tol = tolerance_pips * pip_size
    levels: list[Level] = []

    def cluster(values: list[tuple[float, Candle]], kind: str, name: str) -> None:
        used = [False] * len(values)
        for i in range(len(values)):
            if used[i]:
                continue
            price_i, cand_i = values[i]
            group = [(price_i, cand_i)]
            for j in range(i + 1, len(values)):
                if used[j]:
                    continue
                if abs(values[j][0] - price_i) <= tol:
                    used[j] = True
                    group.append(values[j])
            if len(group) >= 2:
                avg = sum(p for p, _ in group) / len(group)
                last_cand = max(group, key=lambda pc: ensure_utc(pc[1].time))[1]
                levels.append(
                    Level(
                        name=name,
                        price=round(avg, 8),
                        kind=kind,  # type: ignore[arg-type]
                        created_at=ensure_utc(last_cand.time),
                        touches=len(group),
                    )
                )

    cluster([(c.high, c) for c in s], "equal_high", "equal_high")
    cluster([(c.low, c) for c in s], "equal_low", "equal_low")
    return levels


def swing_derived_levels(
    ltf_candles: Sequence[Candle] | CandleSeries,
    cfg,
) -> list[Level]:
    """Confirmed swing highs/lows as tradable liquidity levels."""
    # Imported lazily to avoid a circular import with structure.py.
    from signal_engine.structure import swing_points

    s = as_series(ltf_candles)
    levels: list[Level] = []
    for sw in swing_points(s, cfg.swing_left, cfg.swing_right):
        levels.append(
            Level(
                name=f"swing_{sw.kind}_{sw.index}",
                price=sw.price,
                kind="swing",
                created_at=ensure_utc(sw.confirmed_at),
            )
        )
    return levels


def key_levels(
    ltf_candles: Sequence[Candle] | CandleSeries,
    htf_candles: Sequence[Candle] | CandleSeries,
    pip_size: float,
    cfg,
) -> list[Level]:
    """Combine prior-day, session, round-number, equal-high/low and swing levels."""
    ltf = as_series(ltf_candles)
    levels: list[Level] = []
    levels.extend(prior_day_levels(htf_candles))
    levels.extend(session_levels(ltf))
    levels.extend(
        equal_high_low_levels(ltf, pip_size, cfg.equal_level_tolerance_pips)
    )
    levels.extend(swing_derived_levels(ltf, cfg))
    if not ltf.is_empty():
        levels.extend(
            round_number_levels(
                ltf.last.close, pip_size, step_pips=50, bands=4, now=ltf.last.time
            )
        )
    return levels
