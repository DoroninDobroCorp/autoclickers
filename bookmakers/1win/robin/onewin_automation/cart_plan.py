"""Build the exact plan consumed by ``OneWinLiveCart`` from a verified live order.

The plan carries only facts that were checked by
``verify_live_execution_conditions``; UI strings are supplied by the executor
that read them from the first-party page.  Nothing here relaxes a guard.
"""
from __future__ import annotations

import copy
import math
from typing import Any

from .common import CommonTaskError


def _text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CommonTaskError(f"{name} required")
    return value.strip()


def cart_plan_from_order(order: dict[str, Any], *, event_url: str, market_name: str,
                         ui_selection_name: str) -> dict[str, Any]:
    if not isinstance(order, dict) or order.get("schema_version") != "automation-live-order.v1" \
            or order.get("execution_ready") is not True or order.get("execution_blockers"):
        raise CommonTaskError("verified automation-live-order.v1 required")
    evidence = order.get("evidence") or {}
    account = evidence.get("account") or {}
    expiries = evidence.get("expiries")
    if not isinstance(expiries, dict):
        raise CommonTaskError("evidence expiries required")
    price = order.get("odds")
    if isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price) or price <= 1:
        raise CommonTaskError("open price required")
    return {
        "ok": True,
        "execution_ready": True,
        "execution_blockers": [],
        "live_submit_contract_verified": True,
        "live_submit_contract_source": _text(evidence.get("live_submit_contract_source"), "live_submit_contract_source"),
        "idempotency_key": order["idempotency_key"],
        "purpose": order.get("purpose"),
        "correlation": copy.deepcopy(order.get("correlation")),
        "source_quotes": copy.deepcopy(order.get("source_quotes")),
        "stake": order["stake"],
        "currency": order["currency"],
        "expires_at": order["expires_at"],
        "evidence": {"expiries": copy.deepcopy(expiries), "origin": copy.deepcopy(evidence.get("executor_quote"))},
        "axes_adapter_version": order["axes_adapter_version"],
        "expected_axes": copy.deepcopy(order["expected_settlement_facts"]),
        "expected_axes_original": copy.deepcopy(order["expected_axes"]),
        "account_conditions": {
            "logged_in": account.get("logged_in"),
            "account_identity_verified": account.get("account_identity_verified"),
            "account_identity_source": account.get("account_identity_source"),
            "currency": account.get("currency"),
            "available_balance": account.get("available_balance"),
            "commission": order["commission"],
            "max_stake": order["max_stake"],
            "capacity": copy.deepcopy(order["capacity"]),
            "live_submit_contract_verified": True,
        },
        "selection": {
            "event_id": order["event_id"],
            "event_url": _text(event_url, "event_url"),
            "market_id": order["market_id"],
            "market_name": _text(market_name, "market_name"),
            "selection_id": order["selection_id"],
            "price": price,
            "axes": copy.deepcopy(order["settlement_facts"]),
        },
        "ui_selection_name": _text(ui_selection_name, "ui_selection_name"),
    }
