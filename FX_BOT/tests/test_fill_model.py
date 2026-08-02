"""Fill model: entry touch, adverse entry penalty, same-candle stop/target rule."""
from dataclasses import dataclass

from tests.fixtures.builders import EURUSD, mk

from backtest.costs import CostConfig
from backtest.fill_model import entry_is_touched, simulate_entry_fill, simulate_exit_on_candle
from domain.models import SetupState, Signal

COST = CostConfig()


def _signal(direction, entry, stop, target):
    st = SetupState(symbol="EURUSD", stage="entry_triggered", direction=direction)
    return Signal(
        symbol="EURUSD", direction=direction, timeframe="M5",
        signal_time=mk(0, entry, entry, entry, entry).time,
        entry=entry, stop=stop, target=target, stop_pips=abs(entry - stop) / EURUSD.pip_size,
        planned_r=2.0, confluence={}, setup_state=st,
    )


@dataclass
class _OT:
    direction: str
    stop_price: float
    target_price: float


def test_entry_touched_long():
    sig = _signal("long", 1.1000, 1.0990, 1.1020)
    assert entry_is_touched(mk(0, 1.1005, 1.1006, 1.0999, 1.1004), sig)  # low dips to entry
    assert not entry_is_touched(mk(0, 1.1005, 1.1008, 1.1002, 1.1006), sig)


def test_entry_fill_is_adverse_for_long():
    sig = _signal("long", 1.1000, 1.0990, 1.1020)
    fill = simulate_entry_fill(mk(0, 1.1002, 1.1003, 1.0998, 1.1001), sig, EURUSD, COST)
    assert fill.price > sig.entry  # pays spread + slippage


def test_same_candle_stop_and_target_assumes_stop():
    ot = _OT("long", stop_price=1.0990, target_price=1.1020)
    # Candle spans both stop and target.
    candle = mk(0, 1.1000, 1.1025, 1.0985, 1.1010)
    exit_fill = simulate_exit_on_candle(candle, ot, EURUSD, COST)
    assert exit_fill is not None
    assert exit_fill.reason == "stop"  # worse outcome assumed
    assert exit_fill.price < 1.0990  # stop slippage makes it worse


def test_target_only_hit():
    ot = _OT("long", stop_price=1.0990, target_price=1.1020)
    candle = mk(0, 1.1000, 1.1025, 1.0995, 1.1015)  # target hit, stop not
    exit_fill = simulate_exit_on_candle(candle, ot, EURUSD, COST)
    assert exit_fill is not None
    assert exit_fill.reason == "target"
