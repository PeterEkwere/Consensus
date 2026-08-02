"""Report writer.

Every backtest run writes a self-contained, reproducible report directory:

    reports/{run_id}/
      config.json          (mandatory — the exact run configuration)
      trades.csv
      signals.csv
      equity_curve.csv
      challenge_result.json
      metrics.json
      summary.md
"""
from __future__ import annotations

import csv
import json
from dataclasses import asdict, is_dataclass
from datetime import datetime
from pathlib import Path

from backtest.metrics import equity_curve, summarize_trades
from domain.models import Trade


def _json_default(o):
    if isinstance(o, datetime):
        return o.isoformat()
    if is_dataclass(o):
        return asdict(o)
    return str(o)


def new_run_id(prefix: str) -> str:
    return f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{prefix}"


def write_report(
    reports_dir: str | Path,
    run_id: str,
    config: dict,
    trades: list[Trade],
    challenge_result,
    starting_balance: float,
    signals_count: int,
) -> Path:
    """Write the full report directory and return its path."""
    out = Path(reports_dir) / run_id
    out.mkdir(parents=True, exist_ok=True)

    (out / "config.json").write_text(json.dumps(config, indent=2, default=_json_default))

    with (out / "trades.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "symbol", "direction", "entry_time", "exit_time", "entry_price",
                    "exit_price", "stop_price", "target_price", "lots", "gross_r", "net_r",
                    "gross_pnl", "net_pnl", "exit_reason"])
        for t in trades:
            w.writerow([t.id, t.symbol, t.direction, t.entry_time.isoformat(), t.exit_time.isoformat(),
                        t.entry_price, t.exit_price, t.stop_price, t.target_price, t.lots,
                        t.gross_r, t.net_r, t.gross_pnl, t.net_pnl, t.exit_reason])

    with (out / "signals.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["signals_found", "trades_filled"])
        w.writerow([signals_count, len(trades)])

    curve = equity_curve(trades, starting_balance)
    with (out / "equity_curve.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["step", "balance"])
        for i, bal in enumerate(curve):
            w.writerow([i, round(bal, 2)])

    (out / "challenge_result.json").write_text(
        json.dumps(challenge_result, indent=2, default=_json_default)
    )

    metrics = summarize_trades(trades, starting_balance)
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2, default=_json_default))

    (out / "summary.md").write_text(_summary_md(run_id, config, metrics, challenge_result, signals_count))
    return out


def _summary_md(run_id, config, metrics, cr, signals_count) -> str:
    cr_d = asdict(cr) if is_dataclass(cr) else dict(cr)
    lines = [
        f"# Backtest summary — {run_id}",
        "",
        f"- Account model: {config.get('account_model')}",
        f"- Period: {config.get('start')} → {config.get('end')}",
        f"- Symbols: {', '.join(config.get('symbols', []))}",
        f"- Timeframes: {config.get('ltf')} entries / {config.get('htf')} structure",
        f"- Cost multiplier: {config.get('cost_multiplier')}x",
        "",
        "## Strategy",
        f"- Signals found: {signals_count}",
        f"- Trades filled: {metrics['trades']}",
        f"- Win rate: {metrics['win_rate'] * 100:.1f}%",
        f"- Avg net R: {metrics['expectancy_r']:.3f}",
        f"- Profit factor: {metrics['profit_factor']}",
        f"- Max drawdown: {metrics['max_drawdown_pct'] * 100:.1f}%",
        f"- Worst day: {metrics['worst_day_pct'] * 100:.1f}%",
        f"- Net PnL: {metrics['net_pnl']}",
        "",
        "## Challenge result",
        f"- Passed: {'yes' if cr_d.get('passed') else 'no'}",
        f"- Days taken: {cr_d.get('days_taken')}",
        f"- End balance: {cr_d.get('end_balance')}",
        f"- Peak drawdown: {cr_d.get('peak_drawdown_pct', 0) * 100:.1f}%",
        f"- Breach reason: {cr_d.get('breach_reason') or 'none'}",
        "",
    ]
    return "\n".join(lines)
