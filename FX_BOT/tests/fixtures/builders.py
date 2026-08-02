"""Deterministic candle builders and canned scenarios for Phase 1 tests."""
from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone

from config.strategy_profiles import get_strategy
from config.symbols import get_symbol_meta
from domain.models import Candle

BASE = datetime(2025, 1, 6, 8, 0, tzinfo=timezone.utc)  # Monday, London session

# EURUSD, generous proximity so hand-built prices are not fragile; 1-bar fractals
# keep synthetic scenarios short.
TEST_CFG = dataclasses.replace(
    get_strategy(),
    swing_left=1,
    swing_right=1,
    level_proximity_pips=20.0,
    max_setup_age_bars=12,
    min_planned_r=2.0,
    bos_min_close_buffer_pips=0.5,
)
EURUSD = get_symbol_meta("EURUSD")


def mk(i: int, o: float, h: float, l: float, c: float, *, symbol: str = "EURUSD",
       tf: str = "M5", vol: int = 100) -> Candle:
    """Build a candle at bar-index ``i`` (5-minute spacing from BASE)."""
    return Candle(
        symbol=symbol,
        timeframe=tf,
        time=BASE + timedelta(minutes=5 * i),
        open=o, high=h, low=l, close=c,
        tick_volume=vol,
    )


# --- Full valid bullish lifecycle -------------------------------------------
# sweep of a swing low -> engulfing rejection -> BOS above a swing high ->
# retest -> entry. Verified by hand in the state-machine design notes.
BULLISH_LIFECYCLE = [
    mk(0, 1.1030, 1.1035, 1.1028, 1.1030),
    mk(1, 1.1030, 1.1040, 1.1029, 1.1038),  # swing high H=1.1040 (conf @2)
    mk(2, 1.1038, 1.1039, 1.1020, 1.1022),
    mk(3, 1.1022, 1.1024, 1.1000, 1.1004),  # swing low L=1.1000 (conf @4)
    mk(4, 1.1004, 1.1012, 1.1002, 1.1010),
    mk(5, 1.1010, 1.1012, 1.0995, 1.1006),  # SWEEP of 1.1000, wick 1.0995
    mk(6, 1.1005, 1.1020, 1.1004, 1.1012),  # bullish ENGULFING rejection
    mk(7, 1.1012, 1.1045, 1.1011, 1.1043),  # BOS: close 1.1043 > H 1.1040
    mk(8, 1.1043, 1.1046, 1.1038, 1.1042),  # bos_confirmed -> waiting_retest
    mk(9, 1.1042, 1.1043, 1.1039, 1.1041),  # RETEST low 1.1039 <= entry 1.1040
]

# Candles 0..5 alone advance idle -> sweep_found.
UP_TO_SWEEP = BULLISH_LIFECYCLE[:6]


def neutral_bars(start_index: int, count: int) -> list[Candle]:
    """Small bearish candles that never form a rejection and never breach 1.0995."""
    return [
        mk(start_index + k, 1.1008, 1.1010, 1.1006, 1.1007)
        for k in range(count)
    ]
