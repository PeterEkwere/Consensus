"""Headline backtest metrics (net-R based, standard library only)."""
from __future__ import annotations

from typing import Sequence

from domain.models import Trade


def expectancy_r(trades: Sequence[Trade]) -> float:
    """Average net R per trade."""
    if not trades:
        return 0.0
    return sum(t.net_r for t in trades) / len(trades)


def profit_factor(trades: Sequence[Trade]) -> float:
    """Gross wins / gross losses (by net PnL). inf when there are no losses."""
    wins = sum(t.net_pnl for t in trades if t.net_pnl > 0)
    losses = -sum(t.net_pnl for t in trades if t.net_pnl < 0)
    if losses == 0:
        return float("inf") if wins > 0 else 0.0
    return wins / losses


def win_rate(trades: Sequence[Trade]) -> float:
    """Fraction of trades with positive net PnL."""
    if not trades:
        return 0.0
    return sum(1 for t in trades if t.net_pnl > 0) / len(trades)


def max_drawdown(equity_curve: Sequence[float]) -> float:
    """Maximum peak-to-trough drawdown as a fraction of the running peak."""
    peak = float("-inf")
    max_dd = 0.0
    for eq in equity_curve:
        peak = max(peak, eq)
        if peak > 0:
            max_dd = max(max_dd, (peak - eq) / peak)
    return max_dd


def equity_curve(trades: Sequence[Trade], starting_balance: float) -> list[float]:
    """Running balance after each trade (entry-time order)."""
    ordered = sorted(trades, key=lambda t: t.entry_time)
    bal = starting_balance
    curve = [bal]
    for t in ordered:
        bal += t.net_pnl
        curve.append(bal)
    return curve


def worst_day_pct(trades: Sequence[Trade], starting_balance: float) -> float:
    """Worst single-day net PnL as a fraction of starting balance (negative)."""
    by_day: dict = {}
    for t in trades:
        key = t.exit_time.date()
        by_day[key] = by_day.get(key, 0.0) + t.net_pnl
    if not by_day:
        return 0.0
    return min(by_day.values()) / starting_balance


def summarize_trades(trades: Sequence[Trade], starting_balance: float) -> dict:
    """Return the headline metric bundle used by reports and the CLI."""
    curve = equity_curve(trades, starting_balance)
    return {
        "trades": len(trades),
        "win_rate": round(win_rate(trades), 4),
        "expectancy_r": round(expectancy_r(trades), 4),
        "profit_factor": (round(profit_factor(trades), 4) if profit_factor(trades) != float("inf") else None),
        "max_drawdown_pct": round(max_drawdown(curve), 4),
        "worst_day_pct": round(worst_day_pct(trades, starting_balance), 4),
        "net_pnl": round(sum(t.net_pnl for t in trades), 2),
        "end_balance": round(curve[-1], 2),
    }
