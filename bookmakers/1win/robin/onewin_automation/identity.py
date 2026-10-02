"""Fail-closed identity boundary between public quotes and basket payloads."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

import onewin_sportsbook

from .subjects import group_subject, requested_subject

class IdentityError(ValueError):
    pass


def _open_decimal(value: Any) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise IdentityError("1win quote price is invalid") from exc
    if not math.isfinite(parsed) or parsed <= 1:
        raise IdentityError("1win quote price must be an open decimal price above 1")
    return parsed


@dataclass(frozen=True)
class ResolvedSelection:
    event_id: str
    event_url: str
    market_id: str
    market_name: str
    selection_id: str
    selection_name: str
    raw_selection: str
    outcome: str
    price: float
    points: float | None
    source: str


def _ordinal(number: int) -> str:
    if 10 <= number % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(number % 10, "th")
    return f"{number}{suffix}"


def _expected_context(arb: dict[str, Any]) -> tuple[tuple[str, int | None], ...]:
    metadata = arb.get("pinnacle_market_metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    if metadata.get("unsupported_context"):
        return (("unsupported", None),)

    explicit = (
        ("map", arb.get("map_number") or metadata.get("map_number")),
        ("set", arb.get("set_number") or metadata.get("set_number")),
        ("game", arb.get("game_number") or metadata.get("game_number")),
        ("round", arb.get("round_number") or metadata.get("round_number")),
        ("half", arb.get("half_number") or metadata.get("half_number")),
        ("quarter", arb.get("quarter_number") or metadata.get("quarter_number")),
        ("inning", arb.get("inning_number") or metadata.get("inning_number")),
        (
            str(metadata.get("period_type") or "period"),
            arb.get("period_number") or metadata.get("period_number"),
        ),
    )
    contexts: list[tuple[str, int | None]] = []
    for kind, value in explicit:
        try:
            number = int(str(value))
        except (TypeError, ValueError):
            continue
        item = (kind.lower(), number)
        if number > 0 and item not in contexts:
            contexts.append(item)

    text = " ".join(str(arb.get(key) or "") for key in ("market_name", "display_market")).lower()
    if re.search(r"(?:\d+\s*(?:[-–]|по)\s*\d+\s*минут|\bпервые\s+\d+\s*иннинг|\+|вместе)", text):
        return (("unsupported", None),)
    labels = (
        ("map", r"(?:map|карт(?:а|ы|е|у))"),
        ("set", r"(?:set|сет(?:а|е|у)?)"),
        ("game", r"(?:game|гейм(?:а|е|у)?)"),
        ("round", r"(?:round|раунд(?:а|е|у|ы)?)"),
        ("half", r"(?:half|тайм(?:а|е|у)?|половин(?:а|ы|е|у))"),
        ("period", r"(?:period|период(?:а|е|у)?)"),
        ("quarter", r"(?:quarter|четверт(?:ь|и))"),
        ("inning", r"(?:inning|иннинг(?:а|е|у)?)"),
    )
    for kind, label in labels:
        for match in re.finditer(
            rf"(?:\b(\d+)\s*{label}\b|\b{label}\s*(\d+)\b)",
            text,
            re.IGNORECASE,
        ):
            item = (kind, int(match.group(1) or match.group(2)))
            if item not in contexts:
                contexts.append(item)
    if contexts:
        return tuple(contexts)
    if re.search(r"\b(?:весь матч|full match|whole match)\b", text):
        return (("full", None),)
    return ()


def _quote_context_matches(arb: dict[str, Any], group_name: str) -> bool:
    expected = _expected_context(arb)
    if not expected:
        return True
    lower = str(group_name or "").lower()
    contextual = r"(?:map|set|half|period|quarter|inning|game|round)"
    for kind, number in expected:
        if kind == "unsupported":
            return False
        if kind == "full":
            if re.search(rf"\b(?:\d+(?:st|nd|rd|th)\s+{contextual}|{contextual}\s+\d+)\b", lower):
                return False
            continue
        if number is None:
            return False
        label = re.escape(kind)
        ordinal = re.escape(_ordinal(number))
        if not re.search(rf"\b(?:{ordinal}\s+{label}|{label}\s+{number})\b", lower):
            return False
    return True


def _source_team_outcome(arb: dict[str, Any], canonical_team: int) -> str | None:
    target_values = (
        (arb.get("home_en"), arb.get("home"))
        if canonical_team == 1 else (arb.get("away_en"), arb.get("away"))
    )
    other_values = (
        (arb.get("away_en"), arb.get("away"))
        if canonical_team == 1 else (arb.get("home_en"), arb.get("home"))
    )
    source_values = (arb.get("team1_en"), arb.get("team2_en"))
    scores: list[float] = []
    for source in source_values:
        target = max(
            (onewin_sportsbook._team_similarity(value, source) for value in target_values),
            default=0.0,
        )
        other = max(
            (onewin_sportsbook._team_similarity(value, source) for value in other_values),
            default=0.0,
        )
        scores.append(target - 0.25 * other)
    if max(scores, default=0.0) < 45 or abs(scores[0] - scores[1]) < 8:
        return None
    return "1" if scores[0] > scores[1] else "2"


def _onewin_order_reversed(arb: dict[str, Any]) -> bool | None:
    home = _source_team_outcome(arb, 1)
    away = _source_team_outcome(arb, 2)
    if home == "1" and away == "2":
        return False
    if home == "2" and away == "1":
        return True
    return None


def _quote_market_kind(group_name: str) -> str | None:
    lower = group_name.lower()
    if "handicap" in lower or "spread" in lower:
        return "handicap"
    if "total" in lower:
        return "total"
    if any(token in lower for token in ("winner", "result", "moneyline", "double chance")):
        return "moneyline"
    return None


def _validate_requested_selection(
    arb: dict[str, Any],
    quote: dict[str, Any],
    market_name: str,
    points: float | None,
) -> None:
    descriptor = onewin_sportsbook._selection_descriptor(arb)
    requested_kind = descriptor.get("kind")
    raw = onewin_sportsbook.raw_counter_selection(arb).lower().replace("х", "x")
    compact = re.sub(r"[^a-zа-я0-9]", "", raw)
    double_chance = compact in {"1x", "x2", "12"}
    if double_chance:
        requested_kind = "moneyline"
    quote_kind = _quote_market_kind(market_name)
    family = "total" if requested_kind == "team_total" else requested_kind
    if not family or quote_kind != family:
        raise IdentityError("resolved 1win market family does not match the requested selection")
    subject = requested_subject(str(arb.get("market_name") or ""))
    if subject is None or group_subject(market_name) != subject:
        raise IdentityError("resolved 1win market subject does not match the request")
    if requested_kind == "team_total":
        team = int(descriptor.get("team") or 0)
        target_values = (
            (arb.get("home_en"), arb.get("home"))
            if team == 1 else (arb.get("away_en"), arb.get("away"))
        )
        other_values = (
            (arb.get("away_en"), arb.get("away"))
            if team == 1 else (arb.get("home_en"), arb.get("home"))
        )
        target_score = max(
            (onewin_sportsbook._team_similarity(value, market_name) for value in target_values),
            default=0.0,
        )
        other_score = max(
            (onewin_sportsbook._team_similarity(value, market_name) for value in other_values),
            default=0.0,
        )
        if target_score < 45 or target_score - other_score < 8:
            raise IdentityError("resolved 1win team-total participant does not match")

    requested_line = descriptor.get("line")
    if requested_line is not None and (
        points is None or abs(float(requested_line) - points) > 0.001
    ):
        raise IdentityError("resolved 1win signed line does not match the requested selection")

    actual_outcome = str(quote.get("outcome") or "").lower().replace("х", "x")
    expected_outcome: str | None
    if double_chance:
        expected_outcome = compact
        if expected_outcome != "12":
            reversed_order = _onewin_order_reversed(arb)
            if reversed_order is None:
                raise IdentityError("1win participant order is missing or ambiguous")
            if reversed_order:
                expected_outcome = "x2" if expected_outcome == "1x" else "1x"
    elif requested_kind in {"moneyline", "handicap"}:
        team = descriptor.get("team")
        if team in {1, 2}:
            expected_outcome = _source_team_outcome(arb, int(team))
            if expected_outcome is None:
                raise IdentityError("1win participant order is missing or ambiguous")
        else:
            expected_outcome = str(descriptor.get("designation") or "").lower()
    else:
        expected_outcome = str(descriptor.get("designation") or "").lower()
    if actual_outcome != expected_outcome:
        raise IdentityError("resolved 1win outcome does not match the requested selection")
    if requested_kind == "moneyline" and not double_chance:
        metadata = arb.get("pinnacle_market_metadata") or {}
        try:
            expected_arity = int(str(metadata.get("market_arity")))
            actual_arity = int(str(quote.get("market_arity")))
        except (TypeError, ValueError) as exc:
            raise IdentityError("authoritative 1win moneyline arity is required") from exc
        if expected_arity not in {2, 3} or actual_arity != expected_arity:
            raise IdentityError("resolved 1win moneyline arity does not match")


def resolved_selection(arb: dict[str, Any], quote: dict[str, Any]) -> ResolvedSelection:
    """Create immutable identity only from an exact verified public quote."""
    if quote.get("verified") is not True or str(quote.get("status") or "").upper() != "OK":
        raise IdentityError("1win selection is not verified and open")

    event_url = str(
        arb.get("bk2_raw_link") or arb.get("bk2_url")
        or arb.get("bk1_raw_link") or arb.get("bk1_url") or ""
    ).strip()
    arb_event_id = onewin_sportsbook.extract_event_id(arb)
    quote_event_id = str(quote.get("event_id") or "").strip()
    if not arb_event_id or not quote_event_id or arb_event_id != quote_event_id:
        raise IdentityError("1win event identifier mismatch")

    market_id = str(quote.get("odds_group_id") or "").strip()
    selection_id = str(quote.get("selection_id") or "").strip()
    if not market_id or not selection_id:
        raise IdentityError("resolved market and selection identifier are required")
    market_name = str(quote.get("odds_group_name") or "").strip()
    if not _quote_context_matches(arb, market_name):
        raise IdentityError("resolved 1win market context does not match the Forted context")

    points = quote.get("points")
    if points is not None:
        try:
            points = float(points)
        except (TypeError, ValueError) as exc:
            raise IdentityError("resolved line is invalid") from exc
        if not math.isfinite(points):
            raise IdentityError("resolved line is invalid")

    _validate_requested_selection(arb, quote, market_name, points)

    return ResolvedSelection(
        event_id=quote_event_id,
        event_url=event_url,
        market_id=market_id,
        market_name=market_name,
        selection_id=selection_id,
        selection_name=str(quote.get("selection") or arb.get("bk2_selection") or "").strip(),
        raw_selection=str(quote.get("raw_selection") or "").strip(),
        outcome=str(quote.get("outcome") or "").strip().lower(),
        price=_open_decimal(quote.get("current_odds")),
        points=points,
        source=str(quote.get("source") or "onewin-public-ws"),
    )
