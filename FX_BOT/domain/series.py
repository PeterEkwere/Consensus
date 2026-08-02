"""``CandleSeries`` — the lightweight, dependency-free candle container.

The architecture doc sketches detectors that take ``pandas.DataFrame``. Phase 1
deliberately uses this small immutable wrapper over ``tuple[Candle, ...]`` instead
so the core engine has ZERO third-party dependencies and is trivially
deterministic to test. The public surface (``highs``, ``lows``, ``closes``,
slicing, ``closed_by``) maps one-to-one onto the columns/filters the doc's
pandas code would have used, so the Phase-2 backtester can adapt without changing
strategy semantics.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Iterable, Iterator, Sequence, overload

from domain.models import Candle
from domain.time_utils import ensure_utc, is_closed_by


def pips_between(price_a: float, price_b: float, pip_size: float) -> float:
    """Absolute distance between two prices expressed in pips."""
    return abs(price_a - price_b) / pip_size


@dataclass(frozen=True)
class CandleSeries:
    """Immutable ordered sequence of candles for one symbol/timeframe."""

    candles: tuple[Candle, ...]

    # -- construction ---------------------------------------------------------
    @classmethod
    def from_iterable(cls, candles: Iterable[Candle]) -> "CandleSeries":
        ordered = tuple(sorted(candles, key=lambda c: ensure_utc(c.time)))
        return cls(ordered)

    # -- sequence protocol ----------------------------------------------------
    def __len__(self) -> int:
        return len(self.candles)

    def __iter__(self) -> Iterator[Candle]:
        return iter(self.candles)

    @overload
    def __getitem__(self, item: int) -> Candle: ...
    @overload
    def __getitem__(self, item: slice) -> "CandleSeries": ...

    def __getitem__(self, item):
        if isinstance(item, slice):
            return CandleSeries(self.candles[item])
        return self.candles[item]

    def is_empty(self) -> bool:
        return len(self.candles) == 0

    @property
    def last(self) -> Candle:
        return self.candles[-1]

    @property
    def first(self) -> Candle:
        return self.candles[0]

    # -- column accessors -----------------------------------------------------
    @property
    def opens(self) -> list[float]:
        return [c.open for c in self.candles]

    @property
    def highs(self) -> list[float]:
        return [c.high for c in self.candles]

    @property
    def lows(self) -> list[float]:
        return [c.low for c in self.candles]

    @property
    def closes(self) -> list[float]:
        return [c.close for c in self.candles]

    @property
    def times(self) -> list[datetime]:
        return [c.time for c in self.candles]

    # -- no-look-ahead filters ------------------------------------------------
    def closed_by(self, decision_time: datetime, timeframe: str | None = None) -> "CandleSeries":
        """Return only candles fully closed at or before ``decision_time``.

        This is the guard used to strip a still-forming candle before handing a
        series to a detector.
        """
        tf = timeframe
        kept = tuple(
            c for c in self.candles
            if is_closed_by(c.time, tf or c.timeframe, decision_time)
        )
        return CandleSeries(kept)

    def tail(self, n: int) -> "CandleSeries":
        return CandleSeries(self.candles[-n:]) if n > 0 else CandleSeries(())


def as_series(candles: Sequence[Candle] | CandleSeries) -> CandleSeries:
    """Coerce a list/tuple of candles or an existing series into a ``CandleSeries``."""
    if isinstance(candles, CandleSeries):
        return candles
    return CandleSeries(tuple(candles))
