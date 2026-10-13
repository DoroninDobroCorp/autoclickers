"""Adapter from the main automation queue (Node ``TasksManager``) to the common task.

The queue item is exactly what ``TaskBuilder.build`` stored: ``pair`` (event
record with ``first``/``second``/``sportName``/``isLive``/``event_id``) and
``outcomeData`` (the value outcome with ``reference_quote``, ``donor_quote``,
``margin_quotes``, ``roi_basis``, ``margin_basis``).  Nothing is recalculated
here: value, ROI and thresholds stay in the private caller.

Identity: the persisted queue ``id`` is the task identity.  It survives a
restart (it is read back from the queue file), so a replay produces the same
idempotency key and is refused as a duplicate by the durable stores.  The
queue stake is informational only: the caller must pass the stake in the
account currency explicitly (the Node queue works in its own currency).
"""
from __future__ import annotations

import hashlib
import math
from typing import Any

from .common import CommonTaskError, task_from_value

QUEUE_ADAPTER_VERSION = "automation-queue-adapter.v1"
_DONOR_BOOKMAKERS = {"1win", "onewin"}


def queue_item_identity(item: Any) -> str:
    """Stable idempotency key of one queue item (never derived from prices or clocks)."""
    if not isinstance(item, dict):
        raise CommonTaskError("queue item must be an object")
    task_id = item.get("id")
    if isinstance(task_id, bool) or not isinstance(task_id, (int, float, str)) or task_id == "":
        raise CommonTaskError("queue item id required")
    if isinstance(task_id, float) and not math.isfinite(task_id):
        raise CommonTaskError("queue item id must be finite")
    bookmaker = str(item.get("bookmakerId") or "").strip().lower()
    if bookmaker not in _DONOR_BOOKMAKERS:
        raise CommonTaskError("queue item is not addressed to 1win")
    digest = hashlib.sha256(f"queue|{bookmaker}|{task_id!r}".encode()).hexdigest()
    return f"q-{digest[:40]}"


def common_task_from_queue_item(item: dict[str, Any], *, stake: float, now: float) -> dict[str, Any]:
    """Convert a queue item into ``automation-task.v1`` (dry-run boundary preserved)."""
    key = queue_item_identity(item)
    pair, outcome = item.get("pair"), item.get("outcomeData")
    if not isinstance(pair, dict) or not isinstance(outcome, dict):
        raise CommonTaskError("queue item must carry pair and outcomeData")
    task = task_from_value(pair, outcome, stake=stake, idempotency_key=key, now=now)
    task["queue"] = {
        "adapter_version": QUEUE_ADAPTER_VERSION,
        "task_id": item.get("id"),
        "bookmaker_id": item.get("bookmakerId"),
        "source": item.get("source"),
        "queue_stake": item.get("stake"),
        "queue_currency_assumed_equal": False,
        "created_at": item.get("createdAt"),
    }
    return task
