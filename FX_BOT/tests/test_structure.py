"""Structure detection: swings, trend, and break-of-structure."""
from tests.fixtures.builders import EURUSD, mk

from signal_engine.structure import break_of_structure, swing_points, trend_state


def _peak_series():
    # High shape 1,2,5,2,1 -> single swing high at index 2 (left=2,right=2).
    highs = [1.1010, 1.1020, 1.1050, 1.1020, 1.1010]
    return [mk(i, h - 0.0005, h, h - 0.0010, h - 0.0003) for i, h in enumerate(highs)]


def test_swing_high_detected():
    swings = swing_points(_peak_series(), left=2, right=2)
    highs = [s for s in swings if s.kind == "high"]
    assert len(highs) == 1
    assert highs[0].index == 2
    assert highs[0].price == 1.1050


def test_swing_low_detected():
    lows = [1.1050, 1.1040, 1.1010, 1.1040, 1.1050]
    candles = [mk(i, l + 0.0005, l + 0.0010, l, l + 0.0003) for i, l in enumerate(lows)]
    swings = [s for s in swing_points(candles, left=2, right=2) if s.kind == "low"]
    assert len(swings) == 1
    assert swings[0].index == 2
    assert swings[0].price == 1.1010


def test_trend_state_bull_and_bear():
    candles = _peak_series()
    swings = swing_points(candles, left=2, right=2)
    # Not enough alternating structure -> range by default.
    assert trend_state(swings) in ("bull", "bear", "range")


def test_bos_requires_close_not_wick():
    # Confirmed swing high at 1.1050 (index 2).
    candles = _peak_series()
    swings = swing_points(candles, left=2, right=2)

    # Wick-only break: high pierces 1.1050 but close stays below -> no BOS.
    wick_only = candles + [mk(5, 1.1030, 1.1060, 1.1029, 1.1045)]
    assert break_of_structure(wick_only, swings, "long", 0.5, EURUSD.pip_size) is None

    # Close-through break -> BOS.
    closed_through = candles + [mk(5, 1.1030, 1.1065, 1.1029, 1.1060)]
    bos = break_of_structure(closed_through, swings, "long", 0.5, EURUSD.pip_size)
    assert bos is not None
    assert bos.direction == "long"
    assert bos.broken_swing.price == 1.1050
