# Scalp Bot — SMC Scalping Signal Engine + FundingPips Backtester

An engineering/research system that (eventually) can:

1. Backtest a Smart-Money-Concepts / price-action scalping strategy **without look-ahead**.
2. Simulate FundingPips challenge rules before any live use.
3. Run a live Telegram **alert-only** bot (it never places orders).

This is not financial advice. The strategy must be proven in simulation before the
live alert bot is built. Full design: [`docs/SCALPING_SIGNAL_BOT_ARCHITECTURE.md`](docs/SCALPING_SIGNAL_BOT_ARCHITECTURE.md).

## Status

- **Phase 1 — Battle-tested architecture: ✅ complete.**
  `config/`, `domain/`, `signal_engine/` (pure state machine) and the Phase-1 unit
  test suite are implemented and green.
- **Phase 2 — Data extraction + backtest: ✅ complete (runs on synthetic data).**
  `data/`, `backtest/`, and the `scripts/` pipeline run end-to-end and write
  reports. See [Phase 2](#phase-2--backtest-pipeline) — including an important
  honesty note: the demo runs on **synthetic** data because MT5 is unavailable here,
  so the pass rates prove the *pipeline*, not the *strategy*.
- Phase 3 (live scanner + guardrail + Telegram) is not started.

## Phase 2 — backtest pipeline

```
data/       MT5 feed + CSV import, CSV/parquet storage, validation, news calendar
backtest/   costs, fill model, no-look-ahead replay, prop simulator, metrics,
            walk-forward, report writer
scripts/    fetch_mt5_history, make_synthetic_history, validate_history,
            run_backtest, run_walk_forward
```

Run the whole pipeline without MT5 (uses the synthetic generator):

```bash
python3 scripts/make_synthetic_history.py --symbols EURUSD GBPUSD USDJPY XAUUSD \
    --start 2025-01-01 --end 2025-06-30 --out data_cache/raw/mt5
python3 scripts/validate_history.py --data data_cache/raw/mt5 \
    --symbols EURUSD GBPUSD USDJPY XAUUSD --timeframes M5 M15
python3 scripts/run_backtest.py      --strategy-profile synthetic --cost-multiplier 1.0
python3 scripts/run_walk_forward.py  --strategy-profile synthetic --cost-multiplier 1.5
```

Each run writes a reproducible `reports/{run_id}/` (config.json, trades.csv,
signals.csv, equity_curve.csv, challenge_result.json, metrics.json, summary.md).

### Real history (no MT5, works on macOS) — Dukascopy

MT5's Python API is Windows-only. To pull **real candles on a Mac with no account
and no API key** (so it can't be region-blocked), use the Dukascopy adapter. It
downloads free historical ticks (bid + ask → **real per-bar spread**) and aggregates
them into candles, pure standard library:

```bash
python3 scripts/fetch_dukascopy_history.py \
    --symbols EURUSD GBPUSD USDJPY XAUUSD --timeframes M5 M15 \
    --start 2024-01-01 --end 2025-06-30 --out data_cache/raw/mt5
# then validate + backtest with a REAL strategy profile (NOT 'synthetic'):
python3 scripts/validate_history.py --data data_cache/raw/mt5 \
    --symbols EURUSD GBPUSD USDJPY XAUUSD --timeframes M5 M15
python3 scripts/run_backtest.py --strategy-profile default --cost-multiplier 1.0
```

It downloads one `.bi5` file per hour, so a multi-month pull is **slow** — that is
expected. Output lands in the same `data_cache/raw/mt5/{symbol}/{tf}.csv` layout, so
everything downstream runs unchanged.

**macOS SSL note:** if you hit `CERTIFICATE_VERIFY_FAILED`, your Python has no root
certs. Fix it (`pip install certifi`, or run *Install Certificates.command* in your
Python folder), or re-run with `--insecure` as a last resort.

Other feeds are also included but secondary: `scripts/fetch_oanda_history.py` (OANDA
v20 — broker-grade + real spread, but blocks signups in some regions) and
`scripts/fetch_mt5_history.py` (broker-exact, Windows + MT5 terminal only).

> When you switch to real data, drop `--strategy-profile synthetic` (that profile
> only exists to detect the demo generator's motifs). Use `default` / `xau_wide`,
> and expect the pass rates to look very different — that is the real test.

> ⚠️ **The pass rates are meaningless as strategy validation.** The synthetic
> generator deliberately embeds detectable winning motifs, so a high pass rate only
> confirms the plumbing (replay → costs → prop rules → reports) is correct. Real MT5
> history is required before the doc's "minimum proof before live use" gates mean
> anything. Do not proceed to Phase 3 on synthetic results.

## Layout (Phase 1)

```
config/          prop rules, symbols, strategy profiles, settings (all parameterised)
domain/          frozen data models, enums, time/no-look-ahead utils, CandleSeries
signal_engine/   structure, levels, liquidity, candles, momentum, setup_state, setup
tests/           structure / liquidity / candles / setup_state / no_lookahead
```

The single strategy entry point is `signal_engine.setup.find_setup` — the ONLY hook
both the future backtester and live scanner may call, which guarantees they trade
identical logic.

## Setup lifecycle (state machine)

```
idle -> sweep_found -> rejection_confirmed -> bos_confirmed -> waiting_retest -> entry_triggered
                    any active stage -> invalidated | expired
```

Each transition is a pure function of `(previous state, closed candles)`. No I/O,
no globals, fully deterministic.

## Running the tests

Phase 1 has **zero third-party dependencies** — standard library only, plus pytest.

```bash
python3 -m pytest
# or the exact Phase-1 acceptance command from the architecture doc:
python3 -m pytest tests/test_structure.py tests/test_liquidity.py tests/test_candles.py \
                  tests/test_setup_state.py tests/test_no_lookahead.py
```

## Design note: no pandas in the core engine (Phase 1 deviation)

The architecture doc sketches detectors taking `pandas.DataFrame`. Phase 1 instead
uses a small immutable `domain.series.CandleSeries` over `tuple[Candle, ...]`
(see [Deviations](#deviations-from-the-doc)). pandas/numpy/pyarrow are declared as
the optional `data` extra and are only needed from Phase 2 onward:

```bash
pip install -e ".[data,dev]"   # when starting Phase 2
```

## Deviations from the doc

1. **`CandleSeries` instead of `pandas.DataFrame`** in the core engine — keeps
   Phase 1 dependency-free and trivially deterministic to test. The public surface
   (`highs`, `lows`, `closes`, slicing, `closed_by`) maps 1:1 to the columns/filters
   the pandas version would have used.
2. **`config/symbols.py` introduced in Phase 1** (the doc lists it under Phase 2)
   because the engine needs `pip_size` to measure sweeps, BOS buffers and stops.
3. **`htf_closed_by` lives in `domain/time_utils.py`** (doc places it in
   `backtest/replay.py`) so the Phase-1 no-look-ahead tests and the live scanner
   share one closure rule.
4. Added `swing_derived_levels` to `key_levels` (the doc calls for "swing-derived
   levels" but only lists it in prose) and a wick-region constraint on
   `detect_sweep` so body-through breakdowns are not misread as sweeps.

### Phase 2 deviations

5. **CSV is the canonical cache format**, not parquet — parquet needs pandas/pyarrow
   which would not install here. `data/storage.py` writes/reads CSV by default and
   uses parquet transparently when those libs are present (`save_candles(fmt=...)`).
   The candle schema is identical either way.
6. **`scripts/make_synthetic_history.py` + `data/synthetic.py` were added** so the
   pipeline is demonstrable without MT5 (Windows-only, absent on this Mac). The real
   `scripts/fetch_mt5_history.py` is implemented and used unchanged on a Windows VPS.
7. **Rolling detection windows in `backtest/replay.py`** (`_LTF_WINDOW=90`,
   `_HTF_WINDOW=60`) plus a monotonic HTF pointer. The naive "expose all candles up
   to now" made replay O(n³) (unusably slow at 50k+ bars). The window is larger than
   any setup's lifespan, so results are unchanged, and it better reflects that SMC
   only uses recent structure. No-look-ahead is preserved (windows only ever contain
   already-closed candles).
8. **`total_trades` / equity metrics vs. challenge result** are two lenses: metrics
   summarise every trade over the full period; `challenge_result` stops the moment
   the profit target (or a breach) is hit. They intentionally disagree.
9. Balance/equity in `prop_simulator` update on trade CLOSE only; intra-trade equity
   dips are not yet modelled (flagged in the module docstring). Add open-equity
   simulation in `replay.py` before trusting a marginal daily-loss pass.
