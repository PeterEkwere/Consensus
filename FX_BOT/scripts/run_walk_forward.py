#!/usr/bin/env python3
"""Run walk-forward challenge attempts and print the pass rate.

Example:
    python scripts/run_walk_forward.py --data data_cache/raw/mt5 \
      --symbols EURUSD GBPUSD USDJPY XAUUSD --ltf M5 --htf M15 \
      --from 2025-01-01 --to 2025-06-30 --attempt-days 30 \
      --start-frequency W-MON --account-model fundingpips_2_step_phase_1 \
      --strategy-profile synthetic --risk-pct 0.005 --cost-multiplier 1.5
"""
import _bootstrap  # noqa: F401
import argparse
import json
import statistics
from datetime import datetime, timezone
from pathlib import Path

from backtest.costs import CostConfig, scaled
from backtest.replay import ReplayConfig
from backtest.report import new_run_id
from backtest.walk_forward import (
    failure_breakdown, generate_start_dates, pass_rate, run_walk_forward,
)
from config.prop_rules import get_prop_rules
from config.strategy_profiles import get_strategy
from config.symbols import get_symbol_meta
from data.storage import DataStore


def _date(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data_cache/raw/mt5")
    ap.add_argument("--symbols", nargs="+", default=["EURUSD", "GBPUSD", "USDJPY", "XAUUSD"])
    ap.add_argument("--ltf", default="M5")
    ap.add_argument("--htf", default="M15")
    ap.add_argument("--from", dest="dfrom", type=_date, default=_date("2025-01-01"))
    ap.add_argument("--to", dest="dto", type=_date, default=_date("2025-06-30"))
    ap.add_argument("--attempt-days", type=int, default=30)
    ap.add_argument("--start-frequency", default="W-MON")
    ap.add_argument("--account-model", default="fundingpips_2_step_phase_1")
    ap.add_argument("--strategy-profile", default="synthetic")
    ap.add_argument("--initial-balance", type=float, default=100_000.0)
    ap.add_argument("--risk-pct", type=float, default=0.005)
    ap.add_argument("--cost-multiplier", type=float, default=1.0)
    ap.add_argument("--reports", default="reports")
    return ap.parse_args()


def main() -> int:
    args = parse_args()
    rules = get_prop_rules(args.account_model)
    strategy = get_strategy(args.strategy_profile)
    strategy = type(strategy)(**{**strategy.__dict__, "ltf": args.ltf, "htf": args.htf})
    cost_cfg = scaled(CostConfig(), args.cost_multiplier)
    store = DataStore(args.data)

    base_cfg = ReplayConfig(
        symbols=args.symbols, ltf=args.ltf, htf=args.htf, start=args.dfrom, end=args.dto,
        strategy_profile=args.strategy_profile, risk_pct=args.risk_pct,
        initial_balance=args.initial_balance,
    )
    start_dates = generate_start_dates(args.dfrom, args.dto, args.start_frequency)
    results = run_walk_forward(start_dates, args.attempt_days, store, base_cfg,
                               strategy, cost_cfg, get_symbol_meta, rules)

    passed = sum(1 for r in results if r.result.passed)
    pr = pass_rate(results)
    breakdown = failure_breakdown(results)
    pass_days = [r.result.days_taken for r in results if r.result.passed and r.result.days_taken]
    dds = [r.result.peak_drawdown_pct for r in results]

    print(f"Walk-forward attempts: {len(results)}")
    print(f"Passed: {passed}")
    print(f"Failed: {len(results) - passed}")
    print(f"Pass rate: {pr * 100:.1f}%  (cost multiplier {args.cost_multiplier}x)\n")
    print("Failure breakdown:")
    for reason, count in sorted(breakdown.items(), key=lambda kv: -kv[1]):
        print(f"  {reason}: {count}")
    print()
    if pass_days:
        print(f"Median days to pass: {int(statistics.median(pass_days))}")
    if dds:
        print(f"Median peak DD: {statistics.median(dds) * 100:.1f}%")
        print(f"Worst peak DD: {max(dds) * 100:.1f}%")

    run_id = new_run_id("walk_forward")
    out = Path(args.reports) / run_id
    out.mkdir(parents=True, exist_ok=True)
    summary = {
        "attempts": len(results), "passed": passed, "pass_rate": pr,
        "cost_multiplier": args.cost_multiplier, "attempt_days": args.attempt_days,
        "failure_breakdown": breakdown,
        "attempts_detail": [
            {"start": r.start_date.isoformat(), "passed": r.result.passed,
             "breach_reason": r.result.breach_reason, "days_taken": r.result.days_taken,
             "peak_dd_pct": r.result.peak_drawdown_pct, "end_balance": r.result.end_balance}
            for r in results
        ],
    }
    (out / "walk_forward.json").write_text(json.dumps(summary, indent=2))
    print(f"\nReport written to {out}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
