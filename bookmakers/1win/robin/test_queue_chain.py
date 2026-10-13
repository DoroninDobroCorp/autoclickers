"""Queue -> common task -> executor order -> cart plan, using the real Node queue code."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from native_fixture_support import recorded_native_market
from onewin_automation.cart_plan import cart_plan_from_order
from onewin_automation.common import (
    CommonTaskError,
    DurableAttemptStore,
    DurableDryRunStore,
    instant,
    verify_live_execution_conditions,
)
from onewin_automation.queue_adapter import common_task_from_queue_item, queue_item_identity

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
RECORDED = json.loads((HERE / "fixtures" / "recorded_value_outcomes.json").read_text())
NOW = instant(RECORDED["replay_now_iso"])
NODE = shutil.which("node")

QUEUE_SCRIPT = r"""
const path = require('path');
const fs = require('fs');
const os = require('os');
const repo = process.argv[1];
const { TaskBuilder } = require(path.join(repo, 'core/node/betting/TaskBuilder.js'));
const { TasksManager } = require(path.join(repo, 'core/node/tasks/tasks-manager.js'));
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-chain-'));
const log = console.log; console.log = () => {};
const manager = new TasksManager({ tasksFilePath: path.join(dir, 'tasks.json') });
const builder = new TaskBuilder({ bookmakerName: '1win' });
const tracker = { pair: input.pair, outcomeData: input.outcome, type: 'single', outcome: input.outcome.outcome,
  lastROI: 0, matchId: input.pair.second.matchId };
const task = builder.build(tracker, { stake: 1, isHighROI: false, home: input.pair.first.homeName,
  away: input.pair.first.awayName, ourSide: input.pair.second, expectedOdds: input.outcome.score2.value });
const added = manager.addTask(task);
const current = manager.getCurrentTask('1win');
console.log = log;
console.log(JSON.stringify({ added, current }));
fs.rmSync(dir, { recursive: true, force: true });
"""


def enqueue(case_name: str) -> dict:
    case = next(c for c in RECORDED["cases"] if c["name"] == case_name)
    proc = subprocess.run([NODE, "-e", QUEUE_SCRIPT, str(REPO)], input=json.dumps(case), text=True,
                          capture_output=True, timeout=60)
    if proc.returncode != 0:
        raise AssertionError(proc.stderr)
    result = json.loads(proc.stdout.strip().splitlines()[-1])
    assert result["added"] is True and result["current"], result
    return result["current"]


@unittest.skipUnless(NODE, "node is required for the real queue code")
class RealQueueToCommonTask(unittest.TestCase):
    def test_item_is_what_the_queue_really_stores(self):
        item = enqueue("P1 T< 1")
        self.assertEqual(item["bookmakerId"], "1win")
        self.assertIn("outcomeData", item)
        self.assertEqual(item["outcomeData"]["donor_quote"]["market_axes"]["market_family"], "total")

    def test_adapter_builds_the_same_task_the_value_path_builds(self):
        item = enqueue("P1 T< 1")
        task = common_task_from_queue_item(item, stake=1.0, now=NOW)
        direct = next(c for c in RECORDED["cases"] if c["name"] == "P1 T< 1")
        self.assertEqual(task["quote"], direct["outcome"]["donor_quote"])
        self.assertEqual(task["axes"], direct["outcome"]["donor_quote"]["market_axes"])
        self.assertEqual(task["axes_contract"]["status"], "complete")
        self.assertEqual(task["reference_source"], "BIA")
        self.assertFalse(task["execution_ready"])
        self.assertEqual(task["queue"]["task_id"], item["id"])
        self.assertFalse(task["queue"]["queue_currency_assumed_equal"])

    def test_identity_is_stable_across_restart_and_does_not_depend_on_prices(self):
        item = enqueue("P1 T< 1")
        restarted = json.loads(json.dumps(item))
        repriced = copy.deepcopy(item)
        repriced["outcomeData"]["donor_quote"]["odds"] = 9.99
        self.assertEqual(queue_item_identity(item), queue_item_identity(restarted))
        self.assertEqual(queue_item_identity(item), queue_item_identity(repriced))
        other = copy.deepcopy(item)
        other["id"] = item["id"] + 1
        self.assertNotEqual(queue_item_identity(item), queue_item_identity(other))

    def test_other_bookmaker_or_missing_identity_is_refused(self):
        item = enqueue("P1 T< 1")
        for mutation in ({"bookmakerId": "sansabet"}, {"id": None}, {"id": True}, {"pair": None}, {"outcomeData": []}):
            broken = {**item, **mutation}
            with self.subTest(mutation=mutation):
                with self.assertRaises(CommonTaskError):
                    common_task_from_queue_item(broken, stake=1.0, now=NOW)

    def test_stake_must_be_explicit_and_positive_in_the_account_currency(self):
        item = enqueue("P1 T< 1")
        for stake in (None, True, 0, -1, float("nan")):
            with self.subTest(stake=repr(stake)):
                with self.assertRaises((CommonTaskError, TypeError)):
                    common_task_from_queue_item(item, stake=stake, now=NOW)

    def test_restart_replay_withdrawal_and_changed_payload(self):
        item = enqueue("P1 T< 1")
        task = common_task_from_queue_item(item, stake=1.0, now=NOW)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "dry.sqlite"
            store = DurableDryRunStore(path)
            self.assertFalse(store.prepare(task, now=NOW + 0.1)["duplicate"])
            store.close()
            store = DurableDryRunStore(path)
            replay = common_task_from_queue_item(json.loads(json.dumps(item)), stake=1.0, now=NOW)
            self.assertTrue(store.prepare(replay, now=NOW + 0.2)["duplicate"])
            stale = copy.deepcopy(replay)
            stale["quote"]["odds"] = 1.01
            with self.assertRaises(CommonTaskError):
                store.prepare(stale, now=NOW + 0.2)
            store.reconcile(task["idempotency_key"], status="WITHDRAWN", revision=1)
            self.assertEqual(store.prepare(replay, now=NOW + 0.3)["status"], "WITHDRAWN")
            with self.assertRaises(CommonTaskError):
                store.reconcile(task["idempotency_key"], status="DRY_RUN_VERIFIED", revision=2)
            with self.assertRaises(CommonTaskError):
                store.reconcile(task["idempotency_key"], status="WITHDRAWN", revision=0)
            store.close()


def executor_quote(task: dict) -> dict:
    donor, execution = task["quote"], task["quote"]["execution"]
    return {
        "identity_verified_by": "onewin-executor", "verified": True,
        "provider_id_namespace": execution["provider_id_namespace"],
        "provider_event_key": execution["provider_event_key"],
        "native_event_id": execution["provider_event_key"],
        "native_market_id": execution["provider_market_key"],
        "native_selection_id": execution["provider_selection_key"],
        "source_market": donor["source_market"], "odds": donor["odds"], "source_ts": NOW + 0.2,
        "currency": "USDT", "commission": 0.0, "max_stake": 8.45, "axes": copy.deepcopy(donor["market_axes"]),
        "live_submit_contract_verified": True, "live_submit_contract_source": "synthetic-chain-fixture",
        "native_market": recorded_native_market(task["outcome_key"]),
    }


ACCOUNT = {"logged_in": True, "account_identity_verified": True, "account_identity_source": "synthetic-chain-fixture",
           "currency": "USDT", "available_balance": 8.45, "observed_at": NOW + 0.2}


class OrderToCartPlan(unittest.TestCase):
    def order(self):
        direct = next(c for c in RECORDED["cases"] if c["name"] == "P1 T< 1")
        from onewin_automation.common import task_from_value
        task = task_from_value(direct["pair"], direct["outcome"], stake=1.0, idempotency_key="plan-1", now=NOW)
        return verify_live_execution_conditions(task, executor_quote(task), ACCOUNT, now=NOW + 1)

    def test_plan_carries_only_verified_facts(self):
        order = self.order()
        plan = cart_plan_from_order(order, event_url="https://1win.pro/betting/match/sport/39949187",
                                    market_name="1st half. Total", ui_selection_name="Under 1")
        self.assertEqual(plan["idempotency_key"], "plan-1")
        self.assertEqual(plan["currency"], "USDT")
        self.assertEqual(plan["expected_axes"], plan["selection"]["axes"])
        self.assertEqual(plan["expires_at"], min(plan["evidence"]["expiries"].values()))
        self.assertEqual(plan["selection"]["selection_id"], order["selection_id"])
        self.assertEqual(plan["account_conditions"]["commission"], 0.0)

    def test_unverified_or_mutated_orders_are_refused(self):
        order = self.order()
        for mutation in ({"execution_ready": False}, {"execution_blockers": ["x"]}, {"schema_version": "x"}):
            with self.subTest(mutation=mutation):
                with self.assertRaises(CommonTaskError):
                    cart_plan_from_order({**order, **mutation}, event_url="https://1win.pro/betting/match/sport/1",
                                         market_name="m", ui_selection_name="s")
        with self.assertRaises(CommonTaskError):
            cart_plan_from_order(order, event_url="", market_name="m", ui_selection_name="s")


@unittest.skipUnless(NODE, "node is required for the cart state machine")
class PlanDrivesRealCartStateMachine(unittest.TestCase):
    """Python order -> plan -> the real OneWinLiveCart on a fake page (no network, synthetic receipts)."""

    HARNESS = HERE / "scripts" / "onewin" / "plan_contract_harness.mjs"

    def plan(self, key="plan-1", name="P1 T< 1"):
        from onewin_automation.common import task_from_value
        direct = next(c for c in RECORDED["cases"] if c["name"] == name)
        task = task_from_value(direct["pair"], direct["outcome"], stake=1.0, idempotency_key=key, now=NOW)
        order = verify_live_execution_conditions(task, executor_quote(task), ACCOUNT, now=NOW + 1)
        return cart_plan_from_order(order, event_url="https://1win.pro/betting/match/sport/" + order["event_id"],
                                    market_name="1st half. Total", ui_selection_name="Under 1")

    def drive(self, plan, store_path, scenario="accept", **extra):
        payload = {"plan": plan, "store_path": str(store_path), "now": NOW + 1, "scenario": scenario, **extra}
        proc = subprocess.run([NODE, str(self.HARNESS)], input=json.dumps(payload), text=True, capture_output=True,
                              timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertTrue(out["synthetic_transport"])
        self.assertFalse(out["network_used"])
        return out

    def test_accept_then_replay_after_restart_is_a_duplicate(self):
        with tempfile.TemporaryDirectory() as d:
            store = Path(d) / "attempts.json"
            plan = self.plan()
            first = self.drive(plan, store)
            self.assertEqual(first["result"]["status"], "ACCEPTED", first)
            self.assertEqual(first["forwarded_requests"], 1)
            self.assertEqual(first["attempt"]["receipt"]["bet_id"], "SYNTHETIC-plan-1")
            again = self.drive(plan, store)
            self.assertIn("DUPLICATE_IDEMPOTENCY_KEY", again["error"])
            self.assertEqual(again["forwarded_requests"], 0)

    def test_second_task_for_the_same_selection_is_not_executed(self):
        with tempfile.TemporaryDirectory() as d:
            store = Path(d) / "attempts.json"
            self.drive(self.plan("plan-1"), store)
            second = self.drive(self.plan("plan-2"), store)
            self.assertIn("DUPLICATE_SELECTION_ATTEMPT", second["error"])
            self.assertEqual(second["forwarded_requests"], 0)

    def test_timeout_after_send_is_indeterminate_and_never_retried(self):
        with tempfile.TemporaryDirectory() as d:
            store = Path(d) / "attempts.json"
            plan = self.plan()
            first = self.drive(plan, store, "timeout_after_send")
            self.assertEqual(first["result"]["status"], "INDETERMINATE")
            self.assertEqual(first["forwarded_requests"], 1)
            retry = self.drive(plan, store, "accept")
            self.assertIn("DUPLICATE_IDEMPOTENCY_KEY", retry["error"])
            self.assertEqual(retry["forwarded_requests"], 0)
            self.assertEqual(retry["attempt"]["status"], "INDETERMINATE")

    def test_expiry_after_submitting_and_withdrawal_forward_nothing(self):
        for scenario in ("expire_after_submitting", "withdraw_after_submitting"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as d:
                out = self.drive(self.plan(), Path(d) / "attempts.json", scenario)
                self.assertEqual(out["forwarded_requests"], 0)
                self.assertEqual(out["result"]["status"], "ABORTED_PRE_SUBMIT")
                self.assertEqual(out["attempt"]["status"], "WITHDRAWN")
                self.assertEqual(out["attempt"]["not_sent_proof"]["forwarded_requests"], 0)

    def test_price_drift_on_the_board_aborts_before_submit(self):
        with tempfile.TemporaryDirectory() as d:
            out = self.drive(self.plan(), Path(d) / "attempts.json", board_price=2.5)
            self.assertEqual(out["forwarded_requests"], 0)
            self.assertIn("BOARD_PRICE_CHANGED", out["result"]["error"])
            self.assertEqual(out["attempt"]["status"], "WITHDRAWN")

    def test_expired_plan_is_refused_before_claiming(self):
        with tempfile.TemporaryDirectory() as d:
            plan = self.plan()
            out = self.drive({**plan, "expires_at": NOW + 0.5}, Path(d) / "attempts.json")
            self.assertIn("TASK_EXPIRED", out["error"])
            self.assertIsNone(out["attempt"])

    def test_changed_market_identity_in_the_plan_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            plan = self.plan()
            tampered = copy.deepcopy(plan)
            tampered["selection"]["axes"]["unit"] = "points"
            out = self.drive(tampered, Path(d) / "attempts.json")
            self.assertIn("AXES_MISMATCH", out["error"])
            self.assertEqual(out["forwarded_requests"], 0)

    def test_unproven_payout_rule_is_refused_by_the_executor_side_as_well(self):
        with tempfile.TemporaryDirectory() as d:
            plan = self.plan()
            for facts in (plan["expected_axes"], plan["selection"]["axes"]):
                facts["payout_rule"] = {**facts["payout_rule"], "status": "unverified"}
            out = self.drive(plan, Path(d) / "attempts.json")
            self.assertIn("PAYOUT_RULE_UNVERIFIED", out["error"])
            self.assertEqual(out["forwarded_requests"], 0)

    def test_reject_is_terminal_and_a_new_task_may_not_reuse_the_key(self):
        with tempfile.TemporaryDirectory() as d:
            store = Path(d) / "attempts.json"
            out = self.drive(self.plan(), store, "reject")
            self.assertEqual(out["result"]["status"], "REJECTED")
            again = self.drive(self.plan(), store, "accept")
            self.assertIn("DUPLICATE_IDEMPOTENCY_KEY", again["error"])
            self.assertEqual(again["forwarded_requests"], 0)


class SelectionLevelDuplicateGuard(unittest.TestCase):
    def test_second_key_for_the_same_native_selection_is_refused_until_resolved(self):
        payload = {"event_id": "1", "market_id": "2", "selection_id": "10:1:0", "expected_odds": 1.87}
        with tempfile.TemporaryDirectory() as d:
            store = DurableAttemptStore(Path(d) / "attempts.sqlite")
            self.assertTrue(store.claim("a", stake=1.0, currency="USDT", payload={**payload, "idempotency_key": "a"}, now=1000))
            self.assertFalse(store.claim("b", stake=1.0, currency="USDT", payload={**payload, "idempotency_key": "b"}, now=1001))
            store.record_status("a", "SUBMITTING", now=1002)
            store.record_status("a", "INDETERMINATE", error="timeout", now=1003)
            self.assertFalse(store.claim("b", stake=1.0, currency="USDT", payload={**payload, "idempotency_key": "b"}, now=1004))
            other = {**payload, "selection_id": "10:2:0"}
            self.assertTrue(store.claim("c", stake=1.0, currency="USDT", payload={**other, "idempotency_key": "c"}, now=1005))
            store.record_status("c", "WITHDRAWN", error="queue withdrawal", now=1006)
            self.assertTrue(store.claim("d", stake=1.0, currency="USDT", payload={**other, "idempotency_key": "d"}, now=1007))
            store.close()


if __name__ == "__main__":
    unittest.main()
