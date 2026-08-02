"""Reversal candle classification (pin / engulfing)."""
from tests.fixtures.builders import TEST_CFG, mk

from signal_engine.candles import classify_rejection


def test_valid_bullish_pin_bar():
    # Long lower wick, small body near the top of the range.
    candle = mk(0, 1.10440, 1.10460, 1.10300, 1.10450)
    rej = classify_rejection([candle], "long", TEST_CFG)
    assert rej is not None
    assert rej.kind == "pin"
    assert rej.direction == "long"


def test_invalid_pin_bar_body_too_large():
    # Big body relative to wick -> not a pin.
    candle = mk(0, 1.10320, 1.10460, 1.10300, 1.10450)
    assert classify_rejection([candle], "long", TEST_CFG) is None


def test_valid_bullish_engulfing():
    prev = mk(0, 1.10400, 1.10410, 1.10340, 1.10350)  # bearish
    cur = mk(1, 1.10345, 1.10470, 1.10344, 1.10460)   # bullish, covers prev body
    rej = classify_rejection([prev, cur], "long", TEST_CFG)
    assert rej is not None
    assert rej.kind == "engulfing"
    assert rej.direction == "long"


def test_valid_bearish_pin_bar():
    candle = mk(0, 1.10360, 1.10500, 1.10340, 1.10350)
    rej = classify_rejection([candle], "short", TEST_CFG)
    assert rej is not None
    assert rej.kind == "pin"
    assert rej.direction == "short"
