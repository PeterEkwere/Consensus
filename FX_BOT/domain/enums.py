"""Canonical string types and stage constants shared across the system.

These are kept as ``Literal`` type aliases (not ``enum.Enum``) so that domain
dataclasses stay JSON-friendly and comparisons read naturally in strategy code.
Runtime-validated tuples live here so both the engine and tests import one source
of truth for the legal values.
"""
from __future__ import annotations

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

DIRECTIONS: tuple[Direction, ...] = ("long", "short")
TRENDS: tuple[Trend, ...] = ("bull", "bear", "range")

# Ordered lifecycle of a healthy setup.
STAGE_ORDER: tuple[SetupStage, ...] = (
    "idle",
    "sweep_found",
    "rejection_confirmed",
    "bos_confirmed",
    "waiting_retest",
    "entry_triggered",
)

# Stages that still hold a live, mutable setup (not idle, not terminal).
ACTIVE_STAGES: tuple[SetupStage, ...] = (
    "sweep_found",
    "rejection_confirmed",
    "bos_confirmed",
    "waiting_retest",
)

# Stages the state machine can never leave.
TERMINAL_STAGES: tuple[SetupStage, ...] = ("entry_triggered", "invalidated", "expired")


def opposite(direction: Direction) -> Direction:
    """Return the opposite trade direction."""
    return "short" if direction == "long" else "long"


def is_active(stage: SetupStage) -> bool:
    """True when a setup is mid-flight and can still advance or invalidate."""
    return stage in ACTIVE_STAGES
