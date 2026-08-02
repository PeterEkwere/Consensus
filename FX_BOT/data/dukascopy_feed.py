"""Dukascopy historical tick feed (pure standard library — no third-party deps).

Dukascopy publishes free historical ticks with NO account required, so it cannot be
region-blocked. Each ``.bi5`` file holds one hour of ticks, LZMA-compressed. We
download hour-by-hour, decode, and aggregate ticks into candles on the fly.

Gotchas handled here:
  * URL month is ZERO-INDEXED (January = 00 ... December = 11).
  * A tick record is 20 bytes big-endian: (ms_offset:u32, ask:u32, bid:u32,
    ask_vol:f32, bid_vol:f32). Integer prices are scaled by a per-instrument factor.
  * Bid price is used for candle OHLC (chart convention); spread = ask - bid,
    averaged over the bar and stored as ``spread_points`` (real spread!).
  * Missing/empty hours (weekends, holidays) return no ticks and are skipped.

This is slower than a REST API (many small files) but requires no key and gives a
true spread. Times are bar-OPEN UTC, matching our Candle convention.
"""
from __future__ import annotations

import lzma
import ssl
import struct
import time as _time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from domain.models import Candle
from domain.series import CandleSeries
from domain.time_utils import ensure_utc, floor_to_timeframe

BASE_URL = "https://datafeed.dukascopy.com/datafeed"
_RECORD = struct.Struct(">IIIff")  # ms, ask, bid, ask_vol, bid_vol

# Price scaling factor per instrument (Dukascopy stores integer prices).
# EURUSD/GBPUSD are 5-digit (1e-5); JPY pairs and XAUUSD are 3-digit (1e-3).
PRICE_FACTOR = {
    "EURUSD": 1e-5, "GBPUSD": 1e-5, "USDJPY": 1e-3, "XAUUSD": 1e-3,
}


def price_factor(symbol: str) -> float:
    """Integer-price scaling factor for a Dukascopy instrument."""
    if symbol in PRICE_FACTOR:
        return PRICE_FACTOR[symbol]
    # Heuristic fallback: JPY quote -> 1e-3, else 1e-5.
    return 1e-3 if symbol.endswith("JPY") else 1e-5


def _lzma_decompress(data: bytes) -> bytes:
    for fmt in (lzma.FORMAT_AUTO, lzma.FORMAT_ALONE):
        try:
            return lzma.decompress(data, format=fmt)
        except lzma.LZMAError:
            continue
    raise lzma.LZMAError("Could not decompress .bi5 payload")


def decode_bi5(data: bytes) -> list[tuple]:
    """Decompress a .bi5 payload into raw tick tuples (ms, ask, bid, av, bv).

    Pure/offline — unit-testable without network.
    """
    if not data:
        return []
    raw = _lzma_decompress(data)
    n = len(raw) - (len(raw) % _RECORD.size)
    return list(_RECORD.iter_unpack(raw[:n]))


def ticks_from_records(records: list[tuple], hour_start: datetime, factor: float) -> list[tuple]:
    """Convert raw records into (time, bid, ask) tuples using the hour start + factor."""
    hour_start = ensure_utc(hour_start)
    out = []
    for ms, ask_raw, bid_raw, _av, _bv in records:
        t = hour_start + timedelta(milliseconds=ms)
        out.append((t, bid_raw * factor, ask_raw * factor))
    return out


class _Aggregator:
    """Streams ticks into candle buckets for one symbol/timeframe."""

    def __init__(self, symbol: str, timeframe: str, point_size: float):
        self.symbol = symbol
        self.timeframe = timeframe
        self.point_size = point_size
        self.buckets: dict[datetime, dict] = {}

    def add(self, t: datetime, bid: float, ask: float) -> None:
        key = floor_to_timeframe(t, self.timeframe)
        b = self.buckets.get(key)
        spread = ask - bid
        if b is None:
            self.buckets[key] = {"o": bid, "h": bid, "l": bid, "c": bid,
                                 "n": 1, "ss": spread}
        else:
            if bid > b["h"]:
                b["h"] = bid
            if bid < b["l"]:
                b["l"] = bid
            b["c"] = bid
            b["n"] += 1
            b["ss"] += spread

    def candles(self) -> list[Candle]:
        out: list[Candle] = []
        for key in sorted(self.buckets):
            b = self.buckets[key]
            avg_spread = b["ss"] / b["n"] if b["n"] else 0.0
            sp = int(round(avg_spread / self.point_size)) if self.point_size else None
            out.append(Candle(
                symbol=self.symbol, timeframe=self.timeframe, time=key,
                open=round(b["o"], 5), high=round(b["h"], 5),
                low=round(b["l"], 5), close=round(b["c"], 5),
                tick_volume=b["n"], spread_points=sp,
            ))
        return out


def aggregate_ticks(symbol: str, timeframe: str, ticks: list[tuple], point_size: float) -> list[Candle]:
    """Aggregate (time, bid, ask) ticks into candles (pure/offline, testable)."""
    agg = _Aggregator(symbol, timeframe, point_size)
    for t, bid, ask in ticks:
        agg.add(ensure_utc(t), bid, ask)
    return agg.candles()


def make_ssl_context(insecure: bool = False) -> ssl.SSLContext:
    """Build an SSL context.

    ``insecure=True`` disables verification — needed only when a macOS Python has no
    root certificates installed (a common setup issue). Prefer fixing certs: run
    ``/Applications/Python\\ 3.x/Install\\ Certificates.command`` or ``pip install
    certifi``. If certifi is present we use its CA bundle automatically.
    """
    if insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    try:
        import certifi  # optional
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def _hour_url(symbol: str, dt: datetime) -> str:
    return (f"{BASE_URL}/{symbol}/{dt.year:04d}/{dt.month - 1:02d}/{dt.day:02d}/"
            f"{dt.hour:02d}h_ticks.bi5")


def _download_hour(symbol: str, dt: datetime, retries: int = 6, timeout: float = 45.0,
                   ssl_context: ssl.SSLContext | None = None) -> bytes | None:
    url = _hour_url(symbol, dt)
    ctx = ssl_context or make_ssl_context()
    req = urllib.request.Request(url, headers={"User-Agent": "scalp-bot/0.1"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None  # no data for this hour (weekend/holiday)
            if exc.code == 429 or exc.code >= 500:
                _time.sleep(1.5 * (attempt + 1))
                continue
            raise RuntimeError(f"Dukascopy HTTP {exc.code} for {url}") from exc
        except urllib.error.URLError as exc:
            # A missing-CA-cert failure will never succeed on retry -> fail loudly.
            if isinstance(getattr(exc, "reason", None), ssl.SSLCertVerificationError):
                raise RuntimeError(
                    "SSL certificate verification failed. Your Python has no CA "
                    "certificates. Fix: run the 'Install Certificates.command' in your "
                    "Python folder, or `pip install certifi`. As a last resort re-run "
                    "the fetch script with --insecure."
                ) from exc
            _time.sleep(1.5 * (attempt + 1))
        except (TimeoutError, ssl.SSLError, OSError):
            # Read/connect timeout or transient socket error: back off and retry.
            _time.sleep(1.5 * (attempt + 1))
    # Exhausted retries for this hour; skip it rather than aborting the whole run.
    return None


def fetch_symbol_timeframes(
    symbol: str,
    timeframes: list[str],
    start: datetime,
    end: datetime,
    point_size: float,
    polite_delay: float = 0.0,
    insecure: bool = False,
    log=lambda *_: None,
) -> dict[str, list[Candle]]:
    """Download ticks once and aggregate into each requested timeframe.

    Returns {timeframe: [Candle, ...]}. Downloads hour-by-hour to bound memory.
    """
    factor = price_factor(symbol)
    aggs = {tf: _Aggregator(symbol, tf, point_size) for tf in timeframes}
    start = ensure_utc(start)
    end = ensure_utc(end)
    ctx = make_ssl_context(insecure=insecure)

    hour = start.replace(minute=0, second=0, microsecond=0)
    total_hours = max(1, int((end - hour).total_seconds() // 3600))
    done = 0
    while hour < end:
        data = _download_hour(symbol, hour, ssl_context=ctx)
        if data:
            for t, bid, ask in ticks_from_records(decode_bi5(data), hour, factor):
                if t < start or t >= end:
                    continue
                for agg in aggs.values():
                    agg.add(t, bid, ask)
        done += 1
        if done % 240 == 0:  # ~every 10 days
            log(f"  {symbol}: {done}/{total_hours} hours")
        if polite_delay:
            _time.sleep(polite_delay)
        hour += timedelta(hours=1)

    return {tf: agg.candles() for tf, agg in aggs.items()}
