#!/usr/bin/env python3
"""Extract real native 1win selections from saved captures into a test fixture.

Usage: build_native_axes_cases.py EVIDENCE_DIR OUT_JSON FILE [FILE ...]

Each FILE is a saved JSON capture (platform value frames / calculator frames /
runtime snapshots) holding native ``raw.oddsGroups`` of a 1win event.  For every
selection that ``derive_native_axes`` accepts, one representative per
(sport, group template, outcome code, line sign) is kept together with:

* the exact native values (copied, never re-typed) and their file/JSON path;
* the expected axes, computed by an *independent* oracle below that looks only
  at the outcome code and the group name (not at ``native_axes``);
* when the same snapshot holds a platform outcome with identical settlement
  axes, that outcome's key, path and axes (real platform output).

The script needs the Mac-side evidence and is documentation of provenance; the
tests only read the JSON it writes.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from onewin_automation.native_axes import NativeAxesUnknown, derive_native_axes  # noqa: E402

SPORT = {18: "football", 23: "basketball", 33: "tennis", 34: "handball", 35: "ice_hockey"}
FIELDS = ("sport", "market_family", "period", "target", "unit", "side", "line")


def sport_id(key: str | None) -> int | None:
    m = re.match(r"sport:(\d+):", key or "")
    return int(m.group(1)) if m else None


def template(value: str, home: str | None, away: str | None) -> str:
    out = re.sub(r"\s+", " ", value).strip()
    for name, token in ((home, "{HOME}"), (away, "{AWAY}")):
        if name and name in out:
            out = out.replace(name, token)
    return out


# -- independent oracle ----------------------------------------------------
# (sport id, group name with the team replaced by {team}, lower-cased) -> (family, period, unit)
ORACLE: dict[tuple[int, str], tuple[str, str, str]] = {}


def _o(sport: int, name: str, family: str, period: str, unit: str) -> None:
    ORACLE[(sport, name.lower())] = (family, period, unit)


for _n, _f in (("Full time result", "result"), ("Double chance", "double_chance"), ("Draw no bet", "dnb"),
               ("Both teams to score", "btts"), ("Total", "total"), ("Handicap", "handicap"),
               ("{team} total", "team_total"), ("Odd/Even", "odd_even")):
    _o(18, _n, _f, "ft", "goals")
for _lbl, _p in (("1st half", "h1"), ("2nd half", "h2")):
    for _n, _f in (("Result", "result"), ("Double chance", "double_chance"), ("Total", "total"),
                   ("Handicap", "handicap"), ("{team} total", "team_total"), ("Odd/Even", "odd_even"),
                   ("Total. Even/Odd", "odd_even")):
        _o(18, f"{_lbl}. {_n}", _f, _p, "goals")
        _o(18, f"Corners. {_lbl}. {_n}", _f, _p, "corners")
for _n, _f in (("Total", "total"), ("Handicap", "handicap"), ("{team} total", "team_total")):
    _o(18, f"Corners. {_n}", _f, "ft", "corners")
for _n, _f in (("Result", "result"), ("Total", "total"), ("Handicap", "handicap"), ("{team} total", "team_total")):
    _o(34, _n, _f, "ft", "goals")
    _o(34, f"1st half. {_n}", _f, "h1", "goals")
_o(34, "1st half. Asian handicap", "handicap", "h1", "goals")
_o(23, "Winner (incl. OT)", "moneyline", "ft_ot", "points")
_o(23, "Result (reg. time)", "result", "ft_reg", "points")
for _n, _f in (("Total (incl. OT)", "total"), ("Handicap (incl. OT)", "handicap"),
               ("{team} total (incl. OT)", "team_total"), ("Odd/Even (incl. OT)", "odd_even")):
    _o(23, _n, _f, "ft_ot", "points")
for _lbl, _p in (("1st half", "h1"), ("1st quarter", "q1"), ("2nd quarter", "q2"), ("3rd quarter", "q3")):
    for _n, _f in (("Result", "result"), ("Total", "total"), ("Handicap", "handicap"),
                   ("{team} total", "team_total"), ("Odd/Even", "odd_even")):
        _o(23, f"{_lbl}. {_n}", _f, _p, "points")
_o(35, "Full time result", "result", "ft", "goals")
_o(35, "Double chance", "double_chance", "ft", "goals")
for _lbl, _p in (("1st period", "p1"), ("2nd period", "p2"), ("3rd period", "p3")):
    for _n, _f in (("Result", "result"), ("Total", "total"), ("Handicap", "handicap"), ("{team} total", "team_total"),
                   ("Double chance", "double_chance"), ("Both teams to score", "btts")):
        _o(35, f"{_lbl}. {_n}", _f, _p, "goals")
_o(33, "Winner", "moneyline", "match", "sets")

SIDE_BY_CODE = {"1": "home", "x": "draw", "2": "away"}


def oracle(sid: int, group: str, selection: str, points, home: str, away: str, code: str) -> dict:
    name = re.sub(r"\s+", " ", group).strip()
    team_target = None
    for who, team in (("home", home), ("away", away)):
        if team and team in name:
            name = name.replace(team, "{team}")
            team_target = who
            break
    family, period, unit = ORACLE[(sid, name.lower())]
    axes = {"sport": SPORT[sid], "market_family": family, "period": period, "target": "match", "unit": unit}
    if family == "team_total":
        axes["target"] = team_target
    if family in ("total", "team_total"):
        axes["side"], axes["line"] = code, float(points)
    elif family == "handicap":
        axes["side"], axes["line"] = SIDE_BY_CODE[code], float(points)
    else:
        axes["side"] = SIDE_BY_CODE.get(code, code)
    return axes


def axes_key(axes: dict) -> tuple:
    return tuple((k, float(axes[k]) if k == "line" and axes.get(k) is not None else axes.get(k)) for k in FIELDS)


def main() -> None:
    evidence, out, *files = sys.argv[1:]
    cases: dict[tuple, dict] = {}
    digests: dict[str, str] = {}
    for name in files:
        raw_bytes = (Path(evidence) / name).read_bytes()
        digests[name] = hashlib.sha256(raw_bytes).hexdigest()[:12]
        data = json.loads(raw_bytes)
        seen_events: set = set()

        def handle(path, raw, leg, outcomes):
            sid = sport_id(leg.get("source_competition_key"))
            home = leg.get("home", leg.get("homeName"))
            away = leg.get("away", leg.get("awayName"))
            platform = {}
            for index, outcome in enumerate(outcomes or []):
                ax = outcome.get("axes") or {}
                if ax.get("market_family") not in (None, "unknown"):
                    platform.setdefault(axes_key(ax), (outcome.get("key"), index, ax))
            for gi, group in enumerate(raw["oddsGroups"]):
                for oi, odd in enumerate(group.get("oddsList", [])):
                    v1 = (odd.get("vars") or {}).get("v1")
                    try:
                        points = float(v1) if v1 is not None else None
                    except ValueError:
                        continue  # e.g. "30:00" of time-based markets: never a canonical line
                    native = {"sport_id": sid, "group_name": group.get("name"), "selection_name": odd.get("name"),
                              "points": points, "home_name": home, "away_name": away, "outcome_code": odd.get("outcome")}
                    try:
                        derived = derive_native_axes(**native)
                    except NativeAxesUnknown:
                        continue
                    expected = oracle(sid, native["group_name"], native["selection_name"], points, home, away,
                                      native["outcome_code"])
                    sign = None if points is None else ("neg" if points < 0 else "zero" if points == 0 else "pos")
                    key = (sid, template(native["group_name"], home, away), native["outcome_code"], sign)
                    linked = platform.get(axes_key(expected))
                    if key in cases and (cases[key]["platform"] is not None or linked is None):
                        continue
                    cases[key] = {
                        "evidence": {"file": name, "path": "/".join(map(str, path + ["oddsGroups", gi, "oddsList", oi]))},
                        "native": native,
                        "expected": expected,
                        "derived_equals_expected": derived == expected,
                        "platform": None if linked is None else {
                            "key": linked[0], "path": f"{'/'.join(map(str, path[:-2]))}/outcomes/{linked[1]}",
                            "sportref_market_type": linked[2].get("sportref_market_type"),
                            "axes": {k: linked[2].get(k) for k in FIELDS if linked[2].get(k) is not None},
                        },
                    }

        def walk(o, path, parent):
            if isinstance(o, dict):
                if "leg_a" in o and "outcomes" in o and isinstance(o["leg_a"], dict) \
                        and isinstance(o["leg_a"].get("raw"), dict) and "oddsGroups" in o["leg_a"]["raw"] \
                        and o["leg_a"].get("bookmaker") == "1win":
                    leg = o["leg_a"]
                    token = leg.get("source_event_key")
                    if token not in seen_events:
                        seen_events.add(token)
                        handle(path + ["leg_a", "raw"], leg["raw"], leg, o["outcomes"])
                    return
                if "oddsGroups" in o and parent is not None:
                    handle(path, o, parent, None)
                    return
                for k, v in o.items():
                    walk(v, path + [k], o)
            elif isinstance(o, list):
                for i, v in enumerate(o):
                    walk(v, path + [i], parent)

        walk(data, [], None)
        print("scanned", name, len(cases), flush=True)
    rows = []
    for index, key in enumerate(sorted(cases, key=lambda k: (k[0], k[1], str(k[2]), str(k[3])))):
        row = cases[key]
        rows.append({"id": f"c{index:03d}", **row})
    mismatches = [r["id"] for r in rows if not r.pop("derived_equals_expected")]
    payload = {
        "provenance": {
            "kind": "native_1win_oddsGroups_selections",
            "sport_ids": {"18": "Soccer", "23": "Basketball", "27": "Volleyball", "33": "Tennis",
                          "34": "Handball", "35": "Hockey"},
            "evidence_sha256_12": digests,
            "note": "native values are copied verbatim from the capture; 'expected' comes from an independent "
                    "oracle keyed by outcome code and group name; 'platform' is the real platform outcome of the "
                    "same snapshot whose settlement axes are identical (null when the platform emitted none).",
        },
        "cases": rows,
    }
    Path(out).write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n")
    print("cases", len(rows), "oracle/derive mismatches", mismatches)


if __name__ == "__main__":
    main()
