"""Prop challenge simulator: breaches, passing, and the loss floor."""
from datetime import datetime, timedelta, timezone

from backtest.prop_simulator import (
    simulate_challenge, starting_daily_loss_limit, total_loss_floor,
)
from config.prop_rules import get_prop_rules
from domain.models import Trade

RULES = get_prop_rules("fundingpips_2_step_phase_1")
BASE = datetime(2025, 1, 6, 10, 0, tzinfo=timezone.utc)


def _trade(day_offset_hours, net_pnl, symbol="EURUSD", direction="long"):
    entry = BASE + timedelta(hours=day_offset_hours)
    return Trade(
        id=f"t{day_offset_hours}", symbol=symbol, direction=direction,
        entry_time=entry, exit_time=entry + timedelta(minutes=30),
        entry_price=1.1, exit_price=1.1, stop_price=1.09, target_price=1.12,
        lots=0.1, gross_r=0.0, net_r=net_pnl / 500.0,
        gross_pnl=net_pnl, net_pnl=net_pnl, exit_reason="target",
    )


def test_loss_floor_static():
    floor = total_loss_floor(100_000, 105_000, RULES)
    assert floor == 100_000 * (1 - 0.10)  # static: based on initial, not high-water


def test_daily_loss_limit_basis():
    assert starting_daily_loss_limit(100_000, 100_000, RULES) == 100_000 * 0.05


def test_max_daily_loss_breach():
    # One catastrophic day beyond the 5% daily limit.
    trades = [_trade(0, -6_000)]
    res = simulate_challenge(trades, RULES, 100_000)
    assert not res.passed
    assert res.breach_reason == "max_daily_loss"


def test_max_total_loss_breach():
    # Spread losses across separate days so the daily limit is not the trigger.
    trades = [_trade(24 * d, -3_000) for d in range(5)]  # -15k total, one per day
    res = simulate_challenge(trades, RULES, 100_000)
    assert not res.passed
    assert res.breach_reason == "max_total_loss"


def test_passes_target_with_min_days():
    # Reach +8% across >=3 distinct days without breaching daily loss.
    trades = [_trade(24 * d, 3_000) for d in range(3)]  # +9k over 3 days
    res = simulate_challenge(trades, RULES, 100_000)
    assert res.passed
    assert res.trading_days >= RULES.min_trading_days
    assert res.breach_reason is None


def test_target_hit_but_min_days_not_met():
    # +8% in a single day -> target met but min trading days unmet.
    trades = [_trade(0, 5_000), _trade(1, 4_000)]
    res = simulate_challenge(trades, RULES, 100_000)
    assert not res.passed
    assert res.breach_reason == "min_days_not_met"
