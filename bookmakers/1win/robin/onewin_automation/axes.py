"""Explicit, versioned adapter between platform canonical axes and settlement facts.

Platform publishes ``CanonicalOutcomeAxes`` (entity/contracts.go): ``sport``,
``market_family``, ``period``, ``target``, ``unit``, ``side``, ``line``,
``sportref_market_type``, ``key`` and nested ``arb_groups``.  It has no
``scope``/``market`` members.  Regulation/overtime scope is encoded in the
period token and the sport (``ft_reg``, ``ft_ot`` for basketball,
``ft_ot_pen`` for ice hockey, ``match`` for tennis/volleyball) and is derived
here from an explicit table; an unlisted combination is *unproven* and is
rejected instead of being defaulted.  Units are never inferred from line size
or replaced by a placeholder.

The original axes object is always preserved by the caller together with
``ADAPTER_VERSION``; only the normalised settlement facts are compared.
Display ``key`` and nested ``arb_groups`` are diagnostics and never take part
in the comparison.
"""
from __future__ import annotations

import copy
import math
import re
from typing import Any

ADAPTER_VERSION = "platform-canonical-axes-adapter.v1"
PLATFORM_SCHEMA = "platform-canonical.v1"
LEGACY_SCHEMA = "legacy-onewin-axes.v0"

# Facts that decide settlement.  ``sportref_market_type`` is compared only when
# both sides carry it (the executor cannot always derive a registry id).
COMPARE_KEYS = (
    "sport", "market_family", "period", "scope", "target", "unit", "side", "line",
)
LEGACY_REQUIRED = ("period", "scope", "unit", "market", "side")
GUESSED_UNITS = frozenset({
    "", "unknown", "unverified", "match_base_unit", "unverified_from_dom_only",
    "guessed", "undisclosed", "none", "null",
})
GUESSED_VALUES = frozenset({"", "unknown", "unverified", "guessed", "undisclosed", "none", "null"})
# Families whose settlement is defined by a signed or unsigned line.
LINE_FAMILIES = frozenset({"total", "team_total", "handicap", "handicap_3way"})
# Families that never carry a line (a stray one is a contradiction).
NO_LINE_FAMILIES = frozenset({
    "result", "moneyline", "dnb", "double_chance", "btts", "odd_even",
})
UNPROVEN_PAYOUT_STATUSES = frozenset({"unverified_draw_rule"})
UNPROVEN_DRAW_PAYOUTS = frozenset({"undisclosed", "unknown", ""})


class AxesContractError(ValueError):
    """Canonical axes cannot be turned into proven settlement facts."""

    def __init__(self, code: str, message: str | None = None):
        self.code = code
        super().__init__(message or code)


def _text(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _finite(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def derive_scope(sport: str, period: str, family: str) -> tuple[str, str]:
    """Return ``(base_period, scope)`` for a platform period token.

    Raises ``AxesContractError`` when the combination is not proven.  ``ft``
    is regulation only where the platform guarantees it (football, handball,
    ice-hockey result/dnb/double chance); it is never assumed elsewhere.
    """
    if period.endswith("_reg"):
        base = period[: -len("_reg")]
        if base in {"ft", "h1", "h2"} or re.fullmatch(r"p\d+|q\d", base):
            return base, "regulation"
        raise AxesContractError("axes_scope_unproven", f"unproven regulation period {period!r}")
    if period == "ft_ot" and sport == "basketball":
        return "ft", "incl_overtime"
    if period == "ft_ot_pen" and sport == "ice_hockey":
        return "ft", "incl_overtime_penalties"
    if period == "ft":
        if sport in {"football", "handball"}:
            return "ft", "regulation"
        if sport == "ice_hockey" and family in {"result", "dnb", "double_chance"}:
            return "ft", "regulation"
    elif period in {"h1", "h2"} and sport in {"football", "handball", "basketball"}:
        return period, "regulation"
    elif re.fullmatch(r"q[1-4]", period) and sport == "basketball":
        return period, "regulation"
    elif re.fullmatch(r"p[1-3]", period) and sport == "ice_hockey":
        return period, "regulation"
    elif period == "match" and sport in {"tennis", "volleyball"}:
        return "match", "match"
    elif re.fullmatch(r"set[1-5]", period) and sport in {"tennis", "volleyball"}:
        return period, "set"
    raise AxesContractError(
        "axes_scope_unproven",
        f"settlement scope of period {period!r} is not proven for sport {sport!r}/{family!r}",
    )


def payout_rule(*contexts: Any) -> dict[str, Any]:
    """Collect result variant / draw payout facts from quote contexts.

    Unknown stays unknown: ``status`` is ``unverified`` when any context says
    the draw rule is undisclosed or unverified.  Nothing is inferred from the
    number of runners.
    """
    variants: set[str] = set()
    draws: set[str] = set()
    status = "proven"
    for ctx in contexts:
        if not isinstance(ctx, dict):
            continue
        variant = _text(ctx.get("result_variant"))
        if variant:
            variants.add(variant)
        draw = ctx.get("draw_payout")
        if isinstance(draw, str):
            draws.add(draw.strip().lower())
        pay_status = _text(ctx.get("payout_status"))
        if (pay_status in UNPROVEN_PAYOUT_STATUSES
                or (isinstance(draw, str) and draw.strip().lower() in UNPROVEN_DRAW_PAYOUTS)):
            status = "unverified"
    if len(variants) > 1:
        raise AxesContractError("payout_variant_conflict", f"conflicting result variants {sorted(variants)}")
    if len(draws - UNPROVEN_DRAW_PAYOUTS) > 1:
        raise AxesContractError("payout_draw_conflict", f"conflicting draw payouts {sorted(draws)}")
    return {
        "status": status,
        "result_variant": next(iter(variants), None),
        "draw_payout": next(iter(draws - UNPROVEN_DRAW_PAYOUTS), None),
    }


def _normalise_platform(axes: dict[str, Any]) -> dict[str, Any]:
    values: dict[str, str] = {}
    for key in ("sport", "market_family", "period", "target", "unit", "side", "sportref_market_type"):
        value = _text(axes.get(key))
        if value is None:
            raise AxesContractError(f"axes_incomplete:{key}", f"incomplete axes: missing {key}")
        values[key] = value
    family = values["market_family"].lower()
    if family in GUESSED_VALUES or family == "unknown":
        raise AxesContractError("axes_family_unknown", f"unknown market family {family!r}")
    unit = values["unit"].lower()
    if unit in GUESSED_UNITS:
        raise AxesContractError("axes_unit_unverified", f"guessed or unverified market unit: {unit}")
    for key in ("period", "target", "side"):
        if values[key].lower() in GUESSED_VALUES:
            raise AxesContractError(f"axes_{key}_unverified", f"unverified {key}: {values[key]!r}")
    line_raw = axes.get("line")
    line = _finite(line_raw)
    if line_raw is not None and line is None:
        raise AxesContractError("axes_line_invalid", "line must be a finite number")
    if family in LINE_FAMILIES and line is None:
        raise AxesContractError("axes_incomplete:line", "incomplete axes: missing line")
    if family in NO_LINE_FAMILIES and line is not None:
        raise AxesContractError("axes_line_contradiction", f"{family} cannot carry a line")
    base_period, scope = derive_scope(values["sport"], values["period"], family)
    return {
        "sport": values["sport"],
        "market_family": family,
        "market": family,
        "period": base_period,
        "scope": scope,
        "target": values["target"],
        "unit": unit,
        "side": values["side"].lower(),
        "line": line,
        "sportref_market_type": values["sportref_market_type"],
    }


def _normalise_legacy(axes: dict[str, Any]) -> dict[str, Any]:
    values: dict[str, str] = {}
    for key in LEGACY_REQUIRED:
        value = _text(axes.get(key))
        if value is None:
            raise AxesContractError(f"axes_incomplete:{key}", f"incomplete axes: missing {key}")
        values[key] = value
    unit = values["unit"].lower()
    if unit in GUESSED_UNITS:
        raise AxesContractError("axes_unit_unverified", f"guessed or unverified market unit: {unit}")
    line_raw = axes.get("line")
    line = _finite(line_raw)
    if line_raw is not None and line is None:
        raise AxesContractError("axes_line_invalid", "line must be a finite number")
    return {
        "sport": _text(axes.get("sport")),
        "market_family": values["market"].lower(),
        "market": values["market"].lower(),
        "period": values["period"],
        "scope": values["scope"],
        "target": _text(axes.get("target")),
        "unit": unit,
        "side": values["side"].lower(),
        "line": line,
        "sportref_market_type": _text(axes.get("sportref_market_type")),
    }


def normalise_axes(axes: Any, *, contexts: tuple[Any, ...] = ()) -> dict[str, Any]:
    """Return ``{adapter_version, schema, facts, original}`` or raise.

    ``contexts`` are quote dictionaries that may carry ``result_variant``,
    ``draw_payout`` and ``payout_status``.
    """
    if not isinstance(axes, dict) or not axes:
        raise AxesContractError("axes_missing", "verified axes required")
    original = copy.deepcopy(axes)
    if "market_family" in axes or "sportref_market_type" in axes:
        schema, facts = PLATFORM_SCHEMA, _normalise_platform(axes)
    elif "market" in axes or "scope" in axes:
        schema, facts = LEGACY_SCHEMA, _normalise_legacy(axes)
    else:
        raise AxesContractError("axes_schema_unrecognized", "axes schema is not recognised")
    facts["payout_rule"] = payout_rule(*contexts)
    return {"adapter_version": ADAPTER_VERSION, "schema": schema, "facts": facts, "original": original}


def _same_line(left: Any, right: Any) -> bool:
    if left is None or right is None:
        return left is None and right is None
    return abs(float(left) - float(right)) <= 1e-9


def compare_facts(expected: dict[str, Any], actual: dict[str, Any]) -> list[str]:
    """Return the settlement facts on which two normalised objects differ."""
    differing: list[str] = []
    if expected.get("schema") != actual.get("schema"):
        return ["schema"]
    left, right = expected["facts"], actual["facts"]
    for key in COMPARE_KEYS:
        if key == "line":
            if not _same_line(left.get(key), right.get(key)):
                differing.append(key)
        elif left.get(key) != right.get(key):
            differing.append(key)
    expected_type, actual_type = left.get("sportref_market_type"), right.get("sportref_market_type")
    if expected_type and actual_type and expected_type != actual_type:
        differing.append("sportref_market_type")
    return differing


def public_facts(normalised: dict[str, Any]) -> dict[str, Any]:
    """Flat, JSON-safe facts used by consumers that must not re-derive scope."""
    return copy.deepcopy(normalised["facts"])
