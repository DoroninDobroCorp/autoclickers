"""Export boundary for executor attempts (consumed by the settlement / reporting stages).

An attempt of the live executor (``DurableAttemptStore`` entry) is turned into a small, closed
record that says what happened to ONE identity: which native selection, which stake was requested,
what the bookmaker answered, and whether the evidence is synthetic.  This module never writes a
ledger, never computes profit and never marks anything settled: ``settlement`` is always
``pending`` and the export carries no value or ROI.  A receipt of a non-production transport is
exported with ``synthetic=True`` so that it cannot be mistaken for a real bet downstream.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any

EXPORT_SCHEMA = "automation-receipt-export.v1"
_STATUSES = {"CLAIMED", "PRE_CHECK_PASSED", "SUBMITTING", "ACCEPTED", "REJECTED", "INDETERMINATE", "WITHDRAWN"}
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


def export_attempt_receipt(entry: dict[str, Any], *, transport_environment: str,
                           queue_task_id: Any = None) -> dict[str, Any]:
    """``entry`` is one attempt of the executor store; ``transport_environment`` is stated by the
    caller (``production`` or ``local_stand``) and is never inferred from the receipt."""
    if not isinstance(entry, dict):
        raise ReceiptExportError("attempt entry must be an object")
    if transport_environment not in {"production", "local_stand"}:
        raise ReceiptExportError("transport_environment must be 'production' or 'local_stand'")
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
    synthetic = transport_environment != "production" or (bet_id is not None and bool(_SYNTHETIC_ID.match(bet_id)))
    mismatches = list(receipt.get("condition_mismatches") or []) if receipt else []
    record = {
        "schema_version": EXPORT_SCHEMA,
        "idempotency_key": key,
        "queue_task_id": queue_task_id,
        "attempt_status": status,
        "outcome": ("accepted_reconciled" if status == "INDETERMINATE" and reconciled and reconciled["kind"] == "placed"
                    else "not_placed_reconciled" if status == "INDETERMINATE" and reconciled and reconciled["kind"] == "not_placed"
                    else _OUTCOME[status]),
        "identity": {"event_id": entry.get("event_id"), "market_id": entry.get("market_id"), "selection_id": entry.get("selection_id")},
        "requested": {"stake": _number(entry.get("stake")), "currency": entry.get("currency"),
                      "expected_odds": _number(entry.get("expected_odds"))},
        "bookmaker_receipt": None,
        "rejection_code": entry.get("error") if status == "REJECTED" else None,
        "unresolved": status in {"CLAIMED", "PRE_CHECK_PASSED", "SUBMITTING", "INDETERMINATE"} and reconciled is None,
        "reconciliation": reconciled,
        "timestamps": {"created_at_utc": _iso(entry.get("created_at")), "updated_at_utc": _iso(entry.get("updated_at"))},
        "transport_environment": transport_environment,
        "synthetic": synthetic,
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
