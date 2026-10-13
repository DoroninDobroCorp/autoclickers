"""Tests for the independent native 1win axes derivation (``native_axes``).

Inputs are real native 1win values (``raw.oddsGroups`` of saved captures), copied
verbatim into ``fixtures/native_axes_evidence_cases.json`` together with their
capture file, JSON path and the sha256 prefix of the capture.  Expected axes are
checked against the platform's own output:

* ``platform`` links inside the fixture: the real platform outcome of the same
  snapshot whose settlement axes equal the derived ones;
* ``fixtures/platform_axes_f8d56d4.json``: axes serialised by the platform's Go
  ``ParseCanonicalOutcomeAxes``;
* ``onewin_automation.axes.normalise_axes``/``compare_facts``: the adapter must
  produce the same settlement facts for a native-derived object as for the
  platform object (a placeholder registry id is attached to both sides because
  the adapter still requires one; it is never compared).

Negative tests use real captured values too (file and JSON path in comments);
the few that need a market that was never captured say so explicitly.
"""
from __future__ import annotations

import ast
import copy
import json
import math
import re
import sys
import unittest
from pathlib import Path

from onewin_automation.axes import compare_facts, normalise_axes
from onewin_automation.native_axes import (
    NATIVE_DERIVER_VERSION,
    NativeAxesUnknown,
    derive_native_axes,
    facts_from_native_evidence,
)

HERE = Path(__file__).resolve().parent
CORPUS = json.loads((HERE / "fixtures" / "native_axes_evidence_cases.json").read_text())
CASES = CORPUS["cases"]
PLATFORM_ROWS = json.loads((HERE / "fixtures" / "platform_axes_f8d56d4.json").read_text())["rows"]

AXIS_FIELDS = ("sport", "market_family", "period", "target", "unit", "side", "line")
LINE_FAMILIES = {"total", "team_total", "handicap"}
REGISTRY_PLACEHOLDER = "test-registry-placeholder"  # the adapter requires one; never compared


def with_registry(axes: dict) -> dict:
    return {**axes, "sportref_market_type": REGISTRY_PLACEHOLDER}


def comparable(axes: dict) -> dict:
    return {k: axes[k] for k in AXIS_FIELDS if axes.get(k) is not None}


def group_template(native: dict) -> str:
    text = re.sub(r"\s+", " ", native["group_name"]).strip()
    for name in (native["home_name"], native["away_name"]):
        if name and name in text:
            text = text.replace(name, "{team}")
            break
    return text.lower()


def real(sport_id: int, group: str, selection: str) -> dict:
    """The captured native values of one selection (exact group and selection name)."""
    for case in CASES:
        native = case["native"]
        if (native["sport_id"], native["group_name"], native["selection_name"]) == (sport_id, group, selection):
            return copy.deepcopy(native)
    raise KeyError((sport_id, group, selection))


def derive(native: dict, **override):
    values = {**native, **override}
    return derive_native_axes(
        sport_id=values["sport_id"], group_name=values["group_name"], selection_name=values["selection_name"],
        points=values["points"], home_name=values["home_name"], away_name=values["away_name"],
        outcome_code=values["outcome_code"],
    )


# Closed vocabulary: every (sport, group template) proven by the real captures.
PROVEN_GROUPS = {
    18: {
        "1st half. double chance", "1st half. handicap", "1st half. result", "1st half. total",
        "1st half. total. even/odd", "1st half. {team} total", "2nd half. handicap", "2nd half. odd/even",
        "2nd half. result", "2nd half. total", "both teams to score", "corners. 1st half. handicap",
        "corners. 1st half. total", "corners. 1st half. {team} total", "corners. handicap", "corners. total",
        "corners. {team} total", "double chance", "draw no bet", "full time result", "handicap", "odd/even",
        "total", "{team} total",
    },
    23: {
        "1st half. handicap", "1st half. odd/even", "1st half. result", "1st half. total",
        "1st half. {team} total", "1st quarter. handicap", "1st quarter. odd/even", "1st quarter. result",
        "1st quarter. total", "1st quarter. {team} total", "2nd quarter. result", "2nd quarter. total",
        "2nd quarter. {team} total", "3rd quarter. total", "3rd quarter. {team} total", "handicap (incl. ot)",
        "odd/even (incl. ot)", "result (reg. time)", "total (incl. ot)", "winner (incl. ot)",
        "{team} total (incl. ot)",
    },
    33: {"winner"},
    34: {"1st half. asian handicap", "1st half. total", "handicap", "result", "total", "{team} total"},
    35: {
        "1st period. both teams to score", "1st period. double chance", "1st period. handicap",
        "1st period. result", "1st period. total", "1st period. {team} total",
        "2nd period. both teams to score", "2nd period. double chance", "2nd period. handicap",
        "2nd period. result", "2nd period. total", "2nd period. {team} total",
        "3rd period. both teams to score", "3rd period. double chance", "3rd period. handicap",
        "3rd period. result", "3rd period. total", "3rd period. {team} total", "double chance",
        "full time result",
    },
}


class RealNativeSelections(unittest.TestCase):
    def test_every_captured_selection_derives_exactly_the_expected_axes(self):
        self.assertGreaterEqual(len(CASES), 200)
        for case in CASES:
            with self.subTest(case=case["id"], evidence=case["evidence"]):
                self.assertTrue(case["evidence"]["file"] and case["evidence"]["path"])
                self.assertIn(case["evidence"]["file"], CORPUS["provenance"]["evidence_sha256_12"])
                self.assertEqual(derive(case["native"]), case["expected"])

    def test_corpus_covers_exactly_the_closed_vocabulary(self):
        seen: dict[int, set[str]] = {}
        for case in CASES:
            seen.setdefault(case["native"]["sport_id"], set()).add(group_template(case["native"]))
        self.assertEqual(seen, PROVEN_GROUPS)

    def test_corpus_has_both_sides_signs_and_zero_lines(self):
        handicaps = [c for c in CASES if c["expected"]["market_family"] == "handicap"]
        self.assertTrue({c["expected"]["side"] for c in handicaps} == {"home", "away"})
        lines = {c["expected"]["line"] for c in handicaps}
        self.assertTrue(any(v < 0 for v in lines) and any(v > 0 for v in lines) and 0.0 in lines)
        team_targets = {c["expected"]["target"] for c in CASES if c["expected"]["market_family"] == "team_total"}
        self.assertEqual(team_targets, {"home", "away"})

    def test_output_is_the_platform_settlement_vocabulary_only(self):
        for case in CASES:
            with self.subTest(case=case["id"]):
                axes = derive(case["native"])
                self.assertLessEqual(set(axes), set(AXIS_FIELDS))
                self.assertEqual("line" in axes, axes["market_family"] in LINE_FAMILIES)
                for forbidden in ("sportref_market_type", "key", "arb_groups", "scope", "market"):
                    self.assertNotIn(forbidden, axes)

    def test_group_names_are_matched_after_whitespace_and_case_normalisation(self):
        # Real: group "Full time result " (trailing space) of live-value-calculator-01.json.
        base = real(18, "Full time result ", "USM Khenchela")
        expected = derive(base)
        self.assertEqual(derive(base, group_name="  FULL   time RESULT"), expected)
        self.assertEqual(derive(base, group_name="Full time result"), expected)

    def test_derivation_does_not_depend_on_selection_name_case_or_spacing(self):
        total = real(23, "Total (incl. OT)", "Over 175.5")
        self.assertEqual(derive(total, selection_name="  over   175.5 "), derive(total))


class PlatformParity(unittest.TestCase):
    def test_real_platform_outcomes_carry_the_same_settlement_axes(self):
        linked = [c for c in CASES if c["platform"]]
        self.assertGreaterEqual(len(linked), 50)
        for case in linked:
            with self.subTest(case=case["id"], platform_key=case["platform"]["key"]):
                self.assertEqual(comparable(derive(case["native"])), comparable(case["platform"]["axes"]))

    def test_adapter_yields_identical_facts_for_native_and_platform_objects(self):
        for case in (c for c in CASES if c["platform"]):
            with self.subTest(case=case["id"], platform_key=case["platform"]["key"]):
                native = normalise_axes(with_registry(derive(case["native"])))
                platform = normalise_axes(with_registry(case["platform"]["axes"]))
                self.assertEqual(compare_facts(platform, native), [])
                self.assertEqual(native["facts"], platform["facts"])

    def test_every_captured_selection_is_accepted_by_the_adapter(self):
        for case in CASES:
            with self.subTest(case=case["id"]):
                facts = normalise_axes(with_registry(derive(case["native"])))["facts"]
                self.assertEqual(facts["unit"], case["expected"]["unit"])
                self.assertEqual(facts["side"], case["expected"]["side"])
                self.assertEqual(facts["target"], case["expected"]["target"])

    # (native axes selector) -> row of the Go-serialised platform fixture.  The
    # fixture row's line is replaced by the captured native line.
    FIXTURE_PARITY = [
        (("football", "total", "ft", "over", "match", "goals"), ("Soccer", "T> 2.5")),
        (("football", "total", "ft", "under", "match", "goals"), ("Soccer", "T< 2.5")),
        (("football", "handicap", "ft", "home", "match", "goals"), ("Soccer", "H1 -1.5")),
        (("football", "handicap", "ft", "away", "match", "goals"), ("Soccer", "H2 0.25")),
        (("football", "team_total", "ft", "over", "home", "goals"), ("Soccer", "IT1> 1.5")),
        (("football", "result", "ft", "home", "match", "goals"), ("Soccer", "1")),
        (("football", "result", "ft", "draw", "match", "goals"), ("Soccer", "X")),
        (("football", "double_chance", "ft", "1x", "match", "goals"), ("Soccer", "DC 1x")),
        (("football", "btts", "ft", "yes", "match", "goals"), ("Soccer", "BTTS Yes")),
        (("football", "total", "h1", "over", "match", "goals"), ("Soccer", "P1 T> 0.5")),
        (("ice_hockey", "result", "ft", "home", "match", "goals"), ("Hockey", "REG 1")),
        (("ice_hockey", "result", "ft", "draw", "match", "goals"), ("Hockey", "REG X")),
        (("ice_hockey", "result", "ft", "away", "match", "goals"), ("Hockey", "REG 2")),
        (("ice_hockey", "double_chance", "ft", "1x", "match", "goals"), ("Hockey", "DC 1x")),
        (("ice_hockey", "total", "p1", "over", "match", "goals"), ("Hockey", "P1 T> 1.5")),
        (("basketball", "moneyline", "ft_ot", "home", "match", "points"), ("Basketball", "ML 1")),
        (("basketball", "total", "ft_ot", "over", "match", "points"), ("Basketball", "T> 220.5")),
        (("basketball", "handicap", "ft_ot", "home", "match", "points"), ("Basketball", "H1 -5.5")),
        (("basketball", "total", "h1", "over", "match", "points"), ("Basketball", "1H T> 110.5")),
        (("basketball", "total", "q1", "over", "match", "points"), ("Basketball", "P1 T> 50.5")),
        (("tennis", "moneyline", "match", "home", "match", "sets"), ("Tennis", "ML 1")),
        (("tennis", "moneyline", "match", "away", "match", "sets"), ("Tennis", "ML 2")),
        (("handball", "result", "ft", "home", "match", "goals"), ("Handball", "1")),
        (("handball", "result", "ft", "draw", "match", "goals"), ("Handball", "X")),
        (("handball", "total", "ft", "over", "match", "goals"), ("Handball", "T> 60.5")),
        (("handball", "handicap", "ft", "home", "match", "goals"), ("Handball", "H1 -2.5")),
        (("handball", "total", "h1", "over", "match", "goals"), ("Handball", "1H T> 28.5")),
    ]

    def test_go_serialised_platform_rows_equal_native_derivations(self):
        by_row = {(r["sport_name"], r["key"]): r["axes"] for r in PLATFORM_ROWS}
        for selector, row_key in self.FIXTURE_PARITY:
            sport, family, period, side, target, unit = selector
            matching = [
                c for c in CASES
                if tuple(c["expected"].get(k) for k in ("sport", "market_family", "period", "side", "target", "unit"))
                == selector
            ]
            with self.subTest(selector=selector, platform_row=row_key):
                self.assertTrue(matching, "no captured native selection for this platform row")
                fixture_axes = by_row[row_key]
                for case in matching:
                    wanted = {k: v for k, v in fixture_axes.items()
                              if k not in ("arb_groups", "key", "sportref_market_type")}
                    if "line" in wanted:
                        wanted["line"] = case["expected"]["line"]  # the fixture row's own line is a sample
                    self.assertEqual(derive(case["native"]), wanted)


class SettlementScope(unittest.TestCase):
    """Scope is whatever the adapter derives from the produced period token."""

    def scope(self, native: dict):
        facts = normalise_axes(with_registry(derive(native)))["facts"]
        return facts["period"], facts["scope"]

    def test_football_ft_and_halves_are_regulation(self):
        self.assertEqual(self.scope(real(18, "Full time result ", "USM Khenchela")), ("ft", "regulation"))
        self.assertEqual(self.scope(real(18, "1st half. Result", "USM Khenchela")), ("h1", "regulation"))
        self.assertEqual(self.scope(real(18, "2nd half. Total", "Over 0.5")), ("h2", "regulation"))

    def test_basketball_overtime_follows_the_incl_ot_label_only(self):
        self.assertEqual(self.scope(real(23, "Total (incl. OT)", "Over 175.5")), ("ft", "incl_overtime"))
        self.assertEqual(self.scope(real(23, "Winner (incl. OT)", "Manresa")), ("ft", "incl_overtime"))
        self.assertEqual(self.scope(real(23, "Result (reg. time)", "Draw")), ("ft", "regulation"))
        self.assertEqual(self.scope(real(23, "1st quarter. Total", "Over 43.5")), ("q1", "regulation"))
        self.assertEqual(self.scope(real(23, "1st half. Total", "Over 86.5")), ("h1", "regulation"))

    def test_hockey_regulation_only_where_the_draw_or_the_period_proves_it(self):
        self.assertEqual(self.scope(real(35, "Full time result", "Draw")), ("ft", "regulation"))
        self.assertEqual(self.scope(real(35, "Double chance", "San Jose Sharks Or Draw")), ("ft", "regulation"))
        self.assertEqual(self.scope(real(35, "1st period. Total", "Over 2.0")), ("p1", "regulation"))
        self.assertEqual(self.scope(real(35, "3rd period. Result", "Draw")), ("p3", "regulation"))

    def test_tennis_match_winner_is_a_match_fact_in_sets(self):
        self.assertEqual(self.scope(real(33, "Winner", "Sofiia Suslova")), ("match", "match"))
        self.assertEqual(derive(real(33, "Winner", "Sofiia Suslova"))["unit"], "sets")

    def test_corners_have_their_own_unit_and_the_football_scope(self):
        native = real(18, "Corners. 1st half. Total", "Over 4.5")
        self.assertEqual(derive(native)["unit"], "corners")
        self.assertEqual(self.scope(native), ("h1", "regulation"))


class RefusedMarkets(unittest.TestCase):
    """(expected code, capture file, JSON path, sport id, group, selection, points, home, away, outcome)."""

    REAL_REFUSALS = [
        # --- hockey markets without a regulation/overtime label: scope not proven ---
        ("scope_unproven", "live-final-four-sports-calculator.json", "last_frame/input_snapshot/0/leg_a/raw/oddsGroups/9/oddsList/0",
         35, "Total", "Over 4.0", 4.0, "San Jose Sharks", "Boston Bruins", "over"),
        ("scope_unproven", "live-final-four-sports-calculator.json", "last_frame/input_snapshot/0/leg_a/raw/oddsGroups/13/oddsList/0",
         35, "Handicap", "Boston Bruins -2", -2.0, "San Jose Sharks", "Boston Bruins", "2"),
        ("scope_unproven", "live-final-four-sports-calculator.json", "last_frame/input_snapshot/0/leg_a/raw/oddsGroups/19/oddsList/0",
         35, "Match winner", "San Jose Sharks", None, "San Jose Sharks", "Boston Bruins", "1"),
        ("scope_unproven", "live-final-four-sports-calculator.json", "last_frame/input_snapshot/0/leg_a/raw/oddsGroups/22/oddsList/0",
         35, "Boston Bruins total", "Over 2.0", 2.0, "San Jose Sharks", "Boston Bruins", "over"),
        ("scope_unproven", "live-final-four-sports-calculator.json", "last_frame/input_snapshot/0/leg_a/raw/oddsGroups/5/oddsList/0",
         35, "Both teams to score", "Yes", None, "San Jose Sharks", "Boston Bruins", "yes"),
        # --- "Early payout" variants settle differently from the base market ---
        ("early_payout_variant", "live-final-calculator.json", "last_frame/input_snapshot/4/leg_a/raw/oddsGroups/83/oddsList/0",
         18, "Full time result (Early payout 1:0) ", "Draw", None, "Sabah Baku FK", "SK Slavia Praha", "x"),
        ("early_payout_variant", "live-final-calculator.json", "last_frame/input_snapshot/0/leg_a/raw/oddsGroups/23/oddsList/0",
         23, "Winner (incl. OT) (Early payout 18:0)", "Manresa", None, "Bahcesehir Koleji", "Manresa", "2"),
        ("early_payout_variant", "live-final-four-sports-calculator.json", "last_frame/input_snapshot/0/leg_a/raw/oddsGroups/21/oddsList/0",
         35, "Full time result (Early payout 3:0)", "Draw", None, "San Jose Sharks", "Boston Bruins", "x"),
        # --- combined markets ---
        ("combo_market", "live-final-calculator.json", "last_frame/input_snapshot/4/leg_a/raw/oddsGroups/41/oddsList/0",
         18, "Result and total", "Draw And Over 2.5", 2.5, "Sabah Baku FK", "SK Slavia Praha", None),
        ("combo_market", "live-final-calculator.json", "last_frame/input_snapshot/4/leg_a/raw/oddsGroups/20/oddsList/0",
         18, "Total and both teams to score", "Under 2.5 And No", 2.5, "Sabah Baku FK", "SK Slavia Praha", None),
        ("combo_market", "live-final-calculator.json", "last_frame/input_snapshot/4/leg_a/raw/oddsGroups/33/oddsList/0",
         18, "Result and both teams to score", "SK Slavia Praha And Both To Score", None, "Sabah Baku FK", "SK Slavia Praha", None),
        ("combo_market", "live-final-calculator.json", "last_frame/input_snapshot/4/leg_a/raw/oddsGroups/55/oddsList/0",
         18, "1st half. Result and both teams to score", "Both Teams Not To Score and Draw", None, "Sabah Baku FK", "SK Slavia Praha", None),
        # --- player markets ---
        ("player_market", "live-final-calculator.json", "last_frame/input_snapshot/4/leg_a/raw/oddsGroups/26/oddsList/0",
         18, "Player to score ", "Erivaldo Almeida", None, "Sabah Baku FK", "SK Slavia Praha", None),
        ("player_market", "live-final-calculator.json", "last_frame/input_snapshot/7/leg_a/raw/oddsGroups/28/oddsList/0",
         18, "Next player to score", "Akor Adams 4", 4.0, "Atalanta", "Venezia", None),
        ("player_market", "live-final-calculator.json", "last_frame/input_snapshot/4/leg_a/raw/oddsGroups/38/oddsList/0",
         18, "1st player to score", "Younes Lachaab", None, "Sabah Baku FK", "SK Slavia Praha", None),
        ("player_market", "live-final-calculator.json", "last_frame/input_snapshot/4/leg_a/raw/oddsGroups/65/oddsList/0",
         18, "Player. Total shots over", "Ophre Mbina 6 Or More", 6.0, "Sabah Baku FK", "SK Slavia Praha", None),
        # --- statistics whose platform unit is not proven for the native label ---
        ("unit_unproven", "live-final-calculator.json", "last_frame/input_snapshot/4/leg_a/raw/oddsGroups/23/oddsList/0",
         18, "Yellow cards. Total", "Over 3.5", 3.5, "Sabah Baku FK", "SK Slavia Praha", "over"),
        ("unit_unproven", "live-final-calculator.json", "last_frame/input_snapshot/4/leg_a/raw/oddsGroups/73/oddsList/0",
         18, "Yellow cards. SK Slavia Praha total", "Under 1.5", 1.5, "Sabah Baku FK", "SK Slavia Praha", "under"),
        ("unit_unproven", "acceptance-value-calculator.json", "last_frame/input_snapshot/0/leg_a/raw/oddsGroups/43/oddsList/0",
         18, "Shots on target. Total", "Under 8.5", 8.5, "Coventry City", "Newcastle United", "under"),
        ("unit_unproven", "acceptance-value-calculator.json", "last_frame/input_snapshot/0/leg_a/raw/oddsGroups/58/oddsList/0",
         18, "Fouls. Total", "Under 22.5", 22.5, "Coventry City", "Newcastle United", "under"),
        ("unit_unproven", "acceptance-value-calculator.json", "last_frame/input_snapshot/0/leg_a/raw/oddsGroups/59/oddsList/0",
         18, "Offsides. Handicap", "Coventry City 0.0", 0.0, "Coventry City", "Newcastle United", "1"),
        # --- groups outside the proven vocabulary ---
        ("group_unknown", "live-final-calculator.json", "last_frame/input_snapshot/4/leg_a/raw/oddsGroups/24/oddsList/0",
         18, "Corners. Result", "Draw", None, "Sabah Baku FK", "SK Slavia Praha", "x"),
        ("group_unknown", "acceptance-value-calculator.json", "last_frame/input_snapshot/8/leg_a/raw/oddsGroups/24/oddsList/0",
         18, "Corners. Odd/Even", "Odd", None, "IF Elfsborg", "Halmstads BK", "odd"),
        ("group_unknown", "live-final-calculator.json", "last_frame/input_snapshot/8/leg_a/raw/oddsGroups/19/oddsList/0",
         18, "To qualify", "SG Sonnenhof Grossaspach", None, "SG Sonnenhof Grossaspach", "Augsburg", "1"),
        ("group_unknown", "live-final-calculator.json", "last_frame/input_snapshot/4/leg_a/raw/oddsGroups/15/oddsList/0",
         18, "Correct score", "0:1", 0.0, "Sabah Baku FK", "SK Slavia Praha", None),
        ("group_unknown", "live-final-calculator.json", "last_frame/input_snapshot/4/leg_a/raw/oddsGroups/7/oddsList/0",
         18, "Exact number of goals", "1", 1.0, "Sabah Baku FK", "SK Slavia Praha", "1"),
        ("group_unknown", "live-final-calculator.json", "last_frame/input_snapshot/4/leg_a/raw/oddsGroups/1/oddsList/0",
         18, "Halftime/Fulltime", "Sabah Baku FK / Draw", None, "Sabah Baku FK", "SK Slavia Praha", None),
        ("group_unknown", "live-final-calculator.json", "last_frame/input_snapshot/4/leg_a/raw/oddsGroups/62/oddsList/0",
         18, "To win to nil", "SK Slavia Praha", None, "Sabah Baku FK", "SK Slavia Praha", "2"),
        ("group_unknown", "live-final-calculator.json", "last_frame/input_snapshot/4/leg_a/raw/oddsGroups/81/oddsList/0",
         18, "Sabah Baku FK total goals. Even/Odd", "Odd", None, "Sabah Baku FK", "SK Slavia Praha", "odd"),
        ("group_unknown", "live-final-calculator.json", "last_frame/input_snapshot/0/leg_a/raw/oddsGroups/20/oddsList/0",
         23, "Manresa. Odd/Even (incl. OT)", "Even", None, "Bahcesehir Koleji", "Manresa", "even"),
        ("group_unknown", "live-final-calculator.json", "last_frame/input_snapshot/0/leg_a/raw/oddsGroups/10/oddsList/0",
         23, "Highest scoring quarter", "4th Quarter", None, "Bahcesehir Koleji", "Manresa", None),
        ("group_unknown", "live-final-calculator.json", "last_frame/input_snapshot/0/leg_a/raw/oddsGroups/19/oddsList/0",
         23, "Will the game go to overtime?", "Yes", None, "Bahcesehir Koleji", "Manresa", "yes"),
        ("group_unknown", "live-final-calculator.json", "last_frame/input_snapshot/0/leg_a/raw/oddsGroups/14/oddsList/0",
         23, "Winning margins (incl. OT)", "Bahcesehir Koleji 10-13", 10.0, "Bahcesehir Koleji", "Manresa", None),
    ]

    def test_real_refusals_carry_the_specific_code(self):
        for code, file, path, sid, group, selection, points, home, away, outcome in self.REAL_REFUSALS:
            with self.subTest(code=code, group=group, evidence=f"{file}:{path}"):
                with self.assertRaises(NativeAxesUnknown) as ctx:
                    derive_native_axes(sport_id=sid, group_name=group, selection_name=selection, points=points,
                                       home_name=home, away_name=away, outcome_code=outcome)
                self.assertEqual(ctx.exception.code, code)

    def test_scope_is_unproven_before_any_name_is_needed(self):
        with self.assertRaises(NativeAxesUnknown) as ctx:
            derive_native_axes(sport_id=35, group_name="Total", selection_name="Over 4.0", points=4.0)
        self.assertEqual(ctx.exception.code, "scope_unproven")

    def test_unmarked_full_game_basketball_total_is_scope_unproven(self):
        # Synthetic: basketball captures only ever label the full game "(incl. OT)".
        with self.assertRaises(NativeAxesUnknown) as ctx:
            derive_native_axes(sport_id=23, group_name="Total", selection_name="Over 175.5", points=175.5)
        self.assertEqual(ctx.exception.code, "scope_unproven")

    def test_period_that_was_never_captured_is_refused_not_extrapolated(self):
        total = real(23, "Total (incl. OT)", "Over 175.5")
        for group in ("4th quarter. Total", "2nd half. Total", "Total (incl. OT) 1st half"):
            with self.subTest(group=group):
                with self.assertRaises(NativeAxesUnknown) as ctx:
                    derive(total, group_name=group)
                self.assertEqual(ctx.exception.code, "group_unknown")

    def test_volleyball_has_no_native_capture(self):
        # Real catalogue event (runtime-acceptance-live.json parser_snapshot, 1win id 41151996,
        # competition key sport:27:...): no volleyball odds group was ever captured.
        for group, selection, points in (("Total", "Over 180.5", 180.5), ("Winner", "Developres SkyRes Rzeszow (w)", None),
                                         ("Set 1. Total", "Over 46.5", 46.5)):
            with self.subTest(group=group):
                with self.assertRaises(NativeAxesUnknown) as ctx:
                    derive_native_axes(sport_id=27, group_name=group, selection_name=selection, points=points,
                                       home_name="Developres SkyRes Rzeszow (w)", away_name="MKS Sokol Mogilno (w)")
                self.assertEqual(ctx.exception.code, "sport_unproven")

    def test_tennis_markets_other_than_the_captured_winner_are_unknown(self):
        winner = real(33, "Winner", "Suzuna Oigawa")
        for group in ("Total games", "Handicap", "Set 1. Winner", "Sets. Total"):
            with self.subTest(group=group):
                with self.assertRaises(NativeAxesUnknown) as ctx:
                    derive(winner, group_name=group)
                self.assertEqual(ctx.exception.code, "group_unknown")

    def test_unsupported_sport_ids(self):
        winner = real(33, "Winner", "Suzuna Oigawa")
        for sport_id in (99, 0, -18, 18.0, True, None, "abc", "18x", [18]):
            with self.subTest(sport_id=sport_id):
                with self.assertRaises(NativeAxesUnknown) as ctx:
                    derive(winner, sport_id=sport_id)
                self.assertEqual(ctx.exception.code, "sport_unknown")

    def test_digit_string_sport_id_is_the_same_sport(self):
        winner = real(33, "Winner", "Suzuna Oigawa")
        self.assertEqual(derive(winner, sport_id="33"), derive(winner))


class LinesSidesAndNames(unittest.TestCase):
    def codes(self, native: dict, **override) -> str:
        with self.assertRaises(NativeAxesUnknown) as ctx:
            derive(native, **override)
        return ctx.exception.code

    def test_handicap_line_sign_must_match_the_selection(self):
        # Real: "Bahcesehir Koleji -11.5" (points -11.5) of live-final-calculator.json oddsGroups/…/Handicap (incl. OT).
        native = real(23, "Handicap (incl. OT)", "Bahcesehir Koleji -11.5")
        self.assertEqual(derive(native), {"sport": "basketball", "market_family": "handicap", "period": "ft_ot",
                                          "target": "match", "unit": "points", "side": "home", "line": -11.5})
        self.assertEqual(self.codes(native, points=11.5), "points_conflict")
        self.assertEqual(self.codes(native, points=-10.5), "points_conflict")

    def test_handicap_line_keeps_the_sign_for_the_named_team(self):
        home = derive(real(23, "Handicap (incl. OT)", "Bahcesehir Koleji -11.5"))
        away = derive(real(23, "Handicap (incl. OT)", "Manresa 15.5"))
        self.assertEqual((home["side"], home["line"]), ("home", -11.5))
        self.assertEqual((away["side"], away["line"]), ("away", 15.5))

    def test_total_line_must_match_the_selection(self):
        native = real(23, "Total (incl. OT)", "Over 175.5")
        self.assertEqual(self.codes(native, points=176.5), "points_conflict")
        self.assertEqual(self.codes(native, points=None), "points_missing")
        self.assertEqual(self.codes(native, points=-175.5), "points_invalid")

    def test_total_side_is_taken_from_the_selection_and_checked_against_the_code(self):
        native = real(23, "Total (incl. OT)", "Over 175.5")
        self.assertEqual(derive(native)["side"], "over")
        self.assertEqual(self.codes(native, outcome_code="under"), "outcome_conflict")
        self.assertEqual(self.codes(native, selection_name="Exactly 175.5"), "selection_unknown")

    def test_points_must_be_a_finite_non_bool_number(self):
        native = real(23, "Total (incl. OT)", "Over 175.5")
        for bad in (True, False, float("nan"), float("inf"), -float("inf"), "175.5", [175.5]):
            with self.subTest(points=bad):
                self.assertEqual(self.codes(native, points=bad), "points_invalid")

    def test_line_must_sit_on_the_quarter_grid(self):
        native = real(23, "Total (incl. OT)", "Over 175.5")
        self.assertEqual(self.codes(native, selection_name="Over 175.3", points=175.3), "points_invalid")
        self.assertEqual(derive(native, selection_name="Over 175.25", points=175.25)["line"], 175.25)

    def test_markets_without_a_line_reject_a_stray_line(self):
        native = real(18, "Full time result ", "USM Khenchela")
        self.assertEqual(self.codes(native, points=2.5), "points_unexpected")
        self.assertNotIn("line", derive(native))

    def test_handicap_without_points_is_refused(self):
        native = real(18, "Handicap", "USM Khenchela -1.5")
        self.assertEqual(self.codes(native, points=None), "points_missing")

    def test_zero_line_handicap_is_a_real_line(self):
        # Real zero handicaps: "1st half. Handicap" / "USM Khenchela 0" (live-value-calculator-01.json).
        axes = derive(real(18, "1st half. Handicap", "USM Khenchela 0"))
        self.assertEqual((axes["side"], axes["line"], axes["period"]), ("home", 0.0, "h1"))

    def test_team_with_digits_in_its_name_is_not_mistaken_for_a_line(self):
        native = real(18, "Handicap", "USM Khenchela -1.5")
        axes = derive(native, selection_name="Hertha 03 -1.5", home_name="Hertha 03", away_name="CS Constantine",
                      outcome_code="1")
        self.assertEqual((axes["side"], axes["line"]), ("home", -1.5))

    def test_identical_participant_names_are_ambiguous(self):
        native = real(18, "Full time result ", "USM Khenchela")
        self.assertEqual(self.codes(native, away_name=native["home_name"]), "side_ambiguous")
        handicap = real(18, "Handicap", "USM Khenchela -1.5")
        self.assertEqual(self.codes(handicap, away_name=handicap["home_name"]), "side_ambiguous")

    def test_missing_participant_names_are_ambiguous(self):
        native = real(18, "Full time result ", "USM Khenchela")
        for override in ({"home_name": None}, {"away_name": None}, {"home_name": "", "away_name": ""}):
            with self.subTest(override=override):
                self.assertEqual(self.codes(native, **override), "side_ambiguous")

    def test_no_fuzzy_matching_of_team_names(self):
        native = real(18, "Handicap", "USM Khenchela -1.5")
        for home in ("USM Khenchela II", "U.S.M. Khenchela", "USM Khenchela FC", "USM Khenchel", "USM  Khencheia"):
            with self.subTest(home=home):
                self.assertEqual(self.codes(native, home_name=home), "side_ambiguous")

    def test_exact_match_ignores_only_case_and_spacing(self):
        native = real(18, "Handicap", "USM Khenchela -1.5")
        self.assertEqual(derive(native, home_name="  usm   KHENCHELA ")["side"], "home")

    def test_outcome_code_cannot_contradict_the_named_team(self):
        native = real(18, "Handicap", "USM Khenchela -1.5")
        self.assertEqual(self.codes(native, outcome_code="2"), "side_ambiguous")
        result = real(18, "Full time result ", "USM Khenchela")
        self.assertEqual(self.codes(result, outcome_code="x"), "side_ambiguous")

    def test_swapped_participants_flip_the_side(self):
        native = real(18, "Handicap", "USM Khenchela -1.5")
        swapped = derive(native, home_name=native["away_name"], away_name=native["home_name"], outcome_code=None)
        self.assertEqual(swapped["side"], "away")

    def test_team_total_group_team_must_be_one_of_the_participants(self):
        native = real(18, "Sabah Baku FK total", "Over 2.5")
        self.assertEqual(derive(native)["target"], "home")
        self.assertEqual(self.codes(native, group_name="Some Other Club total"), "side_ambiguous")
        self.assertEqual(self.codes(native, home_name=None), "side_ambiguous")

    def test_two_way_markets_have_no_draw(self):
        native = real(23, "Winner (incl. OT)", "Manresa")
        self.assertEqual(self.codes(native, selection_name="Draw", outcome_code="x"), "selection_unknown")

    def test_a_participant_literally_named_draw_is_ambiguous(self):
        native = real(18, "Full time result ", "Draw")
        self.assertEqual(self.codes(native, home_name="Draw"), "side_ambiguous")

    def test_double_chance_is_matched_exactly_against_both_names(self):
        native = real(18, "Double Chance ", "USM Khenchela Or Draw")
        self.assertEqual(derive(native)["side"], "1x")
        self.assertEqual(self.codes(native, selection_name="USM Khenchela Or CS Constantine", outcome_code="1x"),
                         "side_ambiguous")
        self.assertEqual(self.codes(native, home_name="USM Khenchela II"), "side_ambiguous")

    def test_yes_no_and_odd_even_are_checked_against_their_codes(self):
        btts = real(18, "Both teams to score", "Yes")
        self.assertEqual(derive(btts)["side"], "yes")
        self.assertEqual(self.codes(btts, outcome_code="no"), "outcome_conflict")
        self.assertEqual(self.codes(btts, selection_name="Maybe", outcome_code=None), "selection_unknown")
        odd = real(18, "Odd/Even", "Odd")
        self.assertEqual(derive(odd)["market_family"], "odd_even")
        self.assertEqual(self.codes(odd, outcome_code="even"), "outcome_conflict")

    def test_blank_or_non_string_names_are_input_errors(self):
        native = real(18, "Handicap", "USM Khenchela -1.5")
        for override in ({"group_name": ""}, {"group_name": None}, {"selection_name": "  "}, {"selection_name": 5},
                         {"home_name": 5}, {"outcome_code": 1}):
            with self.subTest(override=override):
                self.assertEqual(self.codes(native, **override), "input_invalid")


class EvidenceWrapper(unittest.TestCase):
    NATIVE = {"sport_id": 23, "group_name": "Total (incl. OT)", "selection_name": "Over 175.5", "points": 175.5,
              "home_name": "Bahcesehir Koleji", "away_name": "Manresa", "outcome_code": "over"}

    def test_wrapper_returns_the_derivation(self):
        self.assertEqual(facts_from_native_evidence(dict(self.NATIVE)), derive_native_axes(**self.NATIVE))
        self.assertEqual(facts_from_native_evidence(dict(self.NATIVE))["line"], 175.5)

    def test_optional_members_may_be_absent(self):
        minimal = {k: self.NATIVE[k] for k in ("sport_id", "group_name", "selection_name", "points")}
        self.assertEqual(facts_from_native_evidence(minimal)["side"], "over")

    def test_wrapper_validates_types_before_deriving(self):
        bad_values = {
            "sport_id": (True, 18.0, None, [18], {"x": 1}),
            "group_name": (None, 5, b"Total"),
            "selection_name": (None, 5),
            "points": (True, float("nan"), float("inf"), "175.5", [175.5]),
            "home_name": (5, True),
            "away_name": (5, ["Manresa"]),
            "outcome_code": (1, True),
        }
        for member, values in bad_values.items():
            for value in values:
                with self.subTest(member=member, value=repr(value)):
                    evidence = dict(self.NATIVE)
                    evidence[member] = value
                    with self.assertRaises(NativeAxesUnknown) as ctx:
                        facts_from_native_evidence(evidence)
                    self.assertEqual(ctx.exception.code, "input_invalid")

    def test_wrapper_rejects_unknown_or_missing_members_and_non_objects(self):
        for evidence in ([], "x", None, {**self.NATIVE, "extra": 1},
                         {k: v for k, v in self.NATIVE.items() if k != "group_name"},
                         {k: v for k, v in self.NATIVE.items() if k != "sport_id"}):
            with self.subTest(evidence=repr(evidence)[:60]):
                with self.assertRaises(NativeAxesUnknown) as ctx:
                    facts_from_native_evidence(evidence)
                self.assertEqual(ctx.exception.code, "input_invalid")

    def test_wrapper_passes_derivation_refusals_through(self):
        evidence = {**self.NATIVE, "group_name": "Result and total", "selection_name": "Draw And Over 2.5",
                    "sport_id": 18, "outcome_code": None}
        with self.assertRaises(NativeAxesUnknown) as ctx:
            facts_from_native_evidence(evidence)
        self.assertEqual(ctx.exception.code, "combo_market")


class ModuleContract(unittest.TestCase):
    def test_version_constant(self):
        self.assertEqual(NATIVE_DERIVER_VERSION, "onewin-native-axes.v1")

    def test_unknown_is_a_value_error_with_a_code(self):
        error = NativeAxesUnknown("group_unknown", "detail")
        self.assertIsInstance(error, ValueError)
        self.assertEqual(error.code, "group_unknown")

    def test_module_is_pure_standard_library(self):
        source = (HERE / "onewin_automation" / "native_axes.py").read_text()
        modules = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                modules.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                self.assertEqual(node.level, 0, "no relative imports: the module is independent")
                modules.add((node.module or "").split(".")[0])
        self.assertTrue(modules)
        stdlib = set(getattr(sys, "stdlib_module_names", ())) or {"math", "re", "typing", "unicodedata"}
        self.assertLessEqual(modules, stdlib | {"__future__"})
        for forbidden in ("rapidfuzz", "sportsbook", "identity", "onewin_automation"):
            self.assertNotIn(forbidden, modules)

    def test_derivation_is_deterministic_and_does_not_mutate_its_inputs(self):
        native = real(18, "Handicap", "USM Khenchela -1.5")
        before = copy.deepcopy(native)
        first, second = derive(native), derive(native)
        self.assertEqual(first, second)
        self.assertEqual(native, before)
        first["side"] = "away"  # a returned object is the caller's own
        self.assertEqual(derive(native)["side"], "home")


if __name__ == "__main__":
    unittest.main()
