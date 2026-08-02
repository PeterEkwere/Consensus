"""FundingPips-style challenge simulator — the main Phase 2 deliverable.

Replays a sequence of closed trades through the prop rules and answers:

    Would this sequence pass the challenge without breaching daily loss, max loss,
    minimum trading days, news, or cooldown rules?

Simplifications (flagged so they can be tightened before any live reliance):
  * Balance/equity are updated on trade CLOSE. Intra-trade equity dips are not
    modelled, so a same-day drawdown that breaches the daily limit *intrabar*
    could be under-counted. The doc calls for open-equity simulation; add it in
    replay before trusting a marginal pass.
  * Daily loss basis = day-start balance. Confirm the exact FundingPips formula.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from data.calendar import affected_currencies, is_news_blackout
from domain.models import Trade
from domain.time_utils import ensure_utc


@dataclass(frozen=True)
class ChallengeResult:
    passed: bool
    days_taken: int | None
    breach_reason: str | None
    peak_drawdown_pct: float
    end_balance: float
    total_trades: int
    trading_days: int
    profit_target_hit_at: datetime | None
    filtered_trades: int = 0


def starting_daily_loss_limit(balance: float, equity: float, rules) -> float:
    """Absolute daily loss allowance for the day, based on day-start balance."""
    return balance * rules.max_daily_loss_pct


def total_loss_floor(initial_balance: float, high_water_equity: float, rules) -> float:
    """Equity floor below which the account is failed."""
    if rules.drawdown_mode == "trailing":
        return high_water_equity * (1 - rules.max_total_loss_pct)
    return initial_balance * (1 - rules.max_total_loss_pct)


def _day_key(t: datetime, rules) -> datetime:
    """Reset-adjusted local day bucket for a timestamp."""
    tz = ZoneInfo(rules.daily_reset_timezone)
    local = ensure_utc(t).astimezone(tz) - timedelta(hours=rules.daily_reset_hour)
    return datetime(local.year, local.month, local.day)


def simulate_challenge(
    trades: list[Trade],
    rules,
    starting_balance: float,
    news_events: list | None = None,
) -> ChallengeResult:
    """Replay trades through the prop rules and return a pass/fail result."""
    news_events = news_events or []
    trades = sorted(trades, key=lambda t: ensure_utc(t.entry_time))

    balance = starting_balance
    high_water = starting_balance
    peak_dd_pct = 0.0
    trading_days: set = set()
    cooldown_until: dict[tuple[str, str], datetime] = {}
    filtered = 0

    current_day = None
    day_start_balance = starting_balance
    target_hit_at: datetime | None = None

    for t in trades:
        entry = ensure_utc(t.entry_time)
        day = _day_key(entry, rules)

        # New trading day: reset the daily loss basis.
        if day != current_day:
            current_day = day
            day_start_balance = balance

        # --- pre-trade filters (do not affect balance) ----------------------
        if news_events and is_news_blackout(t.symbol, entry, news_events, rules):
            filtered += 1
            continue
        key = (t.symbol, t.direction)
        if key in cooldown_until and entry < cooldown_until[key]:
            filtered += 1
            continue

        # --- apply the trade -------------------------------------------------
        balance += t.net_pnl
        trading_days.add(day)
        high_water = max(high_water, balance)
        dd_pct = (high_water - balance) / starting_balance
        peak_dd_pct = max(peak_dd_pct, dd_pct)

        # Losing trade -> same-direction cooldown.
        if t.net_pnl < 0:
            cooldown_until[key] = ensure_utc(t.exit_time) + timedelta(
                minutes=rules.losing_reentry_cooldown_minutes
            )

        # --- breach checks ---------------------------------------------------
        floor = total_loss_floor(starting_balance, high_water, rules)
        if balance <= floor:
            return ChallengeResult(
                passed=False, days_taken=None, breach_reason="max_total_loss",
                peak_drawdown_pct=round(peak_dd_pct, 4), end_balance=round(balance, 2),
                total_trades=_count_applied(trades, filtered),
                trading_days=len(trading_days),
                profit_target_hit_at=None, filtered_trades=filtered,
            )
        daily_limit = starting_daily_loss_limit(day_start_balance, balance, rules)
        if (day_start_balance - balance) >= daily_limit:
            return ChallengeResult(
                passed=False, days_taken=None, breach_reason="max_daily_loss",
                peak_drawdown_pct=round(peak_dd_pct, 4), end_balance=round(balance, 2),
                total_trades=_count_applied(trades, filtered),
                trading_days=len(trading_days),
                profit_target_hit_at=None, filtered_trades=filtered,
            )

        # --- profit target ---------------------------------------------------
        if target_hit_at is None and (balance - starting_balance) >= starting_balance * rules.profit_target_pct:
            target_hit_at = ensure_utc(t.exit_time)
            if len(trading_days) >= rules.min_trading_days:
                return ChallengeResult(
                    passed=True, days_taken=len(trading_days), breach_reason=None,
                    peak_drawdown_pct=round(peak_dd_pct, 4), end_balance=round(balance, 2),
                    total_trades=_count_applied(trades, filtered),
                    trading_days=len(trading_days),
                    profit_target_hit_at=target_hit_at, filtered_trades=filtered,
                )

    # Ran out of trades. Passed only if target met AND min days satisfied.
    passed = target_hit_at is not None and len(trading_days) >= rules.min_trading_days
    reason = None if passed else ("min_days_not_met" if target_hit_at else "target_not_hit")
    return ChallengeResult(
        passed=passed,
        days_taken=len(trading_days) if passed else None,
        breach_reason=reason,
        peak_drawdown_pct=round(peak_dd_pct, 4),
        end_balance=round(balance, 2),
        total_trades=_count_applied(trades, filtered),
        trading_days=len(trading_days),
        profit_target_hit_at=target_hit_at,
    )


def _count_applied(trades: list[Trade], filtered: int) -> int:
    """Number of trades actually applied to the balance."""
    return max(0, len(trades) - filtered)
