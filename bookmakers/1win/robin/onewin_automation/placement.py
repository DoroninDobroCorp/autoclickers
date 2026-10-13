"""Disabled-by-default money-sensitive placement state boundary."""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import datetime, timezone
import inspect
import math
import re
from typing import Any, Protocol

from .basket import BasketValidationError
from .common import CommonTaskError, verify_live_execution_conditions
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
        require_verified_order: bool = True,
        clock: Callable[[], float] | None = None,
        task_store: Any = None,
        diagnostic_only: bool = False,
    ):
        """``require_verified_order=True`` (default): the gate recomputes the live decision itself.

        ``place`` then needs ``payload['live_inputs'] = {task, quote, account_state}`` and calls
        ``verify_live_execution_conditions`` with its own clock, once before the claim and once
        more after the SUBMITTING record. A pre-built "order" object is never trusted. The bare
        legacy behaviour must be requested explicitly with ``require_verified_order=False``.
        """
        self.require_verified_order = bool(require_verified_order)
        self.diagnostic_only = bool(diagnostic_only)
        self.task_store = task_store
        self._clock = clock or (lambda: datetime.now(timezone.utc).timestamp())
        self.config = config or OneWinAutomationConfig.from_env()
        self.enabled = bool(enabled and self.config.live_enabled)
        self.transport = transport
        self.attempt_store = attempt_store
        self.max_stake = float(max_stake if max_stake is not None else self.config.max_stake)
        resolved_default = default_stake if default_stake is not None else self.config.default_stake
        self.default_stake = float(resolved_default) if resolved_default is not None else None
        if self.enabled and self.require_verified_order:
            store = attempt_store
            if (store is None or getattr(store, "is_durable", False) is not True
                    or not callable(getattr(store, "claim", None)) or not callable(getattr(store, "record_status", None))):
                raise LivePlacementDisabled(
                    "a verified-order gate needs a durable attempt store with claim and record_status")

    @classmethod
    def for_diagnostic_test(
        cls,
        *,
        transport: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
        attempt_store: AttemptStore,
        config: OneWinAutomationConfig | None = None,
        clock: Callable[[], float] | None = None,
        task_store: Any = None,
    ) -> "PlacementGate":
        """Placement gate for the owner-authorized single 1 USDT diagnostic test.

        The live switch comes from ``ONEWIN_AUTOMATION_LIVE_ENABLED`` (exactly ``true``) unless an
        explicit config is passed, the budget is 1 USDT, and the decision is recomputed here.
        """
        base = config or replace(OneWinAutomationConfig.from_env(), max_stake=1.0)
        return cls(
            enabled=True,
            config=base,
            transport=transport,
            attempt_store=attempt_store,
            max_stake=1.0,
            require_verified_order=True,
            clock=clock,
            task_store=task_store,
            diagnostic_only=True,
        )

    _ALIAS_FIELDS = ("event_id", "market_id", "selection_id", "expected_odds", "odds", "amount", "order_id")

    def _verify_inputs(self, payload: dict[str, Any], key: str, stake: float, currency: str) -> dict[str, Any]:
        if "order" in payload:
            raise BasketValidationError("a pre-built order object is not accepted; pass live_inputs")
        if "selection" in payload or "odds_group_id" in payload:
            raise BasketValidationError("nested selection / odds_group_id aliases are not accepted")
        inputs = payload.get("live_inputs")
        if (not isinstance(inputs, dict) or not isinstance(inputs.get("task"), dict)
                or not isinstance(inputs.get("quote"), dict) or not isinstance(inputs.get("account_state"), dict)):
            raise BasketValidationError("live_inputs {task, quote, account_state} are required")
        try:
            order = verify_live_execution_conditions(
                inputs["task"], inputs["quote"], inputs["account_state"], now=self._clock(),
                max_stake=self.max_stake, diagnostic_only=self.diagnostic_only, task_store=self.task_store)
        except CommonTaskError as exc:
            raise BasketValidationError(f"live conditions not met: {exc}") from exc
        if order["idempotency_key"] != key:
            raise BasketValidationError("payload idempotency_key does not match the verified task")
        if abs(float(order["stake"]) - stake) > 1e-9:
            raise BasketValidationError("payload stake does not match the verified task")
        if order["currency"] != currency:
            raise BasketValidationError("payload currency does not match the verified order")
        aliases = {"event_id": order["event_id"], "market_id": order["market_id"],
                   "selection_id": order["selection_id"], "expected_odds": order["odds"], "odds": order["odds"],
                   "amount": order["stake"]}
        for name, expected in aliases.items():
            if name in payload:
                value = payload[name]
                if isinstance(expected, float) or name == "amount":
                    if isinstance(value, bool) or not isinstance(value, (int, float)) or float(value) != float(expected):
                        raise BasketValidationError(f"payload {name} conflicts with the verified order")
                elif str(value) != str(expected):
                    raise BasketValidationError(f"payload {name} conflicts with the verified order")
        return order

    @staticmethod
    def _transport_payload(order: dict[str, Any]) -> dict[str, Any]:
        """Whitelist built from the verified order only: nothing else may reach the transport."""
        return {"idempotency_key": order["idempotency_key"], "event_id": order["event_id"],
                "market_id": order["market_id"], "selection_id": order["selection_id"], "odds": order["odds"],
                "stake": order["stake"], "currency": order["currency"]}

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
            order = self._verify_inputs(payload, key, stake_val, currency)
            normalized = self._transport_payload(order)
        else:
            normalized = dict(payload)
            normalized["stake"] = stake_val
            normalized["currency"] = currency

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
            # Permission is decided again at its own moment, after the await above, on a fresh clock.
            try:
                self._verify_inputs(payload, key, stake_val, currency)
            except BasketValidationError as exc:
                token_of = getattr(self.attempt_store, "submit_token", None)
                await self._record_status(key, "WITHDRAWN", error=f"EXPIRED_OR_CHANGED_BEFORE_TRANSPORT: {exc}",
                                          not_sent_proof={"forwarded_requests": 0,
                                                          "submit_token": token_of(key) if callable(token_of) else None})
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
        rejection_signal = (status in {"REJECTED", "DECLINED"} or code in {"REJECTED", "DECLINED"}
                            or err_code in self.KNOWN_REJECTIONS)
        bet_signal = result.get("ok") is True or bool(str(result.get("receipt_id") or result.get("bet_id") or "").strip())
        if rejection_signal and bet_signal:
            # An error next to a (possible) bet is not a rejection: the bet may exist.
            await self._record_outcome(key, "INDETERMINATE", receipt=result, error="MIXED_ERROR_AND_RECEIPT")
            raise PlacementIndeterminate("1win answered with both an error and a bet receipt")
        if rejection_signal:
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
        # The adapter exists for callers that predate verified orders; it is the explicit legacy name.
        kwargs.setdefault("require_verified_order", False)
        super().__init__(default_stake=default_stake, **kwargs)
