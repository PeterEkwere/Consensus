"""No-look-ahead guarantees: the single most important correctness property."""
from datetime import timedelta

from tests.fixtures.builders import BULLISH_LIFECYCLE, EURUSD, TEST_CFG, mk

from domain.time_utils import htf_closed_by
from signal_engine.setup import find_setup
from signal_engine.setup_state import initial_state
from signal_engine.structure import swing_points


def _peak_series():
    highs = [1.1010, 1.1020, 1.1050, 1.1020, 1.1010]
    return [mk(i, h - 0.0005, h, h - 0.0010, h - 0.0003) for i, h in enumerate(highs)]


def test_fractal_swing_respects_confirmation_delay():
    candles = _peak_series()  # swing high at index 2, left=right=2
    # Before the two right-side candles close, the swing is unknowable.
    assert swing_points(candles[:4], left=2, right=2) == []
    # Once index 4 exists, the swing appears and is confirmed at that candle.
    swings = swing_points(candles[:5], left=2, right=2)
    highs = [s for s in swings if s.kind == "high"]
    assert len(highs) == 1
    assert highs[0].index == 2
    assert highs[0].confirmed_at == candles[4].time


def test_find_setup_only_uses_supplied_candles():
    # Locality: evaluating over a prefix must equal evaluating over that same
    # prefix taken from a longer (future-containing) array. If the engine peeked
    # ahead, appending future candles then slicing back would change the result.
    cutoff = 6
    prefix = BULLISH_LIFECYCLE[:cutoff]
    full = BULLISH_LIFECYCLE

    state_a = initial_state("EURUSD")
    for k in range(1, cutoff + 1):
        state_a, _ = find_setup(state_a, prefix[:k], [], TEST_CFG, EURUSD)

    state_b = initial_state("EURUSD")
    for k in range(1, cutoff + 1):
        state_b, _ = find_setup(state_b, full[:k], [], TEST_CFG, EURUSD)

    assert state_a.stage == state_b.stage
    assert state_a.direction == state_b.direction


def test_htf_forming_candle_is_excluded():
    # Three M15 candles opening at 08:00, 08:15, 08:30.
    htf = [
        mk(0, 1.10, 1.11, 1.09, 1.105, tf="M15"),
        mk(3, 1.105, 1.115, 1.10, 1.11, tf="M15"),   # +15m
        mk(6, 1.11, 1.12, 1.105, 1.115, tf="M15"),   # +30m
    ]
    # Decide at 08:44 -> the 08:30 candle (closes 08:45) is still forming.
    decide = htf[2].time + timedelta(minutes=14)
    closed = htf_closed_by(htf, decide, 15)
    assert len(closed) == 2
    assert htf[2] not in closed

    # Decide at 08:45 -> the 08:30 candle has now closed.
    closed2 = htf_closed_by(htf, htf[2].time + timedelta(minutes=15), 15)
    assert len(closed2) == 3
