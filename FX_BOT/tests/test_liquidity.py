"""Liquidity sweep detection."""
from datetime import timezone

from tests.fixtures.builders import BASE, EURUSD, mk

from domain.models import Level
from signal_engine.liquidity import detect_sweep

PIP = EURUSD.pip_size


def _level(price: float, kind: str = "swing") -> Level:
    return Level(name="lvl", price=price, kind=kind, created_at=BASE)


def test_bullish_sweep_below_level_closes_above():
    level = _level(1.1000)
    # low pokes to 1.0995, close reclaims to 1.1006
    candle = mk(0, 1.1010, 1.1012, 1.0995, 1.1006)
    sweep = detect_sweep([candle], [level], PIP, proximity_pips=20.0)
    assert sweep is not None
    assert sweep.direction == "long"
    assert sweep.wick_price == 1.0995
    assert sweep.close_price == 1.1006


def test_bearish_sweep_above_level_closes_below():
    level = _level(1.1000)
    candle = mk(0, 1.0990, 1.1005, 1.0988, 1.0994)
    sweep = detect_sweep([candle], [level], PIP, proximity_pips=20.0)
    assert sweep is not None
    assert sweep.direction == "short"
    assert sweep.wick_price == 1.1005
    assert sweep.close_price == 1.0994


def test_wick_poke_without_reclaim_is_not_a_sweep():
    level = _level(1.1000)
    # Whole body below the level; the low pokes lower but never reclaims above
    # -> a real breakdown, not a sweep.
    candle = mk(0, 1.0998, 1.0999, 1.0990, 1.0995)
    assert detect_sweep([candle], [level], PIP, proximity_pips=20.0) is None


def test_far_level_outside_proximity_ignored():
    level = _level(1.1000)
    # Close is 30 pips above the level; outside a 5-pip proximity window.
    candle = mk(0, 1.1010, 1.1032, 1.0999, 1.1030)
    assert detect_sweep([candle], [level], PIP, proximity_pips=5.0) is None
