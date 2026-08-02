"""Setup lifecycle state machine."""
from dataclasses import replace

from tests.fixtures.builders import (
    BULLISH_LIFECYCLE,
    EURUSD,
    TEST_CFG,
    UP_TO_SWEEP,
    mk,
    neutral_bars,
)

from signal_engine.setup import find_setup
from signal_engine.setup_state import advance_setup_state, initial_state


def _drive(candles, cfg=TEST_CFG, symbol="EURUSD"):
    """Feed candles one at a time (cumulative) and return (final_state, last_signal)."""
    state = initial_state(symbol)
    last_signal = None
    for k in range(1, len(candles) + 1):
        state, sig = find_setup(state, candles[:k], [], cfg, EURUSD)
        if sig is not None:
            last_signal = sig
    return state, last_signal


def test_full_valid_lifecycle_reaches_entry():
    state, signal = _drive(BULLISH_LIFECYCLE)
    assert state.stage == "entry_triggered"
    assert state.direction == "long"
    assert signal is not None
    assert signal.direction == "long"
    assert signal.entry == 1.1040
    assert abs(signal.planned_r - TEST_CFG.min_planned_r) < 1e-6
    assert signal.stop < signal.entry < signal.target


def test_sweep_found_after_up_to_sweep():
    state, _ = _drive(UP_TO_SWEEP)
    assert state.stage == "sweep_found"
    assert state.direction == "long"
    assert state.sweep is not None
    assert state.sweep.wick_price == 1.0995


def test_setup_expires_after_max_age():
    # Reach sweep_found, then feed > max_setup_age_bars bars with no maturation.
    candles = list(UP_TO_SWEEP) + neutral_bars(6, TEST_CFG.max_setup_age_bars + 1)
    state, _ = _drive(candles)
    assert state.stage == "expired"


def test_setup_invalidates_when_sweep_wick_reclaimed():
    # Advance to sweep_found directly, then a candle trades below the sweep wick.
    state = initial_state("EURUSD")
    for k in range(1, len(UP_TO_SWEEP) + 1):
        state = advance_setup_state(state, UP_TO_SWEEP[:k], [], TEST_CFG, EURUSD)
    assert state.stage == "sweep_found"

    breach = mk(6, 1.1000, 1.1002, 1.0990, 1.0998)  # low 1.0990 < wick 1.0995
    state = advance_setup_state(state, list(UP_TO_SWEEP) + [breach], [], TEST_CFG, EURUSD)
    assert state.stage == "invalidated"


def test_terminal_state_resets_and_rehunts():
    # From an invalidated state, find_setup should reset to idle and not crash.
    invalidated = replace(initial_state("EURUSD"), stage="invalidated")
    state, sig = find_setup(invalidated, UP_TO_SWEEP[:1], [], TEST_CFG, EURUSD)
    assert state.stage in ("idle", "sweep_found")
    assert sig is None
