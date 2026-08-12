# Consensus FX Sentinel

> ## ⚠️ Status: no FX edge has been demonstrated in this repository
>
> The legacy Python strategy in this directory **lost money** in its only real-data
> run. January–June 2025 produced roughly **1,225 trades, a 34% win rate, -0.309
> average R, a 0.58 profit factor, a simulated loss of about $189,210, and zero
> passes across 25 walk-forward runs.**
>
> Wins on synthetic data prove plumbing, not markets. No report in `reports/` may
> be described as evidence of profitability, and no historical result here may be
> used to justify enabling live trade-style alerts.
>
> The Node runtime under `runtime/` is a **measurement instrument** for six new
> candidate playbooks. It starts in research mode and stays there. Coding an idea
> does not make it a strategy.

An alert-only foreign-exchange setup finder and outcome-measurement bot. It never
logs into a trading account, places an order, copies a trade, reads a balance, or
claims that a reader made or lost money. This is not financial advice.

## Two code bases, one purpose

| | `runtime/` (Node 22) | Python packages |
|---|---|---|
| Role | Live/research scanner **and** canonical replay | Legacy research archive |
| Status | Current work | Frozen except for correctness repairs |
| Strategy | Six candidate playbooks (P1–P6) | The losing scalping state machine |

`runtime/engine.js` and `runtime/playbooks.js` are the **single canonical strategy
implementation**. Both the live scanner and `runtime/backtest.js` call them, so the
replay cannot drift away from the bot it validates. The six playbooks are
deliberately **not** reimplemented in Python.

## The Node runtime

```bash
npm --prefix FX_BOT test        # deterministic suite, no network, no secrets
npm --prefix FX_BOT run check   # syntax check
node FX_BOT/runtime/bot.js --dry-run --fixtures   # offline pipeline proof
```

CLI modes:

| Command | Behaviour |
|---|---|
| `--dry-run --fixtures` | Deterministic offline scan. No secrets, sends nothing. |
| `--dry-run` | Real provider fetch and candidate summary. Sends nothing, persists nothing. |
| `--send-test` | One unmistakable non-market test message. |
| `--once` | One research scan plus one outcome pass. |
| *(no flag)* | Long-running scanner and Telegram poller. |

A dry run reports candle counts and the latest complete candle per instrument, and
**exits nonzero if every instrument failed to return data**. Zero candidates never
implies the feed worked.

### How a setup is measured

```text
R           = abs(entry - stop)
firstTarget = entry + directionSign * R        (1:1)
finalTarget = entry + directionSign * 3 * R    (3:1)
```

The 1:1 and 3:1 legs are tracked **independently against the original stop** and
reported separately. There is deliberately no blended "strategy win rate": the
first leg risks 1 to make 1, the final leg risks 1 to make 3, and averaging them
would describe a trade nobody took.

Outcome rules, applied to closed Tiingo one-minute OHLC candles:

- Only candles whose **open time is at or after the alert was sent** are eligible.
  A candle that opened before the alert is never used, even if it closed after.
- Entry activates when `low <= entry <= high`.
- The stop reached **without the entry being touched at all** cancels the setup
  before entry; it is not scored.
- One candle containing both entry and stop counts as entered and then stopped.
- **Stop-first ambiguity rule:** a single OHLC bar cannot reveal the order of
  events, so any candle holding both the stop and an unresolved target records the
  stop. This understates performance rather than inventing wins.
- Unresolved setups expire after 24 hours and are reported separately, never as a
  win or a loss.
- A failed data fetch increments a gap counter and resolves nothing.

Costs are recorded at alert time as `observedSpread + 2*slippage + commission`,
converted to R. **When the spread was never observed, cost is unknown — never
zero** — and such a plan cannot graduate out of research mode.

Every candidate carries a `configHash` of the frozen tuning, active universe,
scan cadence, outcome expiry and alert mode that produced it. Changing any of
those decisions starts a new cohort instead of rewriting earlier results;
reordering the same instruments does not.

### Research and promotion

Each playbook keeps its own cohort. Before anyone considers promoting one, the
report must show a genuinely out-of-sample real-data period, a useful number of
completed non-duplicate examples, net expectancy after observed costs, the
t-statistic and sample size, stability across instruments and sessions, behaviour
under higher cost assumptions, and prospective frozen-config results collected
without retuning.

There is **no automatic promotion switch**, and no playbook is hard-coded as
proven. A losing playbook should be disabled, not optimised until the same history
finally looks favourable.

### Known gaps

- A controlled live dry run on 2026-08-09 authenticated to Tiingo and returned
  current top-of-book plus complete M1/M5/M15/H1 histories for all four configured
  instruments. It produced no candidate and sent/persisted nothing. This proves
  the provider path works; it does not prove an edge.
- The live runtime uses read-only Tiingo Forex REST data: one batched
  top-of-book request for current bid/ask plus four historical candle requests
  per instrument. It does not use the high-volume WebSocket firehose because a
  closed-candle strategy gains no decision quality from microsecond updates.
- One four-instrument scan uses 17 requests. The default 30-minute interval is
  therefore 34 requests/hour and 816/day, leaving headroom under the documented
  Tiingo Free limits of 50/hour and 1,000/day. Manual `/scan` requests are
  cadence-limited and replace, rather than add to, a scheduled provider pass.
- Outcome checks reuse each scan's one-minute candles. A target or stop is still
  evaluated at one-minute resolution, but its Telegram notification can arrive
  up to one scan interval later.
- A new alert requires a top-of-book quote no older than 15 minutes. This blocks
  stale weekend and feed-outage setups.
- **There is no authenticated news provider.** News status is `unknown`; alerts say
  so explicitly and a playbook cannot reach normal alert mode while it stays
  unknown. The runtime never claims a news filter passed.
- No forward research period has been collected yet.

## Legacy Python archive

The Python packages remain for audit and history. Only correctness repairs were
made; the strategy was not re-tuned.

**Repaired:** the replay could previously discover a signal at a candle's close and
then fill the entry *inside that same candle*. Signals are now queued and the
earliest candle that may fill one is the **next** candle, which must actually trade
through the entry price. A candle reaching the stop without touching the entry
cancels the setup. See `tests/test_replay_entry_timing.py`.

**Not repaired, and still true of any report in `reports/`:**

- position sizing risks a fraction of the **initial** balance, not the running
  balance, so the equity path is not a faithful sequential simulation;
- portfolio concurrency is applied after per-symbol replay rather than during it;
- the prop-challenge simulator runs with an **empty news calendar**;
- several documented trend/session/momentum/quality filters are not actually wired
  into the setup decision.

The prop simulator is therefore **quarantined as legacy research** until a separate
task repairs and validates the full portfolio chronology.

`scripts/run_backtest.py` now defaults to the `default` strategy profile;
`--strategy-profile synthetic` still works but prints an unmistakable warning that
its results measure plumbing only.

Full legacy design notes: [`docs/SCALPING_SIGNAL_BOT_ARCHITECTURE.md`](docs/SCALPING_SIGNAL_BOT_ARCHITECTURE.md).

## Legacy phase notes

- **Phase 1 — architecture.** `config/`, `domain/`, `signal_engine/` and their unit
  tests are implemented and green.
- **Phase 2 — data extraction + backtest.** `data/`, `backtest/` and `scripts/` run
  end-to-end and write reports. The demo runs on **synthetic** data because MT5 is
  unavailable here, so its pass rates prove the *pipeline*, not the *strategy*.
- Phase 3 (the live Python scanner) was never started and has been superseded by
  the Node runtime above.

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
