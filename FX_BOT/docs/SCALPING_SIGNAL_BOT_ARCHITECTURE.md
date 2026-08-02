# Scalping Signal Bot And FundingPips Backtester Architecture

Date: 2026-06-30

Purpose: build a Python system that can:

1. Backtest a Smart Money Concepts / price-action scalping strategy without look-ahead.
2. Simulate FundingPips challenge rules before any live usage.
3. Run a live Telegram alert bot that scans symbols, ranks the best setups, sizes them conservatively, and never places orders.

This is an engineering and research system, not financial advice. The system must prove the strategy in simulation before the live alert bot is built.

## Current Rule Sources To Verify

FundingPips rules can change, and account models differ. Before trading any challenge account, confirm the exact model rules inside the live FundingPips dashboard.

Public references to check during implementation:

- FundingPips trading objectives: https://fundingpips.com/trading-objectives
- FundingPips terms and conditions: https://fundingpips.com/terms-and-conditions

Default model assumption for this document:

```text
Account model: FundingPips 2-Step
Phase 1 target: 8%
Phase 2 target: 5%
Minimum trading days: 3
Max daily loss: 5%
Max overall loss: 10%
Bot mode: alert-only, no order placement
```

The code must not hard-code these numbers. They belong in `config/prop_rules.py`.

## Non-Negotiable Design Rules

1. One signal engine.
   - Backtest and live scanner must import the same `signal_engine` package.
   - No duplicated strategy logic in `backtest/` or `scanner/`.

2. No look-ahead.
   - Detection functions receive only closed candles.
   - Higher-timeframe data must include only bars closed at or before the current lower-timeframe decision timestamp.
   - Fractal swing detection must respect confirmation delay. A swing with `right=2` is not known until two future candles have closed.

3. Alert-only.
   - The Telegram bot sends signals and position sizing guidance.
   - It must not place orders, close orders, or expose inline order buttons.

4. Prop rules are parameterized.
   - Daily loss, max loss, trailing/static drawdown, news blackout, min days, targets, and account model rules live in config dataclasses.

5. Conservative backtesting.
   - Include spread, commission, slippage, stop slippage, and same-candle stop/target ambiguity.
   - If both target and stop are touched in the same candle and lower-timeframe/tick data is unavailable, assume the worse outcome.

6. "Top 3" means up to three.
   - The scanner should send zero alerts when no setup meets the minimum quality threshold.
   - Never force three trades from a weak market.

## Final Project Layout

Recommended final structure:

```text
scalp_bot/
|-- pyproject.toml
|-- README.md
|-- .env.example
|-- config/
|   |-- __init__.py
|   |-- settings.py
|   |-- prop_rules.py
|   |-- symbols.py
|   `-- strategy_profiles.py
|-- domain/
|   |-- __init__.py
|   |-- models.py
|   |-- enums.py
|   `-- time_utils.py
|-- data/
|   |-- __init__.py
|   |-- mt5_feed.py
|   |-- mt5_export.py
|   |-- storage.py
|   |-- calendar.py
|   `-- validation.py
|-- signal_engine/
|   |-- __init__.py
|   |-- candles.py
|   |-- levels.py
|   |-- liquidity.py
|   |-- momentum.py
|   |-- setup_state.py
|   |-- setup.py
|   `-- structure.py
|-- backtest/
|   |-- __init__.py
|   |-- replay.py
|   |-- fill_model.py
|   |-- costs.py
|   |-- prop_simulator.py
|   |-- metrics.py
|   |-- walk_forward.py
|   `-- report.py
|-- scanner/
|   |-- __init__.py
|   |-- scan.py
|   `-- ranker.py
|-- risk/
|   |-- __init__.py
|   |-- exposure.py
|   `-- guardrail.py
|-- state/
|   |-- __init__.py
|   |-- schema.sql
|   `-- store.py
|-- bot/
|   |-- __init__.py
|   |-- telegram_bot.py
|   `-- formatters.py
|-- scripts/
|   |-- fetch_mt5_history.py
|   |-- validate_history.py
|   |-- run_backtest.py
|   |-- run_walk_forward.py
|   |-- run_scanner.py
|   `-- reconcile_state.py
|-- tests/
|   |-- fixtures/
|   |-- test_structure.py
|   |-- test_liquidity.py
|   |-- test_setup_state.py
|   |-- test_no_lookahead.py
|   |-- test_fill_model.py
|   |-- test_prop_rules.py
|   `-- test_guardrail.py
|-- data_cache/
|   |-- raw/
|   `-- processed/
`-- reports/
```

## Phase 1: Battle-Tested Architecture

Phase 1 builds the foundation. The goal is not to make Telegram work. The goal is to make the system honest, testable, and impossible to accidentally backtest one strategy while trading another.

### Phase 1 Deliverables

```text
config/
domain/
signal_engine/
tests/
```

The phase is complete when:

1. Every signal detector is deterministic and pure.
2. The setup lifecycle is tested with fixtures.
3. Look-ahead traps are covered by unit tests.
4. A candle sequence either produces the expected setup state or fails for a clear reason.

### Core Domain Models

Put shared plain data objects in `domain/models.py`.

```python
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Literal


Direction = Literal["long", "short"]
Trend = Literal["bull", "bear", "range"]
SetupStage = Literal[
    "idle",
    "sweep_found",
    "rejection_confirmed",
    "bos_confirmed",
    "waiting_retest",
    "entry_triggered",
    "invalidated",
    "expired",
]


@dataclass(frozen=True)
class Candle:
    symbol: str
    timeframe: str
    time: datetime
    open: float
    high: float
    low: float
    close: float
    tick_volume: int = 0
    spread_points: int | None = None


@dataclass(frozen=True)
class Swing:
    time: datetime
    index: int
    kind: Literal["high", "low"]
    price: float
    confirmed_at: datetime


@dataclass(frozen=True)
class BOS:
    time: datetime
    direction: Direction
    broken_swing: Swing
    close_price: float
    clean_break: bool


@dataclass(frozen=True)
class Level:
    name: str
    price: float
    kind: Literal["session_high", "session_low", "day_high", "day_low", "round", "equal_high", "equal_low", "swing"]
    created_at: datetime
    last_touched_at: datetime | None = None
    touches: int = 0
    freshness_score: float = 1.0


@dataclass(frozen=True)
class Sweep:
    time: datetime
    direction: Direction
    level: Level
    wick_price: float
    close_price: float
    reclaim_distance_pips: float


@dataclass(frozen=True)
class Rejection:
    time: datetime
    kind: Literal["pin", "engulfing"]
    direction: Direction
    strength: float


@dataclass(frozen=True)
class SetupState:
    symbol: str
    stage: SetupStage
    direction: Direction | None = None
    sweep: Sweep | None = None
    rejection: Rejection | None = None
    bos: BOS | None = None
    entry_level: float | None = None
    stop_price: float | None = None
    target_price: float | None = None
    created_at: datetime | None = None
    expires_at: datetime | None = None
    confluence: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class Signal:
    symbol: str
    direction: Direction
    timeframe: str
    signal_time: datetime
    entry: float
    stop: float
    target: float
    stop_pips: float
    planned_r: float
    confluence: dict[str, float]
    setup_state: SetupState
```

### Prop Rules Model

Put prop rules in `config/prop_rules.py`.

```python
from dataclasses import dataclass
from typing import Literal


DrawdownMode = Literal["static", "trailing"]


@dataclass(frozen=True)
class PropRules:
    name: str
    initial_balance: float
    profit_target_pct: float
    min_trading_days: int
    max_daily_loss_pct: float
    max_total_loss_pct: float
    drawdown_mode: DrawdownMode
    daily_reset_timezone: str
    daily_reset_hour: int
    news_blackout_minutes_before: int
    news_blackout_minutes_after: int
    losing_reentry_cooldown_minutes: int
    consistency_max_day_profit_pct: float | None = None


FUNDINGPIPS_2_STEP_PHASE_1 = PropRules(
    name="fundingpips_2_step_phase_1",
    initial_balance=100_000.0,
    profit_target_pct=0.08,
    min_trading_days=3,
    max_daily_loss_pct=0.05,
    max_total_loss_pct=0.10,
    drawdown_mode="static",
    daily_reset_timezone="Europe/Prague",  # Confirm server time in dashboard.
    daily_reset_hour=0,
    news_blackout_minutes_before=5,
    news_blackout_minutes_after=5,
    losing_reentry_cooldown_minutes=10,
)
```

### Strategy Settings

Put tunable strategy parameters in `config/strategy_profiles.py`.

```python
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
```

### Signal Engine Design

The original strategy is sequential:

```text
trend -> key level -> sweep -> rejection -> BOS -> retest -> entry
```

Do not implement this as a one-shot detector. Implement it as a pure state machine.

#### `signal_engine/structure.py`

```python
import pandas as pd
from domain.models import BOS, Swing, Trend


def swing_points(df: pd.DataFrame, left: int = 2, right: int = 2) -> list[Swing]:
    """
    Return confirmed fractal swings only.

    Important:
    A swing at index i is only confirmed after index i + right has closed.
    The returned Swing.confirmed_at must be the timestamp of that confirmation candle.
    """


def trend_state(swings: list[Swing], min_pairs: int = 2) -> Trend:
    """
    bull: latest highs and lows are rising.
    bear: latest highs and lows are falling.
    range: anything else.
    """


def break_of_structure(
    df: pd.DataFrame,
    swings: list[Swing],
    direction: str,
    min_close_buffer_pips: float,
    pip_size: float,
) -> BOS | None:
    """
    A BOS is valid only when a closed candle closes beyond the relevant confirmed swing.
    Wick-only breaks do not count.
    """
```

#### `signal_engine/levels.py`

```python
import pandas as pd
from domain.models import Level


def prior_day_levels(df_htf: pd.DataFrame) -> list[Level]:
    """Return previous completed day high and low."""


def session_levels(df_ltf: pd.DataFrame, session_tz: str) -> list[Level]:
    """Return completed London, New York, and Asian session highs/lows."""


def round_number_levels(current_price: float, pip_size: float, step_pips: int, bands: int = 5) -> list[Level]:
    """Build nearby psychological levels around current price."""


def equal_high_low_levels(df: pd.DataFrame, pip_size: float, tolerance_pips: float) -> list[Level]:
    """Find highs/lows touched at least twice within tolerance."""


def key_levels(df_ltf: pd.DataFrame, df_htf: pd.DataFrame, pip_size: float, cfg) -> list[Level]:
    """Combine prior day, session, round number, equal high/low, and swing-derived levels."""
```

#### `signal_engine/liquidity.py`

```python
import pandas as pd
from domain.models import Level, Sweep


def detect_sweep(
    df: pd.DataFrame,
    levels: list[Level],
    pip_size: float,
    proximity_pips: float,
) -> Sweep | None:
    """
    A bullish reversal setup starts with a sweep below liquidity:
    low pokes below a level, candle closes back above it.

    A bearish reversal setup starts with a sweep above liquidity:
    high pokes above a level, candle closes back below it.
    """
```

#### `signal_engine/candles.py`

```python
import pandas as pd
from domain.models import Rejection


def classify_rejection(df: pd.DataFrame, direction: str, cfg) -> Rejection | None:
    """
    Pin bar:
    - wick in reversal direction >= cfg.pin_wick_body_ratio * body
    - body closes in the outer third of the candle range

    Engulfing:
    - current candle body fully covers previous candle body
    - close direction agrees with intended reversal direction
    """
```

#### `signal_engine/momentum.py`

```python
import pandas as pd


def true_range(df: pd.DataFrame) -> pd.Series:
    """Return true range series."""


def atr(df: pd.DataFrame, period: int) -> pd.Series:
    """Return ATR series."""


def momentum_score(df: pd.DataFrame, period: int, lookback: int) -> float:
    """Return latest ATR divided by rolling ATR mean."""


def momentum_ok(df: pd.DataFrame, period: int, lookback: int, min_ratio: float) -> bool:
    """True when ATR ratio is above the configured threshold."""
```

#### `signal_engine/setup_state.py`

```python
import pandas as pd
from domain.models import SetupState


def initial_state(symbol: str) -> SetupState:
    """Return idle state for a symbol."""


def advance_setup_state(
    state: SetupState,
    df_ltf: pd.DataFrame,
    df_htf: pd.DataFrame,
    cfg,
    symbol_meta,
) -> SetupState:
    """
    Pure state transition for one symbol using closed candles only.

    Transitions:
    idle -> sweep_found
    sweep_found -> rejection_confirmed
    rejection_confirmed -> bos_confirmed
    bos_confirmed -> waiting_retest
    waiting_retest -> entry_triggered
    any active state -> invalidated
    any active state -> expired
    """
```

#### `signal_engine/setup.py`

```python
import pandas as pd
from domain.models import SetupState, Signal


def build_signal_from_state(state: SetupState, df_ltf: pd.DataFrame, cfg, symbol_meta) -> Signal | None:
    """Convert an entry-triggered setup state into a tradable Signal."""


def find_setup(
    previous_state: SetupState,
    df_ltf: pd.DataFrame,
    df_htf: pd.DataFrame,
    cfg,
    symbol_meta,
) -> tuple[SetupState, Signal | None]:
    """
    The only strategy entry point used by both backtest and live scanner.
    This function performs no I/O.
    """
```

### Phase 1 Unit Tests

Tests must be written before downstream backtesting.

Required tests:

```text
tests/test_structure.py
  - swing high/low detection works
  - swing is not available before right-side confirmation candles close
  - BOS requires candle close, not wick

tests/test_liquidity.py
  - bullish sweep below level closes back above
  - bearish sweep above level closes back below
  - wick poke without reclaim is not a sweep

tests/test_candles.py
  - valid pin bar
  - invalid pin bar with body too large
  - valid engulfing candle

tests/test_setup_state.py
  - full valid lifecycle reaches entry_triggered
  - setup expires after max_setup_age_bars
  - setup invalidates when sweep wick is reclaimed against direction

tests/test_no_lookahead.py
  - find_setup cannot see future LTF candles
  - HTF candle currently forming is excluded
  - fractal swings respect confirmation delay
```

### Phase 1 Acceptance Criteria

Phase 1 is finished only when this passes:

```bash
pytest tests/test_structure.py tests/test_liquidity.py tests/test_candles.py tests/test_setup_state.py tests/test_no_lookahead.py
```

Do not start Telegram work before this foundation is green.

## Phase 2: Data Extraction And Backtesting Scripts

Phase 2 answers the question that matters:

```text
Does this strategy pass FundingPips-style challenges in simulation after costs?
```

It should be possible to run one terminal command and see a result summary.

### Phase 2 Deliverables

```text
data/
backtest/
scripts/fetch_mt5_history.py
scripts/validate_history.py
scripts/run_backtest.py
scripts/run_walk_forward.py
reports/
```

### MT5 Environment Note

The Python `MetaTrader5` package generally expects a running MetaTrader 5 terminal. On macOS this can be awkward depending on broker setup. The practical options are:

1. Run the extractor on a Windows VPS with MT5 installed.
2. Run MT5 under a working compatibility setup and test carefully.
3. Export CSV from MT5 and import it through `data/storage.py`.

The architecture should support both direct MT5 pulls and CSV/parquet imports.

### Historical Data Storage

Store extracted candles as parquet:

```text
data_cache/
|-- raw/
|   `-- mt5/
|       |-- EURUSD/
|       |   |-- M1.parquet
|       |   |-- M5.parquet
|       |   `-- M15.parquet
|       `-- XAUUSD/
|           |-- M1.parquet
|           |-- M5.parquet
|           `-- M15.parquet
`-- processed/
    `-- aligned/
```

Required candle schema:

```text
symbol: string
timeframe: string
time: timezone-aware datetime
open: float
high: float
low: float
close: float
tick_volume: int
spread_points: int | null
real_volume: int | null
source: string
```

### Symbol Metadata

Put pip, point, lot step, contract size, and quote/currency metadata in `config/symbols.py`.

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class SymbolMeta:
    symbol: str
    base_currency: str
    quote_currency: str
    pip_size: float
    point_size: float
    contract_size: float
    lot_step: float
    min_lot: float
    max_lot: float
    typical_spread_pips: float
    commission_per_lot_round_turn: float


SYMBOLS = {
    "EURUSD": SymbolMeta("EURUSD", "EUR", "USD", 0.0001, 0.00001, 100_000, 0.01, 0.01, 100.0, 0.8, 7.0),
    "GBPUSD": SymbolMeta("GBPUSD", "GBP", "USD", 0.0001, 0.00001, 100_000, 0.01, 0.01, 100.0, 1.0, 7.0),
    "USDJPY": SymbolMeta("USDJPY", "USD", "JPY", 0.01, 0.001, 100_000, 0.01, 0.01, 100.0, 0.9, 7.0),
    "XAUUSD": SymbolMeta("XAUUSD", "XAU", "USD", 0.1, 0.01, 100, 0.01, 0.01, 50.0, 2.5, 7.0),
}
```

Confirm these broker-specific values from MT5 symbol info before trusting them.

### Data Extraction Script

#### `scripts/fetch_mt5_history.py`

Command:

```bash
python scripts/fetch_mt5_history.py \
  --symbols EURUSD GBPUSD USDJPY XAUUSD \
  --timeframes M1 M5 M15 \
  --start 2024-01-01 \
  --end 2026-06-30 \
  --out data_cache/raw/mt5
```

Responsibilities:

1. Connect to MT5.
2. Pull candles for each symbol/timeframe/date range.
3. Normalize timestamps to timezone-aware UTC.
4. Save parquet files.
5. Print extraction summary.

Function design:

```python
def parse_args() -> argparse.Namespace:
    """Parse CLI arguments."""


def fetch_symbol_timeframe(symbol: str, timeframe: str, start: datetime, end: datetime) -> pd.DataFrame:
    """Fetch rates from MT5 and return normalized candle DataFrame."""


def save_candles(df: pd.DataFrame, out_dir: Path, symbol: str, timeframe: str) -> Path:
    """Save parquet to data_cache/raw/mt5/{symbol}/{timeframe}.parquet."""


def main() -> int:
    """CLI entry point."""
```

Example terminal output:

```text
Connected to MT5 account: demo-123456
EURUSD M1: 518240 candles saved
EURUSD M5: 103648 candles saved
EURUSD M15: 34549 candles saved
...
Done. Files written to data_cache/raw/mt5
```

### History Validation Script

#### `scripts/validate_history.py`

Command:

```bash
python scripts/validate_history.py --data data_cache/raw/mt5 --symbols EURUSD GBPUSD USDJPY XAUUSD
```

Checks:

1. Missing candle gaps.
2. Duplicate timestamps.
3. Non-monotonic timestamps.
4. Invalid OHLC values.
5. Spread outliers.
6. Too little data per symbol.

Function design:

```python
def validate_ohlc(df: pd.DataFrame) -> list[str]:
    """Return validation errors for invalid OHLC rows."""


def validate_time_index(df: pd.DataFrame, timeframe: str) -> list[str]:
    """Return duplicate, gap, and ordering errors."""


def validate_spread(df: pd.DataFrame, symbol_meta) -> list[str]:
    """Flag missing or extreme spread observations."""


def build_validation_report(data_dir: Path, symbols: list[str]) -> pd.DataFrame:
    """Return one summary row per symbol/timeframe."""
```

### Backtest Fill Model

The fill model must be conservative because scalping performance is highly sensitive to costs.

#### `backtest/costs.py`

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class CostConfig:
    spread_multiplier: float = 1.0
    commission_multiplier: float = 1.0
    stop_slippage_pips: float = 0.5
    target_slippage_pips: float = 0.0
    market_entry_slippage_pips: float = 0.1


def spread_pips_for_bar(candle, symbol_meta, fallback: float) -> float:
    """Use MT5 spread if present, otherwise fallback to configured typical spread."""


def commission_cost_usd(lots: float, symbol_meta, cfg: CostConfig) -> float:
    """Return round-turn commission cost."""
```

#### `backtest/fill_model.py`

```python
from domain.models import Signal


def entry_is_touched(candle, signal: Signal) -> bool:
    """Return True when the retest entry price is touched after signal time."""


def simulate_entry_fill(candle, signal: Signal, symbol_meta, cost_cfg):
    """Return entry fill with bid/ask and slippage applied."""


def simulate_exit_on_candle(candle, open_trade, symbol_meta, cost_cfg):
    """
    Return stop, target, or None.

    If stop and target are both touched in the same candle:
    - use lower timeframe data if available
    - otherwise assume stop first
    """
```

### Backtest Replay Engine

#### `backtest/replay.py`

Core idea:

```text
For each closed LTF candle:
  - expose candles up to now only
  - expose HTF candles closed at or before now only
  - advance setup state for each symbol
  - create pending retest signal if BOS is confirmed
  - simulate fill only if later candle touches entry
  - manage open trades candle-by-candle
```

Function design:

```python
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class ReplayConfig:
    symbols: list[str]
    ltf: str
    htf: str
    start: datetime
    end: datetime
    strategy_profile: str
    max_open_trades: int = 3
    one_trade_per_symbol: bool = True


def htf_closed_by(df_htf: pd.DataFrame, current_ltf_time: datetime, htf_minutes: int) -> pd.DataFrame:
    """Return only HTF candles fully closed by the LTF decision timestamp."""


def replay_symbol(
    symbol: str,
    df_ltf: pd.DataFrame,
    df_htf: pd.DataFrame,
    strategy_cfg,
    symbol_meta,
    cost_cfg,
) -> list:
    """Replay one symbol and return candidate trades/signals."""


def replay_portfolio(
    data_store,
    replay_cfg: ReplayConfig,
    strategy_cfg,
    cost_cfg,
    prop_rules,
) -> list:
    """Replay all symbols in timestamp order and return executed trades."""
```

### Trade Model

Put in `domain/models.py` or `backtest/replay.py`.

```python
@dataclass(frozen=True)
class Trade:
    id: str
    symbol: str
    direction: Direction
    entry_time: datetime
    exit_time: datetime
    entry_price: float
    exit_price: float
    stop_price: float
    target_price: float
    lots: float
    gross_r: float
    net_r: float
    gross_pnl: float
    net_pnl: float
    exit_reason: Literal["stop", "target", "expired", "manual", "session_close"]
    confluence: dict[str, float]
```

### Prop Challenge Simulator

#### `backtest/prop_simulator.py`

This is the main Phase 2 deliverable.

It must answer:

```text
Would this sequence of trades pass the challenge without breaching rules?
```

Function design:

```python
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class ChallengeResult:
    passed: bool
    days_taken: int | None
    breach_reason: str | None
    peak_drawdown_pct: float
    end_balance: float
    total_trades: int
    trading_days: int
    profit_target_hit_at: datetime | None


def starting_daily_loss_limit(balance: float, equity: float, rules) -> float:
    """
    Compute the daily loss limit basis according to the selected prop rules.
    Confirm final FundingPips formula from dashboard/terms before live use.
    """


def total_loss_floor(initial_balance: float, high_water_equity: float, rules) -> float:
    """Return static or trailing max-loss floor."""


def simulate_challenge(
    trades: list,
    rules,
    starting_balance: float,
    news_events: list,
) -> ChallengeResult:
    """
    Replay trades through prop rules:
    - balance
    - equity
    - daily loss
    - max loss
    - min trading days
    - profit target
    - cooldown
    - news blackout
    """
```

Important: daily loss checks should consider live equity, not only closed trade P&L. If the backtest only stores closed trades, add open trade equity simulation in `replay.py`.

### Metrics

#### `backtest/metrics.py`

```python
def expectancy_r(trades: list) -> float:
    """Average net R per trade."""


def profit_factor(trades: list) -> float:
    """Gross wins divided by gross losses."""


def win_rate(trades: list) -> float:
    """Winning trades / all trades."""


def max_drawdown(equity_curve: pd.Series) -> float:
    """Maximum equity drawdown."""


def summarize_trades(trades: list) -> dict:
    """Return headline metrics."""
```

### Walk-Forward Testing

#### `backtest/walk_forward.py`

Run many simulated challenge attempts starting at different dates.

Function design:

```python
def generate_start_dates(start: datetime, end: datetime, frequency: str = "W-MON") -> list[datetime]:
    """Generate challenge start dates."""


def run_attempt(start_date: datetime, attempt_days: int, replay_cfg, strategy_cfg, cost_cfg, rules):
    """Run one challenge attempt from a given start date."""


def run_walk_forward(start_dates: list[datetime], attempt_days: int, cfg) -> pd.DataFrame:
    """Return one result row per challenge attempt."""


def pass_rate(results: pd.DataFrame) -> float:
    """Share of attempts that passed with no breach."""
```

### Backtest Script

#### `scripts/run_backtest.py`

Command:

```bash
python scripts/run_backtest.py \
  --data data_cache/raw/mt5 \
  --symbols EURUSD GBPUSD USDJPY XAUUSD \
  --ltf M5 \
  --htf M15 \
  --start 2025-01-01 \
  --end 2025-06-30 \
  --account-model fundingpips_2_step_phase_1 \
  --initial-balance 100000 \
  --risk-pct 0.005 \
  --cost-multiplier 1.0
```

Expected terminal output:

```text
Backtest: fundingpips_2_step_phase_1
Period: 2025-01-01 -> 2025-06-30
Symbols: EURUSD, GBPUSD, USDJPY, XAUUSD
Timeframes: M5 entries, M15 structure

Signals found: 418
Trades filled: 173
Win rate: 42.2%
Avg net R: 0.18
Profit factor: 1.31
Max drawdown: 3.8%
Worst day: -1.4%

Challenge result:
PASSED: yes
Days taken: 18
End balance: 108247.50
Peak drawdown: 3.8%
Breach reason: none

Report written to reports/20250630_153022_backtest/
```

Function design:

```python
def parse_args() -> argparse.Namespace:
    """Parse CLI args."""


def build_run_config(args):
    """Build replay, strategy, cost, and prop configs."""


def run(args) -> int:
    """Run one backtest and write reports."""


def main() -> int:
    """CLI entry point."""
```

### Walk-Forward Script

#### `scripts/run_walk_forward.py`

Command:

```bash
python scripts/run_walk_forward.py \
  --data data_cache/raw/mt5 \
  --symbols EURUSD GBPUSD USDJPY XAUUSD \
  --ltf M5 \
  --htf M15 \
  --from 2024-01-01 \
  --to 2026-06-30 \
  --attempt-days 30 \
  --start-frequency W-MON \
  --account-model fundingpips_2_step_phase_1 \
  --initial-balance 100000 \
  --risk-pct 0.005 \
  --cost-multiplier 1.5
```

Expected terminal output:

```text
Walk-forward attempts: 126
Passed: 47
Failed: 79
Pass rate: 37.3%

Failure breakdown:
max_daily_loss: 21
max_total_loss: 9
target_not_hit: 42
min_days_not_met: 0
news_or_cooldown_filtered: 7

Median days to pass: 19
Median peak DD: 4.1%
Worst peak DD: 8.6%

Report written to reports/20250630_160441_walk_forward/
```

### Reports

Each backtest run should create:

```text
reports/{run_id}/
|-- config.json
|-- trades.csv
|-- signals.csv
|-- equity_curve.csv
|-- challenge_result.json
|-- metrics.json
`-- summary.md
```

`config.json` is mandatory. Every result must be reproducible from the exact config snapshot.

### Phase 2 Acceptance Criteria

Phase 2 is finished when:

1. `fetch_mt5_history.py` can create parquet history.
2. `validate_history.py` flags bad data.
3. `run_backtest.py` prints a readable strategy result.
4. `run_walk_forward.py` prints pass rate across many start dates.
5. Results are written to `reports/`.
6. The strategy is tested at normal costs and 1.5x costs.

Do not build the Telegram bot unless walk-forward results are acceptable.

Suggested minimum to continue:

```text
At 1.0x costs:
  pass rate >= 50%
  profit factor >= 1.25
  average net R > 0
  no frequent daily-limit breaches

At 1.5x costs:
  average net R should not collapse deeply negative
  daily-limit breach rate must stay low
```

These are not guarantees. They are gates to avoid building a live bot around an obviously weak strategy.

## Phase 3: Live Telegram Scanner And FundingPips Guardrail

Phase 3 connects the proven backtest logic to live scanning.

The live bot does three things:

1. Scan for setups.
2. Rank valid setups.
3. Apply risk guardrails before sending alerts.

It does not execute trades.

### Phase 3 Deliverables

```text
scanner/
risk/
state/
bot/
scripts/run_scanner.py
scripts/reconcile_state.py
```

### Live Data Flow

```text
MT5 latest closed candles
  -> scanner.scan_all_symbols()
  -> signal_engine.find_setup()
  -> scanner.ranker.rank_signals()
  -> risk.guardrail.evaluate_signal()
  -> bot.telegram_bot.send_alert()
```

### Scanner

#### `scanner/scan.py`

```python
from domain.models import Signal, SetupState


def latest_closed_candles(symbol: str, timeframe: str, bars: int) -> pd.DataFrame:
    """
    Pull candles from MT5.
    Exclude the current forming candle.
    """


def scan_symbol(
    symbol: str,
    previous_state: SetupState,
    cfg,
    symbol_meta,
) -> tuple[SetupState, Signal | None]:
    """Pull LTF/HTF data and call signal_engine.find_setup."""


def scan_all_symbols(symbols: list[str], state_store, cfg) -> list[Signal]:
    """Scan all symbols and return non-None signals."""
```

### Ranker

#### `scanner/ranker.py`

```python
from domain.models import Signal


def score_signal(signal: Signal, session_context, weights: dict[str, float]) -> float:
    """
    Score based on:
    - planned R
    - ATR ratio
    - level freshness
    - clean BOS
    - session bonus
    - spread penalty
    - correlation penalty
    """


def rank_signals(signals: list[Signal], max_count: int, min_score: float) -> list[Signal]:
    """
    Return up to max_count signals.
    Do not force weak trades.
    """
```

### State Store

Use SQLite, not loose JSON, because the bot needs durable state.

#### `state/schema.sql`

Tables:

```sql
CREATE TABLE IF NOT EXISTS bot_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS setup_states (
    symbol TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    signal_time TEXT NOT NULL,
    entry REAL NOT NULL,
    stop REAL NOT NULL,
    target REAL NOT NULL,
    planned_r REAL NOT NULL,
    score REAL NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS manual_trades (
    id TEXT PRIMARY KEY,
    mt5_ticket TEXT,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    entry_time TEXT NOT NULL,
    exit_time TEXT,
    entry_price REAL NOT NULL,
    exit_price REAL,
    lots REAL NOT NULL,
    pnl REAL,
    status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cooldowns (
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    blocked_until TEXT NOT NULL,
    reason TEXT NOT NULL,
    PRIMARY KEY (symbol, direction)
);
```

#### `state/store.py`

```python
class StateStore:
    def get_setup_state(self, symbol: str):
        """Load last setup state for symbol."""

    def save_setup_state(self, symbol: str, state):
        """Persist setup state."""

    def save_alert(self, alert):
        """Persist sent alert."""

    def set_cooldown(self, symbol: str, direction: str, blocked_until, reason: str):
        """Block same-direction signals after a losing trade."""

    def is_paused(self) -> bool:
        """Return manual pause state."""

    def set_paused(self, paused: bool):
        """Set manual kill switch."""
```

### Risk Guardrail

The guardrail is what aligns the bot with the FundingPips challenge goal.

It should shrink or suppress signals that threaten:

1. Daily loss limit.
2. Overall loss limit.
3. Trailing loss floor if using Zero model.
4. Soft daily stop.
5. Total open exposure.
6. Correlated exposure.
7. News restrictions.
8. Losing-trade cooldown.

#### `risk/exposure.py`

```python
def currency_exposure(open_trades: list) -> dict[str, float]:
    """Return net exposure by currency."""


def correlated_risk(signal, open_trades: list) -> float:
    """Estimate extra portfolio risk from same-direction currency correlation."""


def total_open_risk(open_trades: list) -> float:
    """Return worst-case open risk in account currency."""
```

#### `risk/guardrail.py`

```python
from dataclasses import dataclass
from domain.models import Signal


@dataclass(frozen=True)
class AccountSnapshot:
    balance: float
    equity: float
    initial_balance: float
    day_start_balance: float
    day_start_equity: float
    high_water_equity: float
    open_trades: list
    server_time: object


@dataclass(frozen=True)
class GuardrailDecision:
    allowed: bool
    reason: str | None
    lots: float
    risk_amount: float
    daily_loss_headroom: float
    max_loss_headroom: float
    score_adjustment: float = 0.0


def pip_value_per_lot(symbol: str, price: float, symbol_meta, account_currency: str = "USD") -> float:
    """Return pip value per lot in account currency."""


def round_lots_down(lots: float, lot_step: float, min_lot: float, max_lot: float) -> float:
    """Round lots down to broker lot step."""


def calculate_position_size(
    signal: Signal,
    account: AccountSnapshot,
    symbol_meta,
    risk_pct: float,
) -> float:
    """Base lot size from risk_pct and stop distance."""


def daily_loss_headroom(account: AccountSnapshot, rules, soft_daily_loss_pct: float) -> float:
    """Return remaining internal daily loss budget."""


def max_loss_headroom(account: AccountSnapshot, rules, safety_buffer_pct: float) -> float:
    """Return remaining distance from max loss floor after safety buffer."""


def evaluate_signal(
    signal: Signal,
    account: AccountSnapshot,
    rules,
    symbol_meta,
    news_calendar,
    state_store,
    risk_pct: float = 0.005,
    soft_daily_loss_pct: float = 0.03,
    max_total_open_risk_pct: float = 0.015,
    dd_safety_buffer_pct: float = 0.01,
) -> GuardrailDecision:
    """
    Return allowed/suppressed plus safe lot size.

    Suppress when:
    - bot is paused
    - signal is during news blackout
    - cooldown applies
    - daily soft stop is hit
    - full stop-out would violate safety buffer
    - total open risk is too high
    - rounded lot size is below broker minimum
    """
```

### News Calendar

#### `data/calendar.py`

The implementation can start with a CSV import, then later connect to a calendar API.

```python
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class NewsEvent:
    time: datetime
    currency: str
    impact: str
    title: str


def load_news_events(path: str) -> list[NewsEvent]:
    """Load high-impact events from CSV or API cache."""


def affected_currencies(symbol: str) -> tuple[str, str]:
    """Return base and quote currencies for an FX symbol."""


def is_news_blackout(symbol: str, now: datetime, events: list[NewsEvent], rules) -> bool:
    """True if high-impact event affects symbol within blackout window."""
```

### Telegram Bot

#### `bot/formatters.py`

```python
def format_signal_alert(signal, decision, score: float) -> str:
    """Return Telegram-safe alert message."""


def format_status(account, rules, state_store) -> str:
    """Return status message."""
```

Alert format:

```text
SETUP: EURUSD LONG
Score: 84.5
Timeframe: M5 entry / M15 structure

Entry: 1.08420
Stop: 1.08270
Target: 1.08720
Stop: 15.0 pips
Planned R: 2.0

Safe size: 0.33 lots
Risk: $500.00
Daily headroom: $2,740.00
Max-loss headroom: $7,920.00

Why:
- Sweep: prior London low
- Rejection: pin bar
- BOS: clean close
- ATR ratio: 1.18

Execution: manual only.
```

#### `bot/telegram_bot.py`

```python
class TelegramAlertBot:
    def send_signal(self, signal, decision, score: float):
        """Send one signal alert."""

    def send_batch(self, alerts: list):
        """Send up to top 3 approved alerts."""

    async def status_command(self, update, context):
        """Return account and bot state."""

    async def pause_command(self, update, context):
        """Pause scanner alerts."""

    async def resume_command(self, update, context):
        """Resume scanner alerts."""
```

### Live Scanner Script

#### `scripts/run_scanner.py`

Command:

```bash
python scripts/run_scanner.py \
  --symbols EURUSD GBPUSD USDJPY XAUUSD \
  --ltf M5 \
  --htf M15 \
  --account-model fundingpips_2_step_phase_1 \
  --risk-pct 0.005 \
  --max-alerts 3
```

Responsibilities:

1. Connect to MT5.
2. Start Telegram bot.
3. Schedule scans just after candle close.
4. Pull latest closed candles.
5. Advance setup state per symbol.
6. Rank signals.
7. Apply guardrail.
8. Send approved alerts.
9. Persist states and alerts.

Function design:

```python
def seconds_until_next_candle(timeframe: str, offset_seconds: int = 3) -> int:
    """Return delay until next closed candle should be available."""


def scan_once(app_context) -> list:
    """Run one scan cycle and return approved alerts."""


def run_scheduler(app_context):
    """Run APScheduler loop."""


def main() -> int:
    """CLI entry point."""
```

### Account State Reconciliation

Because the human executes trades manually, the bot must reconcile account state from MT5.

#### `scripts/reconcile_state.py`

Command:

```bash
python scripts/reconcile_state.py --account-model fundingpips_2_step_phase_1
```

Responsibilities:

1. Pull MT5 account balance/equity.
2. Pull open positions.
3. Pull closed deals since last sync.
4. Detect losing closed trades.
5. Set 10-minute cooldown per symbol/direction after losing trades.
6. Update day-start balance/equity at server reset.
7. Update high-water equity when needed.

Function design:

```python
def load_mt5_account_snapshot() -> AccountSnapshot:
    """Read balance, equity, open positions, and server time from MT5."""


def sync_closed_deals(state_store, since):
    """Persist closed manual trades and detect losses."""


def update_cooldowns_from_losses(state_store, closed_trades, rules):
    """Apply same-direction cooldowns."""


def reconcile() -> None:
    """Full sync routine."""
```

### Phase 3 Acceptance Criteria

Phase 3 is finished when:

1. Scanner runs on demo without placing orders.
2. Alerts include entry, stop, target, planned R, score, safe lots, and headroom.
3. `/status`, `/pause`, and `/resume` work.
4. Losing-trade cooldown works after reconciliation.
5. News blackout suppresses affected symbols.
6. Guardrail suppresses alerts that threaten daily or max-loss buffers.
7. The bot sends zero alerts in weak markets instead of forcing trades.

## Implementation Order

Build in this exact order:

```text
1. Domain models and config
2. Signal engine detectors
3. Signal engine state machine
4. Unit tests for look-ahead and lifecycle
5. MT5 data extraction
6. Data validation
7. Backtest replay engine
8. Fill model and cost model
9. Prop simulator
10. Metrics and reports
11. Walk-forward script
12. Ranker
13. Guardrail and exposure model
14. SQLite state store
15. Telegram alert bot
16. Live scanner scheduler
17. Demo run and reconciliation
```

Stop after step 11 if walk-forward pass rate is poor.

## Critical Risks

1. Scalping cost drag.
   - Spread, commission, and slippage can erase a low-timeframe edge.

2. False backtest from look-ahead.
   - Fractals, HTF candles, and retest logic are common failure points.

3. Human execution mismatch.
   - The backtest assumes exact entries. In live trading, missed entries and late entries change expectancy.

4. Forced trading.
   - "Top 3" must not mean three trades every scan.

5. Prop rule mismatch.
   - FundingPips dashboard rules are the final source of truth.

6. MT5 data quality.
   - Historical spreads may be incomplete or unreliable. Conservative cost assumptions are mandatory.

## Minimum Proof Before Live Use

Before using the bot on a paid challenge:

```text
1. At least 1 year of historical backtest data.
2. Walk-forward starts at weekly intervals.
3. Results tested at 1.0x and 1.5x costs.
4. No frequent daily-loss breaches.
5. The best ranked setups outperform the unranked set.
6. Demo scanner runs for at least 2 weeks.
7. Alerts are manually compared against chart behavior.
```

The first real success metric is not win rate. It is:

```text
Walk-forward FundingPips pass rate with zero rule breaches.
```

If the strategy cannot survive that test, do not build or use the live bot.
