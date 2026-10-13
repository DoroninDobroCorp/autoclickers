"""Shared test helpers: native 1win evidence for the recorded value cases.

Names and group labels follow real native captures (see
``fixtures/native_axes_evidence_cases.json``); participant names are the 1win-side
names of the recorded pair.
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
RECORDED = json.loads((HERE / "fixtures" / "recorded_value_outcomes.json").read_text())

# outcome key of the recorded frame -> (group name, selection template, points, native outcome code)
RECORDED_NATIVE = {
    "P1 T< 1": ("1st half. Total", "Under 1.0", 1.0, "under"),
    "P1 T> 1": ("1st half. Total", "Over 1.0", 1.0, "over"),
    "P1 H1 -0.25": ("1st half. Handicap", "{home} -0.25", -0.25, "1"),
    "P1 IT2> 0.5": ("1st half. {away} total", "Over 0.5", 0.5, "over"),
    "P1 X": ("1st half. Result", "Draw", None, "x"),
    "P1 DC X2": ("1st half. Double chance", "Draw Or {away}", None, "x2"),
    "X": ("Full time result", "Draw", None, "x"),
}


def recorded_native_market(outcome_key: str) -> dict | None:
    row = RECORDED_NATIVE.get(outcome_key)
    if row is None:
        return None
    case = next(c for c in RECORDED["cases"] if c["name"] == outcome_key)
    second = case["pair"]["second"]
    home, away = second["homeName"], second["awayName"]
    group, selection, points, code = row
    return {"sport_id": 18, "group_name": group.format(home=home, away=away),
            "selection_name": selection.format(home=home, away=away), "points": points,
            "home_name": home, "away_name": away, "outcome_code": code}
