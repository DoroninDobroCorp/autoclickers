"""Disabled-by-default money-sensitive placement state boundary."""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from .basket import BasketValidationError
from .config import OneWinAutomationConfig


class LivePlacementDisabled(RuntimeError):
    pass


class PlacementIndeterminate(RuntimeError):
    """The live request may have left the process; never retry automatically."""


class PlacementRejected(RuntimeError):
    pass


class AttemptStore(Protocol):
    """Durable shared store whose claim operation is atomic across workers."""

    async def claim(self, idempotency_key: str) -> bool: ...


class PlacementGate:
    """One-shot live gate requiring an injected durable duplicate guard.

    No concrete 1win submit transport is supplied by this story before the
    authenticated contract is captured. The gate nevertheless fixes the money
    semantics required of that future transport.
    """

    def __init__(
        self,
        *,
        enabled: bool,
        config: OneWinAutomationConfig | None = None,
        transport: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
        attempt_store: AttemptStore | None = None,
    ):
        self.config = config or OneWinAutomationConfig.from_env()
        self.enabled = bool(enabled and self.config.live_enabled)
        self.transport = transport
        self.attempt_store = attempt_store

    async def place(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.enabled:
            raise LivePlacementDisabled("1win live placement is disabled")
        if self.attempt_store is None:
            raise LivePlacementDisabled("1win live placement requires a durable shared attempt store")
        key = str(payload.get("idempotency_key") or "").strip()
        if not key:
            raise BasketValidationError("idempotency_key is required for live placement")
        if not await self.attempt_store.claim(key):
            raise BasketValidationError("duplicate 1win placement idempotency_key")
        try:
            result = await self.transport(dict(payload))
        except TimeoutError as exc:
            raise PlacementIndeterminate(str(exc) or "1win placement timed out after send") from exc
        except Exception as exc:
            raise PlacementIndeterminate(str(exc) or "1win placement result is indeterminate") from exc
        if not isinstance(result, dict):
            raise PlacementIndeterminate("1win placement returned an invalid response")
        status = str(result.get("status") or "").strip().upper()
        code = str(result.get("code") or "").strip().upper()
        if status in {"REJECTED", "DECLINED"} or code in {"REJECTED", "DECLINED"}:
            raise PlacementRejected(str(result.get("detail") or "1win placement rejected"))
        if result.get("ok") is not True:
            raise PlacementIndeterminate("1win placement returned no definitive receipt or rejection")
        if not str(result.get("receipt_id") or "").strip():
            raise PlacementIndeterminate("1win placement response has no receipt identifier")
        return result
