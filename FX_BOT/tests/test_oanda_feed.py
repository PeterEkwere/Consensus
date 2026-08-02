"""Offline tests for the OANDA adapter (pure parsing/mapping — no network)."""
from datetime import timezone

from config.symbols import get_symbol_meta
from data.oanda_feed import candle_from_json, to_instrument


def test_instrument_mapping():
    assert to_instrument("EURUSD") == "EUR_USD"
    assert to_instrument("XAUUSD") == "XAU_USD"
    assert to_instrument("USDJPY") == "USD_JPY"


def _sample(complete=True):
    # OANDA MBA candle with UNIX time (epoch seconds) = 2025-01-02 08:00:00 UTC.
    return {
        "complete": complete,
        "time": "1735804800.000000000",
        "volume": 132,
        "mid": {"o": "1.10400", "h": "1.10460", "l": "1.10380", "c": "1.10440"},
        "bid": {"o": "1.10395", "h": "1.10455", "l": "1.10375", "c": "1.10435"},
        "ask": {"o": "1.10405", "h": "1.10465", "l": "1.10385", "c": "1.10445"},
    }


def test_candle_parsing_and_spread():
    meta = get_symbol_meta("EURUSD")
    c = candle_from_json("EURUSD", "M5", _sample(), meta.point_size)
    assert c is not None
    assert c.symbol == "EURUSD" and c.timeframe == "M5"
    assert c.time.tzinfo is not None
    assert c.time.astimezone(timezone.utc).hour == 8
    assert c.open == 1.10400 and c.close == 1.10440
    # spread = ask.c - bid.c = 1.10445 - 1.10435 = 0.00010 -> 10 points (pip_size/point_size)
    assert c.spread_points == 10


def test_incomplete_candle_skipped():
    meta = get_symbol_meta("EURUSD")
    assert candle_from_json("EURUSD", "M5", _sample(complete=False), meta.point_size) is None
