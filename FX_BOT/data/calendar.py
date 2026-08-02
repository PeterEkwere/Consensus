"""High-impact news calendar (minimal CSV-backed implementation).

Introduced in Phase 2 because the prop simulator must be able to filter trades that
fall inside a news blackout. Phase 3 can later swap the CSV loader for a live API
without changing the ``is_news_blackout`` contract.

CSV schema: time (ISO-8601 UTC), currency, impact, title
"""
from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from domain.time_utils import ensure_utc


@dataclass(frozen=True)
class NewsEvent:
    time: datetime
    currency: str
    impact: str
    title: str


def load_news_events(path: str | Path) -> list[NewsEvent]:
    """Load high-impact events from a CSV cache. Missing file -> empty list."""
    p = Path(path)
    if not p.exists():
        return []
    events: list[NewsEvent] = []
    with p.open(newline="") as fh:
        for row in csv.DictReader(fh):
            events.append(
                NewsEvent(
                    time=ensure_utc(datetime.fromisoformat(row["time"])),
                    currency=row["currency"].strip().upper(),
                    impact=row.get("impact", "high").strip().lower(),
                    title=row.get("title", "").strip(),
                )
            )
    events.sort(key=lambda e: e.time)
    return events


def affected_currencies(symbol: str) -> tuple[str, str]:
    """Return (base, quote) currencies for a 6-letter FX symbol; best-effort for others."""
    if len(symbol) >= 6:
        return symbol[:3].upper(), symbol[3:6].upper()
    return symbol.upper(), ""


def is_news_blackout(symbol: str, now: datetime, events: list[NewsEvent], rules) -> bool:
    """True if a high-impact event affecting ``symbol`` is within the blackout window."""
    now = ensure_utc(now)
    base, quote = affected_currencies(symbol)
    before = timedelta(minutes=rules.news_blackout_minutes_before)
    after = timedelta(minutes=rules.news_blackout_minutes_after)
    for ev in events:
        if ev.impact != "high":
            continue
        if ev.currency not in (base, quote):
            continue
        if ev.time - before <= now <= ev.time + after:
            return True
    return False
