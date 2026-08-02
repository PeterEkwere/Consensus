"""The setup lifecycle as a PURE state machine.

The strategy is sequential:

    trend -> key level -> sweep -> rejection -> BOS -> retest -> entry

Rather than a one-shot detector, it is modelled as an explicit state machine that
advances at most one step per closed candle and can invalidate or expire from any
active stage. Every transition is a pure function of (previous state, closed
candles) — no I/O, no globals, fully deterministic.

Stages:
    idle -> sweep_found -> rejection_confirmed -> bos_confirmed
         -> waiting_retest -> entry_triggered
    any active stage -> invalidated
    any active stage -> expired
"""
from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
from typing import Sequence

from domain.enums import ACTIVE_STAGES, TERMINAL_STAGES
from domain.models import Candle, SetupState
from domain.series import CandleSeries, as_series
from domain.time_utils import ensure_utc, timeframe_minutes
from signal_engine.candles import classify_rejection
from signal_engine.levels import key_levels
from signal_engine.liquidity import detect_sweep
from signal_engine.momentum import momentum_score
from signal_engine.structure import break_of_structure, swing_points


def initial_state(symbol: str) -> SetupState:
    """Return the idle starting state for a symbol."""
    return SetupState(symbol=symbol, stage="idle")


def _age_in_bars(series: CandleSeries, created_at) -> int:
    """Number of closed candles that have printed strictly after ``created_at``."""
    ref = ensure_utc(created_at)
    return sum(1 for c in series if ensure_utc(c.time) > ref)


def advance_setup_state(
    state: SetupState,
    ltf_candles: Sequence[Candle] | CandleSeries,
    htf_candles: Sequence[Candle] | CandleSeries,
    cfg,
    symbol_meta,
) -> SetupState:
    """Advance one symbol's setup by one closed candle. Pure and deterministic."""
    s = as_series(ltf_candles)
    if s.is_empty():
        return state
    last = s.last
    pip_size = symbol_meta.pip_size

    # Terminal stages never change; the caller resets via find_setup.
    if state.stage in TERMINAL_STAGES:
        return state

    # --- guards that apply to any live setup --------------------------------
    if state.stage in ACTIVE_STAGES:
        # Invalidation: the sweep wick was reclaimed against the setup direction.
        if state.sweep is not None:
            if state.direction == "long" and last.low < state.sweep.wick_price:
                return replace(state, stage="invalidated")
            if state.direction == "short" and last.high > state.sweep.wick_price:
                return replace(state, stage="invalidated")
        # Expiry: the setup took too long to mature.
        if state.created_at is not None and _age_in_bars(s, state.created_at) > cfg.max_setup_age_bars:
            return replace(state, stage="expired")

    # --- forward transitions -------------------------------------------------
    if state.stage == "idle":
        return _try_sweep(state, s, htf_candles, cfg, symbol_meta)
    if state.stage == "sweep_found":
        return _try_rejection(state, s, cfg)
    if state.stage == "rejection_confirmed":
        return _try_bos(state, s, cfg, symbol_meta)
    if state.stage == "bos_confirmed":
        return _to_waiting_retest(state)
    if state.stage == "waiting_retest":
        return _try_entry(state, s)
    return state


def _try_sweep(state, s: CandleSeries, htf, cfg, symbol_meta) -> SetupState:
    pip_size = symbol_meta.pip_size
    levels = key_levels(s, htf, pip_size, cfg)
    sweep = detect_sweep(s, levels, pip_size, cfg.level_proximity_pips)
    if sweep is None:
        return state
    ltf_min = timeframe_minutes(cfg.ltf)
    expires_at = ensure_utc(sweep.time) + timedelta(minutes=ltf_min * cfg.max_setup_age_bars)
    confluence = {
        "sweep_reclaim_pips": round(sweep.reclaim_distance_pips, 2),
        "momentum": round(momentum_score(s, cfg.atr_period, cfg.atr_mean_lookback), 3),
    }
    return replace(
        state,
        stage="sweep_found",
        direction=sweep.direction,
        sweep=sweep,
        created_at=sweep.time,
        expires_at=expires_at,
        confluence=confluence,
    )


def _try_rejection(state, s: CandleSeries, cfg) -> SetupState:
    rej = classify_rejection(s, state.direction, cfg)
    if rej is None:
        return state
    confluence = dict(state.confluence)
    confluence["rejection_strength"] = round(rej.strength, 3)
    return replace(state, stage="rejection_confirmed", rejection=rej, confluence=confluence)


def _try_bos(state, s: CandleSeries, cfg, symbol_meta) -> SetupState:
    pip_size = symbol_meta.pip_size
    swings = swing_points(s, cfg.swing_left, cfg.swing_right)
    bos = break_of_structure(s, swings, state.direction, cfg.bos_min_close_buffer_pips, pip_size)
    if bos is None:
        return state

    # Entry plan: retest of the broken structure, stop beyond the sweep wick.
    entry_level = bos.broken_swing.price
    buffer = cfg.bos_min_close_buffer_pips * pip_size
    if state.direction == "long":
        stop_price = state.sweep.wick_price - buffer
        risk = entry_level - stop_price
        target_price = entry_level + cfg.min_planned_r * risk
    else:
        stop_price = state.sweep.wick_price + buffer
        risk = stop_price - entry_level
        target_price = entry_level - cfg.min_planned_r * risk

    if risk <= 0:  # degenerate geometry; abandon rather than emit a bad plan
        return replace(state, stage="invalidated")

    confluence = dict(state.confluence)
    confluence["bos_clean"] = 1.0 if bos.clean_break else 0.0
    return replace(
        state,
        stage="bos_confirmed",
        bos=bos,
        entry_level=entry_level,
        stop_price=stop_price,
        target_price=target_price,
        confluence=confluence,
    )


def _to_waiting_retest(state) -> SetupState:
    """Internal rename: the break is confirmed, now await the retest pullback."""
    return replace(state, stage="waiting_retest")


def _try_entry(state, s: CandleSeries) -> SetupState:
    last = s.last
    if state.direction == "long" and last.low <= state.entry_level:
        return replace(state, stage="entry_triggered")
    if state.direction == "short" and last.high >= state.entry_level:
        return replace(state, stage="entry_triggered")
    return state
