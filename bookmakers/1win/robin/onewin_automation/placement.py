"""Disabled-by-default money-sensitive placement state boundary."""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
import inspect
import math
import re
from typing import Any, Protocol

from .basket import BasketValidationError
from .config import OneWinAutomationConfig


class LivePlacementDisabled(RuntimeError):
    pass


class PlacementIndeterminate(RuntimeError):
    """The live request may have left the process; never retry automatically."""


class PlacementRejected(RuntimeError):
    pass


class PlacementRecordError(PlacementIndeterminate):
    """The bookmaker outcome is known but could not be recorded durably.

    ``receipt`` carries the outcome so that the caller can persist it elsewhere.
    The attempt key stays claimed, so no second bet can be placed under it.
    """

    def __init__(self, message: str, *, status: str, receipt: dict[str, Any] | None):
        super().__init__(message)
        self.status = status
        self.receipt = receipt


class AttemptStore(Protocol):
    """Durable shared store whose claim operation is atomic across workers."""

    async def claim(self, idempotency_key: str, **kwargs: Any) -> bool: ...


class PlacementGate:
    """One-shot live gate requiring an injected durable duplicate guard.

    Enforces that:
    1. The live feature is explicitly enabled both in code and environment.
    2. A durable attempt store is injected.
    3. The payload contains a supported, non-ambiguous, finite positive stake
       that does not exceed the configured maximum budget.
    4. An idempotency key and valid currency are provided.
    5. The attempt is atomically claimed and transition stages (SUBMITTING,
       ACCEPTED, REJECTED, INDETERMINATE) are durably recorded.
    6. Indeterminate responses fail closed without automated retries.
    """

    KNOWN_REJECTIONS = frozenset({
        "not_enough_funds", "zero_bet", "odd_closed", "odd_not_found",
        "currency_not_supported", "odd_cf_changed", "min_bet_amount",
        "min_bet_amount_v2", "max_bet_amount", "max_bet_amount_v2",
        "events_bet_limit_reached", "express_not_enough_outcomes",
        "freebet_not_found", "express_not_allowed", "freebet_cf_limit",
        "freebet_not_valid_currency", "validation_error", "bad_request_error",
        "stake_below_minimum", "stake_above_maximum", "limit_exceeded"
    })

    def __init__(
        self,
        *,
        enabled: bool,
        config: OneWinAutomationConfig | None = None,
        transport: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
        attempt_store: AttemptStore | None = None,
        max_stake: float | None = None,
        default_stake: float | None = None,
        require_verified_order: bool = False,
        clock: Callable[[], float] | None = None,
    ):
        self.require_verified_order = bool(require_verified_order)
        self._clock = clock or (lambda: datetime.now(timezone.utc).timestamp())
        self.config = config or OneWinAutomationConfig.from_env()
        self.enabled = bool(enabled and self.config.live_enabled)
        self.transport = transport
        self.attempt_store = attempt_store
        self.max_stake = float(max_stake if max_stake is not None else self.config.max_stake)
        resolved_default = default_stake if default_stake is not None else self.config.default_stake
        self.default_stake = float(resolved_default) if resolved_default is not None else None

    @classmethod
    def for_diagnostic_test(
        cls,
        *,
        transport: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
        attempt_store: AttemptStore,
        config: OneWinAutomationConfig | None = None,
        clock: Callable[[], float] | None = None,
    ) -> "PlacementGate":
        """Placement gate for the owner-authorized single 1 USDT diagnostic test.

        It only places a payload that carries a verified ``automation-live-order.v1``
        produced by ``verify_live_execution_conditions`` and re-checks the order's
        absolute expiry after the SUBMITTING record, immediately before the transport.
        """
        return cls(
            enabled=True,
            config=config or OneWinAutomationConfig(live_enabled=True, max_stake=1.0),
            transport=transport,
            attempt_store=attempt_store,
            max_stake=1.0,
            require_verified_order=True,
            clock=clock,
        )

    def _check_order(self, payload: dict[str, Any], key: str, stake: float, currency: str) -> dict[str, Any]:
        order = payload.get("order")
        if not isinstance(order, dict) or order.get("schema_version") != "automation-live-order.v1":
            raise BasketValidationError("a verified automation-live-order.v1 is required")
        if order.get("execution_ready") is not True or order.get("execution_blockers"):
            raise BasketValidationError("the order is not execution ready")
        if str(order.get("idempotency_key") or "") != key:
            raise BasketValidationError("order idempotency_key does not match the payload")
        order_stake = order.get("stake")
        if isinstance(order_stake, bool) or not isinstance(order_stake, (int, float)) or abs(float(order_stake) - stake) > 1e-9:
            raise BasketValidationError("order stake does not match the payload")
        if str(order.get("currency") or "").upper() != currency or currency != "USDT":
            raise BasketValidationError("order currency does not match the payload")
        for payload_key, order_key in (("event_id", "event_id"), ("market_id", "market_id"), ("selection_id", "selection_id")):
            if payload_key in payload and str(payload[payload_key]) != str(order.get(order_key)):
                raise BasketValidationError(f"order {order_key} does not match the payload")
        expected_odds = payload.get("expected_odds", payload.get("odds"))
        if expected_odds is not None:
            order_odds = order.get("odds")
            if isinstance(order_odds, bool) or not isinstance(order_odds, (int, float)) or float(order_odds) != float(expected_odds):
                raise BasketValidationError("order odds do not match the payload")
        self._assert_order_fresh(order)
        return order

    def _assert_order_fresh(self, order: dict[str, Any]) -> None:
        expires_at = order.get("expires_at")
        current = self._clock()
        if (isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)) or not math.isfinite(expires_at)
                or isinstance(current, bool) or not isinstance(current, (int, float)) or not math.isfinite(current)
                or current <= 0):
            raise BasketValidationError("order expiry or clock is invalid")
        if current >= expires_at:
            raise BasketValidationError("order EXPIRED before the transport")

    async def _record_status(self, key: str, status: str, **kwargs: Any) -> None:
        if self.attempt_store is not None and hasattr(self.attempt_store, "record_status"):
            res = self.attempt_store.record_status(key, status, **kwargs)
            if inspect.isawaitable(res):
                await res

    async def _record_outcome(self, key: str, status: str, *, receipt: dict[str, Any] | None, **kwargs: Any) -> None:
        """Record a post-transport outcome; a recording failure never hides the outcome."""
        try:
            await self._record_status(key, status, receipt=receipt, **kwargs)
        except Exception as exc:
            raise PlacementRecordError(
                f"1win outcome {status} could not be recorded durably: {exc}", status=status, receipt=receipt
            ) from exc

    async def place(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.enabled:
            raise LivePlacementDisabled("1win live placement is disabled")
        if self.attempt_store is None:
            raise LivePlacementDisabled("1win live placement requires a durable shared attempt store")
        if not isinstance(payload, dict):
            raise BasketValidationError("payload must be a dictionary")

        # 1. Supported stake contract: unambiguous, non-boolean, finite positive number
        raw_stake = payload.get("stake")
        if raw_stake is None:
            if self.default_stake is not None:
                stake_val = self.default_stake
            else:
                raise BasketValidationError("stake is required for live placement")
        else:
            if isinstance(raw_stake, bool):
                raise BasketValidationError("stake is missing or invalid")
            try:
                stake_val = float(raw_stake)
            except (TypeError, ValueError) as exc:
                raise BasketValidationError("stake is missing or invalid") from exc

        if not math.isfinite(stake_val) or stake_val <= 0:
            raise BasketValidationError("stake must be a positive finite number")
        if stake_val > self.max_stake:
            raise BasketValidationError(f"stake {stake_val:g} exceeds maximum allowed stake {self.max_stake:g}")

        # Check for conflicting amount field
        if "amount" in payload:
            raw_amt = payload.get("amount")
            if isinstance(raw_amt, bool):
                raise BasketValidationError("ambiguous stake/amount in live placement payload")
            try:
                amt_val = float(raw_amt)
            except (TypeError, ValueError) as exc:
                raise BasketValidationError("ambiguous stake/amount in live placement payload") from exc
            if not math.isfinite(amt_val) or abs(amt_val - stake_val) > 1e-9:
                raise BasketValidationError("ambiguous stake/amount in live placement payload")

        # 2. Idempotency key
        key = str(payload.get("idempotency_key") or "").strip()
        if not key or len(key) > 128:
            raise BasketValidationError("idempotency_key is required for live placement")

        # 3. Currency validation
        currency = str(payload.get("currency") or "USDT").strip().upper()
        if not re.match(r"^[A-Z]{3,6}$", currency):
            raise BasketValidationError("currency is invalid")

        order = None
        if self.require_verified_order:
            order = self._check_order(payload, key, stake_val, currency)

        normalized = dict(payload)
        normalized["stake"] = stake_val
        normalized["currency"] = currency
        if order is not None:
            # The attempt must always carry the native identity the order was verified for,
            # so that the store can refuse a second intent on the same selection.
            for field in ("event_id", "market_id", "selection_id"):
                normalized.setdefault(field, order[field])
            if "expected_odds" not in normalized and "odds" not in normalized:
                normalized["expected_odds"] = order["odds"]

        # 4. Atomic claim with full metadata
        try:
            sig = inspect.signature(self.attempt_store.claim)
            accepts_kw = len(sig.parameters) >= 2 or "stake" in sig.parameters or any(
                p.kind == p.VAR_KEYWORD for p in sig.parameters.values()
            )
        except Exception:
            accepts_kw = False

        if accepts_kw:
            claimed = self.attempt_store.claim(key, stake=stake_val, currency=currency, payload=normalized)
        else:
            claimed = self.attempt_store.claim(key)

        if inspect.isawaitable(claimed):
            claimed = await claimed
        if not claimed:
            raise BasketValidationError("duplicate 1win placement idempotency_key")

        # 5. Record SUBMITTING stage prior to network transmission
        await self._record_status(key, "SUBMITTING")
        if order is not None:
            # Freshness is decided at the moment of permission, after the await above.
            try:
                self._assert_order_fresh(order)
            except BasketValidationError as exc:
                await self._record_status(key, "WITHDRAWN", error=str(exc), not_sent_proof={"forwarded_requests": 0})
                raise

        # 6. Execute transport
        try:
            result = await self.transport(dict(normalized))
        except TimeoutError as exc:
            await self._record_outcome(key, "INDETERMINATE", receipt=None, error=str(exc) or "timeout")
            raise PlacementIndeterminate(str(exc) or "1win placement timed out after send") from exc
        except Exception as exc:
            await self._record_outcome(key, "INDETERMINATE", receipt=None, error=str(exc) or type(exc).__name__)
            raise PlacementIndeterminate(str(exc) or "1win placement result is indeterminate") from exc

        if not isinstance(result, dict):
            await self._record_outcome(key, "INDETERMINATE", receipt=None, error="invalid response type")
            raise PlacementIndeterminate("1win placement returned an invalid response")

        status = str(result.get("status") or "").strip().upper()
        code = str(result.get("code") or "").strip().upper()
        detail = str(result.get("detail") or result.get("message") or "1win placement rejected")

        # Check explicit bookmaker rejection
        errors = result.get("errors")
        err_code = str(errors[0].get("code") or "") if isinstance(errors, list) and errors and isinstance(errors[0], dict) else ""
        if (
            status in {"REJECTED", "DECLINED"}
            or code in {"REJECTED", "DECLINED"}
            or err_code in self.KNOWN_REJECTIONS
        ):
            await self._record_outcome(key, "REJECTED", receipt=result, error=detail)
            raise PlacementRejected(detail)

        # Check definitive acceptance
        if result.get("ok") is not True:
            await self._record_outcome(key, "INDETERMINATE", receipt=result, error="no definitive receipt or rejection")
            raise PlacementIndeterminate("1win placement returned no definitive receipt or rejection")

        receipt_id = str(result.get("receipt_id") or "").strip()
        if not receipt_id:
            await self._record_outcome(key, "INDETERMINATE", receipt=result, error="missing receipt identifier")
            raise PlacementIndeterminate("1win placement response has no receipt identifier")

        # Check receipt field consistency
        mismatches = []
        if "accepted_odds" in result:
            try:
                acc_odds = float(result["accepted_odds"])
                exp_odds = float(normalized.get("expected_odds") or normalized.get("odds") or 0)
                if exp_odds > 0 and abs(acc_odds - exp_odds) > 1e-9:
                    mismatches.append("accepted_odds_mismatch")
            except (TypeError, ValueError):
                mismatches.append("invalid_accepted_odds")
        if "amount" in result:
            try:
                acc_amt = float(result["amount"])
                if abs(acc_amt - stake_val) > 1e-9:
                    mismatches.append("accepted_amount_mismatch")
            except (TypeError, ValueError):
                mismatches.append("invalid_accepted_amount")
        if "currency" in result and str(result["currency"]).strip().upper() != currency:
            mismatches.append("accepted_currency_mismatch")

        if mismatches:
            result["condition_mismatch"] = True
            result["condition_mismatches"] = mismatches

        await self._record_outcome(key, "ACCEPTED", receipt=result)
        return result


class LegacyPlacementGateAdapter(PlacementGate):
    """Explicit compatibility adapter for legacy callers omitting stake.

    Injects the configured default stake (default 1.0 USDT) into the normalized
    payload before budget validation, attempt claim, and transport submission.
    """

    def __init__(self, *, default_stake: float = 1.0, **kwargs: Any):
        super().__init__(default_stake=default_stake, **kwargs)
