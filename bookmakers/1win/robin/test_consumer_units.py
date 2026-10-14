"""Units of the consumer: policy, journal, instance lock, adviser budget."""
from __future__ import annotations

import copy
import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from onewin_automation.consumer.jev_advisor import JevAdvisor
from onewin_automation.consumer.journal import InstanceLock, InstanceLockError, Journal, JournalError
from onewin_automation.consumer.policy import PolicyError, load_policy, parse_policy

BASE = {"schema": "onewin-consumer-policy.v1", "mode": "dry", "account_id": "acct-1", "currency": "USDT", "stake": 1.0, "max_stake": 1.0,
        "purpose": "diagnostic_test", "environment": "local_stand", "tasks_file": "/x/tasks.json", "state_dir": "/x/state",
        "executor": {"url": "http://127.0.0.1:1", "token_env": "ONEWIN_EXECUTOR_TOKEN"}}


class PolicyTest(unittest.TestCase):
    def test_closed_schema_and_defaults(self):
        policy = parse_policy(BASE)
        self.assertEqual((policy.mode, policy.currency, policy.bookmaker_id, policy.jev_veto_on_fail), ("dry", "USDT", "1win", True))
        self.assertEqual(parse_policy({k: v for k, v in BASE.items() if k != "mode"}).mode, "disabled")
        with self.assertRaises(PolicyError):
            parse_policy({**BASE, "account": "someone-else"})        # unknown fields are refused, not ignored
        with self.assertRaises(PolicyError):
            parse_policy({**BASE, "tasks_file": 7})

    def test_the_policy_owns_currency_stake_and_environment(self):
        for patch in ({"currency": "EUR"}, {"stake": 0}, {"stake": -1}, {"stake": True}, {"stake": float("nan")}, {"stake": 2.0, "max_stake": 1.0},
                      {"purpose": "diagnostic_test", "stake": 2.0, "max_stake": 2.0}, {"environment": None}, {"environment": "staging"},
                      {"account_id": ""}, {"account_id": "a b"}, {"bookmaker_id": "sansabet"}, {"mode": "live"}):
            with self.subTest(patch=patch), self.assertRaises(PolicyError):
                parse_policy({**BASE, **patch})
        parse_policy({**BASE, "purpose": "value", "stake": 2.0, "max_stake": 5.0})

    def test_a_command_line_mode_can_only_lower(self):
        policy = parse_policy({**BASE, "mode": "dry"})
        self.assertEqual(policy.with_mode("observe").mode, "observe")
        self.assertEqual(policy.with_mode("disabled").mode, "disabled")
        with self.assertRaises(PolicyError):
            policy.with_mode("real")

    def test_secrets_are_names_of_environment_variables_never_values(self):
        for executor in ({"url": "http://127.0.0.1:1", "token_env": "plain-secret-value"}, {"url": "ftp://x", "token_env": "ONEWIN_EXECUTOR_TOKEN"}):
            with self.assertRaises(PolicyError):
                parse_policy({**BASE, "executor": executor})
        with self.assertRaises(PolicyError):
            parse_policy({**BASE, "jev": {"url_env": "https://gateway.example/api", "token_env": "JEV_TOKEN"}})
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "p.json"
            path.write_text(json.dumps(BASE))
            self.assertEqual(load_policy(path).account_id, "acct-1")
            with self.assertRaises(PolicyError):
                load_policy(Path(d) / "missing.json")


class JournalTest(unittest.TestCase):
    def test_phases_replay_and_a_torn_tail_is_cut(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "j.jsonl"
            journal = Journal(path)
            journal.append({"phase": "claimed", "key": "k1", "snapshot": {"id": 1}})
            journal.append({"phase": "built", "key": "k1"})
            journal.append({"phase": "claimed", "key": "k2", "snapshot": {"id": 2}})
            journal.close()
            with open(path, "ab") as handle:
                handle.write(b'{"phase": "handed_off", "key": "k1", "at"')   # a crash in the middle of a write
            reopened = Journal(path)
            items = reopened.items()
            self.assertEqual((items["k1"]["phase"], items["k2"]["phase"]), ("built", "claimed"))
            reopened.append({"phase": "handed_off", "key": "k1"})
            self.assertEqual(reopened.items()["k1"]["phase"], "handed_off")
            self.assertTrue(path.read_bytes().endswith(b"\n"))

    def test_a_corrupt_record_in_the_middle_is_an_error_not_a_skip(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "j.jsonl"
            path.write_bytes(b'{"phase":"claimed","key":"k"}\nnot json\n{"phase":"built","key":"k"}\n')
            with self.assertRaises(JournalError):
                Journal(path).records()


class InstanceLockTest(unittest.TestCase):
    def test_second_holder_refused_dead_holder_taken_over(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "consumer.lock"
            first = InstanceLock(path, stale_s=2)
            first.acquire()
            with self.assertRaises(InstanceLockError):
                InstanceLock(path, stale_s=2).acquire()
            first.release()
            self.assertFalse(path.exists())
            path.write_text(json.dumps({"pid": 999999, "host": "gone", "token": "t", "heartbeat_at": time.time() - 60}))
            taken = InstanceLock(path, stale_s=2)
            taken.acquire()
            taken.release()
            # a holder on THIS host whose process is gone is stale at once, however fresh its last beat
            import socket
            path.write_text(json.dumps({"pid": 2147483646, "host": socket.gethostname(), "token": "t", "heartbeat_at": time.time()}))
            again = InstanceLock(path, stale_s=600)
            again.acquire()
            again.release()
            # ... and a live one on this host is not taken over
            path.write_text(json.dumps({"pid": os.getpid(), "host": socket.gethostname(), "token": "t", "heartbeat_at": time.time()}))
            with self.assertRaises(InstanceLockError):
                InstanceLock(path, stale_s=600).acquire()


class AdviserTest(unittest.TestCase):
    TASK = {"schema_version": "automation-task.v1", "mode": "dry_run", "execution_ready": False, "expires_at": 1000.0}

    def test_not_configured_is_a_record_not_a_refusal(self):
        out = JevAdvisor(url=None, token=None, timeout_s=1.0).advise(self.TASK, clock=lambda: 900.0)
        self.assertEqual((out["status"], out["execution_ready"], out["reason"]), ("NOT_CONFIGURED", False, "jev_not_configured"))

    def test_no_time_left_means_no_call(self):
        calls = []

        class Boom:
            def __init__(self, *a):
                calls.append(a)

        advisor = JevAdvisor(url="http://x", token="t" * 16, timeout_s=2.0, client_factory=Boom)
        out = advisor.advise(self.TASK, clock=lambda: 999.9)
        self.assertEqual((out["status"], out["reason"]), ("INVESTIGATE", "no_time_left_for_review"))
        self.assertEqual(calls, [])

    def test_a_client_that_raises_or_answers_late_cannot_arm_anything(self):
        class Raises:
            def __init__(self, *a):
                pass

            async def system_one(self, state, questions):
                raise RuntimeError("down")

        out = JevAdvisor(url="http://x", token="t" * 16, timeout_s=2.0, client_factory=Raises).advise(self.TASK, clock=lambda: 900.0)
        self.assertEqual((out["status"], out["execution_ready"], out["reason"]), ("INVESTIGATE", False, "review_unavailable_or_invalid"))

        class Answer:
            def __init__(self, *a):
                pass

            async def system_one(self, state, questions):
                from types import SimpleNamespace
                return SimpleNamespace(choices={"decision": SimpleNamespace(choice="PASS", confidence=0.99)}, model="m")

        ticks = iter([900.0, 900.0, 1000.5])   # the task expires while the gateway thinks
        out = JevAdvisor(url="http://x", token="t" * 16, timeout_s=2.0, client_factory=Answer).advise(self.TASK, clock=lambda: next(ticks, 1000.5))
        self.assertEqual((out["status"], out["execution_ready"]), ("INVESTIGATE", False))


class LostAnswerTest(unittest.TestCase):
    """The order was handed to the executor and the answer was lost: "never heard of it" is not proof
    while the request can still arrive, so the outcome is unresolved, never "not sent"."""

    def _consumer(self, executor, tmp):
        from onewin_automation.consumer.core import Consumer
        policy = parse_policy({**BASE, "mode": "real", "state_dir": str(tmp), "executor_deadline_s": 1.0, "poll_interval_ms": 50})

        class Queue:
            def __init__(self):
                self.calls = []

            def request(self, op, **args):
                self.calls.append((op, args))
                if op == "task_state":
                    return {"where": "current", "stop_requested": False, "claim": None, "history": []}
                if op == "record_outcome":
                    return {"recorded": True, "entry": {"status": args["outcome"]["status"]}}
                return {}

        consumer = Consumer(policy, queue=Queue(), executor=executor)
        consumer.open()
        return consumer

    @staticmethod
    def _executor(*, fence=None, store="aaaa", attempts=None):
        """A reachable executor that knows nothing of the key.  ``fence``: a callable (key, reason) -> answer
        or an exception class to raise; None = the route is missing (an older executor: 404)."""
        from onewin_automation.consumer.executor_client import ExecutorRefused

        class Executor:
            fences = []

            def submit(self, envelope):
                from onewin_automation.consumer.executor_client import ExecutorUnavailable
                raise ExecutorUnavailable("timed out")

            def attempt(self, key):
                if attempts:
                    return next(attempts)
                return {"attempt": None, "in_flight": False, "last_run": None, "fenced": None}

            def recover(self):
                return {}

            def fence(self, key, reason):
                Executor.fences.append((key, reason))
                if fence is None:
                    raise ExecutorRefused(404, "NOT_FOUND", "unknown route")
                return fence(key, reason)

        Executor.fences = []
        return Executor()

    @staticmethod
    def _fenced_answer(store="aaaa"):
        return lambda key, reason: {"fence": {"fenced": True, "tombstone": {"at": 1, "reason": reason}}, "key": key,
                                    "store": {"path_sha256": store}, "attempt": None, "in_flight": False, "last_run": None}

    def test_lost_submit_answer_with_nothing_found_is_unresolved(self):
        """Nothing found is not proof: without the executor's fence acknowledgement the order may still arrive."""
        with tempfile.TemporaryDirectory() as d:
            consumer = self._consumer(self._executor(fence=None), d)
            try:
                view = consumer._await_attempt("k", {"id": 1.5}, None, delivery_unknown=True,
                                               unknown_reason="order_delivery_unknown_after_lost_answer")
                self.assertTrue(view.get("delivery_unknown"))
                decision = consumer._decision_from_attempt("k", view)
                self.assertEqual(decision.status, "unresolved")
                self.assertIn("fence_not_acknowledged", decision.reasons[0])
            finally:
                consumer.close()

    def test_restart_after_a_journalled_handoff_never_calls_a_missing_attempt_not_sent_without_the_fence(self):
        """The case of the coordinator's probe: a reachable executor with attempt=null, in_flight=false, no run."""
        with tempfile.TemporaryDirectory() as d:
            consumer = self._consumer(self._executor(fence=None), d)
            try:
                view = consumer._await_attempt_after_restart("prior-handoff", {"id": 1.5}, handed=True)
                decision = consumer._decision_from_attempt("prior-handoff", view)
                self.assertEqual(decision.status, "unresolved")
                self.assertFalse(view.get("fenced_not_sent"))
                self.assertIn("order_delivery_unknown_after_restart", decision.reasons[0])
            finally:
                consumer.close()

    def test_restart_with_the_fence_acknowledged_is_not_sent_and_the_key_is_refused_for_good(self):
        with tempfile.TemporaryDirectory() as d:
            executor = self._executor(fence=self._fenced_answer("aaaa"))
            consumer = self._consumer(executor, d)
            try:
                view = consumer._await_attempt_after_restart("prior-handoff", {"id": 1.5}, handed=True, store="aaaa")
                decision = consumer._decision_from_attempt("prior-handoff", view)
                self.assertEqual((decision.status, decision.reasons), ("not_sent", ["executor_fenced_order_before_claim"]))
                self.assertEqual([k for k, _ in executor.fences], ["prior-handoff"])
            finally:
                consumer.close()

    def test_a_fence_given_by_another_store_is_not_an_acknowledgement(self):
        with tempfile.TemporaryDirectory() as d:
            consumer = self._consumer(self._executor(fence=self._fenced_answer("bbbb")), d)
            try:
                view = consumer._await_attempt_after_restart("prior-handoff", {"id": 1.5}, handed=True, store="aaaa")
                decision = consumer._decision_from_attempt("prior-handoff", view)
                self.assertEqual(decision.status, "unresolved")
                self.assertIn("executor_store_is_not_the_one_the_order_was_handed_to", decision.reasons[0])
            finally:
                consumer.close()

    def test_when_the_fence_finds_an_attempt_that_attempt_is_followed(self):
        answers = iter([{"attempt": None, "in_flight": False, "last_run": None},
                        {"attempt": {"status": "ACCEPTED", "stake": 1.0, "receipt": {"bet_id": "B-9", "accepted_cf": 1.8}},
                         "in_flight": False}])
        fence = lambda key, reason: {"fence": {"fenced": False, "status": "ACCEPTED"}, "store": {"path_sha256": "aaaa"},   # noqa: E731
                                     "attempt": {"status": "ACCEPTED"}}
        with tempfile.TemporaryDirectory() as d:
            consumer = self._consumer(self._executor(fence=fence, attempts=answers), d)
            try:
                view = consumer._await_attempt_after_restart("k", {"id": 1.5}, handed=True, store="aaaa")
                decision = consumer._decision_from_attempt("k", view)
                self.assertEqual((decision.status, decision.ticket_id), ("accepted", "B-9"))
            finally:
                consumer.close()

    def test_without_a_journalled_handoff_the_own_journal_is_the_proof(self):
        with tempfile.TemporaryDirectory() as d:
            executor = self._executor(fence=None)
            consumer = self._consumer(executor, d)
            try:
                view = consumer._await_attempt_after_restart("k", {"id": 1.5}, handed=False)
                self.assertTrue(view.get("not_handed_off"))
                self.assertEqual(executor.fences, [])      # nothing was asked of the executor's store
            finally:
                consumer.close()

    def test_unknown_delivery_of_an_order_built_from_real_evidence_is_recorded_as_exposure_not_as_a_test_entry(self):
        """No attempt exists, so the record cannot take its provenance from one: it is the evidence of the order."""
        from onewin_automation.consumer.core import Decision

        for built_synthetic, expected in ((False, False), (True, True)):
            with tempfile.TemporaryDirectory() as d:
                consumer = self._consumer(self._executor(fence=None), d)
                try:
                    consumer.journal.append({"phase": "claimed", "key": "k", "task_id": 1.5, "snapshot": {"id": 1.5}})
                    consumer.journal.append({"phase": "built", "key": "k", "synthetic": built_synthetic})
                    consumer._write_queue("k", {"id": 1.5}, Decision("unresolved", ["order_delivery_unknown_after_restart"], "executor"), None)
                    recorded = [a for op, a in consumer.queue.calls if op == "record_outcome"][-1]["outcome"]
                    self.assertEqual((recorded["status"], recorded["synthetic"]), ("unresolved", expected))
                finally:
                    consumer.close()

    def test_a_refusal_before_anything_was_built_is_never_an_order(self):
        from onewin_automation.consumer.core import Decision

        with tempfile.TemporaryDirectory() as d:
            consumer = self._consumer(self._executor(fence=None), d)
            try:
                consumer.journal.append({"phase": "claimed", "key": "k2", "task_id": 2.5, "snapshot": {"id": 2.5}})
                consumer._write_queue("k2", {"id": 2.5}, Decision("not_sent", ["refused"], "engine"), None)
                recorded = [a for op, a in consumer.queue.calls if op == "record_outcome"][-1]["outcome"]
                self.assertTrue(recorded["synthetic"])
            finally:
                consumer.close()

    def test_lost_submit_answer_and_the_attempt_shows_up_later_is_followed(self):
        from onewin_automation.consumer.executor_client import ExecutorUnavailable

        views = iter([{"attempt": None, "in_flight": False, "last_run": None}, {"attempt": None, "in_flight": True, "last_run": {}},
                      {"attempt": {"status": "ACCEPTED", "stake": 1.0, "receipt": {"bet_id": "B-1", "accepted_cf": 1.9}}, "in_flight": False}])

        class Executor:
            def submit(self, envelope):
                raise ExecutorUnavailable("timed out")

            def attempt(self, key):
                return next(views)

            def recover(self):
                return {}

        with tempfile.TemporaryDirectory() as d:
            consumer = self._consumer(Executor(), d)
            try:
                view = consumer._await_attempt("k", {"id": 1.5}, None, delivery_unknown=True)
                decision = consumer._decision_from_attempt("k", view)
                self.assertEqual((decision.status, decision.ticket_id), ("accepted", "B-1"))
            finally:
                consumer.close()


if __name__ == "__main__":
    unittest.main()
