"""Conservative fill model.

Entries are retest limit fills penalised by spread + entry slippage. Exits check
stop and target on each candle; when BOTH are touched in the same candle and no
lower-timeframe/tick data is available, the WORSE outcome (stop) is assumed.
"""
from __future__ import annotations

from dataclasses import dataclass

from backtest.costs import CostConfig, spread_pips_for_bar
from domain.models import Candle, Signal


@dataclass(frozen=True)
class EntryFill:
    price: float
    time: object


@dataclass(frozen=True)
class ExitFill:
    price: float
    reason: str  # "stop" | "target"


def entry_is_touched(candle: Candle, signal: Signal) -> bool:
    """True when the retest entry price is touched by this candle."""
    return candle.low <= signal.entry <= candle.high


def simulate_entry_fill(candle: Candle, signal: Signal, symbol_meta, cost_cfg: CostConfig) -> EntryFill:
    """Fill the retest entry, penalised by spread + entry slippage (adverse)."""
    spread = spread_pips_for_bar(candle, symbol_meta, symbol_meta.typical_spread_pips, cost_cfg)
    penalty = (spread + cost_cfg.market_entry_slippage_pips) * symbol_meta.pip_size
    if signal.direction == "long":
        return EntryFill(price=signal.entry + penalty, time=candle.time)
    return EntryFill(price=signal.entry - penalty, time=candle.time)


def simulate_exit_on_candle(candle: Candle, open_trade, symbol_meta, cost_cfg: CostConfig) -> ExitFill | None:
    """Return the stop/target exit on this candle, or None if neither is hit.

    Same-candle ambiguity: if both levels are inside the bar's range, assume the
    stop fills first (the worse outcome), since we have no intrabar data.
    """
    direction = open_trade.direction
    stop = open_trade.stop_price
    target = open_trade.target_price
    stop_slip = cost_cfg.stop_slippage_pips * symbol_meta.pip_size
    tgt_slip = cost_cfg.target_slippage_pips * symbol_meta.pip_size

    if direction == "long":
        stop_hit = candle.low <= stop
        target_hit = candle.high >= target
        if stop_hit and target_hit:
            return ExitFill(price=stop - stop_slip, reason="stop")
        if stop_hit:
            return ExitFill(price=stop - stop_slip, reason="stop")
        if target_hit:
            return ExitFill(price=target - tgt_slip, reason="target")
        return None

    stop_hit = candle.high >= stop
    target_hit = candle.low <= target
    if stop_hit and target_hit:
        return ExitFill(price=stop + stop_slip, reason="stop")
    if stop_hit:
        return ExitFill(price=stop + stop_slip, reason="stop")
    if target_hit:
        return ExitFill(price=target + tgt_slip, reason="target")
    return None
