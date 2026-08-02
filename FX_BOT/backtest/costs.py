"""Trading cost model.

Scalping edges are tiny, so costs are modelled conservatively: spread, commission,
and slippage on entries and stops. All multipliers live in ``CostConfig`` so a
backtest can be re-run at, e.g., 1.5x costs to check robustness.
"""
from __future__ import annotations

from dataclasses import dataclass, replace


@dataclass(frozen=True)
class CostConfig:
    spread_multiplier: float = 1.0
    commission_multiplier: float = 1.0
    stop_slippage_pips: float = 0.5
    target_slippage_pips: float = 0.0
    market_entry_slippage_pips: float = 0.1


def scaled(cfg: CostConfig, multiplier: float) -> CostConfig:
    """Scale every cost component by ``multiplier`` (e.g. 1.5 for a stress run)."""
    return replace(
        cfg,
        spread_multiplier=cfg.spread_multiplier * multiplier,
        commission_multiplier=cfg.commission_multiplier * multiplier,
        stop_slippage_pips=cfg.stop_slippage_pips * multiplier,
        target_slippage_pips=cfg.target_slippage_pips * multiplier,
        market_entry_slippage_pips=cfg.market_entry_slippage_pips * multiplier,
    )


def spread_pips_for_bar(candle, symbol_meta, fallback: float, cfg: CostConfig) -> float:
    """Spread in pips for a bar: use recorded MT5 spread if present, else fallback."""
    if candle.spread_points is not None:
        pips = candle.spread_points * (symbol_meta.point_size / symbol_meta.pip_size)
    else:
        pips = fallback
    return pips * cfg.spread_multiplier


def commission_cost_usd(lots: float, symbol_meta, cfg: CostConfig) -> float:
    """Round-turn commission cost in account currency."""
    return lots * symbol_meta.commission_per_lot_round_turn * cfg.commission_multiplier
