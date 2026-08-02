"""Historical candle storage.

Canonical on-disk format is CSV (standard library only) so the whole pipeline runs
without third-party deps. A parquet backend is used transparently when pandas +
pyarrow are installed (``save_candles(..., fmt="parquet")``), matching the doc's
parquet layout. Either way the candle schema is identical:

    symbol, timeframe, time (tz-aware UTC ISO-8601), open, high, low, close,
    tick_volume, spread_points, real_volume, source
"""
from __future__ import annotations

import csv
import os
from datetime import datetime
from pathlib import Path
from typing import Iterable, Sequence

from domain.models import Candle
from domain.series import CandleSeries
from domain.time_utils import ensure_utc

CANDLE_FIELDS = [
    "symbol", "timeframe", "time", "open", "high", "low", "close",
    "tick_volume", "spread_points", "real_volume", "source",
]


def candle_path(base_dir: str | os.PathLike, symbol: str, timeframe: str, ext: str = "csv") -> Path:
    """Path for ``{base_dir}/{symbol}/{timeframe}.{ext}``."""
    return Path(base_dir) / symbol / f"{timeframe}.{ext}"


def _row_for(c: Candle, source: str, real_volume: int | None) -> dict:
    return {
        "symbol": c.symbol,
        "timeframe": c.timeframe,
        "time": ensure_utc(c.time).isoformat(),
        "open": repr(c.open),
        "high": repr(c.high),
        "low": repr(c.low),
        "close": repr(c.close),
        "tick_volume": c.tick_volume,
        "spread_points": "" if c.spread_points is None else c.spread_points,
        "real_volume": "" if real_volume is None else real_volume,
        "source": source,
    }


def save_candles(
    candles: Sequence[Candle],
    base_dir: str | os.PathLike,
    symbol: str,
    timeframe: str,
    *,
    source: str = "mt5",
    fmt: str = "csv",
) -> Path:
    """Write candles to ``{base_dir}/{symbol}/{timeframe}.{ext}`` and return the path."""
    if fmt == "parquet":
        return _save_parquet(candles, base_dir, symbol, timeframe, source)

    path = candle_path(base_dir, symbol, timeframe, "csv")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=CANDLE_FIELDS)
        writer.writeheader()
        for c in candles:
            writer.writerow(_row_for(c, source, None))
    return path


def load_candles(
    base_dir: str | os.PathLike,
    symbol: str,
    timeframe: str,
) -> list[Candle]:
    """Load candles for a symbol/timeframe. Prefers CSV, falls back to parquet."""
    csv_path = candle_path(base_dir, symbol, timeframe, "csv")
    if csv_path.exists():
        return _load_csv(csv_path)
    pq_path = candle_path(base_dir, symbol, timeframe, "parquet")
    if pq_path.exists():
        return _load_parquet(pq_path)
    raise FileNotFoundError(
        f"No history for {symbol} {timeframe} under {base_dir} (looked for {csv_path.name} / {pq_path.name})"
    )


def _load_csv(path: Path) -> list[Candle]:
    out: list[Candle] = []
    with path.open(newline="") as fh:
        for row in csv.DictReader(fh):
            sp = row.get("spread_points", "")
            out.append(
                Candle(
                    symbol=row["symbol"],
                    timeframe=row["timeframe"],
                    time=ensure_utc(datetime.fromisoformat(row["time"])),
                    open=float(row["open"]),
                    high=float(row["high"]),
                    low=float(row["low"]),
                    close=float(row["close"]),
                    tick_volume=int(row["tick_volume"] or 0),
                    spread_points=(int(sp) if sp not in ("", None) else None),
                )
            )
    out.sort(key=lambda c: c.time)
    return out


# --- optional parquet backend (only used when pandas/pyarrow present) ---------
def _save_parquet(candles, base_dir, symbol, timeframe, source) -> Path:  # pragma: no cover
    import pandas as pd  # noqa: WPS433 (optional dep)

    path = candle_path(base_dir, symbol, timeframe, "parquet")
    path.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame(
        {
            "symbol": [c.symbol for c in candles],
            "timeframe": [c.timeframe for c in candles],
            "time": [ensure_utc(c.time) for c in candles],
            "open": [c.open for c in candles],
            "high": [c.high for c in candles],
            "low": [c.low for c in candles],
            "close": [c.close for c in candles],
            "tick_volume": [c.tick_volume for c in candles],
            "spread_points": [c.spread_points for c in candles],
            "real_volume": [None for _ in candles],
            "source": [source for _ in candles],
        }
    )
    df.to_parquet(path, index=False)
    return path


def _load_parquet(path: Path) -> list[Candle]:  # pragma: no cover
    import pandas as pd  # noqa: WPS433

    df = pd.read_parquet(path).sort_values("time")
    out: list[Candle] = []
    for _, r in df.iterrows():
        sp = r.get("spread_points")
        out.append(
            Candle(
                symbol=r["symbol"],
                timeframe=r["timeframe"],
                time=ensure_utc(r["time"].to_pydatetime()),
                open=float(r["open"]),
                high=float(r["high"]),
                low=float(r["low"]),
                close=float(r["close"]),
                tick_volume=int(r["tick_volume"] or 0),
                spread_points=(int(sp) if sp is not None and sp == sp else None),
            )
        )
    return out


class DataStore:
    """Thin accessor over a data-cache directory."""

    def __init__(self, base_dir: str | os.PathLike):
        self.base_dir = Path(base_dir)

    def load(self, symbol: str, timeframe: str) -> list[Candle]:
        return load_candles(self.base_dir, symbol, timeframe)

    def load_series(self, symbol: str, timeframe: str) -> CandleSeries:
        return CandleSeries(tuple(self.load(symbol, timeframe)))

    def has(self, symbol: str, timeframe: str) -> bool:
        return (
            candle_path(self.base_dir, symbol, timeframe, "csv").exists()
            or candle_path(self.base_dir, symbol, timeframe, "parquet").exists()
        )
