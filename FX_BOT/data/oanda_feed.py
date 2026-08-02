"""OANDA v20 REST history feed (pure standard library — no third-party deps).

Downloads broker-grade candles on a Mac without MT5. Uses bid/ask/mid candles so a
real per-bar spread is derived and stored as ``spread_points`` (same units the MT5
feed and cost model expect).

Auth: set ``OANDA_API_TOKEN`` (and optionally ``OANDA_ENV=practice|live``). A free
OANDA *practice* account provides a token that works here.

Notes:
  * ``candle["time"]`` from OANDA is the bar OPEN time (UTC) — matches our
    ``Candle.time`` convention. We request UNIX datetime format to avoid parsing
    9-digit nanosecond RFC3339 stamps.
  * Only ``complete`` candles are kept, so a still-forming bar never leaks in.
  * Instruments are mapped EURUSD->EUR_USD, XAUUSD->XAU_USD, etc.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from domain.models import Candle
from domain.time_utils import ensure_utc, timeframe_minutes

OANDA_HOSTS = {
    "practice": "https://api-fxpractice.oanda.com",
    "live": "https://api-fxtrade.oanda.com",
}
INSTRUMENT_MAP = {
    "EURUSD": "EUR_USD", "GBPUSD": "GBP_USD", "USDJPY": "USD_JPY", "XAUUSD": "XAU_USD",
}
_MAX_COUNT = 5000  # OANDA per-request cap


def to_instrument(symbol: str) -> str:
    """Map our symbol (EURUSD) to an OANDA instrument (EUR_USD)."""
    if symbol in INSTRUMENT_MAP:
        return INSTRUMENT_MAP[symbol]
    if len(symbol) >= 6 and "_" not in symbol:
        return f"{symbol[:3]}_{symbol[3:6]}"
    return symbol


def candle_from_json(symbol: str, timeframe: str, c: dict, point_size: float) -> Candle | None:
    """Convert one OANDA candle dict (MBA prices) into a canonical Candle.

    Returns None for incomplete (still-forming) candles. Pure — no network — so it
    is unit-testable offline.
    """
    if not c.get("complete", False):
        return None
    t_raw = c["time"]
    # UNIX format -> epoch seconds string; RFC3339 fallback also handled.
    try:
        t = datetime.fromtimestamp(float(t_raw), tz=timezone.utc)
    except ValueError:
        t = ensure_utc(datetime.fromisoformat(str(t_raw).replace("Z", "+00:00")[:26]))
    mid, bid, ask = c["mid"], c["bid"], c["ask"]
    spread_price = float(ask["c"]) - float(bid["c"])
    spread_points = int(round(spread_price / point_size)) if point_size else None
    return Candle(
        symbol=symbol,
        timeframe=timeframe,
        time=t,
        open=float(mid["o"]),
        high=float(mid["h"]),
        low=float(mid["l"]),
        close=float(mid["c"]),
        tick_volume=int(c.get("volume", 0)),
        spread_points=spread_points,
    )


def _request(url: str, token: str, retries: int = 5) -> dict:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept-Datetime-Format": "UNIX",
            "Content-Type": "application/json",
        },
    )
    last_err = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            body = exc.read().decode()[:300]
            if exc.code in (429,) or exc.code >= 500:
                time.sleep(1.5 * (attempt + 1))
                last_err = RuntimeError(f"OANDA HTTP {exc.code}: {body}")
                continue
            raise RuntimeError(f"OANDA HTTP {exc.code}: {body}") from exc
        except urllib.error.URLError as exc:  # transient network
            last_err = RuntimeError(f"OANDA network error: {exc}")
            time.sleep(1.5 * (attempt + 1))
    raise last_err or RuntimeError("OANDA request failed")


def fetch_symbol_timeframe(
    symbol: str,
    timeframe: str,
    start: datetime,
    end: datetime,
    token: str,
    env: str = "practice",
    point_size: float | None = None,
) -> list[Candle]:
    """Fetch complete candles for one symbol/timeframe over [start, end)."""
    if not token:
        raise RuntimeError("No OANDA token. Set OANDA_API_TOKEN in your environment.")
    if point_size is None:
        from config.symbols import get_symbol_meta
        point_size = get_symbol_meta(symbol).point_size

    host = OANDA_HOSTS[env]
    instrument = to_instrument(symbol)
    gran = timeframe.upper()
    start = ensure_utc(start)
    end = ensure_utc(end)
    step = timedelta(minutes=timeframe_minutes(timeframe))

    by_time: dict[datetime, Candle] = {}
    cursor = start
    include_first = "true"
    while cursor < end:
        params = urllib.parse.urlencode({
            "granularity": gran,
            "price": "MBA",
            "count": _MAX_COUNT,
            "from": f"{cursor.timestamp():.0f}",
            "includeFirst": include_first,
        })
        data = _request(f"{host}/v3/instruments/{instrument}/candles?{params}", token)
        raw = data.get("candles", [])
        if not raw:
            break

        last_time = None
        for rc in raw:
            candle = candle_from_json(symbol, timeframe, rc, point_size)
            if candle is None:
                continue
            if candle.time >= end:
                break
            by_time[candle.time] = candle
            last_time = candle.time

        if last_time is None:
            cursor = cursor + step * _MAX_COUNT  # skip an empty stretch (weekends)
        else:
            cursor = last_time + step
        include_first = "false"
        if len(raw) < _MAX_COUNT:
            break

    return sorted(by_time.values(), key=lambda c: c.time)
