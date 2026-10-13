"""Regressions for the independent review of 2026-10-13 (R-xx ids follow its report).

Each test states the bypass it closes.  They are written against public behaviour
so that they fail with a meaningful assertion before the fix.
"""
from __future__ import annotations

import copy
import json
import math
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

from native_fixture_support import recorded_native_market
from onewin_automation.common import (
    CommonTaskError,
    DurableAttemptStore,
    DurableDryRunStore,
    assess_live_readiness,
    instant,
    task_from_value,
    verify_executor_quote,
    verify_live_execution_conditions,
)
from onewin_automation.config import OneWinAutomationConfig
from onewin_automation.placement import (
    BasketValidationError,
    PlacementGate,
    PlacementIndeterminate,
    PlacementRejected,
)

HERE = Path(__file__).resolve().parent
RECORDED = json.loads((HERE / "fixtures" / "recorded_value_outcomes.json").read_text())
NOW = instant(RECORDED["replay_now_iso"])


def case(name: str = "P1 T< 1") -> dict:
    return copy.deepcopy(next(c for c in RECORDED["cases"] if c["name"] == name))


def task(name: str = "P1 T< 1", *, stake: float = 1.0, key: str = "followup-1", mutate=None) -> dict:
    c = case(name)
    if mutate:
        mutate(c)
    return task_from_value(c["pair"], c["outcome"], stake=stake, idempotency_key=key, now=NOW)


def quote(t: dict, **over) -> dict:
    donor, execution = t["quote"], t["quote"]["execution"]
    value = {
        "identity_verified_by": "onewin-executor", "verified": True,
        "provider_id_namespace": execution["provider_id_namespace"],
        "provider_event_key": execution["provider_event_key"], "native_event_id": execution["provider_event_key"],
        "native_market_id": execution["provider_market_key"], "native_selection_id": execution["provider_selection_key"],
        "source_market": donor["source_market"], "odds": donor["odds"], "source_ts": NOW + 0.2, "currency": "USDT",
        "commission": 0.0, "max_stake": 8.45, "axes": copy.deepcopy(donor["market_axes"]),
        "live_submit_contract_verified": True, "live_submit_contract_source": "followup-fixture",
        "native_market": recorded_native_market(t["outcome_key"]),
    }
    value.update(over)
    return value


ACCOUNT = {"logged_in": True, "account_identity_verified": True, "account_identity_source": "followup-fixture",
           "currency": "USDT", "available_balance": 8.45, "observed_at": NOW + 0.2}
AT = NOW + 1


class Binding(unittest.TestCase):
    def test_r05_native_event_id_is_bound_to_the_parser_event(self):
        t = task()
        verdict = assess_live_readiness(t, quote(t, native_event_id="99999999"), ACCOUNT, now=AT)
        self.assertFalse(verdict["execution_ready"])
        self.assertIn("executor_binding_mismatch", verdict["execution_blockers"])
        with self.assertRaises(CommonTaskError) as refusal:
            verify_live_execution_conditions(t, quote(t, native_event_id="99999999"), ACCOUNT, now=AT)
        self.assertIn("event_id", str(refusal.exception))

    def test_r21_order_axes_are_the_axes_the_engine_checked(self):
        t = task()
        q = quote(t, market_axes="garbage")  # truthy, not an object: must not be echoed into the order
        order = verify_live_execution_conditions(t, q, ACCOUNT, now=AT)
        self.assertEqual(order["axes"], t["quote"]["market_axes"])
        self.assertNotEqual(order["axes"], "garbage")


class PayoutRule(unittest.TestCase):
    def declared(self, **fields):
        def mutate(c):
            for side in ("reference_quote", "donor_quote"):
                c["outcome"][side].update(fields)
        return mutate

    def test_r04_executor_payout_rule_must_be_proven_and_equal(self):
        t = task(mutate=self.declared(result_variant="two_way", draw_payout="refund", payout_status="declared"))
        good = quote(t, result_variant="two_way", draw_payout="refund", payout_status="declared")
        self.assertTrue(assess_live_readiness(t, good, ACCOUNT, now=AT)["execution_ready"])
        for name, over in (("unverified", {"payout_status": "unverified_draw_rule", "draw_payout": "undisclosed"}),
                           ("other variant", {"result_variant": "three_way"}),
                           ("other draw", {"draw_payout": "lose"})):
            with self.subTest(name):
                verdict = assess_live_readiness(t, {**good, **over}, ACCOUNT, now=AT)
                self.assertFalse(verdict["execution_ready"], verdict)
                with self.assertRaises(CommonTaskError):
                    verify_live_execution_conditions(t, {**good, **over}, ACCOUNT, now=AT)

    def test_r13_absence_of_a_declaration_is_not_called_proven(self):
        t = task()
        order = verify_live_execution_conditions(t, quote(t), ACCOUNT, now=AT)
        self.assertEqual(order["settlement_facts"]["payout_rule"]["status"], "not_declared")
        declared = task(mutate=self.declared(result_variant="two_way", draw_payout="refund"))
        order = verify_live_execution_conditions(declared, quote(declared, result_variant="two_way", draw_payout="refund"),
                                                 ACCOUNT, now=AT)
        self.assertEqual(order["settlement_facts"]["payout_rule"]["status"], "proven")

    def test_r13_a_policy_can_demand_declared_payout_rules(self):
        t = task()
        verdict = assess_live_readiness(t, quote(t), ACCOUNT, now=AT, require_declared_payout=True)
        self.assertIn("payout_rule_not_declared", verdict["execution_blockers"])


class TaskContent(unittest.TestCase):
    def test_r07_live_flag_must_be_a_real_boolean(self):
        for bad in (None, 0, 1, "false", "true", ""):
            with self.subTest(isLive=repr(bad)):
                with self.assertRaises(CommonTaskError):
                    task(mutate=lambda c, b=bad: c["pair"].__setitem__("isLive", b))
        missing = case()
        del missing["pair"]["isLive"]
        with self.assertRaises(CommonTaskError):
            task_from_value(missing["pair"], missing["outcome"], stake=1.0, idempotency_key="k", now=NOW)

    def test_r07_tampered_live_flag_in_a_stored_task_is_invalid(self):
        t = task()
        t["is_live"] = "false"
        self.assertIn("invalid_task", assess_live_readiness(t, quote(t), ACCOUNT, now=AT)["execution_blockers"])

    def test_r12_task_content_is_revalidated_at_permission_time(self):
        t = task()
        cases = {
            "reference source": lambda x: x["reference_quote"].__setitem__("source", "sansabet"),
            "reference event": lambda x: x["reference_quote"].__setitem__("source_event_key", "other-event"),
            "reference price": lambda x: x["reference_quote"].__setitem__("odds", 1.0),
            "margin source": lambda x: x["margin_quotes"][0].__setitem__("source", "pinnacle"),
            "margin price": lambda x: x["margin_quotes"][0].__setitem__("odds", None),
            "donor source": lambda x: x["quote"].__setitem__("source", "bet365"),
            "external blocker": lambda x: x.__setitem__("execution_blockers", ["operator_hold"]),
        }
        for name, mutate in cases.items():
            tampered = copy.deepcopy(t)
            mutate(tampered)
            with self.subTest(name):
                verdict = assess_live_readiness(tampered, quote(tampered), ACCOUNT, now=AT)
                self.assertFalse(verdict["execution_ready"], name)
                with self.assertRaises(CommonTaskError):
                    verify_live_execution_conditions(tampered, quote(tampered), ACCOUNT, now=AT)

    def test_r11_withdrawn_dry_run_task_cannot_be_executed(self):
        t = task()
        with tempfile.TemporaryDirectory() as d:
            store = DurableDryRunStore(Path(d) / "dry.sqlite")
            store.prepare(t, now=NOW + 0.1)
            self.assertTrue(assess_live_readiness(t, quote(t), ACCOUNT, now=AT, task_store=store)["execution_ready"])
            store.reconcile(t["idempotency_key"], status="WITHDRAWN", revision=1)
            verdict = assess_live_readiness(t, quote(t), ACCOUNT, now=AT, task_store=store)
            self.assertFalse(verdict["execution_ready"])
            self.assertIn("task_withdrawn_or_terminal", verdict["execution_blockers"])
            with self.assertRaises(CommonTaskError):
                verify_live_execution_conditions(t, quote(t), ACCOUNT, now=AT, task_store=store)
            store.close()

    def test_r11_unknown_task_in_the_store_is_not_executable(self):
        t = task()
        with tempfile.TemporaryDirectory() as d:
            store = DurableDryRunStore(Path(d) / "dry.sqlite")
            verdict = assess_live_readiness(t, quote(t), ACCOUNT, now=AT, task_store=store)
            self.assertIn("task_not_prepared", verdict["execution_blockers"])
            store.close()


class NeverRaises(unittest.TestCase):
    def test_r17_hostile_values_become_blockers_not_exceptions(self):
        t = task()
        hostile = [
            ("quote", "observed_at_origin", []), ("quote", "source_ts", {"a": 1}), ("quote", "odds", 10 ** 400),
            ("quote", "max_stake", 10 ** 400), ("quote", "commission", 10 ** 400), ("account", "available_balance", 10 ** 400),
            ("account", "observed_at", [1]), ("task", "stake", 10 ** 400), ("task", "expires_at", "soon"),
        ]
        for scope, field, value in hostile:
            q, a, tk = quote(t), copy.deepcopy(ACCOUNT), copy.deepcopy(t)
            if field == "observed_at_origin":  # exercise the provenance path instead of source_ts
                del q["source_ts"]
                q["observed_at"] = "2026-10-12T17:38:32.5Z"
                q["observed_at_semantics"] = "provider_confirmation"
            {"quote": q, "account": a, "task": tk}[scope][field] = value
            with self.subTest(scope=scope, field=field):
                try:
                    verdict = assess_live_readiness(tk, q, a, now=AT)
                except Exception as exc:  # noqa: BLE001 - the contract is "never raises"
                    self.fail(f"assess raised {type(exc).__name__}: {exc}")
                self.assertFalse(verdict["execution_ready"])
                with self.assertRaises(CommonTaskError):
                    verify_live_execution_conditions(tk, q, a, now=AT)
                if scope != "account":  # the dry-run verifier does not see the account
                    with self.assertRaises(CommonTaskError):
                        verify_executor_quote(tk, q, now=AT)

    def test_r18_nan_and_bool_clocks_cannot_create_or_prepare_tasks(self):
        c = case()
        for bad in (float("nan"), float("inf"), True, 0, -1):
            with self.subTest(now=repr(bad)):
                with self.assertRaises(CommonTaskError):
                    task_from_value(c["pair"], c["outcome"], stake=1.0, idempotency_key="k", now=bad)
        t = task()
        with tempfile.TemporaryDirectory() as d:
            store = DurableDryRunStore(Path(d) / "dry.sqlite")
            for bad in (float("nan"), float("inf"), True):
                with self.subTest(prepare_now=repr(bad)):
                    with self.assertRaises(CommonTaskError):
                        store.prepare(t, now=bad)
            store.close()


class SelectionGuard(unittest.TestCase):
    def test_r20_formatting_and_currency_label_do_not_hide_the_same_selection(self):
        with tempfile.TemporaryDirectory() as d:
            store = DurableAttemptStore(Path(d) / "attempts.sqlite")
            base = {"event_id": "41389968", "market_id": "6380", "selection_id": "10:174509365120497860:1", "expected_odds": 5.5}
            self.assertTrue(store.claim("a", stake=1.0, currency="USDT", payload={**base, "idempotency_key": "a"}, now=1000))
            variants = {
                "padded id": {**base, "selection_id": " 10:174509365120497860:1 "},
                "padded event": {**base, "event_id": " 41389968"},
                "other currency label": base,
            }
            for name, payload in variants.items():
                with self.subTest(name):
                    currency = "EUR" if name == "other currency label" else "USDT"
                    self.assertFalse(store.claim(f"b-{name}", stake=1.0, currency=currency,
                                                 payload={**payload, "idempotency_key": f"b-{name}"}, now=1001))
            store.close()

    def test_r24_reconciled_not_placed_frees_the_selection_with_an_audit_trail(self):
        base = {"event_id": "1", "market_id": "2", "selection_id": "10:1:0", "expected_odds": 1.87}
        with tempfile.TemporaryDirectory() as d:
            store = DurableAttemptStore(Path(d) / "attempts.sqlite")
            store.claim("a", stake=1.0, currency="USDT", payload={**base, "idempotency_key": "a"}, now=1000)
            store.record_status("a", "SUBMITTING", now=1001)
            store.record_status("a", "INDETERMINATE", error="timeout", now=1002)
            self.assertFalse(store.claim("b", stake=1.0, currency="USDT", payload={**base, "idempotency_key": "b"}, now=1003))
            with self.assertRaises(CommonTaskError):  # needs an operator and a concrete evidence reference
                store.add_revision("a", kind="reconciled_not_placed", data={"note": "looked fine"}, now=1004)
            store.add_revision("a", kind="reconciled_not_placed",
                               data={"operator": "owner", "evidence": "account bet history 2026-10-13T15:30Z: no bet"}, now=1005)
            self.assertEqual(store.get_attempt("a")["status"], "INDETERMINATE")  # the sealed record is untouched
            self.assertTrue(store.claim("b", stake=1.0, currency="USDT", payload={**base, "idempotency_key": "b"}, now=1006))
            store.close()

    def test_r14_a_vanished_store_file_is_corruption_not_an_empty_history(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "attempts.sqlite"
            store = DurableAttemptStore(path)
            store.claim("a", stake=1.0, currency="USDT", payload={"idempotency_key": "a", "event_id": "1"}, now=1000)
            path.unlink()
            with self.assertRaises(CommonTaskError):
                store.claim("a", stake=1.0, currency="USDT", payload={"idempotency_key": "a", "event_id": "1"}, now=1001)
            store.close()


class ConfigFlag(unittest.TestCase):
    def test_r22_live_flag_is_exactly_true_like_the_node_side(self):
        keep = os.environ.get("ONEWIN_AUTOMATION_LIVE_ENABLED")
        try:
            for value, expected in (("true", True), ("TRUE", True), ("1", False), ("yes", False), ("on", False), ("", False)):
                os.environ["ONEWIN_AUTOMATION_LIVE_ENABLED"] = value
                with self.subTest(value=value):
                    self.assertEqual(OneWinAutomationConfig.from_env().live_enabled, expected)
        finally:
            if keep is None:
                os.environ.pop("ONEWIN_AUTOMATION_LIVE_ENABLED", None)
            else:
                os.environ["ONEWIN_AUTOMATION_LIVE_ENABLED"] = keep


class GateRecomputesTheDecision(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = DurableAttemptStore(Path(self.tmp.name) / "attempts.sqlite", max_stake=1.0)
        self.calls = []

        async def transport(payload):
            self.calls.append(copy.deepcopy(payload))
            return {"ok": True, "status": "ACCEPTED", "receipt_id": "synthetic-9", "amount": payload["stake"],
                    "currency": payload["currency"], "accepted_odds": payload["odds"]}
        self.transport = transport

    async def asyncTearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def gate(self, clock):
        return PlacementGate.for_diagnostic_test(
            transport=self.transport, attempt_store=self.store,
            config=OneWinAutomationConfig(live_enabled=True, max_stake=1.0), clock=lambda: clock.value)

    def payload(self, t=None, **over):
        t = t or task()
        value = {"idempotency_key": t["idempotency_key"], "stake": 1.0, "currency": "USDT",
                 "live_inputs": {"task": t, "quote": quote(t), "account_state": copy.deepcopy(ACCOUNT)}}
        value.update(over)
        return value

    class Clock:
        def __init__(self, value):
            self.value = value

    async def test_r03_a_forged_order_literal_is_not_a_verification(self):
        forged = {"idempotency_key": "forged-1", "stake": 1.0, "currency": "USDT",
                  "order": {"schema_version": "automation-live-order.v1", "execution_ready": True, "execution_blockers": [],
                            "idempotency_key": "forged-1", "stake": 1.0, "currency": "USDT", "expires_at": NOW + 3600,
                            "event_id": "1", "market_id": "2", "selection_id": "10:3:0", "odds": 1.5}}
        with self.assertRaises(BasketValidationError):
            await self.gate(self.Clock(AT)).place(forged)
        self.assertEqual(self.calls, [])

    async def test_r03_verification_runs_inside_the_gate_and_feeds_the_transport(self):
        result = await self.gate(self.Clock(AT)).place(self.payload())
        self.assertEqual(result["receipt_id"], "synthetic-9")
        sent = self.calls[0]
        self.assertEqual(sorted(sent), ["currency", "event_id", "idempotency_key", "market_id", "odds", "selection_id", "stake"])
        t = task()
        self.assertEqual(sent["selection_id"], t["quote"]["execution"]["provider_selection_key"])

    async def test_attempt_carries_the_native_identity_of_the_verified_order(self):
        t = task()
        await self.gate(self.Clock(AT)).place(self.payload(t))
        attempt = self.store.get_attempt(t["idempotency_key"])
        execution = t["quote"]["execution"]
        self.assertEqual((attempt["event_id"], attempt["market_id"], attempt["selection_id"]),
                         (execution["provider_event_key"], execution["provider_market_key"], execution["provider_selection_key"]))
        self.assertEqual(attempt["expected_odds"], t["quote"]["odds"])
        self.assertEqual(attempt["status"], "ACCEPTED")

    async def test_r03_expired_evidence_at_the_gate_clock_is_refused(self):
        with self.assertRaises(BasketValidationError):
            await self.gate(self.Clock(NOW + 3600)).place(self.payload())
        self.assertEqual(self.calls, [])

    async def test_r03_expiry_between_the_submitting_record_and_the_transport_sends_nothing(self):
        clock = self.Clock(AT)
        real = self.store.record_status

        def hook(key, status, **kw):
            result = real(key, status, **kw)
            if status == "SUBMITTING":
                clock.value = NOW + 3600
            return result
        self.store.record_status = hook
        with self.assertRaises(BasketValidationError):
            await self.gate(clock).place(self.payload())
        self.store.record_status = real
        self.assertEqual(self.calls, [])
        self.assertEqual(self.store.get_attempt(task()["idempotency_key"])["status"], "WITHDRAWN")

    async def test_r08_conflicting_aliases_never_reach_the_transport(self):
        for name, extra in (("nested selection", {"selection": {"event_id": "666", "market_id": "777", "selection_id": "10:1:0"}}),
                            ("odds", {"odds": 9.99}), ("odds group", {"odds_group_id": "OTHER-MARKET"}),
                            ("amount", {"amount": 9999}), ("stake", {"stake": 5.0})):
            with self.subTest(name):
                with self.assertRaises(BasketValidationError):
                    await self.gate(self.Clock(AT)).place(self.payload(**extra))
        self.assertEqual(self.calls, [])

    async def test_r09_the_diagnostic_gate_needs_the_environment_switch_and_a_durable_store(self):
        keep = os.environ.pop("ONEWIN_AUTOMATION_LIVE_ENABLED", None)
        try:
            gate = PlacementGate.for_diagnostic_test(transport=self.transport, attempt_store=self.store,
                                                     clock=lambda: AT)
            self.assertFalse(gate.enabled)
        finally:
            if keep is not None:
                os.environ["ONEWIN_AUTOMATION_LIVE_ENABLED"] = keep

        class ClaimOnly:
            is_durable = True

            def claim(self, key, **kw):
                return True
        with self.assertRaises(Exception):
            PlacementGate.for_diagnostic_test(transport=self.transport, attempt_store=ClaimOnly(),
                                              config=OneWinAutomationConfig(live_enabled=True, max_stake=1.0))

    async def test_r10_a_receipt_next_to_an_error_is_never_a_clean_rejection(self):
        async def mixed(payload):
            return {"ok": True, "receipt_id": "BET-REAL-1", "errors": [{"code": "odd_cf_changed"}]}
        gate = PlacementGate.for_diagnostic_test(
            transport=mixed, attempt_store=self.store, config=OneWinAutomationConfig(live_enabled=True, max_stake=1.0),
            clock=lambda: AT)
        t = task()
        with self.assertRaises(PlacementIndeterminate):
            await gate.place(self.payload(t))
        attempt = self.store.get_attempt(t["idempotency_key"])
        self.assertEqual(attempt["status"], "INDETERMINATE")
        self.assertEqual(attempt["receipt"]["receipt_id"], "BET-REAL-1")
        # and the selection stays owned: nothing else may be placed on it
        other = task(key="followup-2")
        with self.assertRaises(BasketValidationError):
            await gate.place(self.payload(other, idempotency_key="followup-2"))


class LegacyGateIsExplicit(unittest.IsolatedAsyncioTestCase):
    async def test_r09_the_gate_requires_a_verified_order_unless_legacy_is_explicit(self):
        with tempfile.TemporaryDirectory() as d:
            store = DurableAttemptStore(Path(d) / "attempts.sqlite")
            calls = []

            async def transport(payload):
                calls.append(payload)
                return {"ok": True, "receipt_id": "r-1", "amount": payload["stake"]}
            cfg = OneWinAutomationConfig(live_enabled=True, max_stake=5.0)
            strict = PlacementGate(enabled=True, config=cfg, transport=transport, attempt_store=store, max_stake=5.0)
            with self.assertRaises(BasketValidationError):
                await strict.place({"idempotency_key": "bare-1", "stake": 1.0})
            self.assertEqual(calls, [])
            legacy = PlacementGate(enabled=True, config=cfg, transport=transport, attempt_store=store, max_stake=5.0,
                                   require_verified_order=False)
            self.assertEqual((await legacy.place({"idempotency_key": "bare-1", "stake": 1.0}))["receipt_id"], "r-1")
            store.close()


if __name__ == "__main__":
    unittest.main()


class NotSentProofIsAProcessCapability(unittest.TestCase):
    """R-15: only the process that holds the in-flight submission may assert that nothing was sent."""

    PAYLOAD = {"event_id": "1", "market_id": "2", "selection_id": "10:1:0", "expected_odds": 1.87}

    def submitting(self, directory):
        store = DurableAttemptStore(Path(directory) / "attempts.sqlite")
        store.claim("a", stake=1.0, currency="USDT", payload={**self.PAYLOAD, "idempotency_key": "a"}, now=1000)
        store.record_status("a", "SUBMITTING", now=1001)
        return store

    def test_r15_a_bare_assertion_is_not_proof(self):
        with tempfile.TemporaryDirectory() as d:
            store = self.submitting(d)
            with self.assertRaises(CommonTaskError):
                store.record_status("a", "WITHDRAWN", error="x", now=1002, not_sent_proof={"forwarded_requests": 0})
            with self.assertRaises(CommonTaskError):
                store.record_status("a", "WITHDRAWN", error="x", now=1002,
                                    not_sent_proof={"forwarded_requests": 0, "submit_token": "guess"})
            self.assertEqual(store.get_attempt("a")["status"], "SUBMITTING")
            token = store.submit_token("a")
            self.assertTrue(isinstance(token, str) and len(token) >= 16)
            store.record_status("a", "WITHDRAWN", error="x", now=1003,
                                not_sent_proof={"forwarded_requests": 0, "submit_token": token})
            self.assertEqual(store.get_attempt("a")["status"], "WITHDRAWN")
            store.close()

    def test_r15_a_restarted_process_can_only_resolve_to_indeterminate(self):
        with tempfile.TemporaryDirectory() as d:
            store = self.submitting(d)
            store.close()
            reopened = DurableAttemptStore(Path(d) / "attempts.sqlite")
            self.assertIsNone(reopened.submit_token("a"))
            with self.assertRaises(CommonTaskError):
                reopened.record_status("a", "WITHDRAWN", error="restart", now=1002,
                                       not_sent_proof={"forwarded_requests": 0, "submit_token": "anything"})
            reopened.record_status("a", "INDETERMINATE", error="restart_recovery", now=1003)
            reopened.close()


class QueueCurrency(unittest.TestCase):
    def item(self, **over):
        c = case()
        item = {"id": 1760000000000.5, "bookmakerId": "1win", "pair": c["pair"], "outcomeData": c["outcome"],
                "stake": 10, "source": "analyzer_single"}
        item.update(over)
        return item

    def test_r25_stake_currency_is_explicit_and_checked(self):
        from onewin_automation.queue_adapter import common_task_from_queue_item
        t = common_task_from_queue_item(self.item(), stake=1.0, stake_currency="USDT", now=NOW)
        self.assertEqual(t["queue"]["stake_currency"], "USDT")
        self.assertEqual(t["queue"]["queue_stake"], 10)
        for bad in ("EUR", "usdt ", None, ""):
            with self.subTest(currency=repr(bad)):
                with self.assertRaises(CommonTaskError):
                    common_task_from_queue_item(self.item(), stake=1.0, stake_currency=bad, now=NOW)
        with self.assertRaises(CommonTaskError):  # the queue item declares another currency
            common_task_from_queue_item(self.item(currency="EUR"), stake=1.0, stake_currency="USDT", now=NOW)
        with self.assertRaises(TypeError):  # no silent default
            common_task_from_queue_item(self.item(), stake=1.0, now=NOW)
