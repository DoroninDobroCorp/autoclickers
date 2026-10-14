"""The 1win queue consumer: queue item -> common task -> verified order -> executor -> durable
attempt -> queue history -> receipt export.

No trading logic lives here.  Every decision is made by the common engine (``common``,
``queue_adapter``, ``cart_plan``, ``receipt_export``); this module only sequences them, owns the
claim of the queue item, and keeps the record that makes a restart exact.

What the consumer guarantees
----------------------------
* **No second send.**  One key per queue item (``queue_item_identity``); the executor's durable
  attempt store refuses a key it knows and one live intent per native selection.  The consumer never
  re-submits after the order was handed off: an unclear outcome is ``unresolved`` in the queue and
  ``INDETERMINATE`` in the attempt until it is reconciled by identity.
* **Ownership.**  A queue lease (``TasksManager.claimTask``) before any work, renewed while it lasts;
  one consumer per account state directory (instance lock).
* **Exact restart.**  The journal says how far an item got; the executor says what happened to the
  money.  ``recover()`` replays both and finishes what is owed: queue history, export.
* **Policy owns the account, the currency and the stake.**  Nothing in a queue item can raise a
  limit or change the account.
* **Jev advises.**  Its answer is recorded in the order; it can only veto (FAIL), it never arms.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ..cart_plan import cart_plan_from_order
from ..common import (CommonTaskError, DurableDryRunStore, assess_live_readiness, verify_live_execution_conditions)
from ..queue_adapter import QUEUE_ADAPTER_VERSION, common_task_from_queue_item, queue_item_identity
from ..receipt_export import ReceiptExportError, export_attempt_receipt
from .executor_client import ORDER_SCHEMA, ExecutorClient, ExecutorRefused, ExecutorUnavailable
from .journal import InstanceLock, Journal
from .jev_advisor import JevAdvisor
from .policy import Policy
from .queue_client import QueueClient, QueueError

REPORT_SCHEMA = "onewin-consumer-report.v1"
EXPORT_SCHEMA = "onewin-consumer-export.v1"
_TERMINAL = {"ACCEPTED", "REJECTED", "INDETERMINATE", "WITHDRAWN"}
_OPEN = {"CLAIMED", "PRE_CHECK_PASSED", "SUBMITTING"}
_ITEM_ACCOUNT_FIELDS = ("accountId", "account_id", "account", "login")


class Hooks:
    """Test seam: called at each durable point.  The product never installs one."""

    def at(self, point: str, **context: Any) -> None:  # pragma: no cover - default is a no-op
        return None


_DELIVERY_GRACE_S = 8.0   # how long a hand-off that was not answered is given to show up before it is fenced


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _sha(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode()).hexdigest()


def _atomic_write(path: Path, text: str) -> str:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(str(tmp), os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    try:
        os.write(fd, text.encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)
    dir_fd = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    return hashlib.sha256(text.encode()).hexdigest()


@dataclass
class Decision:
    """What happens to a queue item: one of accepted / rejected / not_sent / unresolved / dry_run."""

    status: str
    reasons: list[str] = field(default_factory=list)
    stage: str = ""
    ticket_id: str | None = None
    odds: float | None = None
    stake: float | None = None
    error_code: str | None = None

    def as_record(self) -> dict[str, Any]:
        return {"status": self.status, "reasons": list(self.reasons), "stage": self.stage, "ticket_id": self.ticket_id,
                "odds": self.odds, "stake": self.stake, "error_code": self.error_code}

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> "Decision":
        return cls(status=record["status"], reasons=list(record.get("reasons") or []), stage=record.get("stage", ""),
                   ticket_id=record.get("ticket_id"), odds=record.get("odds"), stake=record.get("stake"),
                   error_code=record.get("error_code"))


@dataclass
class Built:
    key: str
    task: dict[str, Any] | None = None
    evidence: dict[str, Any] | None = None
    advisory: dict[str, Any] | None = None
    order: dict[str, Any] | None = None
    plan: dict[str, Any] | None = None
    refusal: Decision | None = None
    synthetic: bool = True


class Consumer:
    def __init__(self, policy: Policy, *, queue: QueueClient, executor: ExecutorClient, advisor: JevAdvisor | None = None,
                 clock: Callable[[], float] = time.time, hooks: Hooks | None = None, log: Callable[[dict[str, Any]], None] | None = None):
        self.policy = policy
        self.queue = queue
        self.executor = executor
        self.advisor = advisor or JevAdvisor(url=None, token=None, timeout_s=policy.jev.timeout_s)
        self.clock = clock
        self.hooks = hooks or Hooks()
        self._log = log or (lambda record: None)
        self.state_dir = policy.account_dir
        self.journal: Journal | None = None
        self.prepared: DurableDryRunStore | None = None
        self.instance_lock: InstanceLock | None = None
        self._store_id: str | None = None   # identity of the executor's attempt store the orders are handed to

    # ------------------------------------------------------------------ lifecycle
    @property
    def writes(self) -> bool:
        return self.policy.mode in ("dry", "real")

    def open(self) -> None:
        """Take the account state (dry / real); observe and disabled own nothing."""
        if not self.writes:
            return
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.instance_lock = InstanceLock(self.state_dir / "consumer.lock")
        self.instance_lock.acquire()
        self.journal = Journal(self.state_dir / "journal.jsonl")
        self.prepared = DurableDryRunStore(self.state_dir / "prepared.sqlite")

    def close(self) -> None:
        if self.journal:
            self.journal.close()
        if self.prepared:
            self.prepared.close()
        if self.instance_lock:
            self.instance_lock.release()

    def preflight(self) -> dict[str, Any]:
        """The executor must be the one the policy means: same environment, armed when real."""
        health = self.executor.health()
        problems = []
        if health.get("transport_environment") != self.policy.environment:
            problems.append(f"executor_environment_{health.get('transport_environment')}_policy_{self.policy.environment}")
        if self.policy.mode == "real":
            if health.get("mode") != "real":
                problems.append("executor_not_in_real_mode")
            if health.get("live_gate_open") is not True:
                problems.append("executor_live_gate_closed")
            if self.policy.environment == "production" and health.get("store", {}).get("durable") is not True:
                problems.append("executor_store_not_durable")
        if problems:
            raise PreflightError(problems, health)
        self._store_id = (health.get("store") or {}).get("path_sha256")
        return health

    # ------------------------------------------------------------------ evaluation (read-only)
    def _evidence_request(self, task: dict[str, Any]) -> dict[str, Any]:
        quote = task["quote"]
        return {
            "schema": "automation-evidence-request.v1",
            "idempotency_key": task["idempotency_key"],
            "event_id": task["event_id"],
            "outcome_key": task["outcome_key"],
            "is_live": task["is_live"],
            "stake": task["stake"],
            "currency": self.policy.currency,
            "account_id": self.policy.account_id,
            "expires_at": task["expires_at"],
            "quote": {"odds": quote.get("odds"), "source_market": quote.get("source_market"), "execution": quote.get("execution"),
                      "market_axes": quote.get("market_axes")},
            "axes": task.get("axes"),
        }

    def evaluate(self, item: dict[str, Any], *, prepare: bool) -> Built:
        """Every step that may refuse, in order, each with its concrete reasons.  ``prepare`` writes the
        durable prepared-task record (dry/real); observe evaluates without writing anything."""
        p = self.policy
        try:
            key = queue_item_identity(item)
        except CommonTaskError as exc:
            return Built(key="unidentified", refusal=Decision("not_sent", [f"queue_item_identity_invalid:{exc}"], "adapter"))
        built = Built(key=key)

        # the account is the policy's: an item that names another one is refused, never re-addressed
        for name in _ITEM_ACCOUNT_FIELDS:
            declared = item.get(name)
            if declared not in (None, "") and str(declared).strip() != p.account_id:
                built.refusal = Decision("not_sent", [f"queue_item_names_other_account:{name}"], "policy")
                return built
        try:
            task = common_task_from_queue_item(item, stake=p.stake, stake_currency=p.currency, now=self.clock())
        except CommonTaskError as exc:
            built.refusal = Decision("not_sent", [f"adapter_refused:{exc}"] + [f"blocker:{b}" for b in exc.blockers], "adapter")
            return built
        built.task = task
        if prepare and self.prepared is not None:
            try:
                prepared = self.prepared.prepare(task, now=self.clock())
            except CommonTaskError as exc:
                built.refusal = Decision("not_sent", [f"task_not_preparable:{exc}"] + [f"blocker:{b}" for b in exc.blockers], "adapter")
                return built
            if prepared["status"] in {"WITHDRAWN", "EXPIRED", "INDETERMINATE", "REJECTED"}:
                built.refusal = Decision("not_sent", [f"task_already_terminal:{prepared['status']}"], "adapter")
                return built
        task_store = self.prepared if prepare else None

        try:
            evidence = self.executor.evidence(self._evidence_request(task), timeout_s=p.evidence_deadline_s)
        except ExecutorUnavailable as exc:
            built.refusal = Decision("not_sent", [f"executor_unavailable:{str(exc)[:80]}"], "evidence")
            return built
        except ExecutorRefused as exc:
            built.refusal = Decision("not_sent", [f"executor_refused_evidence:{exc.code}"], "evidence")
            return built
        built.evidence = evidence
        if evidence.get("available") is not True:
            built.refusal = Decision("not_sent", [f"executor_evidence_unavailable:{evidence.get('reason', 'unknown')}"], "evidence")
            return built
        env = (evidence.get("provenance") or {}).get("transport_environment")
        if env != p.environment:
            built.refusal = Decision("not_sent", [f"executor_environment_mismatch:{env}"], "evidence")
            return built
        built.synthetic = evidence.get("synthetic") is not False
        if built.synthetic and p.environment == "production":
            built.refusal = Decision("not_sent", ["synthetic_evidence_in_production_policy"], "evidence")
            return built
        quote, account = evidence.get("executor_quote"), evidence.get("account_state")
        diagnostic = p.purpose == "diagnostic_test"
        readiness = assess_live_readiness(task, quote, account, now=self.clock(), max_stake=p.max_stake,
                                          diagnostic_only=diagnostic, task_store=task_store)
        if readiness["execution_ready"] is not True:
            built.refusal = Decision("not_sent", [f"blocker:{b}" for b in readiness["execution_blockers"]], "engine")
            return built

        # advice: bounded by what is left of the task, never a permission, and only a FAIL can stop us
        built.advisory = self.advisor.advise(task, clock=self.clock)
        if built.advisory.get("status") == "FAIL" and p.jev_veto_on_fail:
            built.refusal = Decision("not_sent", ["jev_advises_fail"], "jev")
            return built

        try:
            order = verify_live_execution_conditions(task, quote, account, now=self.clock(), max_stake=p.max_stake,
                                                     diagnostic_only=diagnostic, task_store=task_store)
        except CommonTaskError as exc:
            built.refusal = Decision("not_sent", [f"blocker:{b}" for b in exc.blockers] or [f"engine_refused:{exc}"], "engine")
            return built
        ui = evidence.get("ui") or {}
        try:
            plan = cart_plan_from_order(order, event_url=ui.get("event_url"), market_name=ui.get("market_name"),
                                        ui_selection_name=ui.get("ui_selection_name"))
        except CommonTaskError as exc:
            built.refusal = Decision("not_sent", [f"plan_refused:{exc}"], "plan")
            return built
        plan["advisory"] = {k: built.advisory.get(k) for k in ("schema_version", "status", "execution_ready", "confidence",
                                                             "confidence_is_calibrated", "model", "reason", "prompt_version")}
        plan["policy"] = {"account_id": p.account_id, "purpose": p.purpose, "consumer_id": p.consumer_id}
        built.order, built.plan = order, plan
        return built

    def _envelope(self, built: Built, item: dict[str, Any]) -> dict[str, Any]:
        return {
            "schema": ORDER_SCHEMA,
            "mode": "real" if self.policy.mode == "real" else "dry",
            "plan": built.plan,
            "queue_ref": {"task_id": item.get("id"), "adapter_version": QUEUE_ADAPTER_VERSION},
            "consumer": {"id": self.policy.consumer_id},
            "provenance": {"synthetic": built.synthetic, "evidence_source": (built.evidence or {}).get("source")},
        }

    # ------------------------------------------------------------------ observe
    def observe(self, item: dict[str, Any]) -> dict[str, Any]:
        built = self.evaluate(item, prepare=False)
        report = {"schema": REPORT_SCHEMA, "mode": "observe", "key": built.key, "task_id": item.get("id")}
        if built.refusal:
            report.update(decision="would_refuse", reasons=built.refusal.reasons, stage=built.refusal.stage)
        else:
            report.update(decision="would_order", plan_sha256=_sha(built.plan), selection_id=built.plan["selection"]["selection_id"],
                          odds=built.plan["selection"]["price"], stake=built.plan["stake"], currency=built.plan["currency"],
                          advisory=(built.plan or {}).get("advisory"), expires_at=built.plan["expires_at"])
        if self.policy.mode != "observe":
            report["mode"] = self.policy.mode
        return report

    # ------------------------------------------------------------------ one item
    def process(self, item: dict[str, Any]) -> dict[str, Any]:
        """dry / real: claim, evaluate, hand off, follow the attempt, write the queue, export."""
        p = self.policy
        assert self.journal is not None
        try:
            key = queue_item_identity(item)
        except CommonTaskError as exc:
            return {"schema": REPORT_SCHEMA, "mode": p.mode, "key": None, "task_id": item.get("id"), "skipped": f"unidentifiable:{exc}"}
        task_id = item.get("id")

        # the account is the policy's: an item that names another one is not ours to touch at all
        for name in _ITEM_ACCOUNT_FIELDS:
            declared = item.get(name)
            if declared not in (None, "") and str(declared).strip() != p.account_id:
                return {"schema": REPORT_SCHEMA, "mode": p.mode, "key": key, "task_id": task_id,
                        "skipped": f"queue_item_names_other_account:{name}"}

        known = self.journal.items().get(key)
        if known and known["phase"] is not None:
            # the same message again (re-delivery / restart): finish what is owed, never start again
            return self.resume(key, item=item)

        claim = self.queue.request("claim", task_id=task_id, consumer_id=p.consumer_id, lease_ms=p.lease_ms)
        report: dict[str, Any] = {"schema": REPORT_SCHEMA, "mode": p.mode, "key": key, "task_id": task_id}
        if not claim.get("claimed"):
            report.update(skipped=f"not_claimed:{claim.get('reason')}", holder=claim.get("holder"))
            return report
        token = claim["claim"]["token"]
        self.journal.append({"phase": "claimed", "key": key, "task_id": task_id, "snapshot": item, "claim_token": token,
                             "consumer_id": p.consumer_id, "mode": p.mode})
        self.hooks.at("after_claim", key=key)

        try:
            built = self.evaluate(item, prepare=True)
        except Exception as exc:  # noqa: BLE001 - a bug must not leave the item half-processed
            built = Built(key=key, refusal=Decision("not_sent", [f"internal_error_before_order:{type(exc).__name__}"], "internal"))
        report["advisory"] = (built.advisory or {}).get("status")
        if built.refusal:
            return self._settle(key, item, built.refusal, attempt=None, report=report, built=built)
        self.journal.append({"phase": "built", "key": key, "plan_sha256": _sha(built.plan), "synthetic": built.synthetic,
                             "advisory": built.plan.get("advisory"), "evidence_source": (built.evidence or {}).get("source"),
                             "expires_at": built.plan["expires_at"]})
        self.hooks.at("after_built", key=key)

        envelope = self._envelope(built, item)
        # intent first: after a crash between this record and the answer, the executor is asked, never the item re-sent
        self.journal.append({"phase": "handed_off", "key": key, "mode": p.mode, "executor": p.executor.url,
                             "executor_store": self._store_id})
        self.hooks.at("after_handoff_recorded", key=key)
        if p.mode == "dry":
            return self._dry(key, item, envelope, report, built)
        # From here a lost lease proves nothing: the queue is told, so that the slot is freed with an
        # `unresolved` entry (exposure kept) and never with a cancellation.
        try:
            marked = self.queue.request("mark_handoff", task_id=task_id, token=token, attempt_key=key)
        except QueueError:
            marked = {"marked": False, "reason": "queue_unavailable"}
        if not marked.get("marked"):
            decision = Decision("not_sent", [f"handoff_not_marked_in_queue:{marked.get('reason')}"], "queue")
            return self._settle(key, item, decision, attempt=None, report=report, built=built)
        return self._real(key, item, envelope, report, built, token)

    def _dry(self, key: str, item: dict[str, Any], envelope: dict[str, Any], report: dict[str, Any], built: Built) -> dict[str, Any]:
        try:
            answer = self.executor.dry_run(envelope, timeout_s=max(self.policy.executor_deadline_s, 5.0))
        except (ExecutorUnavailable, ExecutorRefused) as exc:
            decision = Decision("not_sent", [f"dry_run_not_completed:{type(exc).__name__}:{str(exc)[:80]}"], "executor")
            return self._settle(key, item, decision, attempt=None, report=report, built=built)
        result = answer.get("result") or {}
        self.journal.append({"phase": "observed", "key": key, "dry_run": result})
        ok = (result.get("ok") is True and answer.get("external_placement") is False
              and not result.get("blocked_submit_requests") and result.get("coverage_ok") is True)
        if ok:
            decision = Decision("dry_run", ["dry_run_verified"], "executor", odds=result.get("board_price"), stake=built.plan["stake"])
        else:
            decision = Decision("not_sent", [f"dry_run_failed:{result.get('error') or 'cart_not_clean'}"], "executor")
        return self._settle(key, item, decision, attempt=None, report=report, built=built)

    def _real(self, key: str, item: dict[str, Any], envelope: dict[str, Any], report: dict[str, Any], built: Built, token: str) -> dict[str, Any]:
        delivery_unknown = False
        busy_until = time.monotonic() + 3.0
        while True:
            try:
                self.executor.submit(envelope)
                break
            except ExecutorRefused as exc:
                if exc.code == "EXECUTOR_BUSY" and time.monotonic() < busy_until:
                    # another placement is still being closed out; nothing was accepted, so asking again is safe
                    time.sleep(0.1)
                    continue
                decision = Decision("not_sent", [f"executor_refused_order:{exc.code}"], "executor")
                return self._settle(key, item, decision, attempt=None, report=report, built=built)
            except ExecutorUnavailable:
                delivery_unknown = True
                break
        # (a lost answer: the request may still be on its way. The attempt is asked for below and nothing is
        # re-sent; "never heard of it" is not proof while the request can be late.)
        self.hooks.at("after_submit_returned", key=key)
        try:
            attempt_view = self._await_attempt(key, item, token, delivery_unknown=delivery_unknown,
                                               unknown_reason="order_delivery_unknown_after_lost_answer", store=self._store_id)
        except Exception:  # noqa: BLE001 - after the hand-off nothing is assumed: the outcome stays unresolved
            attempt_view = {"unreachable": True}
        return self._finish_attempt(key, item, attempt_view, report, built=built)

    # ------------------------------------------------------------------ following the attempt
    def _fence(self, key: str, reason: str, *, store: str | None) -> tuple[str, dict[str, Any]]:
        """Ask the owner of the executor's attempt store to refuse ``key`` for good.  The only way a hand-off
        that was not answered is ever called "not sent": 'fenced' (no attempt existed, none can now), 'attempt'
        (one exists: follow it) or 'unknown' (nothing was acknowledged; the order may still arrive)."""
        try:
            out = self.executor.fence(key, reason)
        except (ExecutorUnavailable, ExecutorRefused) as exc:
            return "unknown", {"reason": f"fence_not_acknowledged:{type(exc).__name__}:{getattr(exc, 'code', '')}"}
        answered = (out.get("store") or {}).get("path_sha256")
        if store and answered != store:
            # an acknowledgement of another store says nothing about the one the order was handed to
            return "unknown", {"reason": "executor_store_is_not_the_one_the_order_was_handed_to"}
        if (out.get("fence") or {}).get("fenced") is True:
            return "fenced", out
        if out.get("attempt"):
            return "attempt", out
        return "unknown", {"reason": "fence_answer_not_understood"}

    def _await_attempt(self, key: str, item: dict[str, Any], token: str | None, *, delivery_unknown: bool = False,
                       unknown_reason: str = "order_delivery_unknown", store: str | None = None) -> dict[str, Any]:
        """Poll the executor until the attempt is terminal.  Renews the lease; passes a cancel on as a
        withdrawal request; at the deadline it stops waiting and the outcome stays unresolved.

        "Nothing there" is never a result by itself: the request may still be on its way (tunnel, queue).  The
        absence is only turned into "not sent" by the executor's fence (a durable refusal of the key)."""
        p = self.policy
        deadline = time.monotonic() + p.executor_deadline_s
        # a lost submit answer: wait this long for the order to show up before the fence is asked for
        grace_until = time.monotonic() + min(_DELIVERY_GRACE_S, p.executor_deadline_s / 2.0) if delivery_unknown else 0.0
        fence_rounds = 0
        next_renew = time.monotonic() + p.lease_ms / 3000.0
        withdrawn = False
        unreachable = 0
        view: dict[str, Any] = {}
        while True:
            try:
                view = self.executor.attempt(key)
                unreachable = 0
            except (ExecutorUnavailable, ExecutorRefused):
                unreachable += 1
                view = {"unreachable": True}
            attempt = view.get("attempt")
            if attempt and attempt.get("status") in _TERMINAL:
                return view
            if not attempt and not view.get("unreachable") and not view.get("in_flight"):
                last = view.get("last_run")
                if (last and last.get("finished_at")) or not last:
                    if not last and time.monotonic() < grace_until:
                        pass  # a lost answer: the order is given time to show up before the fence is asked for
                    elif fence_rounds >= 3:
                        view["delivery_unknown"] = True
                        view["unknown_reason"] = f"{unknown_reason}:fence_and_lookup_disagree"
                        return view
                    else:
                        fence_rounds += 1
                        verdict, detail = self._fence(key, "consumer_order_not_acknowledged", store=store)
                        if verdict == "fenced":
                            view["fenced_not_sent"] = True
                            return view
                        if verdict == "unknown":
                            view["delivery_unknown"] = True
                            view["unknown_reason"] = f"{unknown_reason}:{detail.get('reason')}"
                            return view
                        continue  # an attempt exists after all: the next lookup follows it
            now = time.monotonic()
            if attempt and not view.get("in_flight") and not view.get("unreachable") and attempt.get("status") in _OPEN:
                # an open attempt nobody is driving: the executor settles it (WITHDRAWN / INDETERMINATE), never re-sends
                try:
                    self.executor.recover()
                except (ExecutorUnavailable, ExecutorRefused):
                    pass
            if token and now >= next_renew:
                try:
                    self.queue.request("renew", task_id=item.get("id"), token=token, lease_ms=p.lease_ms)
                except QueueError:
                    pass
                next_renew = now + p.lease_ms / 3000.0
            if not withdrawn:
                state = None
                try:
                    state = self.queue.request("task_state", task_id=item.get("id"))
                except QueueError:
                    state = None
                if state and (state.get("stop_requested") or (state.get("where") is None and not any(
                        h.get("attemptKey") == key for h in state.get("history") or []))):
                    reason = "stop_requested" if state.get("stop_requested") else "queue_item_gone"
                    try:
                        self.executor.withdraw(key, reason)
                    except (ExecutorUnavailable, ExecutorRefused):
                        pass
                    withdrawn = True
            if now >= deadline:
                view["deadline_exceeded"] = True
                return view
            time.sleep(p.poll_interval_ms / 1000.0)

    def _decision_from_attempt(self, key: str, view: dict[str, Any], plan: dict[str, Any] | None = None) -> Decision:
        attempt = view.get("attempt")
        if not attempt:
            last = view.get("last_run") or {}
            if view.get("fenced_not_sent"):
                # acknowledged by the executor's store: the key can never be claimed, so nothing was or will be sent
                if last.get("finished_at"):
                    return Decision("not_sent", [f"executor_refused_before_claim:{last.get('thrown') or 'unknown'}", "fenced"], "executor")
                return Decision("not_sent", ["executor_fenced_order_before_claim"], "executor")
            if view.get("delivery_unknown"):
                return Decision("unresolved", [view.get("unknown_reason") or "order_delivery_unknown"], "executor")
            # unreachable / deadline: nothing is known, the executor may hold an attempt we cannot see
            return Decision("unresolved", ["executor_unreachable_attempt_unknown"], "executor")
        status = attempt.get("status")
        stake = attempt.get("stake")
        if status == "ACCEPTED":
            receipt = attempt.get("receipt") or {}
            ticket = receipt.get("bet_id") or receipt.get("receipt_id")
            if ticket in (None, ""):
                return Decision("unresolved", ["accepted_without_receipt_id"], "executor", stake=stake)
            reasons = ["accepted"] + [f"mismatch:{m}" for m in receipt.get("condition_mismatches") or []]
            return Decision("accepted", reasons, "executor", ticket_id=str(ticket), odds=receipt.get("accepted_cf"), stake=stake)
        if status == "REJECTED":
            return Decision("rejected", [f"bookmaker_rejected:{attempt.get('error')}"], "executor", stake=stake, error_code=attempt.get("error"))
        if status == "WITHDRAWN":
            return Decision("not_sent", [f"withdrawn:{attempt.get('error') or 'requested'}"], "executor", stake=stake)
        if status == "INDETERMINATE":
            return Decision("unresolved", [f"outcome_unknown:{attempt.get('error')}"], "executor", stake=stake)
        return Decision("unresolved", [f"attempt_open_at_deadline:{status}"], "executor", stake=stake)

    def _finish_attempt(self, key: str, item: dict[str, Any], view: dict[str, Any], report: dict[str, Any], *,
                        built: Built | None = None) -> dict[str, Any]:
        assert self.journal is not None
        attempt = view.get("attempt")
        self.journal.append({"phase": "observed", "key": key, "attempt_status": attempt.get("status") if attempt else None,
                             "native_idempotency_key": ((attempt or {}).get("native_request") or {}).get("idempotency_key"),
                             "deadline_exceeded": bool(view.get("deadline_exceeded")), "unreachable": bool(view.get("unreachable"))})
        self.hooks.at("after_observed", key=key)
        decision = self._decision_from_attempt(key, view)
        return self._settle(key, item, decision, attempt=attempt, report=report, built=built)

    # ------------------------------------------------------------------ queue + export
    def _settle(self, key: str, item: dict[str, Any], decision: Decision, *, attempt: dict[str, Any] | None,
                report: dict[str, Any], built: Built | None = None) -> dict[str, Any]:
        assert self.journal is not None
        self.journal.append({"phase": "decided", "key": key, "decision": decision.as_record()})
        self.hooks.at("after_decided", key=key)
        self._write_queue(key, item, decision, attempt)
        self.hooks.at("after_queue_written", key=key)
        export = self._export(key, item, attempt, decision)
        self.hooks.at("after_export", key=key)
        self._reconcile_prepared(key, decision)
        report.update(decision=decision.status, reasons=decision.reasons, stage=decision.stage,
                      attempt_status=attempt.get("status") if attempt else None, export=export)
        return report

    def _write_queue(self, key: str, item: dict[str, Any], decision: Decision, attempt: dict[str, Any] | None) -> dict[str, Any]:
        assert self.journal is not None
        provenance = self._attempt_provenance(attempt)
        if not attempt:
            # No attempt is known.  Whether the record is a test entry is a fact of the EVIDENCE the order was
            # built from (journalled at "built"), not of the absence: an order of real evidence whose delivery is
            # unknown is exposure.  An item refused before it was built (no "built" record) never was an order.
            built = ((self.journal.items().get(key) or {}).get("phases") or {}).get("built")
            if built is not None and built.get("synthetic") is False:
                provenance = {"synthetic": False, "environment": self.policy.environment}
        outcome: dict[str, Any] = {
            "status": decision.status, "attemptKey": key, "reason": "; ".join(decision.reasons)[:300] or None,
            "stake": decision.stake if decision.stake is not None else self.policy.stake,
            "synthetic": provenance["synthetic"], "transportEnvironment": provenance["environment"],
            "taskSnapshot": item, "errorCode": decision.error_code,
        }
        if decision.status == "accepted":
            outcome["ticketId"] = decision.ticket_id
            outcome["odds"] = decision.odds
        if decision.status == "dry_run":
            outcome["odds"] = decision.odds
            outcome["synthetic"] = provenance["synthetic"]
        written = self.queue.request("record_outcome", task_id=item.get("id"), outcome=outcome)
        self.journal.append({"phase": "queue_written", "key": key, "recorded": bool(written.get("recorded")),
                             "already": bool(written.get("already")), "queue_status": (written.get("entry") or {}).get("status")})
        return written

    @staticmethod
    def _attempt_provenance(attempt: dict[str, Any] | None) -> dict[str, Any]:
        if not attempt:
            # nothing was attempted at the bookmaker: the record is synthetic only if the evidence was
            return {"synthetic": True, "environment": None}
        try:
            record = export_attempt_receipt(attempt)
        except ReceiptExportError:
            return {"synthetic": True, "environment": None}
        return {"synthetic": record["synthetic"], "environment": record["transport_environment"]}

    def _export(self, key: str, item: dict[str, Any], attempt: dict[str, Any] | None, decision: Decision) -> dict[str, Any] | None:
        assert self.journal is not None
        if not attempt:
            self.journal.append({"phase": "exported", "key": key, "skipped": "no_attempt_at_the_bookmaker"})
            return None
        record = export_attempt_receipt(attempt, queue_task_id=item.get("id"))
        document = {"schema": EXPORT_SCHEMA, "key": key, "queue": {"task_id": item.get("id"), "decision": decision.status,
                                                                  "reasons": decision.reasons}, "receipt": record}
        path = self.state_dir / "exports" / f"{key}.json"
        digest = _atomic_write(path, json.dumps(document, sort_keys=True, indent=2, allow_nan=False) + "\n")
        self.journal.append({"phase": "exported", "key": key, "path": str(path), "sha256": digest})
        return {"path": str(path), "sha256": digest, "outcome": record["outcome"], "synthetic": record["synthetic"],
                "unresolved": record["unresolved"]}

    def _reconcile_prepared(self, key: str, decision: Decision) -> None:
        if self.prepared is None:
            return
        mapped = {"dry_run": "DRY_RUN_VERIFIED", "accepted": "EXPIRED", "rejected": "REJECTED", "not_sent": "WITHDRAWN",
                  "unresolved": "INDETERMINATE"}[decision.status]
        try:
            self.prepared.reconcile(key, status=mapped, revision=time.time_ns() // 1000)
        except CommonTaskError:
            pass  # unknown to the prepared store (refused before preparation) or already terminal

    # ------------------------------------------------------------------ restart / re-delivery
    def resume(self, key: str, *, item: dict[str, Any] | None = None) -> dict[str, Any]:
        """Finish an item the journal shows as unfinished.  Reads the executor for the truth; never re-sends."""
        assert self.journal is not None
        entry = self.journal.items().get(key)
        report: dict[str, Any] = {"schema": REPORT_SCHEMA, "mode": self.policy.mode, "key": key, "resumed_from": entry["phase"] if entry else None}
        if not entry:
            return report
        claimed = entry["phases"].get("claimed") or {}
        snapshot = claimed.get("snapshot") or item or {}
        report["task_id"] = snapshot.get("id")
        phase = entry["phase"]
        decided = (entry["phases"].get("decided") or {}).get("decision")

        if phase in ("queue_written", "exported", "decided") and decided:
            decision = Decision.from_record(decided)
            attempt = self._attempt_or_none(key)
            if phase == "decided" or self._still_queued(snapshot) or (
                    decision.status == "unresolved" and not (entry["phases"].get("exported") or {}).get("late_resolution")):
                # the decision was taken but the queue still holds the task (crash before the write, or a
                # re-delivered copy): record again, the record is idempotent per attempt key.  An unresolved
                # exposure is re-asserted from the journal every time: a queue file that lost it (restored
                # copy, an older TasksManager that aged it out) gets it back, an existing record is untouched.
                self._write_queue(key, snapshot, decision, attempt)
            if phase != "exported":
                self._export(key, snapshot, attempt, decision)
                self._reconcile_prepared(key, decision)
            late = self._late_resolution(key, snapshot, decision, attempt, entry)
            report.update(decision=decision.status, reasons=decision.reasons)
            if late:
                report["late_resolution"] = late
            return report

        handed = "handed_off" in entry["phases"] or "observed" in entry["phases"]
        mode = (entry["phases"].get("handed_off") or {}).get("mode") or claimed.get("mode") or self.policy.mode
        if mode == "dry":
            decision = Decision("not_sent", ["dry_run_interrupted_by_restart"], "recovery")
            return self._settle(key, snapshot, decision, attempt=None, report=report)
        # real: ask the executor what happened to the order, even when the hand-off was never journalled
        store = (entry["phases"].get("handed_off") or {}).get("executor_store")
        view = self._await_attempt_after_restart(key, snapshot, handed=handed, store=store)
        if view.get("not_handed_off"):
            # the hand-off is journalled BEFORE the request is made: no such record is this consumer's own
            # proof that it never asked the executor for anything
            decision = Decision("not_sent", ["consumer_stopped_before_order_was_handed_off"], "recovery")
            return self._settle(key, snapshot, decision, attempt=None, report=report)
        return self._finish_attempt(key, snapshot, view, report)

    def _still_queued(self, snapshot: dict[str, Any]) -> bool:
        try:
            return self.queue.request("task_state", task_id=snapshot.get("id")).get("where") is not None
        except QueueError:
            return False

    def _late_resolution(self, key: str, snapshot: dict[str, Any], decision: Decision, attempt: dict[str, Any] | None,
                         entry: dict[str, Any]) -> dict[str, Any] | None:
        """The consumer gave up waiting (deadline / executor unreachable) and left the entry ``unresolved``;
        the attempt has since reached a terminal state of its own: the entry is resolved by it."""
        assert self.journal is not None
        if decision.status != "unresolved":
            return None
        exported = entry["phases"].get("exported") or {}
        if exported.get("late_resolution"):
            return None
        if not attempt and (entry["phases"].get("observed") or {}).get("attempt_status") is None \
                and "handed_off" in entry["phases"] and self.policy.mode == "real":
            # no attempt was ever seen: only the executor's fence can say that the order will never arrive
            store = (entry["phases"].get("handed_off") or {}).get("executor_store")
            verdict, detail = self._fence(key, "consumer_recovery_unresolved_without_attempt", store=store)
            if verdict == "fenced":
                resolution = {"resolution": "not_placed", "operator": "consumer",
                              "evidence": "executor fenced the key: no attempt existed and none can be claimed any more"}
                resolved = self.queue.request("resolve_outcome", attempt_key=key, resolution=resolution)
                self.journal.append({"phase": "exported", "key": key, "late_resolution": "not_placed", "fenced": True,
                                     "attempt_status": None, "path": None, "sha256": None})
                return {"resolution": "not_placed", "fenced": True, "queue": bool(resolved.get("resolved") or resolved.get("already"))}
            if verdict != "attempt":
                return None
            attempt = detail.get("attempt")
        if not attempt or attempt.get("status") not in _TERMINAL:
            return None
        if attempt["status"] == "INDETERMINATE":
            return None
        if attempt["status"] == "ACCEPTED":
            receipt = attempt.get("receipt") or {}
            ticket = receipt.get("bet_id") or receipt.get("receipt_id")
            if ticket in (None, ""):
                return None
            resolution = {"resolution": "accepted", "ticketId": str(ticket), "odds": receipt.get("accepted_cf"),
                          "evidence": "executor attempt reached ACCEPTED after the consumer stopped waiting", "operator": "consumer"}
        else:
            resolution = {"resolution": "not_placed", "operator": "consumer",
                          "evidence": f"executor attempt reached {attempt['status']} after the consumer stopped waiting"}
        resolved = self.queue.request("resolve_outcome", attempt_key=key, resolution=resolution)
        new_decision = self._decision_from_attempt(key, {"attempt": attempt})
        export = self._export(key, snapshot, attempt, new_decision)
        self.journal.append({"phase": "exported", "key": key, "late_resolution": resolution["resolution"],
                             "attempt_status": attempt["status"], "path": (export or {}).get("path"), "sha256": (export or {}).get("sha256")})
        return {"resolution": resolution["resolution"], "queue": bool(resolved.get("resolved") or resolved.get("already"))}

    def _attempt_or_none(self, key: str) -> dict[str, Any] | None:
        try:
            return self.executor.attempt(key).get("attempt")
        except (ExecutorUnavailable, ExecutorRefused):
            return None

    def _await_attempt_after_restart(self, key: str, snapshot: dict[str, Any], *, handed: bool = True,
                                     store: str | None = None) -> dict[str, Any]:
        """After a restart.  Without a journalled hand-off nothing can have been sent by this consumer.  With
        one, the request may still be on its way: the executor is asked, and when it knows nothing the key is
        fenced; an unacknowledged fence leaves the outcome unresolved (never "not sent")."""
        if not handed:
            try:
                view = self.executor.attempt(key)
            except (ExecutorUnavailable, ExecutorRefused):
                view = {}
            if not view.get("attempt") and not view.get("in_flight"):
                return {"not_handed_off": True}
            return self._await_attempt(key, snapshot, token=None, store=None)
        return self._await_attempt(key, snapshot, token=None, delivery_unknown=True,
                                   unknown_reason="order_delivery_unknown_after_restart", store=store)

    def recover(self) -> list[dict[str, Any]]:
        """Finish every item the journal shows as unfinished (at start, before new work)."""
        if not self.writes or self.journal is None:
            return []
        out = []
        for key, item in list(self.journal.items().items()):
            if item["phase"] != "exported":
                out.append(self.resume(key))
                continue
            decided = (item["phases"].get("decided") or {}).get("decision") or {}
            if decided.get("status") == "unresolved" and not (item["phases"].get("exported") or {}).get("late_resolution"):
                report = self.resume(key)
                if report.get("late_resolution"):
                    out.append(report)
        return out

    # ------------------------------------------------------------------ driving
    def tick(self) -> dict[str, Any] | None:
        """One look at the queue: the current item of the bookmaker, if any."""
        current = self.queue.request("current")
        item = current.get("item")
        if not item:
            return None
        if self.policy.mode == "observe":
            return self.observe(item)
        if self.policy.mode in ("dry", "real"):
            return self.process(item)
        return None

    def run(self, *, max_items: int | None = None, idle_exit_s: float | None = None, stop: Callable[[], bool] | None = None,
            emit: Callable[[dict[str, Any]], None] | None = None) -> int:
        emit = emit or (lambda record: None)
        handled = 0
        if self.writes:
            for report in self.recover():
                emit(report)
        idle_since = time.monotonic()
        last_signature: Any = None
        while True:
            if stop and stop():
                break
            report = self.tick()
            if report is None:
                if idle_exit_s is not None and time.monotonic() - idle_since >= idle_exit_s:
                    break
                time.sleep(self.policy.poll_interval_ms / 1000.0)
                continue
            idle_since = time.monotonic()
            signature = (report.get("key"), report.get("decision"), report.get("plan_sha256"), tuple(report.get("reasons") or ()),
                         report.get("skipped"))
            if self.policy.mode != "observe" or signature != last_signature:
                emit(report)
                handled += 1
            last_signature = signature
            if report.get("skipped") or report.get("decision") in ("would_order", "would_refuse"):
                # nothing changed in the queue: do not spin on the same item
                time.sleep(self.policy.poll_interval_ms / 1000.0)
            if max_items is not None and handled >= max_items:
                break
        return handled

    # ------------------------------------------------------------------ operator reconciliation
    def reconcile(self, key: str, *, bet_id: str | None, not_placed: bool, evidence: str, operator: str) -> dict[str, Any]:
        """An INDETERMINATE attempt resolved by identity against the bookmaker's own history.

        Placed: the executor attempt gets ``receipt_reconciled`` (bet id + source) and the queue entry
        becomes completed with that ticket.  Not placed: ``reconciled_not_placed`` (operator + evidence
        required by the store) and the queue entry is cancelled.  Both re-export."""
        if bool(bet_id) == bool(not_placed):
            raise ValueError("exactly one of bet_id / not_placed")
        if not evidence.strip() or not operator.strip():
            raise ValueError("evidence and operator are required")
        if bet_id:
            view = self.executor.add_revision(key, "receipt_reconciled", {"bet_id": str(bet_id), "source": evidence, "operator": operator})
            resolution = {"resolution": "accepted", "ticketId": str(bet_id), "evidence": evidence, "operator": operator}
        else:
            view = self.executor.add_revision(key, "reconciled_not_placed", {"operator": operator, "evidence": evidence})
            resolution = {"resolution": "not_placed", "evidence": evidence, "operator": operator}
        resolved = self.queue.request("resolve_outcome", attempt_key=key, resolution=resolution)
        attempt = view.get("attempt")
        export = None
        if attempt:
            record = export_attempt_receipt(attempt)
            document = {"schema": EXPORT_SCHEMA, "key": key, "queue": {"decision": "reconciled", "resolution": resolution["resolution"]},
                        "receipt": record}
            path = self.state_dir / "exports" / f"{key}.json"
            export = {"path": str(path), "sha256": _atomic_write(path, json.dumps(document, sort_keys=True, indent=2, allow_nan=False) + "\n"),
                      "outcome": record["outcome"]}
        return {"key": key, "resolution": resolution["resolution"], "queue": resolved, "export": export}


class PreflightError(RuntimeError):
    def __init__(self, problems: list[str], health: dict[str, Any]):
        super().__init__(", ".join(problems))
        self.problems = problems
        self.health = health
