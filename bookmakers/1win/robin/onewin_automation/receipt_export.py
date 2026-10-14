"""Export boundary for executor attempts (consumed by the settlement / reporting stages).

An attempt of the live executor (``DurableAttemptStore`` entry) is turned into a small, closed
record that says what happened to ONE identity: which native selection, which stake was requested,
which native idempotency key went on the wire, what the bookmaker answered, and whether the
evidence is synthetic.  This module never writes a ledger, never computes profit and never marks
anything settled: ``settlement`` is always ``pending`` and the export carries no value or ROI.

Provenance is read from the attempt itself, never from the caller: the executor stamps
``payload.executor_provenance`` (the transport environment it observed from the origins it was
configured with) and the order stamps ``payload.provenance`` (whether its evidence was synthetic).
A caller's label can only make a record MORE cautious: a result that is not provably production is
exported ``synthetic=True`` whatever the label and whatever its bet id looks like.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any

EXPORT_SCHEMA = "automation-receipt-export.v1"
_STATUSES = {"CLAIMED", "PRE_CHECK_PASSED", "SUBMITTING", "ACCEPTED", "REJECTED", "INDETERMINATE", "WITHDRAWN"}
_ENVIRONMENTS = {"production", "local_stand"}
_SYNTHETIC_ID = re.compile(r"^(?:STAND|SYNTHETIC|FAKE|TEST)[-_]", re.IGNORECASE)
_OUTCOME = {
    "ACCEPTED": "accepted",
    "REJECTED": "rejected",
    "INDETERMINATE": "unknown_reconcile_required",
    "WITHDRAWN": "not_sent",
    "CLAIMED": "in_flight_or_crashed",
    "PRE_CHECK_PASSED": "in_flight_or_crashed",
    "SUBMITTING": "in_flight_or_crashed",
}


class ReceiptExportError(ValueError):
    pass


def _iso(ms: Any) -> str | None:
    if isinstance(ms, bool) or not isinstance(ms, (int, float)) or not math.isfinite(ms) or ms <= 0:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value)


def _provenance(entry: dict[str, Any], payload: dict[str, Any], caller_label: str | None, bet_id: str | None) -> dict[str, Any]:
    executor = payload.get("executor_provenance") if isinstance(payload.get("executor_provenance"), dict) else {}
    order = payload.get("provenance") if isinstance(payload.get("provenance"), dict) else {}
    observed = executor.get("transport_environment")
    observed = observed if observed in _ENVIRONMENTS else None
    order_synthetic = order.get("synthetic") if isinstance(order.get("synthetic"), bool) else None
    reasons: list[str] = []
    if observed is None:
        reasons.append("executor_environment_not_recorded_in_attempt")
    elif observed != "production":
        reasons.append(f"executor_environment_{observed}")
    if order_synthetic is None:
        reasons.append("order_synthetic_flag_not_recorded")
    elif order_synthetic:
        reasons.append("order_evidence_synthetic")
    if caller_label is not None and caller_label != "production":
        reasons.append(f"caller_label_{caller_label}")
    if bet_id is not None and _SYNTHETIC_ID.match(bet_id):
        reasons.append("bet_id_carries_synthetic_marker")
    conflict = caller_label is not None and observed is not None and caller_label != observed
    return {
        "transport_environment": observed or "unverified",
        "synthetic": bool(reasons),
        "provenance": {
            "verified_from_attempt": observed is not None and order_synthetic is not None,
            "executor_environment_observed": observed,
            "executor_label_by_caller": caller_label,
            "label_conflict": conflict,
            "order_synthetic": order_synthetic,
            "evidence_source": order.get("evidence_source") if isinstance(order.get("evidence_source"), str) else None,
            "executor": {key: executor.get(key) for key in ("contract", "guard_version", "bet_api_origins", "browser_version")
                         if key in executor},
            "synthetic_reasons": reasons,
        },
    }


def export_attempt_receipt(entry: dict[str, Any], *, transport_environment: str | None = None,
                           queue_task_id: Any = None) -> dict[str, Any]:
    """``entry`` is one attempt of the executor store.  ``transport_environment`` is an optional
    label of the caller (``production`` or ``local_stand``); it is recorded but never trusted: the
    environment is the one the executor stamped into the attempt."""
    if not isinstance(entry, dict):
        raise ReceiptExportError("attempt entry must be an object")
    if transport_environment is not None and transport_environment not in _ENVIRONMENTS:
        raise ReceiptExportError("transport_environment must be 'production' or 'local_stand' when given")
    status = entry.get("status")
    key = entry.get("key")
    if status not in _STATUSES or not isinstance(key, str) or not key.strip():
        raise ReceiptExportError("attempt entry without a valid key/status")
    receipt = entry.get("receipt") if isinstance(entry.get("receipt"), dict) else None
    # operator reconciliation of an unknown outcome (revision, never a rewrite of the sealed attempt)
    reconciled = None
    for revision in entry.get("revisions") or []:
        if isinstance(revision, dict) and isinstance(revision.get("data"), dict):
            if revision.get("kind") == "receipt_reconciled" and revision["data"].get("bet_id") not in (None, ""):
                reconciled = {"kind": "placed", "bet_id": str(revision["data"]["bet_id"]), "source": revision["data"].get("source")}
            elif revision.get("kind") == "reconciled_not_placed":
                reconciled = {"kind": "not_placed", "source": revision["data"].get("evidence")}
    bet_id = None
    if receipt:
        raw = receipt.get("bet_id", receipt.get("receipt_id"))
        if isinstance(raw, (str, int)) and not isinstance(raw, bool) and str(raw).strip():
            bet_id = str(raw).strip()
    if status == "ACCEPTED" and bet_id is None:
        raise ReceiptExportError("ACCEPTED attempt without a bookmaker bet id cannot be exported")
    if reconciled and reconciled.get("bet_id") and bet_id is None and status == "INDETERMINATE":
        bet_id = reconciled["bet_id"]
    provenance = _provenance(entry, entry.get("payload") if isinstance(entry.get("payload"), dict) else {}, transport_environment, bet_id)
    native = entry.get("native_request") if isinstance(entry.get("native_request"), dict) else {}
    mismatches = list(receipt.get("condition_mismatches") or []) if receipt else []
    payload = entry.get("payload") if isinstance(entry.get("payload"), dict) else {}
    correlation = payload.get("correlation") if isinstance(payload.get("correlation"), dict) else {}
    if queue_task_id is None:
        queue_task_id = correlation.get("queue_task_id")
    record = {
        "schema_version": EXPORT_SCHEMA,
        "idempotency_key": key,
        "queue_task_id": queue_task_id,
        "purpose": payload.get("purpose") if payload.get("purpose") in {"diagnostic_test", "value"} else None,
        "source_quotes": payload.get("source_quotes") if isinstance(payload.get("source_quotes"), dict) else None,
        "attempt_status": status,
        "outcome": ("accepted_reconciled" if status == "INDETERMINATE" and reconciled and reconciled["kind"] == "placed"
                    else "not_placed_reconciled" if status == "INDETERMINATE" and reconciled and reconciled["kind"] == "not_placed"
                    else _OUTCOME[status]),
        "identity": {"event_id": entry.get("event_id"), "market_id": entry.get("market_id"), "selection_id": entry.get("selection_id"),
                     # the key the first-party page put on the wire: the handle for the bookmaker's own history
                     "native_idempotency_key": native.get("idempotency_key") if isinstance(native.get("idempotency_key"), str) else None,
                     "native_body_sha256": native.get("body_sha256") if isinstance(native.get("body_sha256"), str) else None},
        "requested": {"stake": _number(entry.get("stake")), "currency": entry.get("currency"),
                      "expected_odds": _number(entry.get("expected_odds"))},
        "bookmaker_receipt": None,
        "rejection_code": entry.get("error") if status == "REJECTED" else None,
        "unresolved": status in {"CLAIMED", "PRE_CHECK_PASSED", "SUBMITTING", "INDETERMINATE"} and reconciled is None,
        "reconciliation": reconciled,
        "timestamps": {"created_at_utc": _iso(entry.get("created_at")), "updated_at_utc": _iso(entry.get("updated_at"))},
        "transport_environment": provenance["transport_environment"],
        "synthetic": provenance["synthetic"],
        "provenance": provenance["provenance"],
        # the export is a fact about an attempt: nothing is settled and no money figure is derived
        "settlement": "pending",
        "financial_result": "not_recorded",
    }
    if reconciled and reconciled.get("bet_id") and not receipt:
        record["bookmaker_receipt"] = {"bet_id": reconciled["bet_id"], "accepted_odds": None, "accepted_amount": None, "currency": None,
                                       "possible_profit_amount_quoted": None, "rejected_amount": None, "condition_mismatches": [],
                                       "from_history_reconciliation": True}
    if receipt and bet_id is not None:
        record["bookmaker_receipt"] = {
            "bet_id": bet_id,
            "accepted_odds": _number(receipt.get("accepted_cf")),
            "accepted_amount": _number(receipt.get("amount")),
            "currency": receipt.get("currency"),
            "possible_profit_amount_quoted": _number(receipt.get("possible_profit_amount")),
            "rejected_amount": _number(receipt.get("rejected_amount")),
            "condition_mismatches": mismatches,
        }
    return record
