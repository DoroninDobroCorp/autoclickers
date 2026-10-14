"""The product queue consumer, end to end, through its command line, on the real queue code, the
product executor and a local TLS stand.  Every scenario counts the requests that reached the stand
(the only stub, whose evidence is synthetic and labelled so): where sending is forbidden the number
is 0, where a local simulation is allowed it is exactly the expected one."""
from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from consumer_harness import (HERE, MARKER, REPLAY_NOW, TOKEN, Producer, Stand, case, configure_stand, drive, finish_consumer,
                              leftover_browsers, live_case, replay_offset, reports, run_consumer, start_consumer, write_policy)
from onewin_automation.common import instant
from onewin_automation.consumer.journal import Journal
from onewin_automation.queue_adapter import queue_item_identity
from onewin_automation.receipt_export import export_attempt_receipt

NODE = shutil.which("node")


class StubGateway:
    """Local stand-in of the Jev gateway wire contract: POST /<mode>/api/jev."""

    def __init__(self):
        self.calls: list[str] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                try:
                    self._answer()
                except (BrokenPipeError, ConnectionResetError):
                    pass   # the client gave up (that is the point of the slow / drop modes)

            def _answer(self):
                mode = self.path.strip("/").split("/")[0]
                self.rfile.read(int(self.headers.get("content-length") or 0))
                outer.calls.append(mode)
                if mode == "drop":
                    self.connection.close()
                    return
                if mode == "slow":
                    time.sleep(6.0)
                if mode == "http500":
                    self.send_response(500); self.end_headers(); self.wfile.write(b"upstream"); return
                if mode == "http401":
                    self.send_response(401); self.end_headers(); self.wfile.write(b"no"); return
                if mode == "malformed":
                    self.send_response(200); self.end_headers(); self.wfile.write(b"<html>not json</html>"); return
                choice = "FAIL" if mode == "fail" else ("INVESTIGATE" if mode == "investigate" else "PASS")
                body = json.dumps({"answers": {"decision": {"type": "choice", "choice": choice, "confidence": 0.97,
                                   "probabilities": {choice: 0.97}}}, "model": "jev-stub"}).encode()
                self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def url(self, mode: str) -> str:
        return f"http://127.0.0.1:{self.port}/{mode}/api/jev"

    def close(self):
        self.server.shutdown()


@unittest.skipUnless(NODE, "node is required")
class ConsumerBase(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="consumer-it-"))
        self.offset = replay_offset()
        self.stands: list[Stand] = []
        self.prod = Producer(self.tmp / "tasks.json")

    def tearDown(self):
        self.prod.close()
        for stand in self.stands:
            stand.stop()
        self.assertEqual(leftover_browsers(), [], "every browser of the drill was closed by its owner")
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- helpers
    def stand(self, mode="real", name="P1 T< 1", **kw) -> Stand:
        stand = Stand(self.tmp / f"executor-{len(self.stands)}", mode=mode, clock_offset=kw.pop("clock_offset", self.offset), **kw).start()
        self.stands.append(stand)
        configure_stand(stand, name)
        return stand

    def sync_clock(self, stand: Stand, at: float) -> float:
        """Make the clock of the stand AND of the consumer read ``at`` right now (edge drills)."""
        offset = at - time.time()
        stand.config(clock_offset=offset)
        return offset

    def policy(self, stand: Stand, mode: str, **kw) -> Path:
        return write_policy(self.tmp, mode=mode, stand_url=stand.url, tasks_file=self.prod.tasks_file, state_dir=self.tmp / "state", **kw)

    def run_once(self, policy: Path, *extra: str, offset=None, **kw):
        rc, lines = run_consumer(policy, "--max-items", "1", "--test-clock-offset", repr(self.offset if offset is None else offset), *extra, **kw)
        return rc, lines, reports(lines)

    def history(self):
        return self.prod.history()

    def account_dir(self, account="acct-1") -> Path:
        return self.tmp / "state" / account

    def journal_phases(self, key, account="acct-1"):
        return Journal(self.account_dir(account) / "journal.jsonl").items().get(key, {}).get("order", [])

    def attempt(self, stand: Stand, key: str):
        import urllib.request
        request = urllib.request.Request(f"{stand.url}/v1/attempts/{key}", headers={"authorization": f"Bearer {TOKEN}"})
        with urllib.request.urlopen(request, timeout=10) as reply:
            return json.loads(reply.read())


class DefaultsAndModes(ConsumerBase):
    def test_disabled_is_the_default_and_nothing_is_touched(self):
        stand = self.stand("real")
        item = self.prod.add()
        policy = write_policy(self.tmp, mode="disabled", stand_url=stand.url, tasks_file=self.prod.tasks_file, state_dir=self.tmp / "state")
        rc, lines = run_consumer(policy, "--max-items", "1")
        self.assertEqual(rc, 0)
        self.assertEqual([l["event"] for l in lines], ["disabled"])
        self.assertIsNotNone(self.prod.current()["item"])
        self.assertEqual((stand.money, stand.log()["calls"]), (0, {"evidence": 0, "orders": 0, "dry_runs": 0}))
        self.assertFalse((self.tmp / "state").exists())
        self.assertEqual(self.history(), [])
        # a policy without a stated mode is disabled too
        raw = json.loads(policy.read_text())
        del raw["mode"]
        policy.write_text(json.dumps(raw))
        self.assertEqual(run_consumer(policy)[1][0]["event"], "disabled")
        self.assertEqual(item["id"], self.prod.current()["item"]["id"])

    def test_command_line_can_only_lower_the_policy_mode(self):
        stand = self.stand("dry")
        policy = write_policy(self.tmp, mode="observe", stand_url=stand.url, tasks_file=self.prod.tasks_file, state_dir=self.tmp / "state")
        rc, lines = run_consumer(policy, "--mode", "real")
        self.assertEqual(rc, 2)
        self.assertIn("above the policy mode", lines[0]["reason"])

    def test_observe_reports_what_it_would_do_and_changes_nothing(self):
        stand = self.stand("real")
        item = self.prod.add()
        before = json.loads(self.prod.tasks_file.read_text())
        policy = self.policy(stand, "real")
        rc, lines, reps = self.run_once(policy, "--mode", "observe")
        self.assertEqual(rc, 0)
        self.assertEqual(reps[0]["decision"], "would_order")
        self.assertEqual((reps[0]["stake"], reps[0]["currency"]), (1.0, "USDT"))
        self.assertEqual(json.loads(self.prod.tasks_file.read_text()), before, "queue untouched: no claim, no processing flag, no history")
        self.assertEqual((stand.money, stand.log()["calls"]["orders"], stand.log()["calls"]["dry_runs"]), (0, 0, 0))
        self.assertFalse((self.tmp / "state").exists(), "observe owns no state")
        self.assertEqual(self.prod.current()["item"]["id"], item["id"])


class RealRoute(ConsumerBase):
    def test_accepted_once_with_exact_identity_provenance_and_native_key(self):
        stand = self.stand("real")
        item = self.prod.add()
        key = queue_item_identity(item)
        rc, lines, reps = self.run_once(self.policy(stand, "real"))
        self.assertEqual(rc, 0, lines)
        report = reps[0]
        self.assertEqual((report["decision"], report["attempt_status"]), ("accepted", "ACCEPTED"))
        log = stand.log()
        self.assertEqual(log["money_requests"], 1)
        body = log["money"][0]["body"]
        direct = case()["outcome"]["donor_quote"]
        self.assertEqual((body["amount"], body["currencyCode"]), (1, "USDT"))
        sel = body["coupon"]["selections"][0]
        self.assertEqual((sel["oddId"], str(sel["matchId"]), sel["cf"]),
                         (direct["execution"]["provider_selection_key"], direct["execution"]["provider_event_key"], direct["odds"]))
        view = self.attempt(stand, key)
        attempt = view["attempt"]
        self.assertEqual(attempt["status"], "ACCEPTED")
        self.assertEqual(attempt["native_request"]["idempotency_key"], body["idempotencyKey"], "the key on the wire is the key in the durable attempt")
        self.assertEqual(attempt["payload"]["executor_provenance"]["transport_environment"], "local_stand")
        self.assertTrue(attempt["payload"]["provenance"]["synthetic"])
        self.assertEqual(attempt["payload"]["purpose"], "diagnostic_test")
        self.assertEqual(attempt["payload"]["correlation"]["queue_task_id"], item["id"])
        self.assertEqual(attempt["payload"]["policy"]["account_id"], "acct-1")
        # queue: completed with the receipt's id, a test entry (synthetic), slot free and not processing
        entry = self.history()[-1]
        self.assertEqual((entry["status"], entry["ticketId"], entry["testMode"]), ("completed", "STAND-1", True))
        self.assertEqual(entry["executionOutcome"]["attemptKey"], key)
        self.assertEqual(entry["stake"], 1.0)
        current = self.prod.current()
        self.assertEqual((current["item"], current["processing"]), (None, False))
        # export
        document = json.loads(Path(report["export"]["path"]).read_text())
        receipt = document["receipt"]
        self.assertEqual((receipt["outcome"], receipt["synthetic"], receipt["settlement"], receipt["transport_environment"]),
                         ("accepted", True, "pending", "local_stand"))
        self.assertEqual(receipt["identity"]["native_idempotency_key"], body["idempotencyKey"])
        self.assertEqual(receipt["bookmaker_receipt"]["bet_id"], "STAND-1")
        self.assertEqual(self.journal_phases(key), ["claimed", "built", "handed_off", "observed", "decided", "queue_written", "exported"])
        # what the order rests on is the source's own data, verbatim: quotes, clocks, axes, purpose
        quotes = attempt["payload"]["source_quotes"]
        self.assertEqual((quotes["donor"]["odds"], quotes["donor"]["observed_at"], quotes["donor"]["source_event_key"]),
                         (direct["odds"], direct["observed_at"], direct["source_event_key"]))
        self.assertEqual(quotes["reference"]["source"], "BIA")
        self.assertEqual(attempt["payload"]["expected_axes_original"]["period"], direct["market_axes"]["period"])
        self.assertEqual(attempt["payload"]["selection"]["axes"]["period"], direct["market_axes"]["period"])
        self.assertEqual(attempt["payload"]["selection"]["price"], direct["odds"])
        self.assertEqual(set(attempt["payload"]["evidence"]["expiries"]), {"task", "donor", "reference", "margins", "executor_quote", "account"})
        # Jev not configured: advice recorded as such, not a reason
        self.assertEqual(attempt["payload"]["advisory"]["status"], "NOT_CONFIGURED")
        # a second run finds nothing to do and sends nothing
        rc2, lines2, reps2 = self.run_once(self.policy(stand, "real"), "--idle-exit-s", "0.5")
        self.assertEqual((rc2, reps2), (0, []))
        self.assertEqual(stand.money, 1)

    def test_dry_runs_the_whole_route_through_the_consumer_without_a_bet(self):
        stand = self.stand("dry")
        item = self.prod.add()
        key = queue_item_identity(item)
        rc, lines, reps = self.run_once(self.policy(stand, "dry"))
        self.assertEqual((rc, reps[0]["decision"]), (0, "dry_run"), lines)
        self.assertEqual((stand.money, stand.log()["calls"]), (0, {"evidence": 1, "orders": 0, "dry_runs": 1}))
        entry = self.history()[-1]
        self.assertEqual((entry["status"], entry["dryRun"], entry["testMode"]), ("dry_run", True, True))
        self.assertNotIn("ticketId", entry)
        self.assertEqual(self.prod.current()["item"], None)
        self.assertEqual(self.journal_phases(key), ["claimed", "built", "handed_off", "observed", "decided", "queue_written", "exported"])
        # a dry executor refuses a real order even if somebody asks for one
        policy_real = self.policy(stand, "real", account_id="acct-9")
        self.prod.add(case("P1 T> 1"))
        rc, lines, reps = self.run_once(policy_real)
        self.assertEqual(rc, 3, lines)
        self.assertIn("executor_not_in_real_mode", lines[-1]["problems"])
        self.assertEqual(stand.money, 0)

    def test_real_mode_needs_an_armed_executor_of_the_policy_environment(self):
        stand = self.stand("real", env={"ONEWIN_AUTOMATION_LIVE_ENABLED": "false"})
        self.prod.add()
        rc, lines, reps = self.run_once(self.policy(stand, "real"))
        self.assertEqual(rc, 3)
        self.assertIn("executor_live_gate_closed", lines[-1]["problems"])
        self.assertEqual(self.prod.current()["processing"], False)
        production = self.policy(stand, "real", account_id="acct-p", environment="production")
        rc, lines, reps = self.run_once(production, "--idle-exit-s", "0.5")
        self.assertIn(rc, (2, 3))  # --test-clock-offset is refused for production; or the environment mismatch
        self.assertEqual(stand.money, 0)


class RefusalsKeepCorrectTasksAvailable(ConsumerBase):
    """Every changed condition is refused with its own reason, before anything is claimed at the
    bookmaker, and the next correct task goes through."""

    CASES = {
        "price_changed": ({"evidence": {"odds_delta": 0.01}}, "binding_mismatch"),
        "period_changed": ({"evidence": {"axes": "PERIOD_FT"}}, "axes"),
        "native_text_is_another_period": ({"evidence": {"native_market": {"sport_id": 18, "group_name": "2nd half. Total",
                                                                           "selection_name": "Under 1.0", "points": 1.0, "outcome_code": "under"}}}, "native"),
        "account_currency_changed": ({"evidence": {"account_currency": "EUR"}}, "currency"),
        "quote_currency_changed": ({"evidence": {"currency": "EUR"}}, "currency"),
        "insufficient_balance": ({"evidence": {"available_balance": 0.5}}, "balance"),
        "insufficient_capacity": ({"evidence": {"max_stake": 0.5}}, "capacity"),
        "unknown_commission": ({"evidence": {"commission": None}}, "commission"),
        "unproven_wire_contract": ({"evidence": {"contract_verified": False}}, "contract"),
        "unknown_account": ({"evidence": {"account_identity_verified": None}}, "account"),
        "not_logged_in": ({"evidence": {"logged_in": False}}, "account"),
        "evidence_withheld": ({"evidence": {"available": False, "reason": "no_binding"}}, "executor_evidence_unavailable"),
    }

    def test_each_changed_condition_is_refused_with_a_concrete_reason_and_sends_nothing(self):
        stand = self.stand("real")
        policy = self.policy(stand, "real")
        seen = {}
        for name, (patch, fragment) in self.CASES.items():
            with self.subTest(condition=name):
                evidence = dict(patch["evidence"])
                if evidence.get("axes") == "PERIOD_FT":
                    evidence["axes"] = {**case()["outcome"]["donor_quote"]["market_axes"], "period": "ft"}
                stand.config(evidence=evidence)
                item = self.prod.add()
                rc, lines, reps = self.run_once(policy)
                self.assertEqual(rc, 0, lines)
                report = reps[0]
                self.assertEqual(report["decision"], "not_sent", report)
                self.assertTrue(report["reasons"], report)
                self.assertTrue(any(fragment in r for r in report["reasons"]), (name, report["reasons"]))
                seen[name] = report["reasons"]
                self.assertEqual(stand.money, 0, name)
                entry = self.history()[-1]
                self.assertEqual((entry["status"], entry["taskId"]), ("cancelled", item["id"]))
                self.assertEqual(self.prod.current(), {"item": None, "pending": None, "processing": False})
                stand.config(evidence={"available": True, "reason": None, "commission": 0.0, "max_stake": 8.45, "available_balance": 8.45,
                                       "currency": "USDT", "account_currency": "USDT", "account_identity_verified": True, "logged_in": True,
                                       "odds_delta": 0, "axes": None, "native_market": None, "contract_verified": True})
        # a correct task right after all of them is executed: nothing was blocked by the refusals
        self.prod.add()
        rc, lines, reps = self.run_once(policy)
        self.assertEqual(reps[0]["decision"], "accepted", reps)
        self.assertEqual(stand.money, 1)
        self.assertEqual(stand.log()["calls"]["orders"], 1)
        (self.tmp / "refusal-reasons.json").write_text(json.dumps(seen, indent=2))

    def test_price_drift_on_the_board_is_caught_at_the_cart_and_withdraws_the_attempt(self):
        stand = self.stand("real")
        stand.config(board={"price_delta": 0.3})
        item = self.prod.add()
        rc, lines, reps = self.run_once(self.policy(stand, "real"))
        report = reps[0]
        self.assertEqual((report["decision"], report["attempt_status"]), ("not_sent", "WITHDRAWN"), report)
        self.assertTrue(any("BOARD_PRICE_CHANGED" in r for r in report["reasons"]), report["reasons"])
        self.assertEqual(stand.money, 0)
        document = json.loads(Path(report["export"]["path"]).read_text())
        self.assertEqual(document["receipt"]["outcome"], "not_sent")

    def test_item_of_another_account_or_bookmaker_is_not_touched(self):
        stand = self.stand("real")
        foreign = self.prod.add(account_id="acct-2")
        before = json.loads(self.prod.tasks_file.read_text())
        rc, lines, reps = self.run_once(self.policy(stand, "real"), "--idle-exit-s", "0.3")
        self.assertEqual(rc, 0)
        self.assertTrue(reps[0]["skipped"].startswith("queue_item_names_other_account"), reps)
        self.assertEqual(json.loads(self.prod.tasks_file.read_text()), before)
        self.assertEqual((stand.money, stand.log()["calls"]["evidence"]), (0, 0))
        # another bookmaker's slot is never read as ours
        raw = json.loads(self.prod.tasks_file.read_text())
        raw["currentTasks"]["sansabet"] = {"id": 7.5, "bookmakerId": "sansabet", "home": "A", "away": "B", "outcome": "1", "stake": 5,
                                           "createdAt": int(time.time() * 1000)}
        raw["currentTasks"]["1win"] = None
        raw["processing"]["sansabet"] = True
        self.prod.tasks_file.write_text(json.dumps(raw))
        rc, lines, reps = self.run_once(self.policy(stand, "real"), "--idle-exit-s", "0.5")
        after = json.loads(self.prod.tasks_file.read_text())
        self.assertEqual(after["currentTasks"]["sansabet"], raw["currentTasks"]["sansabet"])
        self.assertTrue(after["processing"]["sansabet"])
        self.assertEqual(foreign["accountId"], "acct-2")


class SourceExpiry(ConsumerBase):
    def test_prematch_task_expires_sixty_seconds_after_the_source_clock(self):
        item = self.prod.add()
        from onewin_automation.queue_adapter import common_task_from_queue_item
        task = common_task_from_queue_item(item, stake=1.0, stake_currency="USDT", now=REPLAY_NOW + 0.5)
        self.assertEqual(task["is_live"], False)
        expires = task["expires_at"]
        self.assertAlmostEqual(expires - (expires - 60.0), 60.0)
        stand = self.stand("real")
        policy = self.policy(stand, "real")
        for label, at in (("one second after expiry", expires + 1.0), ("exactly at expiry", expires)):
            with self.subTest(label):
                offset = self.sync_clock(stand, at)
                rc, lines, reps = self.run_once(policy, offset=offset)
                self.assertEqual(reps[0]["decision"], "not_sent", reps)
                self.assertEqual(stand.money, 0)
                self.assertTrue(any("expired" in r or "future" in r for r in reps[0]["reasons"]), reps[0]["reasons"])
                self.prod.add()
        # at the time the frame was recorded the same task is good; an executor read older than 60 s is not
        stand.config(evidence={"source_age_s": 61.0})
        offset = self.sync_clock(stand, REPLAY_NOW + 0.5)
        rc, lines, reps = self.run_once(policy, offset=offset)
        self.assertEqual(reps[0]["decision"], "not_sent", reps)
        self.assertTrue(any("executor_quote" in r for r in reps[0]["reasons"]), reps[0]["reasons"])
        stand.config(evidence={"source_age_s": 59.0})
        self.prod.add()
        offset = self.sync_clock(stand, REPLAY_NOW + 0.5)
        rc, lines, reps = self.run_once(policy, offset=offset)
        self.assertEqual((reps[0]["decision"], stand.money), ("accepted", 1), reps)

    def test_live_task_expires_five_seconds_after_the_source_clock_and_a_cached_quote_is_not_fresh(self):
        spec = live_case()
        t0 = spec["t0"]
        stand = self.stand("real")
        policy = self.policy(stand, "real")
        # 5.2 s after the source clock: refused by the engine
        self.prod.add(spec)
        offset = self.sync_clock(stand, t0 + 5.2)
        rc, lines, reps = self.run_once(policy, offset=offset)
        self.assertEqual(reps[0]["decision"], "not_sent", reps)
        self.assertTrue(any("expired" in r for r in reps[0]["reasons"]), reps[0]["reasons"])
        self.assertEqual(stand.money, 0)
        # a quote the executor read longer ago than the live window is not "fresh because it was cached"
        stand.config(evidence={"source_age_s": 6.0})
        self.prod.add(spec)
        offset = self.sync_clock(stand, t0 + 0.2)
        rc, lines, reps = self.run_once(policy, offset=offset)
        self.assertEqual(reps[0]["decision"], "not_sent", reps)
        self.assertEqual(stand.money, 0)
        self.assertTrue(any("executor_quote" in r for r in reps[0]["reasons"]), reps[0]["reasons"])
        # while the same task with a fresh executor read goes through inside its five seconds
        stand.config(evidence={"source_age_s": 0.2})
        self.prod.add(spec)
        offset = self.sync_clock(stand, t0 + 0.2)
        rc, lines, reps = self.run_once(policy, offset=offset)
        self.assertEqual((reps[0]["decision"], stand.money), ("accepted", 1), reps)


class CancelAndWithdraw(ConsumerBase):
    def _wait_until(self, predicate, timeout=30.0, step=0.1):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if predicate():
                return True
            time.sleep(step)
        return False

    def _started(self, stand, key) -> bool:
        try:
            view = self.attempt(stand, key)
        except Exception:  # noqa: BLE001
            return False
        return bool(view["attempt"] or view["in_flight"])

    def test_cancel_in_the_queue_while_the_executor_works_withdraws_the_attempt_and_sends_nothing(self):
        stand = self.stand("real")
        stand.config(page_delay_ms=4000)
        item = self.prod.add()
        key = queue_item_identity(item)
        proc = start_consumer(self.policy(stand, "real"), "--max-items", "1", "--test-clock-offset", repr(self.offset))
        self.assertTrue(self._wait_until(lambda: self._started(stand, key)), "the executor took the order")
        cancelled = self.prod.queue.request("cancel", task_id=item["id"], force_current=True)
        self.assertTrue(cancelled["cancelled"], cancelled)
        rc, lines = finish_consumer(proc)
        report = reports(lines)[0]
        self.assertEqual((rc, report["decision"]), (0, "not_sent"), report)
        self.assertIn(report["attempt_status"], (None, "WITHDRAWN"), report)
        self.assertTrue(any("WITHDRAWN" in r or "withdrawn" in r for r in report["reasons"]), report["reasons"])
        self.assertEqual(stand.money, 0)
        statuses = [h["status"] for h in self.history() if h["taskId"] == item["id"]]
        self.assertEqual(statuses, ["cancelled", "cancelled"], "the cancel and the consumer's record of the withdrawn attempt")
        self.assertNotIn("completed", statuses)

    def test_stop_request_on_a_processing_task_is_passed_to_the_executor(self):
        stand = self.stand("real")
        stand.config(page_delay_ms=4000)
        item = self.prod.add()
        key = queue_item_identity(item)
        proc = start_consumer(self.policy(stand, "real"), "--max-items", "1", "--test-clock-offset", repr(self.offset))
        self.assertTrue(self._wait_until(lambda: self._started(stand, key)))
        self.assertTrue(self.prod.queue.request("request_stop", task_id=item["id"])["updated"])
        rc, lines = finish_consumer(proc)
        report = reports(lines)[0]
        self.assertEqual(report["decision"], "not_sent", report)
        self.assertIn(report["attempt_status"], (None, "WITHDRAWN"), report)
        self.assertEqual(stand.money, 0)

    def test_withdrawal_requested_after_the_durable_submitting_record_still_forwards_nothing(self):
        stand = self.stand("real")
        stand.config(withdraw_after_record="SUBMITTING")
        item = self.prod.add()
        rc, lines, reps = self.run_once(self.policy(stand, "real"))
        report = reps[0]
        self.assertEqual((report["decision"], report["attempt_status"]), ("not_sent", "WITHDRAWN"), report)
        self.assertEqual(stand.money, 0)
        attempt = self.attempt(stand, queue_item_identity(item))["attempt"]
        self.assertEqual(attempt["not_sent_proof"]["forwarded_requests"], 0)
        self.assertTrue(attempt["withdrawal_requested"])


class OwnershipAndRedelivery(ConsumerBase):
    def test_second_consumer_on_the_same_account_state_refuses_to_start(self):
        stand = self.stand("real")
        policy = self.policy(stand, "real")
        first = start_consumer(policy, "--idle-exit-s", "6", "--test-clock-offset", repr(self.offset))
        try:
            end = time.monotonic() + 20
            while time.monotonic() < end and not (self.account_dir() / "consumer.lock").exists():
                time.sleep(0.1)
            rc, lines = run_consumer(policy, "--idle-exit-s", "0.3", "--test-clock-offset", repr(self.offset))
            self.assertEqual(rc, 5, lines)
            self.assertIn("instance_lock", lines[-1]["reason"])
        finally:
            finish_consumer(first)

    def test_two_consumers_on_one_item_send_one_order(self):
        stand = self.stand("real")
        item = self.prod.add()
        a = self.policy(stand, "real", account_id="acct-1", consumer_id="consumer-A")
        b = write_policy(self.tmp, mode="real", stand_url=stand.url, tasks_file=self.prod.tasks_file, state_dir=self.tmp / "state-b",
                         account_id="acct-1", consumer_id="consumer-B")
        procs = [start_consumer(p, "--idle-exit-s", "2", "--test-clock-offset", repr(self.offset)) for p in (a, b)]
        results = [finish_consumer(p) for p in procs]
        self.assertEqual([rc for rc, _ in results], [0, 0])
        decisions = [r.get("decision") or r.get("skipped") for _, lines in results for r in reports(lines)]
        self.assertEqual(decisions.count("accepted"), 1, decisions)
        self.assertEqual(stand.money, 1)
        statuses = [h["status"] for h in self.history() if h["taskId"] == item["id"]]
        self.assertEqual(statuses, ["completed"])
        keys = [a["key"] for a in json.loads(json.dumps(self.attempts_of(stand)))]
        self.assertEqual(keys, [queue_item_identity(item)])

    def attempts_of(self, stand):
        import urllib.request
        request = urllib.request.Request(f"{stand.url}/v1/attempts", headers={"authorization": f"Bearer {TOKEN}"})
        with urllib.request.urlopen(request, timeout=10) as reply:
            return json.loads(reply.read())["attempts"]

    def test_repeated_queue_message_and_a_new_task_for_the_same_selection_send_nothing_more(self):
        stand = self.stand("real")
        item = self.prod.add()
        policy = self.policy(stand, "real")
        rc, lines, reps = self.run_once(policy)
        self.assertEqual(reps[0]["decision"], "accepted")
        # the very same message again (same id): finished work is recognised, the slot is freed
        again = self.prod.add(id=item["id"])
        self.assertEqual(again["id"], item["id"])
        rc, lines, reps = self.run_once(policy)
        self.assertEqual(reps[0].get("resumed_from"), "exported", reps)
        self.assertEqual(self.prod.current(), {"item": None, "pending": None, "processing": False})
        self.assertEqual(stand.money, 1)
        self.assertEqual(len([h for h in self.history() if h.get("executionOutcome")]), 1)
        # a NEW task (new id) for the very same native selection: the executor refuses it before any claim
        self.prod.add()
        rc, lines, reps = self.run_once(policy)
        self.assertEqual(reps[0]["decision"], "not_sent", reps)
        self.assertTrue(any("DUPLICATE_SELECTION_ATTEMPT" in r for r in reps[0]["reasons"]), reps[0]["reasons"])
        self.assertEqual(stand.money, 1)

    def test_a_producer_adding_while_the_consumer_works_loses_nothing(self):
        stand = self.stand("real")
        stand.config(page_delay_ms=3000)
        first = self.prod.add()
        policy = self.policy(stand, "real")
        proc = start_consumer(policy, "--max-items", "2", "--idle-exit-s", "10", "--test-clock-offset", repr(self.offset))
        end = time.monotonic() + 30
        while time.monotonic() < end and not self.prod.current()["processing"]:
            time.sleep(0.05)
        self.assertTrue(self.prod.current()["processing"], "the consumer holds the slot")
        # a telegram-class task waits in pending, an analyzer task is refused while the slot is busy (existing priority rules)
        second_spec = case("P1 T> 1")
        pending = self.prod.queue.request("produce", pair=second_spec["pair"], outcome=second_spec["outcome"], stake=1, source_type="telegram")
        analyzer = self.prod.queue.request("produce", pair=case("X")["pair"], outcome=case("X")["outcome"], stake=1)
        self.assertEqual((pending["added"], analyzer["added"]), (True, False))
        # the first board page was requested (and is being held back): only now is the stand re-pointed at the second market
        end = time.monotonic() + 30
        while time.monotonic() < end and not stand.log()["page_paths"]:
            time.sleep(0.05)
        stand.config(page_delay_ms=0)
        configure_stand(stand, "P1 T> 1")
        rc, lines = finish_consumer(proc)
        decisions = [r["decision"] for r in reports(lines)]
        self.assertEqual(rc, 0, lines)
        self.assertEqual(decisions, ["accepted", "accepted"], lines)
        self.assertEqual(stand.money, 2)
        tickets = [h["ticketId"] for h in self.history() if h["status"] == "completed"]
        self.assertEqual(sorted(tickets), ["STAND-1", "STAND-2"])
        self.assertEqual(self.prod.current(), {"item": None, "pending": None, "processing": False})
        self.assertIn(first["id"], [h["taskId"] for h in self.history()])

    def test_state_of_another_account_is_isolated(self):
        stand = self.stand("real")
        item = self.prod.add()
        rc, lines, reps = self.run_once(self.policy(stand, "real", account_id="acct-1"))
        self.assertEqual(reps[0]["decision"], "accepted")
        self.assertTrue((self.account_dir("acct-1") / "journal.jsonl").exists())
        self.assertFalse((self.account_dir("acct-2")).exists())
        # acct-2 sees an empty queue: nothing of acct-1's journal or exports leaks into it
        rc, lines, reps = self.run_once(self.policy(stand, "real", account_id="acct-2"), "--idle-exit-s", "0.3")
        self.assertEqual(reps, [])
        self.assertEqual(Journal(self.account_dir("acct-2") / "journal.jsonl").records(), [])
        self.assertEqual(os.listdir(self.account_dir("acct-2")).count("exports"), 0)
        self.assertEqual(item["id"], self.history()[-1]["taskId"])


class CrashAndRestart(ConsumerBase):
    """The four points of the task, on both sides: the consumer dies, the executor dies."""

    def _unresolved_run(self, stand, **policy_kw):
        item = self.prod.add()
        policy = self.policy(stand, "real", executor_deadline_s=6, **policy_kw)
        rc, lines, reps = self.run_once(policy)
        return item, policy, rc, lines, reps

    def test_consumer_dies_before_the_order_was_handed_off(self):
        stand = self.stand("real")
        item = self.prod.add()
        key = queue_item_identity(item)
        policy = self.policy(stand, "real")
        rc, out = drive(policy, "after_handoff_recorded", self.offset)
        self.assertEqual(rc, 137, out)
        self.assertEqual(stand.log()["calls"]["orders"], 0)
        self.assertEqual(self.journal_phases(key), ["claimed", "built", "handed_off"])
        state = self.prod.state(item["id"])
        self.assertEqual((state["where"], state["claim"]["consumerId"]), ("current", "consumer-acct-1"))
        # restart: the journal says "handed off", the executor says "never heard of it": nothing was sent
        self.assertTrue((self.account_dir() / "consumer.lock").exists(), "a crashed consumer leaves its lock behind")
        rc, lines, reps = self.run_once(policy, "--idle-exit-s", "0.5")
        self.assertEqual(rc, 0, lines)
        resumed = [r for r in reps if r.get("resumed_from")]
        self.assertEqual(resumed[0]["decision"], "not_sent", reps)
        self.assertEqual(stand.money, 0)
        self.assertEqual(self.prod.current(), {"item": None, "pending": None, "processing": False})
        self.assertEqual([h["status"] for h in self.history()], ["cancelled"])

    def test_executor_dies_after_the_durable_claim_before_anything_could_be_sent(self):
        stand = self.stand("real")
        stand.config(crash_after_record="PRE_CHECK_PASSED")
        item, policy, rc, lines, reps = self._unresolved_run(stand)
        key = queue_item_identity(item)
        self.assertFalse(stand.alive())
        self.assertEqual(reps[0]["decision"], "unresolved", reps)  # nothing is known while the executor is gone
        self.assertEqual(self.history()[-1]["status"], "unresolved")
        self.assertEqual(self.prod.current()["processing"], False)
        stand.restart()
        self.assertEqual(stand.orphans_after_restart, [], "the browser of the dead owner was removed by its successor")
        self.assertEqual(stand.ready["recovered_on_start"][0]["to"], "WITHDRAWN")
        rc, lines, reps = self.run_once(policy, "--idle-exit-s", "0.5")
        late = [r for r in reps if r.get("late_resolution")]
        self.assertEqual(late[0]["late_resolution"]["resolution"], "not_placed", reps)
        self.assertEqual(self.attempt(stand, key)["attempt"]["status"], "WITHDRAWN")
        self.assertEqual(stand.money, 0, "the restarted executor sent nothing")
        entry = [h for h in self.history() if h.get("executionOutcome")][-1]
        self.assertEqual((entry["status"], entry["executionOutcome"]["resolution"]["kind"]), ("cancelled", "not_placed"))

    def test_executor_dies_after_the_durable_submitting_record_the_outcome_stays_unresolved(self):
        stand = self.stand("real")
        stand.config(crash_after_record="SUBMITTING")
        item, policy, rc, lines, reps = self._unresolved_run(stand)
        key = queue_item_identity(item)
        self.assertEqual(reps[0]["decision"], "unresolved", reps)
        stand.restart()
        self.assertEqual(stand.orphans_after_restart, [], "the browser of the dead owner was removed by its successor")
        self.assertEqual(stand.ready["recovered_on_start"][0]["to"], "INDETERMINATE")
        rc, lines, reps = self.run_once(policy, "--idle-exit-s", "0.5")
        self.assertFalse([r for r in reps if r.get("late_resolution")], "INDETERMINATE is never turned into a refusal by a restart")
        view = self.attempt(stand, key)
        self.assertEqual(view["attempt"]["status"], "INDETERMINATE")
        self.assertEqual(stand.money, 0)
        # the same selection cannot be sent again while this is unresolved
        self.prod.add()
        rc, lines, reps = self.run_once(policy)
        self.assertEqual(reps[0]["decision"], "not_sent", reps)
        self.assertTrue(any("DUPLICATE_SELECTION_ATTEMPT" in r for r in reps[0]["reasons"]), reps[0]["reasons"])
        self.assertEqual(stand.money, 0)
        # an operator proves "not placed" by identity: the selection is released, the export says so
        rc, lines = run_consumer(policy, "--key", key, "--not-placed", "--evidence", "bookmaker history checked by native key", "--operator", "op-1",
                                 command="reconcile")
        self.assertEqual(rc, 0, lines)
        export = json.loads(Path(lines[-1]["export"]["path"]).read_text())
        self.assertEqual((export["receipt"]["outcome"], export["receipt"]["unresolved"]), ("not_placed_reconciled", False))
        entry = [h for h in self.history() if h.get("executionOutcome", {}).get("attemptKey") == key][-1]
        self.assertEqual(entry["status"], "cancelled")

    def test_executor_dies_when_the_request_reached_the_bookmaker_native_key_is_already_durable(self):
        stand = self.stand("real")
        stand.config(crash_when_stand_receives=True)
        item, policy, rc, lines, reps = self._unresolved_run(stand)
        key = queue_item_identity(item)
        self.assertEqual(reps[0]["decision"], "unresolved", reps)
        stand.restart()
        self.assertEqual(stand.orphans_after_restart, [], "the browser of the dead owner was removed by its successor")
        view = self.attempt(stand, key)
        self.assertEqual(view["attempt"]["status"], "INDETERMINATE")
        native = view["attempt"]["native_request"]
        self.assertTrue(native["idempotency_key"] and len(native["body_sha256"]) == 64, native)
        self.assertEqual(stand.money, 0, "no second request after the restart")
        rc, lines = run_consumer(policy, "--key", key, "--bet-id", "STAND-1", "--evidence", f"stand history by native key {native['idempotency_key']}",
                                 "--operator", "op-1", command="reconcile")
        self.assertEqual(rc, 0, lines)
        export = json.loads(Path(lines[-1]["export"]["path"]).read_text())["receipt"]
        self.assertEqual((export["outcome"], export["unresolved"], export["synthetic"]), ("accepted_reconciled", False, True))
        self.assertEqual(export["identity"]["native_idempotency_key"], native["idempotency_key"])
        entry = [h for h in self.history() if h.get("executionOutcome", {}).get("attemptKey") == key][-1]
        self.assertEqual((entry["status"], entry["ticketId"]), ("completed", "STAND-1"))
        # the same reconciliation again is one revision, and the export is byte for byte the same
        again = run_consumer(policy, "--key", key, "--bet-id", "STAND-1", "--evidence", f"stand history by native key {native['idempotency_key']}",
                             "--operator", "op-1", command="reconcile")[1]
        self.assertEqual(again[-1]["export"]["sha256"], lines[-1]["export"]["sha256"])
        self.assertEqual(len(self.attempt(stand, key)["attempt"]["revisions"]), 1)

    def _crash_after_answer(self, point):
        stand = self.stand("real")
        item = self.prod.add()
        key = queue_item_identity(item)
        policy = self.policy(stand, "real")
        rc, out = drive(policy, point, self.offset)
        self.assertEqual(rc, 137, out)
        self.assertEqual(stand.money, 1)
        self.assertTrue((self.account_dir() / "consumer.lock").exists())
        rc, lines, reps = self.run_once(policy, "--idle-exit-s", "0.5")
        self.assertEqual(rc, 0, lines)
        resumed = [r for r in reps if r.get("resumed_from")]
        self.assertEqual(len(resumed), 1, reps)
        self.assertEqual(resumed[0]["decision"], "accepted")
        self.assertEqual(stand.money, 1, "restart never sends again")
        entries = [h for h in self.history() if h.get("executionOutcome", {}).get("attemptKey") == key]
        self.assertEqual([e["status"] for e in entries], ["completed"], "the queue was written exactly once")
        self.assertEqual(self.journal_phases(key)[-1], "exported")
        export = self.account_dir() / "exports" / f"{key}.json"
        self.assertTrue(export.exists())
        return stand, key, resumed[0]

    def test_consumer_dies_after_the_answer_before_the_queue_was_written(self):
        self._crash_after_answer("after_observed")

    def test_consumer_dies_after_the_decision_was_journalled_before_the_queue_write(self):
        self._crash_after_answer("after_decided")

    def test_consumer_dies_after_the_queue_was_written_before_the_export(self):
        stand, key, report = self._crash_after_answer("after_queue_written")
        self.assertEqual(report["resumed_from"], "queue_written")


class JevIsAnAdviser(ConsumerBase):
    def setUp(self):
        super().setUp()
        self.gateway = StubGateway()

    def tearDown(self):
        self.gateway.close()
        super().tearDown()

    def go(self, mode, **policy_kw):
        stand = self.stand("real")
        self.prod.add()
        jev = {"url_env": "JEV_URL", "token_env": "JEV_TOKEN", "timeout_s": 1.5}
        policy = self.policy(stand, "real", jev=jev, **policy_kw)
        started = time.monotonic()
        rc, lines, reps = self.run_once(policy, env={"JEV_URL": self.gateway.url(mode), "JEV_TOKEN": "stub-token-0123456789"})
        return stand, reps[0], time.monotonic() - started

    def test_pass_and_investigate_are_recorded_and_neither_is_a_permission(self):
        for mode, status in (("ok", "PASS"), ("investigate", "INVESTIGATE")):
            with self.subTest(mode):
                stand, report, _ = self.go(mode)
                self.assertEqual((report["decision"], report["advisory"]), ("accepted", status))
                attempt = self.attempt(stand, report["key"])["attempt"]
                advisory = attempt["payload"]["advisory"]
                self.assertEqual((advisory["status"], advisory["execution_ready"], advisory["confidence_is_calibrated"]), (status, False, False))
                self.assertEqual(stand.money, 1)

    def test_a_pass_does_not_rescue_a_task_the_engine_refuses(self):
        stand = self.stand("real")
        stand.config(evidence={"commission": None})
        self.prod.add()
        policy = self.policy(stand, "real", jev={"url_env": "JEV_URL", "token_env": "JEV_TOKEN"})
        rc, lines, reps = self.run_once(policy, env={"JEV_URL": self.gateway.url("ok"), "JEV_TOKEN": "stub-token-0123456789"})
        self.assertEqual(reps[0]["decision"], "not_sent")
        self.assertTrue(any("commission" in r for r in reps[0]["reasons"]))
        self.assertEqual(self.gateway.calls, [], "no advice is bought for a task that cannot be ordered")
        self.assertEqual(stand.money, 0)

    def test_fail_is_a_veto_only_when_the_policy_says_so(self):
        stand, report, _ = self.go("fail")
        self.assertEqual((report["decision"], report["reasons"]), ("not_sent", ["jev_advises_fail"]))
        self.assertEqual(stand.money, 0)
        self.prod.close(); self.prod = Producer(self.tmp / "tasks-2.json")
        stand, report, _ = self.go("fail", jev_veto_on_fail=False)
        self.assertEqual(report["decision"], "accepted")
        self.assertEqual(report["advisory"], "FAIL")

    def test_down_slow_error_and_malformed_answers_degrade_to_investigate_and_never_hold_the_order(self):
        for mode in ("drop", "slow", "http500", "http401", "malformed"):
            with self.subTest(mode):
                self.prod.close(); self.prod = Producer(self.tmp / f"tasks-{mode}.json")
                stand, report, elapsed = self.go(mode)
                self.assertEqual((report["decision"], report["advisory"]), ("accepted", "INVESTIGATE"), report)
                attempt = self.attempt(stand, report["key"])["attempt"]
                self.assertEqual(attempt["payload"]["advisory"]["reason"], "review_unavailable_or_invalid")
                self.assertLess(elapsed, 14, "a slow gateway costs at most its timeout")
                self.assertEqual(stand.money, 1)
                stand.stop()


class OutcomesAndExport(ConsumerBase):
    def _run_with_answer(self, answer, **stand_cfg):
        stand = self.stand("real")
        stand.config(answer=answer, **stand_cfg)
        item = self.prod.add()
        policy = self.policy(stand, "real")
        rc, lines, reps = self.run_once(policy)
        return stand, item, policy, reps[0]

    def test_rejected_by_the_bookmaker_is_a_proved_refusal(self):
        stand, item, policy, report = self._run_with_answer({"result": {"error": {"code": "odd_cf_changed"}}})
        self.assertEqual((report["decision"], report["attempt_status"]), ("rejected", "REJECTED"), report)
        self.assertEqual(stand.money, 1)
        entry = self.history()[-1]
        self.assertEqual((entry["status"], entry["bookmakerRejected"], entry["failureClass"]), ("failed", True, "odd_cf_changed"))
        export = json.loads(Path(report["export"]["path"]).read_text())["receipt"]
        self.assertEqual((export["outcome"], export["rejection_code"], export["unresolved"]), ("rejected", "odd_cf_changed", False))

    def test_unknown_answer_is_unresolved_not_failed_and_does_not_block_independent_tasks(self):
        stand, item, policy, report = self._run_with_answer({"result": {"error": {"code": "something_new"}}})
        key = report["key"]
        self.assertEqual((report["decision"], report["attempt_status"]), ("unresolved", "INDETERMINATE"), report)
        entry = self.history()[-1]
        self.assertEqual((entry["status"], entry.get("bookmakerRejected")), ("unresolved", None))
        self.assertEqual(self.prod.current(), {"item": None, "pending": None, "processing": False})
        export = json.loads(Path(report["export"]["path"]).read_text())["receipt"]
        self.assertEqual((export["outcome"], export["unresolved"]), ("unknown_reconcile_required", True))
        # an independent task (another selection) goes through at once
        stand.config(answer=None)
        self.prod.add(case("P1 T> 1"))
        configure_stand(stand, "P1 T> 1")
        rc, lines, reps = self.run_once(policy)
        self.assertEqual(reps[0]["decision"], "accepted", reps)
        self.assertEqual(stand.money, 2)
        # three unresolved outcomes do not block the match the way three failures do
        raw = self.prod.raw()
        self.assertEqual(len([h for h in raw["history"] if h["status"] == "unresolved"]), 1)

    def test_no_answer_within_the_cart_window_is_unclear_money_one_request_then_reconciliation_by_native_key(self):
        stand, item, policy, report = self._run_with_answer(None, delay_ms=18000)
        key = report["key"]
        self.assertEqual((report["decision"], report["attempt_status"]), ("unresolved", "INDETERMINATE"), report)
        self.assertEqual(stand.money, 1)
        attempt = self.attempt(stand, key)["attempt"]
        wire_key = stand.log()["money"][0]["body"]["idempotencyKey"]
        self.assertEqual(attempt["native_request"]["idempotency_key"], wire_key)
        # a restart of the consumer re-reads and re-sends nothing
        rc, lines, reps = self.run_once(policy, "--idle-exit-s", "0.5")
        self.assertEqual(stand.money, 1)
        # history search by the stored native key, then the revision with the bookmaker's id
        rc, lines = run_consumer(policy, "--key", key, "--bet-id", "STAND-1", "--evidence", f"stand history by native key {wire_key}",
                                 "--operator", "op-1", command="reconcile")
        self.assertEqual(rc, 0, lines)
        export = json.loads(Path(lines[-1]["export"]["path"]).read_text())["receipt"]
        self.assertEqual((export["outcome"], export["unresolved"], export["synthetic"]), ("accepted_reconciled", False, True))
        self.assertEqual(export["settlement"], "pending")
        self.assertEqual(export["financial_result"], "not_recorded")

    def test_numeric_bookmaker_id_on_the_stand_stays_synthetic_whatever_the_caller_calls_it(self):
        answer = {"result": {"success": {"betId": 9876543, "cf": case()["outcome"]["donor_quote"]["odds"], "amount": 1, "currencyCode": "USDT"}}}
        stand, item, policy, report = self._run_with_answer(answer)
        self.assertEqual(report["decision"], "accepted")
        attempt = self.attempt(stand, report["key"])["attempt"]
        for label in (None, "production", "local_stand"):
            record = export_attempt_receipt(attempt, transport_environment=label)
            self.assertTrue(record["synthetic"], label)
            self.assertEqual(record["transport_environment"], "local_stand")
            self.assertEqual(record["bookmaker_receipt"]["bet_id"], "9876543")
        self.assertTrue(self.history()[-1]["testMode"])
        # the export of an unchanged attempt is repeatable byte for byte
        first = Path(report["export"]["path"]).read_bytes()
        self.assertEqual(json.loads(first)["receipt"], export_attempt_receipt(attempt, queue_task_id=item["id"]))


class ExecutorBoundary(ConsumerBase):
    """What the executor itself refuses, independent of the consumer."""

    def _call(self, stand, method, path, body=None, token=TOKEN):
        import urllib.error
        import urllib.request
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(f"{stand.url}{path}", data=data, method=method,
                                         headers={"authorization": f"Bearer {token}", "content-type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=10) as reply:
                return reply.status, json.loads(reply.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read() or b"{}")

    def test_token_schema_mode_and_provenance_are_enforced(self):
        stand = self.stand("real")
        self.assertEqual(self._call(stand, "GET", "/v1/health", token="x" * 20)[0], 401)
        status, body = self._call(stand, "POST", "/v1/orders", {"schema": "wrong"})
        self.assertEqual((status, body["error"]["code"]), (400, "ORDER_SCHEMA_INVALID"))
        envelope = {"schema": "automation-executor-order.v1", "mode": "dry", "plan": {"idempotency_key": "k"},
                    "provenance": {"synthetic": True}, "consumer": {"id": "c"}}
        self.assertEqual(self._call(stand, "POST", "/v1/orders", envelope)[1]["error"]["code"], "ORDER_MODE_MISMATCH")
        envelope["mode"] = "real"
        del envelope["provenance"]
        self.assertEqual(self._call(stand, "POST", "/v1/orders", envelope)[1]["error"]["code"], "ORDER_PROVENANCE_REQUIRED")
        self.assertEqual(stand.money, 0)

    def test_an_order_cannot_relabel_its_environment_or_origin(self):
        stand = self.stand("real")
        item = self.prod.add()
        policy = self.policy(stand, "real")
        rc, lines, reps = self.run_once(policy)
        attempt = self.attempt(stand, reps[0]["key"])["attempt"]
        env = attempt["payload"]["executor_provenance"]
        self.assertEqual(env["transport_environment"], "local_stand")
        self.assertEqual(env["bet_api_origins"], [stand.ready["bet_origin"]])
        self.assertEqual(attempt["payload"]["selection"]["event_url"].split("/betting")[0], stand.ready["bet_origin"].replace("api-gateway.top-parser.com", "1win.pro"))


if __name__ == "__main__":
    unittest.main()
