"""Core domain models — plain, frozen, hashable data objects.

Shared by the signal engine, backtester, and live scanner. Nothing here does I/O
or holds strategy logic; these are just the vocabulary of the system.

Time convention (important, and enforced by tests):
    ``Candle.time`` is the bar's OPEN timestamp, timezone-aware (UTC).
    A bar with open time ``t`` on an ``m``-minute timeframe is CLOSED at
    ``t + m`` minutes. "Closed candles only" therefore means every candle whose
    close time is at or before the decision timestamp. See ``domain.time_utils``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

from domain.enums import Direction, SetupStage, Trend  # noqa: F401 (re-exported)

__all__ = [
    "Direction",
    "Trend",
    "SetupStage",
    "Candle",
    "Swing",
    "BOS",
    "Level",
    "Sweep",
    "Rejection",
    "SetupState",
    "Signal",
    "Trade",
]


@dataclass(frozen=True)
class Candle:
    symbol: str
    timeframe: str
    time: datetime  # bar OPEN time, tz-aware UTC
    open: float
    high: float
    low: float
    close: float
    tick_volume: int = 0
    spread_points: int | None = None

    @property
    def body(self) -> float:
        return abs(self.close - self.open)

    @property
    def range(self) -> float:
        return self.high - self.low

    @property
    def upper_wick(self) -> float:
        return self.high - max(self.open, self.close)

    @property
    def lower_wick(self) -> float:
        return min(self.open, self.close) - self.low

    @property
    def is_bullish(self) -> bool:
        return self.close > self.open

    @property
    def is_bearish(self) -> bool:
        return self.close < self.open


@dataclass(frozen=True)
class Swing:
    time: datetime
    index: int
    kind: Literal["high", "low"]
    price: float
    confirmed_at: datetime  # timestamp of the candle that confirmed the fractal


@dataclass(frozen=True)
class BOS:
    time: datetime
    direction: Direction
    broken_swing: Swing
    close_price: float
    clean_break: bool


@dataclass(frozen=True)
class Level:
    name: str
    price: float
    kind: Literal[
        "session_high", "session_low", "day_high", "day_low",
        "round", "equal_high", "equal_low", "swing",
    ]
    created_at: datetime
    last_touched_at: datetime | None = None
    touches: int = 0
    freshness_score: float = 1.0


@dataclass(frozen=True)
class Sweep:
    time: datetime
    direction: Direction  # direction of the resulting reversal setup
    level: Level
    wick_price: float   # the extreme the wick reached beyond the level
    close_price: float  # where the sweeping candle reclaimed to
    reclaim_distance_pips: float


@dataclass(frozen=True)
class Rejection:
    time: datetime
    kind: Literal["pin", "engulfing"]
    direction: Direction
    strength: float


@dataclass(frozen=True)
class SetupState:
    symbol: str
    stage: SetupStage
    direction: Direction | None = None
    sweep: Sweep | None = None
    rejection: Rejection | None = None
    bos: BOS | None = None
    entry_level: float | None = None
    stop_price: float | None = None
    target_price: float | None = None
    created_at: datetime | None = None
    expires_at: datetime | None = None
    confluence: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class Signal:
    symbol: str
    direction: Direction
    timeframe: str
    signal_time: datetime
    entry: float
    stop: float
    target: float
    stop_pips: float
    planned_r: float
    confluence: dict[str, float]
    setup_state: SetupState


@dataclass(frozen=True)
class Trade:
    """A filled, closed trade produced by the backtest replay/fill model."""
    id: str
    symbol: str
    direction: Direction
    entry_time: datetime
    exit_time: datetime
    entry_price: float
    exit_price: float
    stop_price: float
    target_price: float
    lots: float
    gross_r: float
    net_r: float
    gross_pnl: float
    net_pnl: float
    exit_reason: Literal["stop", "target", "expired", "manual", "session_close"]
    confluence: dict[str, float] = field(default_factory=dict)
