"""Request-first 1win automation primitives.

The package is intentionally isolated from RobinArb's existing bookmaker paths.
It prepares exact dry-run basket payloads and defines a disabled-by-default live
placement boundary; it does not contain credentials or silently submit bets.
"""

from .basket import BasketPreparer, BasketReceipt
from .config import OneWinAutomationConfig
from .identity import ResolvedSelection, resolved_selection

__all__ = [
    "BasketPreparer",
    "BasketReceipt",
    "OneWinAutomationConfig",
    "ResolvedSelection",
    "resolved_selection",
]
