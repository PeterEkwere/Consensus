#!/usr/bin/env python3
"""Run one backtest and write a report.

Example:
    python scripts/run_backtest.py --data data_cache/raw/mt5 \
      --symbols EURUSD GBPUSD USDJPY XAUUSD --ltf M5 --htf M15 \
      --start 2025-01-01 --end 2025-06-30 \
      --account-model fundingpips_2_step_phase_1 --strategy-profile synthetic \
      --risk-pct 0.005 --cost-multiplier 1.0
"""
import _bootstrap  # noqa: F401
import argparse
from datetime import datetime, timezone

from backtest.costs import CostConfig, scaled
from backtest.metrics import summarize_trades
from backtest.prop_simulator import simulate_challenge
from backtest.replay import ReplayConfig, replay_portfolio
from backtest.report import new_run_id, write_report
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
    ap.add_argument("--start", type=_date, default=_date("2025-01-01"))
    ap.add_argument("--end", type=_date, default=_date("2025-06-30"))
    ap.add_argument("--account-model", default="fundingpips_2_step_phase_1")
    ap.add_argument("--strategy-profile", default="synthetic")
    ap.add_argument("--initial-balance", type=float, default=100_000.0)
    ap.add_argument("--risk-pct", type=float, default=0.005)
    ap.add_argument("--cost-multiplier", type=float, default=1.0)
    ap.add_argument("--reports", default="reports")
    return ap.parse_args()


def run(args) -> int:
    rules = get_prop_rules(args.account_model)
    strategy = get_strategy(args.strategy_profile)
    strategy = type(strategy)(**{**strategy.__dict__, "ltf": args.ltf, "htf": args.htf})
    cost_cfg = scaled(CostConfig(), args.cost_multiplier)
    store = DataStore(args.data)

    replay_cfg = ReplayConfig(
        symbols=args.symbols, ltf=args.ltf, htf=args.htf,
        start=args.start, end=args.end, strategy_profile=args.strategy_profile,
        risk_pct=args.risk_pct, initial_balance=args.initial_balance,
    )
    trades, signals = replay_portfolio(store, replay_cfg, strategy, cost_cfg, get_symbol_meta)
    result = simulate_challenge(trades, rules, args.initial_balance, news_events=[])
    metrics = summarize_trades(trades, args.initial_balance)

    print(f"Backtest: {args.account_model}")
    print(f"Period: {args.start.date()} -> {args.end.date()}")
    print(f"Symbols: {', '.join(args.symbols)}")
    print(f"Timeframes: {args.ltf} entries, {args.htf} structure")
    print(f"Cost multiplier: {args.cost_multiplier}x\n")
    print(f"Signals found: {signals}")
    print(f"Trades filled: {metrics['trades']}")
    print(f"Win rate: {metrics['win_rate'] * 100:.1f}%")
    print(f"Avg net R: {metrics['expectancy_r']:.3f}")
    print(f"Profit factor: {metrics['profit_factor']}")
    print(f"Max drawdown: {metrics['max_drawdown_pct'] * 100:.1f}%")
    print(f"Worst day: {metrics['worst_day_pct'] * 100:.1f}%\n")
    print("Challenge result:")
    print(f"PASSED: {'yes' if result.passed else 'no'}")
    print(f"Days taken: {result.days_taken}")
    print(f"End balance: {result.end_balance}")
    print(f"Peak drawdown: {result.peak_drawdown_pct * 100:.1f}%")
    print(f"Breach reason: {result.breach_reason or 'none'}\n")

    config = {
        "account_model": args.account_model, "strategy_profile": args.strategy_profile,
        "symbols": args.symbols, "ltf": args.ltf, "htf": args.htf,
        "start": args.start, "end": args.end, "risk_pct": args.risk_pct,
        "initial_balance": args.initial_balance, "cost_multiplier": args.cost_multiplier,
    }
    run_id = new_run_id("backtest")
    out = write_report(args.reports, run_id, config, trades, result, args.initial_balance, signals)
    print(f"Report written to {out}/")
    return 0


def main() -> int:
    return run(parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
