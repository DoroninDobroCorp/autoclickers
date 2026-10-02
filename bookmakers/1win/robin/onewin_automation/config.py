"""Environment-backed configuration with secret-safe representations."""
from __future__ import annotations

import math
import os
from dataclasses import dataclass, field


def _bounded_float(name: str, default: float, minimum: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default
    return value if math.isfinite(value) and value >= minimum else default


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class OneWinAutomationConfig:
    """Configuration for the isolated automation package.

    ``proxy_url`` may contain credentials, so its dataclass representation is
    disabled. Consumers should pass it directly to a transport and log only a
    value processed by :mod:`onewin_automation.redaction`.
    """

    proxy_url: str = field(default="", repr=False)
    timeout_sec: float = 15.0
    cache_ttl_sec: float = 0.75
    price_tolerance: float = 0.001
    max_stake: float = 50.0
    live_enabled: bool = False

    @classmethod
    def from_env(cls) -> "OneWinAutomationConfig":
        proxy = (
            os.getenv("ONEWIN_AUTOMATION_PROXY", "").strip()
            or os.getenv("ONEWIN_SPORTSBOOK_PROXY", "").strip()
            or os.getenv("BETFAIR_PROXY", "").strip()
        )
        return cls(
            proxy_url=proxy,
            timeout_sec=_bounded_float("ONEWIN_AUTOMATION_TIMEOUT_SEC", 15.0, 3.0),
            cache_ttl_sec=_bounded_float("ONEWIN_SPORTSBOOK_CACHE_TTL_SEC", 0.75, 0.0),
            price_tolerance=_bounded_float("ONEWIN_AUTOMATION_PRICE_TOLERANCE", 0.001, 0.0),
            max_stake=_bounded_float("ONEWIN_AUTOMATION_MAX_STAKE", 50.0, 0.01),
            live_enabled=_env_flag("ONEWIN_AUTOMATION_LIVE_ENABLED", False),
        )
