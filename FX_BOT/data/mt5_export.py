"""Import broker CSV exported from MT5 into the canonical candle schema.

MT5's "Export bars" / history CSV typically looks like:
    DATE,TIME,OPEN,HIGH,LOW,CLOSE,TICKVOL,VOL,SPREAD
    2024.01.02,08:00:00,1.10412,1.10460,1.10380,1.10440,152,0,8

This importer is deliberately tolerant of header/column-name variations.
"""
from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path

from domain.models import Candle


def _parse_time(row: dict) -> datetime:
    # Support either a single ISO "time"/"datetime" column or split DATE + TIME.
    for key in ("time", "datetime", "date_time"):
        if key in row and row[key]:
            return datetime.fromisoformat(row[key].replace(".", "-", 2)).replace(tzinfo=timezone.utc)
    date = row.get("date") or row.get("<DATE>")
    tod = row.get("time") or row.get("<TIME>") or "00:00:00"
    if not date:
        raise ValueError(f"Cannot parse timestamp from row: {row}")
    date = date.replace(".", "-")
    return datetime.fromisoformat(f"{date} {tod}").replace(tzinfo=timezone.utc)


def _num(row: dict, *names: str, default: str = "0") -> str:
    for n in names:
        if n in row and row[n] != "":
            return row[n]
    return default


def import_csv(path: str | Path, symbol: str, timeframe: str) -> list[Candle]:
    """Read an MT5-exported CSV into a list of canonical ``Candle`` objects."""
    out: list[Candle] = []
    with Path(path).open(newline="") as fh:
        # Sniff delimiter (MT5 uses comma or tab depending on export).
        sample = fh.read(2048)
        fh.seek(0)
        delim = "\t" if "\t" in sample and sample.count("\t") >= sample.count(",") else ","
        reader = csv.DictReader(fh, delimiter=delim)
        reader.fieldnames = [(f or "").strip().lower().strip("<>") for f in (reader.fieldnames or [])]
        for raw in reader:
            row = {(k or "").strip().lower().strip("<>"): (v.strip() if isinstance(v, str) else v)
                   for k, v in raw.items()}
            spread = _num(row, "spread", default="")
            out.append(
                Candle(
                    symbol=symbol,
                    timeframe=timeframe,
                    time=_parse_time(row),
                    open=float(_num(row, "open")),
                    high=float(_num(row, "high")),
                    low=float(_num(row, "low")),
                    close=float(_num(row, "close")),
                    tick_volume=int(float(_num(row, "tickvol", "tick_volume", "volume"))),
                    spread_points=int(spread) if spread not in ("", None) else None,
                )
            )
    out.sort(key=lambda c: c.time)
    return out
