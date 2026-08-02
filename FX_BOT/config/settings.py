"""Runtime/environment settings (paths, credentials, active model selection).

Phase 1 does not require any of these; they exist so later phases read config
from one typed place instead of scattered ``os.getenv`` calls.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _get(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


@dataclass(frozen=True)
class Settings:
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    mt5_login: str = ""
    mt5_password: str = ""
    mt5_server: str = ""
    data_cache_dir: str = "data_cache"
    reports_dir: str = "reports"
    state_db_path: str = "state/scalp_bot.db"
    account_model: str = "fundingpips_2_step_phase_1"
    default_symbols: tuple[str, ...] = field(
        default_factory=lambda: ("EURUSD", "GBPUSD", "USDJPY", "XAUUSD")
    )
    strategy_profile: str = "default"

    @classmethod
    def from_env(cls) -> "Settings":
        """Build settings from environment variables, falling back to defaults."""
        symbols_env = _get("DEFAULT_SYMBOLS")
        symbols = (
            tuple(s.strip() for s in symbols_env.split(",") if s.strip())
            if symbols_env
            else ("EURUSD", "GBPUSD", "USDJPY", "XAUUSD")
        )
        return cls(
            telegram_bot_token=_get("TELEGRAM_BOT_TOKEN"),
            telegram_chat_id=_get("TELEGRAM_CHAT_ID"),
            mt5_login=_get("MT5_LOGIN"),
            mt5_password=_get("MT5_PASSWORD"),
            mt5_server=_get("MT5_SERVER"),
            data_cache_dir=_get("DATA_CACHE_DIR", "data_cache"),
            reports_dir=_get("REPORTS_DIR", "reports"),
            state_db_path=_get("STATE_DB_PATH", "state/scalp_bot.db"),
            account_model=_get("ACCOUNT_MODEL", "fundingpips_2_step_phase_1"),
            default_symbols=symbols,
            strategy_profile=_get("STRATEGY_PROFILE", "default"),
        )
