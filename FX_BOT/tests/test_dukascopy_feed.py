"""Offline tests for the Dukascopy adapter (binary decode + aggregation, no network)."""
import lzma
import struct
from datetime import datetime, timezone

from config.symbols import get_symbol_meta
from data.dukascopy_feed import (
    aggregate_ticks, decode_bi5, price_factor, ticks_from_records,
)

_RECORD = struct.Struct(">IIIff")
HOUR = datetime(2025, 1, 2, 8, 0, tzinfo=timezone.utc)


def _make_bi5(records) -> bytes:
    raw = b"".join(_RECORD.pack(*r) for r in records)
    return lzma.compress(raw, format=lzma.FORMAT_ALONE)


def test_price_factor():
    assert price_factor("EURUSD") == 1e-5
    assert price_factor("USDJPY") == 1e-3
    assert price_factor("XAUUSD") == 1e-3


def test_decode_and_convert_ticks():
    # Two ticks: (ms, ask_raw, bid_raw, ask_vol, bid_vol) for EURUSD (factor 1e-5).
    records = [
        (0, 110450, 110440, 1.0, 1.0),        # bid 1.10440, ask 1.10450
        (60000, 110460, 110445, 2.0, 1.5),    # +60s: bid 1.10445, ask 1.10460
    ]
    decoded = decode_bi5(_make_bi5(records))
    assert decoded == records

    ticks = ticks_from_records(decoded, HOUR, price_factor("EURUSD"))
    assert len(ticks) == 2
    t0, bid0, ask0 = ticks[0]
    assert t0 == HOUR
    assert round(bid0, 5) == 1.10440
    assert round(ask0, 5) == 1.10450


def test_empty_payload():
    assert decode_bi5(b"") == []


def test_aggregate_ticks_into_candle():
    meta = get_symbol_meta("EURUSD")
    # Four ticks inside one M5 bucket; bid path 1.1040 -> 1.1050 -> 1.1030 -> 1.1045.
    ticks = [
        (HOUR, 1.10400, 1.10410),
        (HOUR.replace(minute=1), 1.10500, 1.10512),
        (HOUR.replace(minute=2), 1.10300, 1.10309),
        (HOUR.replace(minute=3), 1.10450, 1.10460),
    ]
    candles = aggregate_ticks("EURUSD", "M5", ticks, meta.point_size)
    assert len(candles) == 1
    c = candles[0]
    assert c.time == HOUR                 # bucket open time
    assert c.open == 1.10400
    assert c.high == 1.10500
    assert c.low == 1.10300
    assert c.close == 1.10450
    assert c.tick_volume == 4
    assert c.spread_points is not None    # real spread derived from ask-bid


def test_ticks_split_across_two_buckets():
    meta = get_symbol_meta("EURUSD")
    ticks = [
        (HOUR, 1.10400, 1.10410),                    # 08:00 -> M5 bucket 08:00
        (HOUR.replace(minute=6), 1.10450, 1.10460),  # 08:06 -> M5 bucket 08:05
    ]
    candles = aggregate_ticks("EURUSD", "M5", ticks, meta.point_size)
    assert len(candles) == 2
    assert candles[0].time == HOUR
    assert candles[1].time == HOUR.replace(minute=5)
