"""Tunable strategy parameters, grouped into named profiles.

All strategy thresholds live here so the same ``signal_engine`` code can be
retuned without edits. Backtest and live scanner must load the SAME profile.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class StrategyConfig:
    ltf: str = "M5"
    htf: str = "M15"
    swing_left: int = 2
    swing_right: int = 2
    equal_level_tolerance_pips: float = 2.0
    level_proximity_pips: float = 3.0
    pin_wick_body_ratio: float = 2.0
    atr_period: int = 14
    atr_mean_lookback: int = 20
    min_atr_ratio: float = 1.0
    min_planned_r: float = 2.0
    max_setup_age_bars: int = 12
    min_quality_score: float = 70.0
    allowed_sessions: tuple[str, ...] = ("london_open", "ny_open", "london_ny_overlap")

    # BOS confirmation: a close must clear the swing by this many pips to count,
    # which rejects marginal/wick-like breaks.
    bos_min_close_buffer_pips: float = 0.5
    # Rejection candle must close in the outer third of its range to qualify.
    rejection_close_third: float = 1.0 / 3.0


PROFILES: dict[str, StrategyConfig] = {
    "default": StrategyConfig(),
    # Tuned for the synthetic demo generator (data/synthetic.py). Keeps the real
    # 2/2 fractal confirmation but widens sweep proximity so the motif geometry is
    # detected reliably. NOT a tuned trading profile.
    "synthetic": StrategyConfig(
        swing_left=2,
        swing_right=2,
        level_proximity_pips=8.0,
        equal_level_tolerance_pips=2.0,
        bos_min_close_buffer_pips=0.5,
        min_planned_r=2.0,
        max_setup_age_bars=12,
    ),
    # Wider, calmer variant for gold-like instruments.
    "xau_wide": StrategyConfig(
        level_proximity_pips=6.0,
        equal_level_tolerance_pips=4.0,
        bos_min_close_buffer_pips=1.0,
        min_planned_r=1.8,
    ),
}


def get_strategy(name: str = "default") -> StrategyConfig:
    """Look up a strategy profile by name."""
    try:
        return PROFILES[name]
    except KeyError as exc:
        known = ", ".join(sorted(PROFILES))
        raise KeyError(f"Unknown strategy profile {name!r}. Known: {known}") from exc
