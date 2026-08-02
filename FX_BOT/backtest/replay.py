"""No-look-ahead backtest replay.

For each closed LTF candle:
  - expose LTF candles up to now only,
  - expose HTF candles closed at or before now only,
  - advance the setup state machine (the same ``find_setup`` the live bot uses),
  - on an entry signal, fill the retest and open a trade,
  - manage the open trade candle-by-candle until stop/target.

Position sizing risks a fixed fraction of the *current* balance per trade, so the
sequence of trades is realistic for prop-rule simulation.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from backtest.costs import CostConfig, commission_cost_usd
from backtest.fill_model import EntryFill, simulate_entry_fill, simulate_exit_on_candle
from domain.models import Candle, Signal, Trade
from domain.series import CandleSeries, as_series
from domain.time_utils import ensure_utc, timeframe_minutes
from signal_engine.setup import find_setup
from signal_engine.setup_state import initial_state

# Rolling detection windows. 90 LTF bars comfortably covers 2/2 fractal
# confirmation plus a full <=12-bar setup lifecycle; 60 HTF bars is ample context.
_LTF_WINDOW = 90
_HTF_WINDOW = 60


@dataclass(frozen=True)
class ReplayConfig:
    symbols: list[str]
    ltf: str
    htf: str
    start: datetime
    end: datetime
    strategy_profile: str = "default"
    risk_pct: float = 0.005
    initial_balance: float = 100_000.0
    max_open_trades: int = 3
    one_trade_per_symbol: bool = True
    max_hold_bars: int = 60  # force-exit stale trades (session-close proxy)


def pip_value_per_lot(symbol_meta, price: float, account_currency: str = "USD") -> float:
    """Approximate pip value per 1.0 lot in the account currency.

    - Quote == account currency (e.g. EURUSD/USD): contract_size * pip_size.
    - Base == account currency (e.g. USDJPY/USD): that value divided by price.
    Confirm exact values against MT5 ``symbol_info`` before live use.
    """
    base_value = symbol_meta.contract_size * symbol_meta.pip_size
    if symbol_meta.quote_currency == account_currency:
        return base_value
    if symbol_meta.base_currency == account_currency and price > 0:
        return base_value / price
    return base_value  # fallback approximation for cross pairs


def round_lots_down(lots: float, lot_step: float, min_lot: float, max_lot: float) -> float:
    """Round a lot size DOWN to the broker step, clamped to [min, max]."""
    if lots < min_lot:
        return 0.0
    stepped = math.floor(lots / lot_step) * lot_step
    stepped = max(min_lot, min(stepped, max_lot))
    return round(stepped, 2)


@dataclass
class _OpenTrade:
    signal: Signal
    symbol: str
    direction: str
    entry_price: float
    entry_time: datetime
    stop_price: float
    target_price: float
    lots: float
    risk_amount: float
    bars_held: int = 0


def _close_trade(ot: _OpenTrade, exit_price: float, exit_time: datetime, reason: str,
                 symbol_meta, cost_cfg: CostConfig, trade_id: str) -> Trade:
    pip = symbol_meta.pip_size
    dir_sign = 1.0 if ot.direction == "long" else -1.0
    pnl_pips = (exit_price - ot.entry_price) / pip * dir_sign
    per_pip_usd = ot.lots * pip_value_per_lot(symbol_meta, ot.entry_price)
    gross_pnl = pnl_pips * per_pip_usd
    commission = commission_cost_usd(ot.lots, symbol_meta, cost_cfg)
    net_pnl = gross_pnl - commission
    stop_pips = abs(ot.entry_price - ot.stop_price) / pip
    gross_r = (pnl_pips / stop_pips) if stop_pips > 0 else 0.0
    net_r = (net_pnl / ot.risk_amount) if ot.risk_amount > 0 else 0.0
    return Trade(
        id=trade_id,
        symbol=ot.symbol,
        direction=ot.direction,  # type: ignore[arg-type]
        entry_time=ot.entry_time,
        exit_time=exit_time,
        entry_price=ot.entry_price,
        exit_price=exit_price,
        stop_price=ot.stop_price,
        target_price=ot.target_price,
        lots=ot.lots,
        gross_r=round(gross_r, 4),
        net_r=round(net_r, 4),
        gross_pnl=round(gross_pnl, 2),
        net_pnl=round(net_pnl, 2),
        exit_reason=reason,  # type: ignore[arg-type]
        confluence=dict(ot.signal.confluence),
    )


def replay_symbol(
    symbol: str,
    ltf_candles,
    htf_candles,
    strategy_cfg,
    symbol_meta,
    cost_cfg: CostConfig,
    replay_cfg: ReplayConfig,
) -> tuple[list[Trade], int]:
    """Replay one symbol. Returns (closed_trades, signal_count).

    Balance for sizing is held flat at ``initial_balance`` here; the portfolio-level
    running balance is applied in ``replay_portfolio`` where trade order is known.
    """
    ltf = as_series(ltf_candles)
    htf = as_series(htf_candles)
    ltf_min = timeframe_minutes(strategy_cfg.ltf)
    htf_min = timeframe_minutes(strategy_cfg.htf)

    # Rolling lookback windows keep detection O(1) per candle instead of O(n).
    # The state machine carries its own state across candles, so it only needs
    # enough recent bars to build levels and confirm the current setup step.
    # A monotonic HTF pointer avoids rescanning all HTF candles each bar.
    htf_candles_seq = htf.candles
    n_htf = len(htf_candles_seq)
    hj = 0  # count of HTF candles closed by the current decision time

    state = initial_state(symbol)
    open_trade: _OpenTrade | None = None
    trades: list[Trade] = []
    signal_count = 0

    for i in range(len(ltf)):
        candle = ltf[i]
        decision_time = ensure_utc(candle.time) + timedelta(minutes=ltf_min)

        # 1) Manage an open trade on this candle first.
        if open_trade is not None:
            open_trade.bars_held += 1
            exit_fill = simulate_exit_on_candle(candle, open_trade, symbol_meta, cost_cfg)
            if exit_fill is not None:
                trades.append(_close_trade(
                    open_trade, exit_fill.price, candle.time, exit_fill.reason,
                    symbol_meta, cost_cfg, f"{symbol}-{len(trades)}"))
                open_trade = None
            elif open_trade.bars_held >= replay_cfg.max_hold_bars:
                # Force close at the candle close as a session/time stop.
                trades.append(_close_trade(
                    open_trade, candle.close, candle.time, "session_close",
                    symbol_meta, cost_cfg, f"{symbol}-{len(trades)}"))
                open_trade = None

        # Advance the monotonic HTF pointer to all HTF bars closed by now.
        while hj < n_htf and (
            ensure_utc(htf_candles_seq[hj].time) + timedelta(minutes=htf_min) <= decision_time
        ):
            hj += 1

        # 2) Look for a new setup only when flat (one trade per symbol).
        if open_trade is None or not replay_cfg.one_trade_per_symbol:
            lo = max(0, i + 1 - _LTF_WINDOW)
            ltf_view = ltf[lo: i + 1]
            htf_view = CandleSeries(htf_candles_seq[max(0, hj - _HTF_WINDOW): hj])
            state, signal = find_setup(state, ltf_view, htf_view, strategy_cfg, symbol_meta)
            if signal is not None and open_trade is None:
                signal_count += 1
                fill = simulate_entry_fill(candle, signal, symbol_meta, cost_cfg)
                lots = _size_position(signal, replay_cfg.initial_balance, replay_cfg.risk_pct, symbol_meta, fill)
                if lots > 0:
                    risk_amount = replay_cfg.risk_pct * replay_cfg.initial_balance
                    open_trade = _OpenTrade(
                        signal=signal, symbol=symbol, direction=signal.direction,
                        entry_price=fill.price, entry_time=candle.time,
                        stop_price=signal.stop, target_price=signal.target,
                        lots=lots, risk_amount=risk_amount,
                    )
    return trades, signal_count


def _size_position(signal: Signal, balance: float, risk_pct: float, symbol_meta, fill: EntryFill) -> float:
    risk_amount = risk_pct * balance
    stop_pips = abs(fill.price - signal.stop) / symbol_meta.pip_size
    if stop_pips <= 0:
        return 0.0
    per_pip_usd = pip_value_per_lot(symbol_meta, fill.price)
    raw_lots = risk_amount / (stop_pips * per_pip_usd)
    return round_lots_down(raw_lots, symbol_meta.lot_step, symbol_meta.min_lot, symbol_meta.max_lot)


def replay_portfolio(
    data_store,
    replay_cfg: ReplayConfig,
    strategy_cfg,
    cost_cfg: CostConfig,
    symbol_meta_lookup,
) -> tuple[list[Trade], int]:
    """Replay all symbols and merge trades in entry-time order.

    ``max_open_trades`` is enforced as a portfolio concurrency cap when merging.
    Returns (executed_trades, total_signal_count).
    """
    all_trades: list[Trade] = []
    total_signals = 0
    for symbol in replay_cfg.symbols:
        meta = symbol_meta_lookup(symbol)
        ltf = data_store.load(symbol, strategy_cfg.ltf)
        htf = data_store.load(symbol, strategy_cfg.htf)
        ltf = [c for c in ltf if replay_cfg.start <= ensure_utc(c.time) <= replay_cfg.end]
        htf = [c for c in htf if ensure_utc(c.time) <= replay_cfg.end]
        trades, sig = replay_symbol(symbol, ltf, htf, strategy_cfg, meta, cost_cfg, replay_cfg)
        all_trades.extend(trades)
        total_signals += sig

    all_trades.sort(key=lambda t: ensure_utc(t.entry_time))
    executed = _apply_concurrency_cap(all_trades, replay_cfg.max_open_trades)
    return executed, total_signals


def _apply_concurrency_cap(trades: list[Trade], max_open: int) -> list[Trade]:
    """Drop trades that would exceed ``max_open`` simultaneously open positions."""
    executed: list[Trade] = []
    open_intervals: list[datetime] = []  # exit times of currently-open accepted trades
    for t in trades:
        entry = ensure_utc(t.entry_time)
        open_intervals = [x for x in open_intervals if x > entry]
        if len(open_intervals) < max_open:
            executed.append(t)
            open_intervals.append(ensure_utc(t.exit_time))
    return executed
