"""Dry-run basket preparation with fresh-price and identity guards."""
from __future__ import annotations

import math
import uuid
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Protocol

from .config import OneWinAutomationConfig
from .identity import IdentityError, ResolvedSelection, resolved_selection
from .redaction import redact_mapping


class BasketValidationError(ValueError):
    def __init__(self, message: str, *, quote: dict[str, Any] | None = None):
        super().__init__(message)
        self.quote = redact_mapping(quote or {})
        self.observed_state = str((quote or {}).get("status") or "")
        self.observed_price = (quote or {}).get("current_odds")


class PriceDriftError(BasketValidationError):
    pass


class QuoteSource(Protocol):
    async def resolve_live_quote(self, arb: dict[str, Any]) -> dict[str, Any]: ...


@dataclass(frozen=True)
class BasketReceipt:
    ok: bool
    status: str
    payload: dict[str, Any]
    quote: dict[str, Any]


def new_idempotency_key(prefix: str = "ow-dry") -> str:
    return f"{prefix}-{uuid.uuid4().hex}"


def _stake(value: Any, maximum: float) -> float:
    try:
        parsed = Decimal(str(value))
        maximum_decimal = Decimal(str(maximum))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise BasketValidationError("stake is missing or invalid") from exc
    if not parsed.is_finite() or parsed <= 0 or parsed > maximum_decimal:
        raise BasketValidationError(f"stake must be above 0 and at most {maximum:g}")
    rounded = parsed.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if rounded <= 0 or rounded > maximum_decimal:
        raise BasketValidationError(f"rounded stake must be above 0 and at most {maximum:g}")
    return float(rounded)


def build_dry_run_payload(
    *,
    arb: dict[str, Any],
    selection: ResolvedSelection,
    stake: float,
    idempotency_key: str,
    max_stake: float = 50.0,
) -> dict[str, Any]:
    key = str(idempotency_key or "").strip()
    if not key:
        raise BasketValidationError("idempotency_key is required")
    if len(key) > 128:
        raise BasketValidationError("idempotency_key is too long")
    return {
        "dry_run": True,
        "idempotency_key": key,
        "arb_id": str(arb.get("id") or "onewin"),
        "event_id": selection.event_id,
        "event_url": selection.event_url,
        "odds_group_id": selection.market_id,
        "odds_group_name": selection.market_name,
        "selection_id": selection.selection_id,
        "selection": selection.selection_name,
        "raw_selection": selection.raw_selection,
        "outcome": selection.outcome,
        "points": selection.points,
        "expected_odds": selection.price,
        "stake": _stake(stake, max_stake),
    }


class BasketPreparer:
    def __init__(
        self,
        quote_source: QuoteSource,
        *,
        config: OneWinAutomationConfig | None = None,
        price_tolerance: float | None = None,
        max_stake: float | None = None,
    ):
        inherited = config or getattr(quote_source, "config", None)
        if not isinstance(inherited, OneWinAutomationConfig):
            inherited = OneWinAutomationConfig()
        self.quote_source = quote_source
        tolerance = inherited.price_tolerance if price_tolerance is None else price_tolerance
        maximum = inherited.max_stake if max_stake is None else max_stake
        self.price_tolerance = max(0.0, float(tolerance))
        self.max_stake = float(maximum)

    async def prepare(
        self,
        arb: dict[str, Any],
        *,
        stake: float,
        idempotency_key: str | None = None,
    ) -> BasketReceipt:
        quote = await self.quote_source.resolve_live_quote(arb)
        try:
            selection = resolved_selection(arb, quote)
        except IdentityError as exc:
            status = str(quote.get("status") or "UNAVAILABLE")
            raise BasketValidationError(f"{status}: {exc}", quote=quote) from exc

        expected = arb.get("bk2_odds")
        try:
            expected_float = float(str(expected))
        except (TypeError, ValueError):
            expected_float = selection.price
        if not math.isfinite(expected_float) or expected_float <= 1:
            expected_float = selection.price
        if abs(selection.price - expected_float) > self.price_tolerance:
            raise PriceDriftError(
                f"1win price changed from {expected_float:g} to {selection.price:g}",
                quote=quote,
            )

        payload = build_dry_run_payload(
            arb=arb,
            selection=selection,
            stake=stake,
            idempotency_key=idempotency_key or new_idempotency_key(),
            max_stake=self.max_stake,
        )
        return BasketReceipt(ok=True, status="BASKET_READY", payload=payload, quote=dict(quote))
