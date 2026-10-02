"""Public request transport adapter for the existing 1win Socket.IO client."""
from __future__ import annotations

import math
import time
from typing import Any

import onewin_sportsbook

from .config import OneWinAutomationConfig
from .snapshot import resolve_strict_quote


class OneWinPublicQuoteSource:
    """Expose the public price client behind the new package interface."""

    def __init__(
        self,
        config: OneWinAutomationConfig | None = None,
        *,
        client: Any | None = None,
    ):
        self.config = config or OneWinAutomationConfig.from_env()
        if client is None:
            public_config = onewin_sportsbook.OneWinSportsbookConfig(
                proxy_url=self.config.proxy_url,
                timeout_sec=self.config.timeout_sec,
                cache_ttl_sec=self.config.cache_ttl_sec,
            )
            client = onewin_sportsbook.OneWinSportsbookClient(public_config)
        self._client = client

    async def prefetch(self, arbs: list[dict[str, Any]]) -> None:
        await self._client.prefetch(arbs)

    async def resolve_live_quote(self, arb: dict[str, Any]) -> dict[str, Any]:
        await self._client.prefetch([arb])
        event_id = onewin_sportsbook.extract_event_id(arb)
        cache = getattr(self._client, "_cache", None)
        cached = cache.get(event_id) if event_id and isinstance(cache, dict) else None
        fresh = False
        if isinstance(cached, tuple) and cached:
            try:
                age = time.monotonic() - float(cached[0])
            except (TypeError, ValueError):
                age = math.inf
            fresh = -0.001 <= age <= self.config.cache_ttl_sec
        if (
            isinstance(cached, tuple)
            and len(cached) >= 3
            and isinstance(cached[1], dict)
            and fresh
        ):
            return resolve_strict_quote(
                arb,
                str(event_id),
                cached[1],
                elapsed_ms=cached[2],
            )
        if isinstance(cache, dict):
            return {
                "verified": False,
                "status": "UNAVAILABLE",
                "detail": "1win returned no fresh odds snapshot for this event",
                "current_odds": None,
                "event_id": event_id,
                "source": "onewin-public-ws",
            }
        return {
            "verified": False,
            "status": "RAW_SNAPSHOT_REQUIRED",
            "detail": "1win strict automation requires a raw snapshot cache interface",
            "current_odds": None,
            "source": "onewin-public-ws",
        }
