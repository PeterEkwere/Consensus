"""Timezone-aware time helpers and the no-look-ahead candle-closure rules.

The single most dangerous class of bug in a backtest is look-ahead: letting a
detector peek at a candle that had not actually closed at the decision moment.
The helpers here centralise that rule so both the live scanner and the backtest
replay use identical closure semantics.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Sequence

# Minutes per MT5-style timeframe label.
TIMEFRAME_MINUTES: dict[str, int] = {
    "M1": 1, "M2": 2, "M3": 3, "M5": 5, "M10": 10, "M15": 15, "M20": 20,
    "M30": 30, "H1": 60, "H2": 120, "H4": 240, "H6": 360, "H8": 480,
    "H12": 720, "D1": 1440, "W1": 10080,
}


def timeframe_minutes(timeframe: str) -> int:
    """Return the number of minutes in a timeframe label (e.g. ``"M5"`` -> 5)."""
    try:
        return TIMEFRAME_MINUTES[timeframe.upper()]
    except KeyError as exc:  # pragma: no cover - defensive
        raise ValueError(f"Unknown timeframe: {timeframe!r}") from exc


def ensure_utc(dt: datetime) -> datetime:
    """Return a tz-aware UTC datetime. Naive datetimes are assumed to be UTC."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def utc_now() -> datetime:
    """Current time, tz-aware UTC."""
    return datetime.now(timezone.utc)


def close_time(open_time: datetime, timeframe: str) -> datetime:
    """Close timestamp of a bar given its open time and timeframe."""
    return ensure_utc(open_time) + timedelta(minutes=timeframe_minutes(timeframe))


def is_closed_by(open_time: datetime, timeframe: str, decision_time: datetime) -> bool:
    """True when a bar opened at ``open_time`` has fully closed by ``decision_time``."""
    return close_time(open_time, timeframe) <= ensure_utc(decision_time)


def htf_closed_by(
    htf_candles: Sequence,
    current_ltf_time: datetime,
    htf_minutes: int,
) -> list:
    """Return only higher-timeframe candles fully closed by the LTF decision time.

    ``current_ltf_time`` is the OPEN time of the lower-timeframe candle currently
    being decided on. A HTF candle is usable only if it closed at or before that
    moment, i.e. ``htf_open + htf_minutes <= current_ltf_time``. This is the guard
    that stops a still-forming 15m candle from leaking into a 5m decision.

    Kept here (rather than in ``backtest/``) because Phase-1 look-ahead tests and
    the live scanner both rely on it.
    """
    decision = ensure_utc(current_ltf_time)
    out = []
    for c in htf_candles:
        if ensure_utc(c.time) + timedelta(minutes=htf_minutes) <= decision:
            out.append(c)
    return out


def floor_to_timeframe(dt: datetime, timeframe: str) -> datetime:
    """Floor a timestamp down to the start of its timeframe bucket (UTC)."""
    dt = ensure_utc(dt)
    minutes = timeframe_minutes(timeframe)
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    total_min = int((dt - epoch).total_seconds() // 60)
    floored = (total_min // minutes) * minutes
    return epoch + timedelta(minutes=floored)


# --- Trading sessions (UTC hour windows; approximate, DST not modelled) --------
# Used by config.strategy_profiles allowed_sessions and levels.session_levels.
SESSION_WINDOWS_UTC: dict[str, tuple[int, int]] = {
    "asia": (0, 8),
    "london_open": (7, 10),
    "london": (7, 16),
    "ny_open": (12, 15),
    "london_ny_overlap": (12, 16),
    "new_york": (12, 21),
}


def in_session(dt: datetime, session: str) -> bool:
    """True when ``dt`` (UTC) falls within the named session window."""
    dt = ensure_utc(dt)
    if session not in SESSION_WINDOWS_UTC:
        raise ValueError(f"Unknown session: {session!r}")
    start, end = SESSION_WINDOWS_UTC[session]
    return start <= dt.hour < end
