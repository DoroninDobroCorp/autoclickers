"""Independent derivation of canonical bet facts from native 1win market data.

This module does not import, and does not trust, the parser, the platform or
the sportsbook adapter.  It looks only at what the 1win sportsbook itself
publishes for one selection: the sport id, the *group name* of the market
("Total (incl. OT)", "1st half. Handicap", ...), the *selection name*
("Over 220.5", "Bahcesehir Koleji -11.5"), the selection's numeric line
(``vars.v1`` of the native odd) and the native outcome code ("1", "x", "over").

The result is expressed in the vocabulary of the platform's
``CanonicalOutcomeAxes`` (``sport``, ``market_family``, ``period``, ``target``,
``unit``, ``side`` and ``line`` where the family has a line) so that the
automation adapter ``onewin_automation.axes.normalise_axes`` yields the same
settlement facts for a native-derived object as for the platform's own axes of
the same outcome.  ``sportref_market_type``, ``key`` and ``arb_groups`` are
registry/display data and are never produced here.

Closed world.  Only (sport, group-name) combinations that were observed in real
native captures *and* whose semantics follow from the group name or from a sport
rule the platform itself uses are derivable.  Everything else raises
``NativeAxesUnknown`` with a specific ``code``; nothing is guessed:

* regulation versus overtime is never defaulted.  A basketball group is
  overtime-inclusive only when it says "(incl. OT)"; an unmarked hockey
  Total/Handicap/Winner/team total/BTTS has an unproven scope;
* a unit is a function of (sport, family, period) plus the group's explicit
  statistic prefix ("Corners."); it is never inferred from the line size;
* the side of a team selection is the exact (normalised) match of the name in
  the selection or the group name against ``home_name``/``away_name``; two
  identical or unmatched names are ``side_ambiguous``;
* "Early payout" variants, combined markets, player markets and statistics
  with a unit the platform does not model are refused.

``home_name``/``away_name`` must be the participant names exactly as the native
event publishes them (the strings that appear in the selection and group
names), not the platform's canonical team names.

Only the standard library is used.
"""
from __future__ import annotations

import math
import re
import unicodedata
from typing import Any, NamedTuple

NATIVE_DERIVER_VERSION = "onewin-native-axes.v1"

# 1win native sport ids (``sport:<id>:category:..`` competition keys) -> platform sport.
SPORTS = {
    18: "football",
    23: "basketball",
    27: "volleyball",
    33: "tennis",
    34: "handball",
    35: "ice_hockey",
}
# Sports for which real native group vocabulary exists in the captured evidence.
# Volleyball (27) has no native capture at all: every volleyball group is
# ``sport_unproven`` until a capture exists.
_NATIVE_VOCABULARY_SPORTS = frozenset({18, 23, 33, 34, 35})


class NativeAxesUnknown(ValueError):
    """The native selection cannot be turned into proven canonical facts."""

    def __init__(self, code: str, message: str | None = None):
        self.code = code
        super().__init__(f"{code}: {message}" if message else code)


# --------------------------------------------------------------------------
# normalisation helpers
# --------------------------------------------------------------------------
_WS = re.compile(r"\s+")


def _norm(value: str) -> str:
    """NFC + collapse any whitespace run (NBSP included) + strip + casefold; nothing fuzzier."""
    text = unicodedata.normalize("NFC", value)
    return _WS.sub(" ", text).strip().casefold()


def _finite(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


# --------------------------------------------------------------------------
# group vocabulary (closed world, observed in native captures)
# --------------------------------------------------------------------------
class _Spec(NamedTuple):
    family: str      # platform market_family
    period: str      # platform period token
    unit: str        # platform unit
    shape: str       # selection grammar (the branches of derive_native_axes)
    scope_proven: bool = True  # False -> the native label does not prove regulation/overtime


_FB, _BB, _VB, _TN, _HB, _IH = 18, 23, 27, 33, 34, 35
_TEAM_TOTAL = "{team} total"
_TEAM_TOTAL_OT = "{team} total (incl. ot)"

# key: (sport id, statistic prefix, period label, base template) -> _Spec
_GROUPS: dict[tuple[int, str, str, str], _Spec] = {}


def _g(sport: int, stat: str, period: str, base: str, spec: _Spec) -> None:
    _GROUPS[(sport, stat, period, base)] = spec


# Football: ft/h1/h2 are regulation (90 min) under the platform's football rule.
_g(_FB, "", "", "full time result", _Spec("result", "ft", "goals", "result3"))
_g(_FB, "", "", "double chance", _Spec("double_chance", "ft", "goals", "double_chance"))
_g(_FB, "", "", "draw no bet", _Spec("dnb", "ft", "goals", "winner2"))
_g(_FB, "", "", "both teams to score", _Spec("btts", "ft", "goals", "yes_no"))
_g(_FB, "", "", "total", _Spec("total", "ft", "goals", "total"))
_g(_FB, "", "", "handicap", _Spec("handicap", "ft", "goals", "handicap"))
_g(_FB, "", "", _TEAM_TOTAL, _Spec("team_total", "ft", "goals", "team_total"))
_g(_FB, "", "", "odd/even", _Spec("odd_even", "ft", "goals", "odd_even"))
_g(_FB, "", "1st half", "result", _Spec("result", "h1", "goals", "result3"))
_g(_FB, "", "1st half", "double chance", _Spec("double_chance", "h1", "goals", "double_chance"))
_g(_FB, "", "1st half", "total", _Spec("total", "h1", "goals", "total"))
_g(_FB, "", "1st half", "handicap", _Spec("handicap", "h1", "goals", "handicap"))
_g(_FB, "", "1st half", _TEAM_TOTAL, _Spec("team_total", "h1", "goals", "team_total"))
_g(_FB, "", "1st half", "total. even/odd", _Spec("odd_even", "h1", "goals", "odd_even"))
_g(_FB, "", "2nd half", "result", _Spec("result", "h2", "goals", "result3"))
_g(_FB, "", "2nd half", "total", _Spec("total", "h2", "goals", "total"))
_g(_FB, "", "2nd half", "handicap", _Spec("handicap", "h2", "goals", "handicap"))
_g(_FB, "", "2nd half", "odd/even", _Spec("odd_even", "h2", "goals", "odd_even"))
# Football corners: the unit comes from the explicit "Corners." prefix.
_g(_FB, "corners", "", "total", _Spec("total", "ft", "corners", "total"))
_g(_FB, "corners", "", "handicap", _Spec("handicap", "ft", "corners", "handicap"))
_g(_FB, "corners", "", _TEAM_TOTAL, _Spec("team_total", "ft", "corners", "team_total"))
_g(_FB, "corners", "1st half", "total", _Spec("total", "h1", "corners", "total"))
_g(_FB, "corners", "1st half", "handicap", _Spec("handicap", "h1", "corners", "handicap"))
_g(_FB, "corners", "1st half", _TEAM_TOTAL, _Spec("team_total", "h1", "corners", "team_total"))

# Handball: ft/h1 are regulation under the platform's handball rule.
_g(_HB, "", "", "result", _Spec("result", "ft", "goals", "result3"))
_g(_HB, "", "", "total", _Spec("total", "ft", "goals", "total"))
_g(_HB, "", "", "handicap", _Spec("handicap", "ft", "goals", "handicap"))
_g(_HB, "", "", _TEAM_TOTAL, _Spec("team_total", "ft", "goals", "team_total"))
_g(_HB, "", "1st half", "total", _Spec("total", "h1", "goals", "total"))
_g(_HB, "", "1st half", "asian handicap", _Spec("handicap", "h1", "goals", "handicap"))

# Basketball: the full game is overtime-inclusive only when the group says so.
_g(_BB, "", "", "winner (incl. ot)", _Spec("moneyline", "ft_ot", "points", "winner2"))
_g(_BB, "", "", "total (incl. ot)", _Spec("total", "ft_ot", "points", "total"))
_g(_BB, "", "", "handicap (incl. ot)", _Spec("handicap", "ft_ot", "points", "handicap"))
_g(_BB, "", "", _TEAM_TOTAL_OT, _Spec("team_total", "ft_ot", "points", "team_total"))
_g(_BB, "", "", "odd/even (incl. ot)", _Spec("odd_even", "ft_ot", "points", "odd_even"))
_g(_BB, "", "", "result (reg. time)", _Spec("result", "ft_reg", "points", "result3"))
for _label, _suffix in (("1st half", "h1"), ("1st quarter", "q1")):
    _g(_BB, "", _label, "result", _Spec("result", _suffix, "points", "result3"))
    _g(_BB, "", _label, "total", _Spec("total", _suffix, "points", "total"))
    _g(_BB, "", _label, "handicap", _Spec("handicap", _suffix, "points", "handicap"))
    _g(_BB, "", _label, _TEAM_TOTAL, _Spec("team_total", _suffix, "points", "team_total"))
    _g(_BB, "", _label, "odd/even", _Spec("odd_even", _suffix, "points", "odd_even"))
_g(_BB, "", "2nd quarter", "result", _Spec("result", "q2", "points", "result3"))
_g(_BB, "", "2nd quarter", "total", _Spec("total", "q2", "points", "total"))
_g(_BB, "", "2nd quarter", _TEAM_TOTAL, _Spec("team_total", "q2", "points", "team_total"))
_g(_BB, "", "3rd quarter", "total", _Spec("total", "q3", "points", "total"))
_g(_BB, "", "3rd quarter", _TEAM_TOTAL, _Spec("team_total", "q3", "points", "team_total"))
# Unmarked full-game basketball groups: scope is not proven.
for _base, _fam, _shape in (("total", "total", "total"), ("handicap", "handicap", "handicap"),
                            ("winner", "moneyline", "winner2"), (_TEAM_TOTAL, "team_total", "team_total")):
    _g(_BB, "", "", _base, _Spec(_fam, "ft", "points", _shape, scope_proven=False))

# Ice hockey: three-way (Draw) full-time markets and period markets are
# regulation; unmarked two-way/total/handicap/BTTS markets have no proven scope.
_g(_IH, "", "", "full time result", _Spec("result", "ft", "goals", "result3"))
_g(_IH, "", "", "double chance", _Spec("double_chance", "ft", "goals", "double_chance"))
for _label, _suffix in (("1st period", "p1"), ("2nd period", "p2"), ("3rd period", "p3")):
    _g(_IH, "", _label, "result", _Spec("result", _suffix, "goals", "result3"))
    _g(_IH, "", _label, "total", _Spec("total", _suffix, "goals", "total"))
    _g(_IH, "", _label, "handicap", _Spec("handicap", _suffix, "goals", "handicap"))
    _g(_IH, "", _label, _TEAM_TOTAL, _Spec("team_total", _suffix, "goals", "team_total"))
    _g(_IH, "", _label, "double chance", _Spec("double_chance", _suffix, "goals", "double_chance"))
    _g(_IH, "", _label, "both teams to score", _Spec("btts", _suffix, "goals", "yes_no"))
for _base, _fam, _shape in (("total", "total", "total"), ("handicap", "handicap", "handicap"),
                            ("match winner", "moneyline", "winner2"), ("winner", "moneyline", "winner2"),
                            (_TEAM_TOTAL, "team_total", "team_total"),
                            ("both teams to score", "btts", "yes_no")):
    _g(_IH, "", "", _base, _Spec(_fam, "ft_ot_pen", "goals", _shape, scope_proven=False))

# Tennis: the only group captured natively is the match winner (sets).
_g(_TN, "", "", "winner", _Spec("moneyline", "match", "sets", "winner2"))

def _platform_unit(sport: int, family: str, period: str, stat: str = "") -> str:
    """The platform's unit rule: a function of (sport, family, period) and an
    explicit statistic prefix, never of the size of the line."""
    if stat == "corners":
        return "corners"
    if stat:
        raise ValueError(f"no platform unit for statistic {stat!r}")
    if sport in (_FB, _HB, _IH):
        return "goals"
    if sport == _BB:
        return "points"
    if sport in (_TN, _VB):
        if period == "match" and family in ("moneyline", "result"):
            return "sets"
        return "games" if sport == _TN else "points"
    raise ValueError(f"no unit rule for sport {sport}")


for (_sport, _stat, _, _), _spec in _GROUPS.items():
    if _spec.unit != _platform_unit(_sport, _spec.family, _spec.period, _stat):
        raise RuntimeError(f"vocabulary entry disagrees with the unit rule: {_sport} {_stat} {_spec}")

# --------------------------------------------------------------------------
# recognised-but-refused vocabulary
# --------------------------------------------------------------------------
_STAT_PREFIX = re.compile(
    r"^(corners|yellow cards|fouls|offsides|shots all|shots on target|player)\. (.*)$")
_PERIOD_PREFIX = re.compile(r"^(1st|2nd|3rd|4th) (half|quarter|period)\. (.*)$")
_COMBO = re.compile(r"^(result and total|result and both teams to score|total and both teams to score)$")
_PLAYER = re.compile(r"\bplayer\b")
_TEAM_TOTAL_GROUP = re.compile(r"^(.+) total$")
_TEAM_TOTAL_OT_GROUP = re.compile(r"^(.+) total \(incl\. ot\)$")
_UNIT_UNPROVEN_STATS = frozenset({"yellow cards", "fouls", "offsides", "shots all", "shots on target"})

_OVER_UNDER = re.compile(r"^(over|under) ([+-]?\d+(?:\.\d+)?)$")
_TRAILING_NUMBER = re.compile(r"^(.*\S) ([+-]?\d+(?:\.\d+)?)$")


def _parse_group(group: str) -> tuple[str, str, str]:
    stat = ""
    m = _STAT_PREFIX.match(group)
    if m:
        stat, group = m.group(1), m.group(2)
    period = ""
    m = _PERIOD_PREFIX.match(group)
    if m:
        period, group = f"{m.group(1)} {m.group(2)}", m.group(3)
    return stat, period, group


def _lookup(sport: int, stat: str, period: str, base: str) -> tuple[_Spec | None, str | None]:
    """Return ``(spec, team_text)``; ``team_text`` is set for team-total groups."""
    spec = _GROUPS.get((sport, stat, period, base))
    if spec is not None:
        return spec, None
    for pattern, template in ((_TEAM_TOTAL_OT_GROUP, _TEAM_TOTAL_OT), (_TEAM_TOTAL_GROUP, _TEAM_TOTAL)):
        m = pattern.match(base)
        if m:
            spec = _GROUPS.get((sport, stat, period, template))
            if spec is not None:
                return spec, m.group(1)
    return None, None


def _refuse_unrecognised(stat: str, group: str, original: str) -> NativeAxesUnknown:
    if stat == "player" or _PLAYER.search(group):
        return NativeAxesUnknown("player_market", f"player market {original!r}")
    if stat in _UNIT_UNPROVEN_STATS:
        return NativeAxesUnknown(
            "unit_unproven",
            f"{original!r}: the {stat} statistic has no proven platform unit",
        )
    return NativeAxesUnknown("group_unknown", f"no proven native market group {original!r}")


# --------------------------------------------------------------------------
# selection grammars
# --------------------------------------------------------------------------
def _team_side(text: str, home: str | None, away: str | None, what: str) -> str:
    """Exact (normalised) comparison against the two participants."""
    if home is None or away is None or not home or not away:
        raise NativeAxesUnknown("side_ambiguous", f"{what}: both participant names are required")
    key, h, a = _norm(text), _norm(home), _norm(away)
    if h == a:
        raise NativeAxesUnknown("side_ambiguous", "participants have identical normalised names")
    if key == h:
        return "home"
    if key == a:
        return "away"
    raise NativeAxesUnknown("side_ambiguous", f"{what}: {text!r} matches neither participant exactly")


def _check_code(code: str | None, expected: str, *, error: str) -> None:
    if code is None:
        return
    if _norm(code) != expected:
        raise NativeAxesUnknown(error, f"outcome code {code!r} contradicts the selection ({expected!r})")


_TEAM_CODE = {"home": "1", "away": "2"}


def _line_from(points: float | None, *, required: bool, allow_negative: bool) -> float | None:
    if points is None:
        if required:
            raise NativeAxesUnknown("points_missing", "this market needs a line")
        return None
    if not required:
        raise NativeAxesUnknown("points_unexpected", "this market carries no line")
    value = _finite(points)
    if value is None:
        raise NativeAxesUnknown("points_invalid", "points must be a finite number")
    if not allow_negative and value < 0:
        raise NativeAxesUnknown("points_invalid", "a total line cannot be negative")
    if (value * 4) != int(value * 4):
        raise NativeAxesUnknown("points_invalid", f"line {value} is not a multiple of 0.25")
    return value + 0.0


def _same_number(left: float, right: float) -> bool:
    return abs(left - right) <= 1e-9


def derive_native_axes(*, sport_id, group_name: str, selection_name: str, points: float | None,
                       home_name: str | None = None, away_name: str | None = None,
                       outcome_code: str | None = None) -> dict:
    """Return platform-vocabulary axes for one native 1win selection or raise.

    ``points`` is the native numeric line of the selection (``vars.v1``) and
    must be ``None`` for markets without a line.  ``outcome_code`` is the native
    odd's ``outcome`` field (``"1"``, ``"x"``, ``"over"``...); when given it must
    agree with everything derived from the names.
    """
    # -- sport -----------------------------------------------------------
    if isinstance(sport_id, bool):
        raise NativeAxesUnknown("sport_unknown", "sport id must be an integer or digit string")
    if isinstance(sport_id, str) and sport_id.strip().isdigit():
        sport_id = int(sport_id.strip())
    if not isinstance(sport_id, int) or sport_id not in SPORTS:
        raise NativeAxesUnknown("sport_unknown", f"unsupported native sport id {sport_id!r}")
    if sport_id not in _NATIVE_VOCABULARY_SPORTS:
        raise NativeAxesUnknown(
            "sport_unproven",
            f"no native group vocabulary was captured for sport {sport_id} ({SPORTS[sport_id]})",
        )
    for label, value in (("group_name", group_name), ("selection_name", selection_name)):
        if not isinstance(value, str) or not value.strip():
            raise NativeAxesUnknown("input_invalid", f"{label} must be a non-empty string")
    for label, value in (("home_name", home_name), ("away_name", away_name), ("outcome_code", outcome_code)):
        if value is not None and not isinstance(value, str):
            raise NativeAxesUnknown("input_invalid", f"{label} must be a string or None")
    if points is not None and _finite(points) is None:
        raise NativeAxesUnknown("points_invalid", "points must be a finite number or None")

    original_group = group_name
    group = _norm(group_name)
    if "early payout" in group:
        raise NativeAxesUnknown("early_payout_variant", f"early-payout market {original_group!r}")
    stat, period, base = _parse_group(group)
    if _COMBO.match(base):
        raise NativeAxesUnknown("combo_market", f"combined market {original_group!r}")
    spec, team_text = _lookup(sport_id, stat, period, base)
    if spec is None:
        raise _refuse_unrecognised(stat, base, original_group)
    if not spec.scope_proven:
        raise NativeAxesUnknown(
            "scope_unproven",
            f"{original_group!r}: the group carries no regulation/overtime label for {SPORTS[sport_id]}",
        )

    sport = SPORTS[sport_id]
    selection = _norm(selection_name)
    code = _norm(outcome_code) if outcome_code is not None else None
    target = "match"
    side: str
    line: float | None = None

    shape = spec.shape
    if shape in ("total", "team_total"):
        m = _OVER_UNDER.match(selection)
        if not m:
            raise NativeAxesUnknown("selection_unknown", f"{selection_name!r} is not Over/Under N")
        side = m.group(1)
        _check_code(code, side, error="outcome_conflict")
        line = _line_from(points, required=True, allow_negative=False)
        if not _same_number(line, float(m.group(2))):
            raise NativeAxesUnknown("points_conflict", f"selection says {m.group(2)} but points is {points}")
        if shape == "team_total":
            target = _team_side(team_text or "", home_name, away_name, "team total group")
    elif shape == "handicap":
        m = _TRAILING_NUMBER.match(_WS.sub(" ", unicodedata.normalize("NFC", selection_name)).strip())
        if not m:
            raise NativeAxesUnknown("selection_unknown", f"{selection_name!r} is not '<team> <line>'")
        line = _line_from(points, required=True, allow_negative=True)
        if not _same_number(line, float(m.group(2))):
            raise NativeAxesUnknown(
                "points_conflict",
                f"selection line {m.group(2)} differs from points {points} (sign included)",
            )
        side = _team_side(m.group(1), home_name, away_name, "handicap selection")
        _check_code(code, _TEAM_CODE[side], error="side_ambiguous")
    else:
        _line_from(points, required=False, allow_negative=True)
        if shape in ("result3", "winner2"):
            if shape == "winner2" and selection == "draw":
                raise NativeAxesUnknown("selection_unknown", "a two-way market has no Draw selection")
            if shape == "result3" and selection == "draw":
                if home_name is not None and away_name is not None and "draw" in (_norm(home_name), _norm(away_name)):
                    raise NativeAxesUnknown("side_ambiguous", "a participant is literally named Draw")
                side = "draw"
                _check_code(code, "x", error="side_ambiguous")
            else:
                side = _team_side(selection_name, home_name, away_name, "winner selection")
                _check_code(code, _TEAM_CODE[side], error="side_ambiguous")
        elif shape == "double_chance":
            if home_name is None or away_name is None or _norm(home_name) == _norm(away_name):
                raise NativeAxesUnknown("side_ambiguous", "double chance needs two distinct participant names")
            h, a = _norm(home_name), _norm(away_name)
            options = {f"{h} or draw": "1x", f"{h} or {a}": "12", f"draw or {a}": "x2"}
            if selection not in options:
                raise NativeAxesUnknown("side_ambiguous", f"{selection_name!r} is not a double-chance of the participants")
            side = options[selection]
            _check_code(code, side, error="side_ambiguous")
        elif shape == "yes_no":
            if selection not in ("yes", "no"):
                raise NativeAxesUnknown("selection_unknown", f"{selection_name!r} is not Yes/No")
            side = selection
            _check_code(code, side, error="outcome_conflict")
        elif shape == "odd_even":
            if selection not in ("odd", "even"):
                raise NativeAxesUnknown("selection_unknown", f"{selection_name!r} is not Odd/Even")
            side = selection
            _check_code(code, side, error="outcome_conflict")
        else:  # pragma: no cover - the table only uses the shapes above
            raise NativeAxesUnknown("group_unknown", f"unhandled shape {shape!r}")

    axes: dict[str, Any] = {
        "sport": sport,
        "market_family": spec.family,
        "period": spec.period,
        "target": target,
        "unit": spec.unit,
        "side": side,
    }
    if line is not None:
        axes["line"] = line
    return axes


_EVIDENCE_FIELDS = ("sport_id", "group_name", "selection_name", "points", "home_name", "away_name", "outcome_code")


def facts_from_native_evidence(evidence: dict) -> dict:
    """Validate a native evidence record and derive its canonical axes.

    ``evidence`` carries exactly the :func:`derive_native_axes` inputs; extra
    members, ``bool`` numbers and non-finite numbers are refused.
    """
    if not isinstance(evidence, dict):
        raise NativeAxesUnknown("input_invalid", "evidence must be an object")
    extra = sorted(set(evidence) - set(_EVIDENCE_FIELDS))
    if extra:
        raise NativeAxesUnknown("input_invalid", f"unexpected evidence members: {extra}")
    for required in ("sport_id", "group_name", "selection_name"):
        if required not in evidence:
            raise NativeAxesUnknown("input_invalid", f"missing evidence member {required}")
    sport_id = evidence["sport_id"]
    if isinstance(sport_id, bool) or not isinstance(sport_id, (int, str)):
        raise NativeAxesUnknown("input_invalid", "sport_id must be an integer or a string")
    for key in ("group_name", "selection_name"):
        if not isinstance(evidence[key], str):
            raise NativeAxesUnknown("input_invalid", f"{key} must be a string")
    for key in ("home_name", "away_name", "outcome_code"):
        if evidence.get(key) is not None and not isinstance(evidence[key], str):
            raise NativeAxesUnknown("input_invalid", f"{key} must be a string or None")
    points = evidence.get("points")
    if points is not None and _finite(points) is None:
        raise NativeAxesUnknown("input_invalid", "points must be a finite number or None (no bool)")
    return derive_native_axes(
        sport_id=sport_id,
        group_name=evidence["group_name"],
        selection_name=evidence["selection_name"],
        points=points,
        home_name=evidence.get("home_name"),
        away_name=evidence.get("away_name"),
        outcome_code=evidence.get("outcome_code"),
    )
