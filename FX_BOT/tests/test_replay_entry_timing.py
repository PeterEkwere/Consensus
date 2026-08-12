"""Replay entry timing: a signal found at a candle's close cannot fill in it.

``find_setup`` only sees candles up to and including candle ``i``, and it only
returns a signal once candle ``i`` has closed. Filling an entry inside candle
``i`` therefore uses information that did not exist when the decision was made.
The replay must queue the signal and treat candle ``i+1`` as the first candle
that may fill it.
"""
from datetime import timedelta

from tests.fixtures.builders import BULLISH_LIFECYCLE, EURUSD, TEST_CFG, mk

from backtest.costs import CostConfig
from backtest.replay import ReplayConfig, replay_symbol
from domain.time_utils import ensure_utc
from signal_engine.setup import find_setup
from signal_engine.setup_state import initial_state

COST = CostConfig()

# The canned lifecycle emits its long signal when candle index 9 closes.
SIGNAL_INDEX = 9
ENTRY = 1.1040


def _replay_cfg() -> ReplayConfig:
    return ReplayConfig(
        symbols=["EURUSD"],
        ltf="M5",
        htf="M15",
        start=BULLISH_LIFECYCLE[0].time,
        end=BULLISH_LIFECYCLE[-1].time + timedelta(days=1),
        risk_pct=0.005,
        initial_balance=100_000.0,
    )


def _run(candles):
    return replay_symbol("EURUSD", candles, [], TEST_CFG, EURUSD, COST, _replay_cfg())


def test_signal_is_emitted_on_the_expected_candle():
    """Guard the fixture: the rest of this module depends on this index."""
    state = initial_state("EURUSD")
    emitted_at = None
    for k in range(1, len(BULLISH_LIFECYCLE) + 1):
        state, signal = find_setup(state, BULLISH_LIFECYCLE[:k], [], TEST_CFG, EURUSD)
        if signal is not None:
            emitted_at = k - 1
            break
    assert emitted_at == SIGNAL_INDEX
    # The trigger candle trades through the entry, which is exactly why filling
    # inside it looks plausible and is nevertheless look-ahead.
    trigger = BULLISH_LIFECYCLE[SIGNAL_INDEX]
    assert trigger.low <= ENTRY <= trigger.high


def test_signal_cannot_fill_on_its_own_trigger_candle():
    # Append a candle that closes the position, so the fill becomes observable
    # as a closed trade. Only *closed* trades are returned, which is why this
    # needs a resolving candle rather than ending on the trigger.
    resolved = BULLISH_LIFECYCLE + [mk(10, 1.1041, 1.1044, 1.0990, 1.0992)]
    trades, signals = _run(resolved)
    assert signals == 1, "the setup is still detected"
    trigger_time = ensure_utc(BULLISH_LIFECYCLE[SIGNAL_INDEX].time)
    for trade in trades:
        assert ensure_utc(trade.entry_time) != trigger_time, \
            "no trade may be filled on the candle that produced the signal"


def test_next_candle_can_fill_the_queued_signal():
    later = BULLISH_LIFECYCLE + [mk(10, 1.1041, 1.1044, 1.1036, 1.1042)]
    resolved = later + [mk(11, 1.1042, 1.1043, 1.0990, 1.0992)]  # reaches the stop
    trades, signals = _run(resolved)
    assert signals == 1
    assert len(trades) == 1
    trade = trades[0]
    assert ensure_utc(trade.entry_time) == ensure_utc(later[10].time), \
        "the fill belongs to the candle after the trigger"
    assert ensure_utc(trade.entry_time) > ensure_utc(BULLISH_LIFECYCLE[SIGNAL_INDEX].time)


def test_queued_signal_is_not_filled_when_entry_is_never_touched():
    # Price gaps away from the entry and never trades back to it.
    away = BULLISH_LIFECYCLE + [
        mk(10, 1.1050, 1.1060, 1.1046, 1.1055),
        mk(11, 1.1055, 1.1065, 1.1051, 1.1060),
    ]
    trades, signals = _run(away)
    assert signals == 1
    assert trades == [], "an untouched entry price must not be filled"


def test_candle_entirely_below_a_long_entry_cannot_fill_it():
    # The old one-sided check treated any low below the entry as a fill even if
    # the candle's HIGH never reached the entry.
    gapped_below = BULLISH_LIFECYCLE + [
        mk(10, 1.1025, 1.1030, 1.1020, 1.1024),
        mk(11, 1.1000, 1.1002, 1.0990, 1.0992),
    ]
    trades, signals = _run(gapped_below)
    assert signals == 1
    assert trades == []


def test_entry_candle_is_checked_immediately_for_stop_first_exit():
    same_bar = BULLISH_LIFECYCLE + [
        mk(10, 1.1038, 1.1044, 1.0990, 1.1000),
    ]
    trades, signals = _run(same_bar)
    assert signals == 1
    assert len(trades) == 1
    assert trades[0].exit_reason == "stop"
    assert ensure_utc(trades[0].entry_time) == ensure_utc(same_bar[10].time)


def test_queued_signal_is_cancelled_when_the_stop_trades_first():
    # A candle that reaches the stop without ever touching the entry invalidates
    # the setup; a later return to the entry must not resurrect it.
    invalidated = BULLISH_LIFECYCLE + [
        mk(10, 1.1030, 1.1032, 1.0990, 1.0995),  # stop 1.09945 reached, entry untouched
        mk(11, 1.1038, 1.1044, 1.1036, 1.1042),  # trades back through the entry
    ]
    trades, signals = _run(invalidated)
    assert signals == 1
    assert trades == [], "a setup invalidated before entry cannot trade"


def test_post_entry_ambiguous_candle_is_still_stop_first():
    # One candle spanning both the stop and the target must resolve as a stop.
    filled = BULLISH_LIFECYCLE + [
        mk(10, 1.1041, 1.1044, 1.1036, 1.1042),  # fills the queued entry
        mk(11, 1.1042, 1.1140, 1.0980, 1.1100),  # spans stop 1.09945 and target 1.1131
    ]
    trades, _ = _run(filled)
    assert len(trades) == 1
    assert trades[0].exit_reason == "stop", "ambiguous candles stay conservative"
