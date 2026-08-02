"""Prop-firm challenge rules — parameterised, never hard-coded in logic.

The default FundingPips 2-Step numbers below are an ASSUMPTION for development.
Confirm the exact model in the live FundingPips dashboard/terms before any real
challenge:
  - https://fundingpips.com/trading-objectives
  - https://fundingpips.com/terms-and-conditions
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

DrawdownMode = Literal["static", "trailing"]


@dataclass(frozen=True)
class PropRules:
    name: str
    initial_balance: float
    profit_target_pct: float
    min_trading_days: int
    max_daily_loss_pct: float
    max_total_loss_pct: float
    drawdown_mode: DrawdownMode
    daily_reset_timezone: str
    daily_reset_hour: int
    news_blackout_minutes_before: int
    news_blackout_minutes_after: int
    losing_reentry_cooldown_minutes: int
    consistency_max_day_profit_pct: float | None = None


FUNDINGPIPS_2_STEP_PHASE_1 = PropRules(
    name="fundingpips_2_step_phase_1",
    initial_balance=100_000.0,
    profit_target_pct=0.08,
    min_trading_days=3,
    max_daily_loss_pct=0.05,
    max_total_loss_pct=0.10,
    drawdown_mode="static",
    daily_reset_timezone="Europe/Prague",  # Confirm server time in dashboard.
    daily_reset_hour=0,
    news_blackout_minutes_before=5,
    news_blackout_minutes_after=5,
    losing_reentry_cooldown_minutes=10,
)

FUNDINGPIPS_2_STEP_PHASE_2 = PropRules(
    name="fundingpips_2_step_phase_2",
    initial_balance=100_000.0,
    profit_target_pct=0.05,
    min_trading_days=3,
    max_daily_loss_pct=0.05,
    max_total_loss_pct=0.10,
    drawdown_mode="static",
    daily_reset_timezone="Europe/Prague",
    daily_reset_hour=0,
    news_blackout_minutes_before=5,
    news_blackout_minutes_after=5,
    losing_reentry_cooldown_minutes=10,
)

PROP_RULES: dict[str, PropRules] = {
    r.name: r for r in (FUNDINGPIPS_2_STEP_PHASE_1, FUNDINGPIPS_2_STEP_PHASE_2)
}


def get_prop_rules(name: str) -> PropRules:
    """Look up a prop model by name, raising a clear error if unknown."""
    try:
        return PROP_RULES[name]
    except KeyError as exc:
        known = ", ".join(sorted(PROP_RULES))
        raise KeyError(f"Unknown prop model {name!r}. Known models: {known}") from exc
