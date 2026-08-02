"""Per-symbol broker metadata (pip/point size, contract, lot rules).

The signal engine needs ``pip_size`` from Phase 1 onward to measure sweeps, BOS
buffers, and stop distances in pips, so this module is introduced now rather than
in Phase 2. The contract/lot/commission fields are here too so Phase 2 sizing and
cost models have a single source of truth.

Confirm every broker-specific value against MT5 ``symbol_info`` before trusting it.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SymbolMeta:
    symbol: str
    base_currency: str
    quote_currency: str
    pip_size: float
    point_size: float
    contract_size: float
    lot_step: float
    min_lot: float
    max_lot: float
    typical_spread_pips: float
    commission_per_lot_round_turn: float


SYMBOLS: dict[str, SymbolMeta] = {
    "EURUSD": SymbolMeta("EURUSD", "EUR", "USD", 0.0001, 0.00001, 100_000, 0.01, 0.01, 100.0, 0.8, 7.0),
    "GBPUSD": SymbolMeta("GBPUSD", "GBP", "USD", 0.0001, 0.00001, 100_000, 0.01, 0.01, 100.0, 1.0, 7.0),
    "USDJPY": SymbolMeta("USDJPY", "USD", "JPY", 0.01, 0.001, 100_000, 0.01, 0.01, 100.0, 0.9, 7.0),
    "XAUUSD": SymbolMeta("XAUUSD", "XAU", "USD", 0.1, 0.01, 100, 0.01, 0.01, 50.0, 2.5, 7.0),
}


def get_symbol_meta(symbol: str) -> SymbolMeta:
    """Look up symbol metadata, raising a clear error if unknown."""
    try:
        return SYMBOLS[symbol]
    except KeyError as exc:
        known = ", ".join(sorted(SYMBOLS))
        raise KeyError(f"Unknown symbol {symbol!r}. Known symbols: {known}") from exc
