"""Walk-forward challenge testing.

Runs many simulated challenge attempts starting at staggered dates. The headline
metric for this system is the FundingPips PASS RATE across attempts with zero rule
breaches — not win rate.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta

from backtest.prop_simulator import ChallengeResult, simulate_challenge
from backtest.replay import ReplayConfig, replay_portfolio
from domain.time_utils import ensure_utc


@dataclass(frozen=True)
class AttemptResult:
    start_date: datetime
    result: ChallengeResult


def generate_start_dates(start: datetime, end: datetime, frequency: str = "W-MON") -> list[datetime]:
    """Generate challenge start dates. Supports weekly (W-*) and daily (D) cadence."""
    start = ensure_utc(start)
    end = ensure_utc(end)
    if frequency.upper().startswith("W"):
        step = timedelta(weeks=1)
        # Align to Monday if W-MON requested.
        cur = start
        if frequency.upper() == "W-MON":
            cur = start + timedelta(days=(7 - start.weekday()) % 7)
    elif frequency.upper() == "D":
        step = timedelta(days=1)
        cur = start
    else:
        step = timedelta(weeks=1)
        cur = start

    dates: list[datetime] = []
    while cur < end:
        dates.append(cur)
        cur = cur + step
    return dates


def run_attempt(
    start_date: datetime,
    attempt_days: int,
    data_store,
    base_replay_cfg: ReplayConfig,
    strategy_cfg,
    cost_cfg,
    symbol_meta_lookup,
    rules,
) -> ChallengeResult:
    """Run one challenge attempt over ``[start_date, start_date + attempt_days]``."""
    end_date = start_date + timedelta(days=attempt_days)
    cfg = replace(base_replay_cfg, start=start_date, end=end_date)
    trades, _ = replay_portfolio(data_store, cfg, strategy_cfg, cost_cfg, symbol_meta_lookup)
    return simulate_challenge(trades, rules, rules.initial_balance, news_events=[])


def run_walk_forward(
    start_dates: list[datetime],
    attempt_days: int,
    data_store,
    base_replay_cfg: ReplayConfig,
    strategy_cfg,
    cost_cfg,
    symbol_meta_lookup,
    rules,
) -> list[AttemptResult]:
    """Return one result per challenge attempt."""
    out: list[AttemptResult] = []
    for sd in start_dates:
        res = run_attempt(sd, attempt_days, data_store, base_replay_cfg,
                          strategy_cfg, cost_cfg, symbol_meta_lookup, rules)
        out.append(AttemptResult(start_date=sd, result=res))
    return out


def pass_rate(results: list[AttemptResult]) -> float:
    """Share of attempts that passed with no breach."""
    if not results:
        return 0.0
    return sum(1 for r in results if r.result.passed) / len(results)


def failure_breakdown(results: list[AttemptResult]) -> dict[str, int]:
    """Count attempts by breach/failure reason."""
    out: dict[str, int] = {}
    for r in results:
        if r.result.passed:
            continue
        reason = r.result.breach_reason or "unknown"
        out[reason] = out.get(reason, 0) + 1
    return out
