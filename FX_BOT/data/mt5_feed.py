"""MetaTrader 5 history feed.

The ``MetaTrader5`` package requires a running MT5 terminal and is Windows-only in
practice. It is imported lazily so the rest of the system (and the whole Phase-1/2
test + backtest pipeline) works without it. On a machine without MT5, calling these
functions raises a clear, actionable error.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from domain.models import Candle
from domain.time_utils import ensure_utc, timeframe_minutes

# MT5 timeframe constants are resolved lazily from the package to avoid importing
# it at module load. Names mirror mt5.TIMEFRAME_* attributes.
_MT5_TF_ATTR = {
    "M1": "TIMEFRAME_M1", "M5": "TIMEFRAME_M5", "M15": "TIMEFRAME_M15",
    "M30": "TIMEFRAME_M30", "H1": "TIMEFRAME_H1", "H4": "TIMEFRAME_H4",
    "D1": "TIMEFRAME_D1",
}


def _import_mt5() -> Any:
    try:
        import MetaTrader5 as mt5  # type: ignore
    except ImportError as exc:  # pragma: no cover - platform dependent
        raise RuntimeError(
            "MetaTrader5 package not available. Install it on a Windows machine with a "
            "running MT5 terminal, or export CSV from MT5 and import via data.mt5_export."
        ) from exc
    return mt5


def connect(login: int | None = None, password: str | None = None, server: str | None = None) -> Any:
    """Initialise the MT5 terminal connection, returning the mt5 module."""
    mt5 = _import_mt5()
    ok = mt5.initialize(login=login, password=password, server=server) if login else mt5.initialize()
    if not ok:  # pragma: no cover - platform dependent
        raise RuntimeError(f"MT5 initialize() failed: {mt5.last_error()}")
    return mt5


def fetch_symbol_timeframe(
    symbol: str,
    timeframe: str,
    start: datetime,
    end: datetime,
    *,
    mt5: Any | None = None,
) -> list[Candle]:
    """Fetch normalized candles from MT5 for one symbol/timeframe/date range."""
    mt5 = mt5 or _import_mt5()
    tf_const = getattr(mt5, _MT5_TF_ATTR[timeframe.upper()])
    rates = mt5.copy_rates_range(symbol, tf_const, ensure_utc(start), ensure_utc(end))
    if rates is None:  # pragma: no cover - platform dependent
        raise RuntimeError(f"MT5 returned no data for {symbol} {timeframe}: {mt5.last_error()}")

    from datetime import timezone

    out: list[Candle] = []
    for r in rates:
        out.append(
            Candle(
                symbol=symbol,
                timeframe=timeframe,
                time=datetime.fromtimestamp(int(r["time"]), tz=timezone.utc),
                open=float(r["open"]),
                high=float(r["high"]),
                low=float(r["low"]),
                close=float(r["close"]),
                tick_volume=int(r["tick_volume"]),
                spread_points=int(r["spread"]) if "spread" in r.dtype.names else None,
            )
        )
    out.sort(key=lambda c: c.time)
    return out
