"""Review regressions for the strict live contract (task 3 follow-up, 2026-10-13).

Every test here is written against the public functions that already exist in
``onewin_automation.common`` so that it fails with a meaningful assertion on the
reviewed revision and passes only when the bypass is really closed.

Two input families are used:

* ``legacy_*``  - the hand-assembled vocabulary used by the older regressions.
  Several reviewed bypasses are only reproducible with it (the platform shape
  is rejected earlier for an unrelated reason).
* ``real_*``    - verbatim excerpts of a recorded value/calculator frame
  (``fixtures/recorded_value_outcomes.json``) whose axes live in
  ``<quote>.market_axes`` exactly as the platform serialised them.
"""
from __future__ import annotations

import copy
import json
import math
from pathlib import Path
import unittest

from onewin_automation.common import (
    CommonTaskError,
    assess_live_readiness,
    instant,
    task_from_value,
    verify_executor_quote,
    verify_live_execution_conditions,
)

HERE = Path(__file__).resolve().parent
RECORDED = json.loads((HERE / "fixtures" / "recorded_value_outcomes.json").read_text())
REPLAY_NOW = instant(RECORDED["replay_now_iso"])


def recorded_case(name: str) -> dict:
    for case in RECORDED["cases"]:
        if case["name"] == name:
            return copy.deepcopy(case)
    raise KeyError(name)


def real_task(name: str = "P1 T< 1", *, stake: float = 1.0, key: str = "review-real-1") -> dict:
    case = recorded_case(name)
    return task_from_value(case["pair"], case["outcome"], stake=stake, idempotency_key=key, now=REPLAY_NOW)


def real_executor_quote(task: dict, **overrides) -> dict:
    """Executor evidence for the *donor* leg exactly as independently verified."""
    donor = task["quote"]
    execution = donor["execution"]
    quote = {
        "identity_verified_by": "onewin-executor",
        "verified": True,
        "provider_id_namespace": execution["provider_id_namespace"],
        "provider_event_key": execution["provider_event_key"],
        "native_event_id": execution["provider_event_key"],
        "native_market_id": execution["provider_market_key"],
        "native_selection_id": execution["provider_selection_key"],
        "source_market": donor["source_market"],
        "odds": donor["odds"],
        "source_ts": REPLAY_NOW + 0.2,
        "currency": "USDT",
        "commission": 0.0,
        "max_stake": 8.45,
        "axes": copy.deepcopy(donor["market_axes"]),
        "live_submit_contract_verified": True,
        "live_submit_contract_source": "synthetic-review-fixture",
    }
    quote.update(overrides)
    return quote


def real_account(**overrides) -> dict:
    account = {
        "logged_in": True,
        "account_identity_verified": True,
        "account_identity_source": "synthetic-review-fixture",
        "currency": "USDT",
        "available_balance": 8.45,
        "observed_at": REPLAY_NOW + 0.2,
    }
    account.update(overrides)
    return account


LEGACY_AXES = {"period": "full_time", "scope": "REG", "unit": "goals", "market": "total", "line": 60.5, "side": "under"}


def legacy_task(stake: float = 1.0) -> dict:
    q = {"source": "1win", "source_event_key": "40021999", "source_market": "T< 60.5", "odds": 1.87,
         "source_ts": 1000, "axes": dict(LEGACY_AXES)}
    r = {**q, "source": "BIA", "source_event_key": "r", "odds": 1.80}
    return task_from_value(
        {"event_id": "canonical", "isLive": True, "first": {"bookmaker": "BIA", "matchId": "r"},
         "second": {"bookmaker": "1win", "matchId": "40021999"}},
        {"outcome": "T< 60.5", "score1": {"value": 1.80}, "score2": {"value": 1.87},
         "reference_quote": r, "donor_quote": q, "margin_quotes": [r]},
        stake=stake, idempotency_key="legacy-review", now=1001)


def legacy_quote(**overrides) -> dict:
    quote = {
        "identity_verified_by": "onewin-executor", "verified": True,
        "provider_id_namespace": "top-parser:1win", "provider_event_key": "40021999",
        "native_event_id": "40021999", "native_market_id": "6271", "native_selection_id": "10:193671744120169820:0",
        "source_market": "T< 60.5", "odds": 1.87, "source_ts": 1001, "currency": "USDT",
        "commission": 0.0, "max_stake": 8.45, "axes": dict(LEGACY_AXES),
        "live_submit_contract_verified": True, "live_submit_contract_source": "synthetic-review-fixture",
    }
    quote.update(overrides)
    return quote


def legacy_account(**overrides) -> dict:
    account = {"logged_in": True, "account_identity_verified": True,
               "account_identity_source": "synthetic-review-fixture", "currency": "USDT",
               "available_balance": 8.45, "observed_at": 1001}
    account.update(overrides)
    return account


class StrictContractMixin:
    """Assess and verify must be two views of the same decision."""

    def decision(self, task, quote, account, *, now, **kw):
        ready = assess_live_readiness(task, quote, account, now=now, **kw)
        try:
            verify_live_execution_conditions(task, quote, account, now=now, **kw)
            verified = True
        except CommonTaskError:
            verified = False
        return ready, verified

    def assertRejectedEverywhere(self, task, quote, account, *, now, blocker=None, **kw):
        ready, verified = self.decision(task, quote, account, now=now, **kw)
        self.assertFalse(verified, "verify_live_execution_conditions accepted a reviewed bypass")
        self.assertFalse(ready["execution_ready"], f"assess_live_readiness reported ready: {ready}")
        if blocker is not None:
            self.assertIn(blocker, ready["execution_blockers"])

    def assertAcceptedEverywhere(self, task, quote, account, *, now, **kw):
        ready, verified = self.decision(task, quote, account, now=now, **kw)
        self.assertTrue(verified, "positive control rejected by verify_live_execution_conditions")
        self.assertTrue(ready["execution_ready"], f"positive control blocked: {ready}")
        self.assertEqual(ready["execution_blockers"], [])


class ReviewedBypassesLegacyVocabulary(StrictContractMixin, unittest.TestCase):
    """Direct reproductions of review_task03_boundaries.py findings."""

    def test_positive_control(self):
        self.assertAcceptedEverywhere(legacy_task(), legacy_quote(), legacy_account(), now=1002)

    def test_missing_account_identity_proof_is_rejected(self):
        account = {"logged_in": True, "currency": "USDT", "available_balance": 10, "observed_at": 1001}
        self.assertRejectedEverywhere(legacy_task(), legacy_quote(), account, now=1001,
                                      blocker="account_identity_unverified")

    def test_bare_identity_flag_without_source_is_rejected(self):
        account = legacy_account()
        del account["account_identity_source"]
        self.assertRejectedEverywhere(legacy_task(), legacy_quote(), account, now=1002,
                                      blocker="account_identity_unverified")

    def test_missing_wire_contract_proof_is_rejected(self):
        quote = legacy_quote()
        del quote["live_submit_contract_verified"]
        self.assertRejectedEverywhere(legacy_task(), quote, legacy_account(), now=1002,
                                      blocker="unverified_live_submit_wire_contract")

    def test_bare_wire_contract_flag_without_source_is_rejected(self):
        quote = legacy_quote()
        del quote["live_submit_contract_source"]
        self.assertRejectedEverywhere(legacy_task(), quote, legacy_account(), now=1002,
                                      blocker="unverified_live_submit_wire_contract")

    def test_expired_executor_quote_is_not_ready(self):
        # source_ts=990 is 11 seconds old at now=1001; live TTL is 5 seconds.
        self.assertRejectedEverywhere(legacy_task(), legacy_quote(source_ts=990), legacy_account(), now=1001,
                                      blocker="executor_quote_expired")

    def test_future_executor_quote_is_not_ready(self):
        self.assertRejectedEverywhere(legacy_task(), legacy_quote(source_ts=1100), legacy_account(), now=1002,
                                      blocker="executor_quote_in_future")

    def test_executor_quote_without_clock_provenance_is_not_ready(self):
        quote = legacy_quote()
        del quote["source_ts"]
        self.assertRejectedEverywhere(legacy_task(), quote, legacy_account(), now=1002,
                                      blocker="executor_quote_clock_unproven")

    def test_stale_account_observation_is_not_ready(self):
        self.assertRejectedEverywhere(legacy_task(), legacy_quote(), legacy_account(observed_at=990), now=1002,
                                      blocker="account_state_expired")

    def test_missing_account_observation_is_not_ready(self):
        account = legacy_account()
        del account["observed_at"]
        self.assertRejectedEverywhere(legacy_task(), legacy_quote(), account, now=1002,
                                      blocker="account_state_clock_unproven")

    def test_wrong_provider_namespace(self):
        self.assertRejectedEverywhere(legacy_task(), legacy_quote(provider_id_namespace="aggregator:BIA"),
                                      legacy_account(), now=1002, blocker="executor_binding_mismatch")

    def test_wrong_source_event_key(self):
        self.assertRejectedEverywhere(legacy_task(), legacy_quote(provider_event_key="99999999"),
                                      legacy_account(), now=1002, blocker="executor_binding_mismatch")

    def test_wrong_source_market(self):
        self.assertRejectedEverywhere(legacy_task(), legacy_quote(source_market="T> 60.5"),
                                      legacy_account(), now=1002, blocker="executor_binding_mismatch")

    def test_incomplete_native_ids(self):
        for field in ("native_event_id", "native_market_id", "native_selection_id"):
            quote = legacy_quote()
            quote[field] = ""
            with self.subTest(field=field):
                self.assertRejectedEverywhere(legacy_task(), quote, legacy_account(), now=1002,
                                              blocker="native_identity_incomplete")
            quote[field] = None
            with self.subTest(field=field, value=None):
                self.assertRejectedEverywhere(legacy_task(), quote, legacy_account(), now=1002,
                                              blocker="native_identity_incomplete")

    def test_price_drift(self):
        self.assertRejectedEverywhere(legacy_task(), legacy_quote(odds=1.86), legacy_account(), now=1002,
                                      blocker="executor_binding_mismatch")

    def test_wrong_currency(self):
        self.assertRejectedEverywhere(legacy_task(), legacy_quote(currency="EUR"), legacy_account(), now=1002,
                                      blocker="executor_currency_mismatch")

    def test_account_currency_must_match_executor_currency(self):
        self.assertRejectedEverywhere(legacy_task(), legacy_quote(), legacy_account(currency="EUR"), now=1002,
                                      blocker="unsupported_account_currency")

    def test_unknown_commission_is_not_zero(self):
        self.assertRejectedEverywhere(legacy_task(), legacy_quote(commission=None), legacy_account(), now=1002,
                                      blocker="unverified_commission")

    def test_capacity_below_stake(self):
        self.assertRejectedEverywhere(legacy_task(stake=5.0), legacy_quote(max_stake=4.0),
                                      legacy_account(available_balance=50), now=1002,
                                      blocker="unverified_or_insufficient_capacity")

    def test_wallet_below_stake(self):
        self.assertRejectedEverywhere(legacy_task(stake=5.0), legacy_quote(max_stake=50),
                                      legacy_account(available_balance=4.0), now=1002,
                                      blocker="insufficient_or_unverified_wallet_balance")

    def test_expired_task(self):
        self.assertRejectedEverywhere(legacy_task(), legacy_quote(source_ts=1004), legacy_account(observed_at=1004),
                                      now=1006, blocker="task_expired_or_missing_expiry")

    def test_task_expiry_cannot_outlive_its_own_evidence(self):
        task = legacy_task()
        task["expires_at"] = 5000  # inflated: the donor clock is 1000, TTL 5s
        self.assertRejectedEverywhere(task, legacy_quote(source_ts=1099), legacy_account(observed_at=1099),
                                      now=1100, blocker="task_evidence_expired")

    def test_invalid_now_values_cannot_bypass(self):
        for now in (True, False, float("nan"), float("inf"), float("-inf"), 0, -5, "1002"):
            with self.subTest(now=repr(now)):
                task, quote, account = legacy_task(), legacy_quote(), legacy_account()
                with self.assertRaises(CommonTaskError):
                    verify_live_execution_conditions(task, quote, account, now=now)
                result = assess_live_readiness(task, quote, account, now=now)
                self.assertFalse(result["execution_ready"])
                self.assertIn("invalid_clock", result["execution_blockers"])

    def test_non_dict_inputs_never_raise_from_assess(self):
        for task, quote, account in ((None, {}, {}), ({}, None, {}), ({}, {}, None), ([], [], [])):
            result = assess_live_readiness(task, quote, account, now=1002)
            self.assertFalse(result["execution_ready"])

    def test_assess_and_verify_agree_over_single_field_mutations(self):
        base_task, base_quote, base_account = legacy_task(), legacy_quote(), legacy_account()
        mutations = [
            ("quote", "verified", False), ("quote", "verified", "yes"), ("quote", "identity_verified_by", "parser"),
            ("quote", "live_submit_contract_verified", "true"), ("quote", "commission", True),
            ("quote", "commission", float("nan")), ("quote", "commission", 1.0), ("quote", "max_stake", float("inf")),
            ("quote", "max_stake", True), ("quote", "odds", float("nan")), ("quote", "native_event_id", 7),
            ("account", "logged_in", "true"), ("account", "account_identity_verified", 1),
            ("account", "available_balance", True), ("account", "available_balance", float("nan")),
            ("account", "observed_at", True), ("account", "observed_at", float("nan")),
        ]
        for scope, field, value in mutations:
            task, quote, account = copy.deepcopy(base_task), copy.deepcopy(base_quote), copy.deepcopy(base_account)
            (quote if scope == "quote" else account)[field] = value
            with self.subTest(scope=scope, field=field, value=repr(value)):
                ready, verified = self.decision(task, quote, account, now=1002)
                self.assertFalse(verified)
                self.assertFalse(ready["execution_ready"])

    def test_diagnostic_budget_is_exactly_one_usdt_everywhere(self):
        self.assertRejectedEverywhere(legacy_task(stake=2.0), legacy_quote(), legacy_account(), now=1002,
                                      diagnostic_only=True, blocker="diagnostic_stake_must_be_1_usdt")
        self.assertAcceptedEverywhere(legacy_task(stake=1.0), legacy_quote(), legacy_account(), now=1002,
                                      diagnostic_only=True)

    def test_order_keeps_native_evidence_origin_for_audit(self):
        order = verify_live_execution_conditions(legacy_task(), legacy_quote(), legacy_account(), now=1002)
        evidence = order["evidence"]
        self.assertEqual(evidence["executor_quote"]["provider_id_namespace"], "top-parser:1win")
        self.assertEqual(evidence["executor_quote"]["native_selection_id"], "10:193671744120169820:0")
        self.assertEqual(evidence["account"]["account_identity_source"], "synthetic-review-fixture")
        self.assertEqual(evidence["live_submit_contract_source"], "synthetic-review-fixture")
        self.assertEqual(order["expires_at"], min(evidence["expiries"].values()))
        for name in ("task", "donor", "reference", "margins", "executor_quote", "account"):
            self.assertIn(name, evidence["expiries"])


class DryVerifierAxesBypass(unittest.TestCase):
    def test_empty_axes_on_both_sides_are_not_a_verified_market(self):
        task = legacy_task()
        task["axes"] = {}
        task["quote"] = {**task["quote"], "axes": {}}
        quote = legacy_quote(axes={})
        with self.assertRaises(CommonTaskError):
            verify_executor_quote(task, quote, now=1002)

    def test_missing_axes_everywhere_are_not_a_verified_market(self):
        task = legacy_task()
        task["axes"] = {}
        task["quote"] = {k: v for k, v in task["quote"].items() if k != "axes"}
        quote = {k: v for k, v in legacy_quote().items() if k != "axes"}
        with self.assertRaises(CommonTaskError):
            verify_executor_quote(task, quote, now=1002)


class RealPlatformInput(StrictContractMixin, unittest.TestCase):
    """The platform JSON as recorded -> value task -> executor verification."""

    def test_task_keeps_the_donor_canonical_axes_from_market_axes(self):
        task = real_task("P1 T< 1")
        self.assertEqual(task["axes"]["market_family"], "total")
        self.assertEqual(task["axes"]["period"], "h1")
        self.assertEqual(task["axes"]["unit"], "goals")
        self.assertEqual(task["axes"]["side"], "under")
        self.assertEqual(task["axes"]["line"], 1)

    def test_executor_verifier_accepts_published_canonical_axes(self):
        task = real_task("P1 T< 1")
        verified = verify_executor_quote(task, real_executor_quote(task), now=REPLAY_NOW + 1)
        self.assertTrue(verified["dry_run"])

    def test_diagnostic_arb_groups_do_not_break_comparison(self):
        # The reference carries nested arb_groups, the donor does not.  Both are
        # the same settlement fact; the nested diagnostics are not compared.
        task = real_task("P1 T< 1")
        quote = real_executor_quote(task)
        quote["axes"]["arb_groups"] = [{"id": "executor-local-diagnostic"}]
        quote["axes"]["key"] = "display key differs"
        self.assertTrue(verify_executor_quote(task, quote, now=REPLAY_NOW + 1)["dry_run"])

    def test_every_settlement_fact_change_is_rejected(self):
        task = real_task("P1 H1 -0.25")
        changes = {"period": "ft", "unit": "points", "side": "away", "line": 0.25, "target": "away",
                   "market_family": "total", "sport": "basketball"}
        for field, value in changes.items():
            quote = real_executor_quote(task)
            quote["axes"][field] = value
            with self.subTest(field=field):
                with self.assertRaises(CommonTaskError):
                    verify_executor_quote(task, quote, now=REPLAY_NOW + 1)

    def test_signed_handicap_line_cannot_flip_sign(self):
        task = real_task("P1 H1 -0.25")
        quote = real_executor_quote(task)
        quote["axes"]["line"] = 0.25
        with self.assertRaises(CommonTaskError):
            verify_executor_quote(task, quote, now=REPLAY_NOW + 1)

    def test_unknown_market_family_stays_diagnostic(self):
        # Recorded old-runtime frame: "FTS Away" had market_family=unknown.
        task = real_task("FTS Away")
        quote = real_executor_quote(task)
        with self.assertRaises(CommonTaskError):
            verify_executor_quote(task, quote, now=REPLAY_NOW + 1)
        self.assertFalse(assess_live_readiness(task, quote, real_account(), now=REPLAY_NOW + 1)["execution_ready"])

    def test_strict_engine_accepts_real_input_and_rejects_without_identity(self):
        task = real_task("P1 T< 1")
        self.assertAcceptedEverywhere(task, real_executor_quote(task), real_account(), now=REPLAY_NOW + 1)
        account = real_account()
        del account["account_identity_verified"]
        self.assertRejectedEverywhere(task, real_executor_quote(task), account, now=REPLAY_NOW + 1,
                                      blocker="account_identity_unverified")

    def test_original_axes_and_adapter_version_are_preserved_in_order(self):
        task = real_task("P1 H1 -0.25")
        order = verify_live_execution_conditions(task, real_executor_quote(task), real_account(),
                                                 now=REPLAY_NOW + 1)
        self.assertEqual(order["axes"], task["quote"]["market_axes"])
        self.assertEqual(order["axes_adapter_version"], "platform-canonical-axes-adapter.v1")
        self.assertEqual(order["settlement_facts"]["scope"], "regulation")
        self.assertEqual(order["settlement_facts"]["line"], -0.25)

    def test_dc_with_reference_handicap_equivalence_keeps_donor_identity(self):
        # In the recorded frame the BIA reference of "P1 DC X2" is the away +0.5
        # handicap while the 1win donor is double chance.  Executability follows
        # the donor leg only; reference axes are never compared with the donor.
        task = real_task("P1 DC X2")
        self.assertEqual(task["axes"]["market_family"], "double_chance")
        quote = real_executor_quote(task)
        self.assertTrue(verify_executor_quote(task, quote, now=REPLAY_NOW + 1)["dry_run"])

    def test_old_runtime_ft_draw_is_regulation_only_where_proven(self):
        task = real_task("X")
        order = verify_live_execution_conditions(task, real_executor_quote(task), real_account(),
                                                 now=REPLAY_NOW + 1)
        self.assertEqual(order["settlement_facts"]["scope"], "regulation")


if __name__ == "__main__":
    unittest.main()
