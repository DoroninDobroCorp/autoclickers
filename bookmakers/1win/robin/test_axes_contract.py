"""Contract tests for the platform-axes -> settlement-facts adapter.

The axes come from ``fixtures/platform_axes_f8d56d4.json``: the platform's own
Go serialisation of ``CanonicalOutcomeAxes`` (not hand-assembled).  Quotes use
the envelope of a recorded value frame with the axes substituted.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from onewin_automation.axes import (
    ADAPTER_VERSION,
    AxesContractError,
    compare_facts,
    normalise_axes,
)
from onewin_automation.common import (
    CommonTaskError,
    assess_live_readiness,
    instant,
    task_from_value,
    verify_executor_quote,
    verify_live_execution_conditions,
)

HERE = Path(__file__).resolve().parent
PLATFORM = json.loads((HERE / "fixtures" / "platform_axes_f8d56d4.json").read_text())
RECORDED = json.loads((HERE / "fixtures" / "recorded_value_outcomes.json").read_text())
NOW = instant(RECORDED["replay_now_iso"])


def axes_for(sport: str, key: str) -> dict:
    for row in PLATFORM["rows"]:
        if row["sport_name"] == sport and row["key"] == key:
            return copy.deepcopy(row["axes"])
    raise KeyError((sport, key))


def envelope_task(sport: str, key: str, *, stake: float = 1.0, live: bool = False) -> dict:
    """Recorded quote envelope (real clocks/proofs) carrying platform-serialised axes."""
    case = copy.deepcopy(next(c for c in RECORDED["cases"] if c["name"] == "P1 T< 1"))
    pair, outcome = case["pair"], case["outcome"]
    pair["sportName"], pair["isLive"] = sport, live
    axes = axes_for(sport, key)
    for quote in (outcome["donor_quote"], outcome["reference_quote"]):
        quote["market_axes"] = copy.deepcopy(axes)
        quote["source_market"] = key
    for margin in outcome["margin_quotes"]:
        margin["source_market"] = key
    outcome["outcome"] = key
    return task_from_value(pair, outcome, stake=stake, idempotency_key=f"axes-{sport}-{key}", now=NOW)


# Natural 1win text of the same bets (group name, selection, points, outcome code, provable).  Names
# and labels follow real native captures; ``provable`` says whether the closed-world native deriver
# may prove the settlement facts (False: scope/unit/sport not proven by native data -> must block).
NATIVE_TEXT = {
    ("Soccer", "T> 2.5"): (18, "Total", "Over 2.5", 2.5, "over", True),
    ("Soccer", "P1 T> 0.5"): (18, "1st half. Total", "Over 0.5", 0.5, "over", True),
    ("Hockey", "REG 1"): (35, "Full time result", "{home}", None, "1", True),
    ("Hockey", "REG X"): (35, "Full time result", "Draw", None, "x", True),
    ("Hockey", "DNB 1"): (35, "Draw no bet", "{home}", None, "1", False),
    ("Hockey", "DC 1x"): (35, "Double chance", "{home} Or Draw", None, "1x", True),
    ("Hockey", "ML 1"): (35, "Match winner", "{home}", None, "1", False),
    ("Hockey", "P1 T> 1.5"): (35, "1st period. Total", "Over 1.5", 1.5, "over", True),
    ("Basketball", "ML 1"): (23, "Winner (incl. OT)", "{home}", None, "1", True),
    ("Basketball", "T> 220.5"): (23, "Total (incl. OT)", "Over 220.5", 220.5, "over", True),
    ("Basketball", "1H T> 110.5"): (23, "1st half. Total", "Over 110.5", 110.5, "over", True),
    ("Basketball", "P1 T> 50.5"): (23, "1st quarter. Total", "Over 50.5", 50.5, "over", True),
    ("Tennis", "ML 1"): (33, "Winner", "{home}", None, "1", True),
    ("Tennis", "Sets T> 2.5"): (33, "Total sets", "Over 2.5", 2.5, "over", False),
    ("Tennis", "T> 22.5"): (33, "Total games", "Over 22.5", 22.5, "over", False),
    ("Tennis", "P1 ML 1"): (33, "1st set. Winner", "{home}", None, "1", False),
    ("Tennis", "P1 T> 9.5"): (33, "1st set. Total games", "Over 9.5", 9.5, "over", False),
    ("Volleyball", "ML 1"): (27, "Winner", "{home}", None, "1", False),
    ("Volleyball", "Sets T> 3.5"): (27, "Total sets", "Over 3.5", 3.5, "over", False),
    ("Volleyball", "T> 180.5"): (27, "Total points", "Over 180.5", 180.5, "over", False),
    ("Volleyball", "P1 T> 46.5"): (27, "1st set. Total points", "Over 46.5", 46.5, "over", False),
    ("Handball", "1H T> 28.5"): (34, "1st half. Total", "Over 28.5", 28.5, "over", True),
}
HOME, AWAY = "Home FC", "Away FC"


def native_market(sport: str, key: str) -> dict:
    sport_id, group, selection, points, code, _ = NATIVE_TEXT[(sport, key)]
    return {"sport_id": sport_id, "group_name": group.format(home=HOME, away=AWAY),
            "selection_name": selection.format(home=HOME, away=AWAY), "points": points,
            "home_name": HOME, "away_name": AWAY, "outcome_code": code}


def executor_quote(task: dict, **over) -> dict:
    donor, execution = task["quote"], task["quote"]["execution"]
    quote = {
        "identity_verified_by": "onewin-executor", "verified": True,
        "provider_id_namespace": execution["provider_id_namespace"],
        "provider_event_key": execution["provider_event_key"],
        "native_event_id": execution["provider_event_key"],
        "native_market_id": execution["provider_market_key"],
        "native_selection_id": execution["provider_selection_key"],
        "source_market": donor["source_market"], "odds": donor["odds"], "source_ts": NOW + 0.2,
        "currency": "USDT", "commission": 0.0, "max_stake": 8.45,
        "axes": copy.deepcopy(donor["market_axes"]),
        "live_submit_contract_verified": True, "live_submit_contract_source": "synthetic-contract-fixture",
    }
    sport = {"football": "Soccer", "ice_hockey": "Hockey", "basketball": "Basketball", "tennis": "Tennis",
             "volleyball": "Volleyball", "handball": "Handball"}[donor["market_axes"]["sport"]]
    if (sport, donor["source_market"]) in NATIVE_TEXT:
        quote["native_market"] = native_market(sport, donor["source_market"])
    quote.update(over)
    return quote


def account(**over) -> dict:
    value = {"logged_in": True, "account_identity_verified": True, "account_identity_source": "synthetic-contract-fixture",
             "currency": "USDT", "available_balance": 8.45, "observed_at": NOW + 0.2}
    value.update(over)
    return value


EXPECTED_SCOPE = {
    ("Soccer", "T> 2.5"): ("ft", "regulation"),
    ("Soccer", "P1 T> 0.5"): ("h1", "regulation"),
    ("Hockey", "REG 1"): ("ft", "regulation"),
    ("Hockey", "REG X"): ("ft", "regulation"),
    ("Hockey", "DNB 1"): ("ft", "regulation"),
    ("Hockey", "DC 1x"): ("ft", "regulation"),
    ("Hockey", "ML 1"): ("ft", "incl_overtime_penalties"),
    ("Hockey", "P1 T> 1.5"): ("p1", "regulation"),
    ("Basketball", "ML 1"): ("ft", "incl_overtime"),
    ("Basketball", "T> 220.5"): ("ft", "incl_overtime"),
    ("Basketball", "1H T> 110.5"): ("h1", "regulation"),
    ("Basketball", "P1 T> 50.5"): ("q1", "regulation"),
    ("Tennis", "ML 1"): ("match", "match"),
    ("Tennis", "Sets T> 2.5"): ("match", "match"),
    ("Tennis", "T> 22.5"): ("match", "match"),
    ("Tennis", "P1 ML 1"): ("set1", "set"),
    ("Tennis", "P1 T> 9.5"): ("set1", "set"),
    ("Volleyball", "ML 1"): ("match", "match"),
    ("Volleyball", "Sets T> 3.5"): ("match", "match"),
    ("Volleyball", "T> 180.5"): ("match", "match"),
    ("Volleyball", "P1 T> 46.5"): ("set1", "set"),
    ("Handball", "1H T> 28.5"): ("h1", "regulation"),
}


class AdapterOnPlatformJson(unittest.TestCase):
    def test_every_registered_row_normalises_with_a_proven_scope(self):
        for (sport, key), (period, scope) in EXPECTED_SCOPE.items():
            with self.subTest(sport=sport, key=key):
                result = normalise_axes(axes_for(sport, key))
                self.assertEqual(result["adapter_version"], ADAPTER_VERSION)
                self.assertEqual(result["schema"], "platform-canonical.v1")
                self.assertEqual((result["facts"]["period"], result["facts"]["scope"]), (period, scope))
                self.assertEqual(result["original"], axes_for(sport, key))  # untouched original

    def test_units_are_taken_from_the_platform_never_replaced(self):
        self.assertEqual(normalise_axes(axes_for("Tennis", "ML 1"))["facts"]["unit"], "sets")
        self.assertEqual(normalise_axes(axes_for("Tennis", "T> 22.5"))["facts"]["unit"], "games")
        self.assertEqual(normalise_axes(axes_for("Volleyball", "Sets H1 -1.5"))["facts"]["unit"], "sets")
        self.assertEqual(normalise_axes(axes_for("Volleyball", "H1 -1.5"))["facts"]["unit"], "points")

    def test_unregistered_seed_rows_stay_diagnostic(self):
        for sport, key in (("Hockey", "T> 5.5"), ("Hockey", "H1 -1.5"), ("Handball", "T> 60.5"), ("Handball", "1")):
            with self.subTest(sport=sport, key=key):
                with self.assertRaises(AxesContractError) as ctx:
                    normalise_axes(axes_for(sport, key))
                self.assertEqual(ctx.exception.code, "axes_incomplete:sportref_market_type")

    def test_scope_is_never_defaulted_from_ft(self):
        # A foreign executor that labels a hockey total as plain "ft" cannot be
        # assumed regulation: the platform emits ft_ot_pen for it.
        axes = axes_for("Hockey", "REG 1")
        axes.update(market_family="total", side="over", line=5.5, sportref_market_type="ice_hockey.total.goals.ft.match")
        with self.assertRaises(AxesContractError) as ctx:
            normalise_axes(axes)
        self.assertEqual(ctx.exception.code, "axes_scope_unproven")
        basket = axes_for("Basketball", "T> 220.5")
        basket["period"] = "ft"
        with self.assertRaises(AxesContractError):
            normalise_axes(basket)

    def test_hockey_regulation_and_overtime_are_different_settlement_facts(self):
        regulation = normalise_axes(axes_for("Hockey", "DNB 1"))
        overtime = copy.deepcopy(regulation)
        overtime["facts"]["scope"] = "incl_overtime_penalties"
        self.assertIn("scope", compare_facts(regulation, overtime))
        self.assertEqual(compare_facts(regulation, regulation), [])

    def test_tennis_sets_games_and_period_never_compare_equal(self):
        sets_total = normalise_axes(axes_for("Tennis", "Sets T> 2.5"))
        games_total = normalise_axes(axes_for("Tennis", "T> 22.5"))
        set1_total = normalise_axes(axes_for("Tennis", "P1 T> 9.5"))
        self.assertIn("unit", compare_facts(sets_total, games_total))
        self.assertIn("period", compare_facts(games_total, set1_total))

    def test_volleyball_sets_and_points_never_compare_equal(self):
        sets = normalise_axes(axes_for("Volleyball", "Sets H1 -1.5"))
        points = normalise_axes(axes_for("Volleyball", "H1 -1.5"))
        self.assertIn("unit", compare_facts(sets, points))

    def test_comparison_ignores_diagnostics_only(self):
        left = normalise_axes(axes_for("Soccer", "T> 2.5"))
        noisy = axes_for("Soccer", "T> 2.5")
        noisy["key"] = "display variant"
        noisy["arb_groups"] = [{"id": "x", "unit": "corners"}]
        noisy["unknown_diagnostic"] = {"nested": [1, 2, 3]}
        self.assertEqual(compare_facts(left, normalise_axes(noisy)), [])
        changed = axes_for("Soccer", "T> 2.5")
        changed["line"] = 3.5
        self.assertEqual(compare_facts(left, normalise_axes(changed)), ["line"])

    def test_line_contradictions_and_missing_lines_are_rejected(self):
        total = axes_for("Soccer", "T> 2.5")
        del total["line"]
        with self.assertRaises(AxesContractError):
            normalise_axes(total)
        result = axes_for("Soccer", "1")
        result["line"] = 0.5
        with self.assertRaises(AxesContractError):
            normalise_axes(result)
        for bad in (True, float("nan"), float("inf"), "2.5"):
            axes = axes_for("Soccer", "T> 2.5")
            axes["line"] = bad
            with self.subTest(line=repr(bad)):
                with self.assertRaises(AxesContractError):
                    normalise_axes(axes)

    def test_unknown_or_guessed_values_are_rejected(self):
        for field, value in (("unit", "match_base_unit"), ("unit", "unverified"), ("market_family", "unknown"),
                             ("period", ""), ("side", "unknown"), ("target", "undisclosed")):
            axes = axes_for("Soccer", "T> 2.5")
            axes[field] = value
            with self.subTest(field=field, value=value):
                with self.assertRaises(AxesContractError):
                    normalise_axes(axes)

    def test_draw_payout_unknown_stays_unknown(self):
        facts = normalise_axes(axes_for("Handball", "1H T> 28.5"),
                               contexts=({"draw_payout": "undisclosed", "payout_status": "unverified_draw_rule"},))
        self.assertEqual(facts["facts"]["payout_rule"]["status"], "unverified")
        proven = normalise_axes(axes_for("Soccer", "1"), contexts=({"result_variant": "three_way"},))
        self.assertEqual(proven["facts"]["payout_rule"]["status"], "proven")
        with self.assertRaises(AxesContractError):
            normalise_axes(axes_for("Soccer", "1"), contexts=({"result_variant": "three_way"}, {"result_variant": "two_way"}))


class EndToEndOnPlatformJson(unittest.TestCase):
    def test_proven_rows_pass_and_unproven_native_semantics_block(self):
        proven = unproven = 0
        for (sport, key) in EXPECTED_SCOPE:
            task = envelope_task(sport, key)
            self.assertEqual(task["axes_contract"]["status"], "complete")
            self.assertEqual(task["axes"], axes_for(sport, key))
            provable = NATIVE_TEXT[(sport, key)][5]
            with self.subTest(sport=sport, key=key, provable=provable):
                if provable:
                    proven += 1
                    self.assertTrue(verify_executor_quote(task, executor_quote(task), now=NOW + 1)["dry_run"])
                    order = verify_live_execution_conditions(task, executor_quote(task), account(), now=NOW + 1)
                    self.assertEqual(order["settlement_facts"]["scope"], EXPECTED_SCOPE[(sport, key)][1])
                    self.assertEqual(order["axes"], axes_for(sport, key))
                    self.assertEqual(order["evidence"]["native_deriver_version"], "onewin-native-axes.v1")
                    self.assertEqual(order["evidence"]["native_settlement_facts"]["scope"],
                                     EXPECTED_SCOPE[(sport, key)][1])
                else:
                    unproven += 1
                    verdict = assess_live_readiness(task, executor_quote(task), account(), now=NOW + 1)
                    self.assertFalse(verdict["execution_ready"])
                    self.assertIn("executor_native_semantics_unproven", verdict["execution_blockers"])
                    with self.assertRaises(CommonTaskError):
                        verify_executor_quote(task, executor_quote(task), now=NOW + 1)
        # every sport is represented; volleyball is entirely unproven (no native capture exists)
        self.assertGreater(proven, 10)
        self.assertGreater(unproven, 5)

    def test_missing_native_evidence_blocks_platform_vocabulary(self):
        task = envelope_task("Soccer", "T> 2.5")
        quote = executor_quote(task)
        del quote["native_market"]
        verdict = assess_live_readiness(task, quote, account(), now=NOW + 1)
        self.assertIn("executor_native_evidence_missing", verdict["execution_blockers"])
        with self.assertRaises(CommonTaskError):
            verify_executor_quote(task, quote, now=NOW + 1)

    def test_echoing_parser_axes_with_other_native_market_is_refused(self):
        task = envelope_task("Soccer", "T> 2.5")
        quote = executor_quote(task, native_market={**native_market("Soccer", "T> 2.5"), "group_name": "1st half. Total"})
        verdict = assess_live_readiness(task, quote, account(), now=NOW + 1)
        self.assertFalse(verdict["execution_ready"])
        self.assertIn("native_axes_mismatch", verdict["execution_blockers"])
        with self.assertRaises(CommonTaskError) as refusal:
            verify_executor_quote(task, quote, now=NOW + 1)
        self.assertIn("period", str(refusal.exception))

    def test_executor_axes_that_contradict_its_own_native_text_are_refused(self):
        task = envelope_task("Soccer", "T> 2.5")
        quote = executor_quote(task)
        quote["axes"] = {**quote["axes"], "line": 3.5}
        quote["native_market"] = {**quote["native_market"], "selection_name": "Over 3.5", "points": 3.5}
        verdict = assess_live_readiness(task, quote, account(), now=NOW + 1)
        self.assertIn("native_axes_mismatch", verdict["execution_blockers"])
        # executor axes and native text agree with each other but not with the task
        self.assertIn("axes_mismatch", verdict["execution_blockers"])

    def test_native_sign_of_a_handicap_cannot_be_flipped(self):
        task = envelope_task("Soccer", "H1 -1.5")
        native = {"sport_id": 18, "group_name": "Handicap", "selection_name": f"{HOME} 1.5", "points": 1.5,
                  "home_name": HOME, "away_name": AWAY, "outcome_code": "1"}
        verdict = assess_live_readiness(task, executor_quote(task, native_market=native), account(), now=NOW + 1)
        self.assertIn("native_axes_mismatch", verdict["execution_blockers"])
        good = {**native, "selection_name": f"{HOME} -1.5", "points": -1.5}
        self.assertTrue(assess_live_readiness(task, executor_quote(task, native_market=good), account(),
                                              now=NOW + 1)["execution_ready"])

    def test_each_settlement_fact_change_gives_the_exact_refusal(self):
        task = envelope_task("Tennis", "P1 T> 9.5")
        mutations = {"unit": "sets", "period": "match", "line": 10.5, "side": "under", "target": "home",
                     "market_family": "handicap", "sport": "volleyball"}
        for field, value in mutations.items():
            quote = executor_quote(task)
            quote["axes"][field] = value
            with self.subTest(field=field):
                verdict = assess_live_readiness(task, quote, account(), now=NOW + 1)
                self.assertFalse(verdict["execution_ready"])
                self.assertTrue({"axes_mismatch", "missing_or_unverified_axes"} & set(verdict["execution_blockers"]),
                                verdict)
                with self.assertRaises(CommonTaskError) as refusal:
                    verify_live_execution_conditions(task, quote, account(), now=NOW + 1)
                # the refusal names the exact settlement fact that changed
                if field in {"unit", "period", "line", "side", "target", "market_family", "sport"}:
                    self.assertIn(field, str(refusal.exception), str(refusal.exception))

    def test_incomplete_market_is_diagnostic_and_never_dry_verified(self):
        task = envelope_task("Hockey", "T> 5.5")
        self.assertEqual(task["axes_contract"]["status"], "incomplete")
        self.assertIn("axes_incomplete:sportref_market_type", task["execution_blockers"])
        self.assertFalse(task["execution_ready"])
        with self.assertRaises(CommonTaskError):
            verify_executor_quote(task, executor_quote(task), now=NOW + 1)
        self.assertFalse(assess_live_readiness(task, executor_quote(task), account(), now=NOW + 1)["execution_ready"])

    def test_executor_cannot_repair_a_task_with_incomplete_axes(self):
        task = envelope_task("Hockey", "T> 5.5")
        repaired = executor_quote(task, axes={**axes_for("Hockey", "T> 5.5"), "sportref_market_type": "ice_hockey.total.goals.ft.match"})
        with self.assertRaises(CommonTaskError):
            verify_executor_quote(task, repaired, now=NOW + 1)

    def test_unverified_draw_rule_blocks_execution_without_disabling_the_family(self):
        task = envelope_task("Handball", "1H T> 28.5")
        task["quote"]["draw_payout"] = "undisclosed"
        task["quote"]["payout_status"] = "unverified_draw_rule"
        verdict = assess_live_readiness(task, executor_quote(task), account(), now=NOW + 1)
        self.assertIn("payout_rule_unverified", verdict["execution_blockers"])
        clean = envelope_task("Handball", "1H T> 28.5")
        self.assertTrue(assess_live_readiness(clean, executor_quote(clean), account(), now=NOW + 1)["execution_ready"])


if __name__ == "__main__":
    unittest.main()
