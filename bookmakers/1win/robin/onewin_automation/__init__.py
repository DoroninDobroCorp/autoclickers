"""Request-first 1win automation primitives.

The package is intentionally isolated from RobinArb's existing bookmaker paths.
It prepares exact dry-run basket payloads and defines a disabled-by-default live
placement boundary; it does not contain credentials or silently submit bets.

The names below are loaded on first use: the queue consumer and the receipt exporter need only the
standard library and must not pull the sportsbook-matching dependencies (``rapidfuzz``) of the
basket/identity modules just because the package was imported.
"""
from __future__ import annotations

import importlib
from typing import Any

_EXPORTS = {
    "BasketPreparer": ".basket",
    "BasketReceipt": ".basket",
    "OneWinAutomationConfig": ".config",
    "ResolvedSelection": ".identity",
    "resolved_selection": ".identity",
}

__all__ = sorted(_EXPORTS)


def __getattr__(name: str) -> Any:
    module = _EXPORTS.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(importlib.import_module(module, __name__), name)
    globals()[name] = value
    return value
