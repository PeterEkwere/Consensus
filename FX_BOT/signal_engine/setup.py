"""The single strategy entry point shared by backtest and live scanner.

``find_setup`` is the ONLY function both ``backtest/`` and ``scanner/`` may call to
get setups. It performs no I/O. Keeping one entry point is what guarantees the
backtest and the live bot trade identical logic.
"""
from __future__ import annotations

from typing import Sequence

from domain.enums import TERMINAL_STAGES
from domain.models import Candle, SetupState, Signal
from domain.series import CandleSeries, as_series
from signal_engine.momentum import momentum_score
from signal_engine.setup_state import advance_setup_state, initial_state


def build_signal_from_state(
    state: SetupState,
    ltf_candles: Sequence[Candle] | CandleSeries,
    cfg,
    symbol_meta,
) -> Signal | None:
    """Convert an entry-triggered state into a tradable ``Signal``."""
    if state.stage != "entry_triggered":
        return None
    if state.entry_level is None or state.stop_price is None or state.target_price is None:
        return None

    s = as_series(ltf_candles)
    pip_size = symbol_meta.pip_size
    entry = state.entry_level
    stop = state.stop_price
    target = state.target_price
    risk = abs(entry - stop)
    reward = abs(target - entry)
    stop_pips = risk / pip_size
    planned_r = reward / risk if risk > 0 else 0.0

    confluence = dict(state.confluence)
    confluence.setdefault(
        "momentum", round(momentum_score(s, cfg.atr_period, cfg.atr_mean_lookback), 3)
    )

    return Signal(
        symbol=state.symbol,
        direction=state.direction,  # type: ignore[arg-type]
        timeframe=cfg.ltf,
        signal_time=s.last.time,
        entry=entry,
        stop=stop,
        target=target,
        stop_pips=round(stop_pips, 2),
        planned_r=round(planned_r, 3),
        confluence=confluence,
        setup_state=state,
    )


def find_setup(
    previous_state: SetupState,
    ltf_candles: Sequence[Candle] | CandleSeries,
    htf_candles: Sequence[Candle] | CandleSeries,
    cfg,
    symbol_meta,
) -> tuple[SetupState, Signal | None]:
    """Advance the setup by one candle and emit a Signal on entry.

    If the previous state is terminal (entry_triggered / invalidated / expired),
    the hunt restarts from idle so the next setup can form.
    """
    state = previous_state
    if state.stage in TERMINAL_STAGES:
        state = initial_state(state.symbol)

    new_state = advance_setup_state(state, ltf_candles, htf_candles, cfg, symbol_meta)

    signal = None
    if new_state.stage == "entry_triggered":
        signal = build_signal_from_state(new_state, ltf_candles, cfg, symbol_meta)
    return new_state, signal
