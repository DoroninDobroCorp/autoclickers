"""Strict raw-snapshot resolver for contexts the legacy resolver can confuse."""
from __future__ import annotations

import math
import re
from typing import Any

import onewin_sportsbook

from .identity import _expected_context, _onewin_order_reversed
from .subjects import group_subject, legacy_market_context, requested_subject


def _context_matches(
    group_name: str,
    expected: tuple[tuple[str, int | None], ...],
) -> bool:
    if not expected:
        return not re.search(
            r"\b(?:\d+(?:st|nd|rd|th)\s+(?:map|set|half|period|quarter|inning|game|round)|"
            r"(?:map|set|half|period|quarter|inning|game|round)\s+\d+)\b",
            str(group_name or "").lower(),
        )
    lower = str(group_name or "").lower()
    any_context = r"(?:map|set|half|period|quarter|inning|game|round)"
    for kind, number in expected:
        if kind == "unsupported":
            return False
        if kind == "full":
            if re.search(rf"\b(?:\d+(?:st|nd|rd|th)\s+{any_context}|{any_context}\s+\d+)\b", lower):
                return False
            continue
        if number is None:
            return False
        ordinal = onewin_sportsbook._ordinal(number)
        if not re.search(rf"\b(?:{re.escape(ordinal)}\s+{kind}|{kind}\s+{number})\b", lower):
            return False
    return True


def _group_arity(group: dict[str, Any]) -> int | None:
    outcomes = {
        str(odd.get("outcome") or "").lower().replace("х", "x")
        for odd in group.get("oddsList") or []
        if isinstance(odd, dict)
    }
    has_home = bool(outcomes & {"1", "home"})
    has_away = bool(outcomes & {"2", "away"})
    if not has_home or not has_away:
        return None
    return 3 if outcomes & {"x", "draw"} else 2


def _filtered_snapshot(arb: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
    expected = _expected_context(arb)
    market_name = str(arb.get("market_name") or "")
    if ("unsupported", None) in expected:
        return {**snapshot, "oddsGroups": [], "_onewin_status": "UNSUPPORTED_CONTEXT"}
    subject = requested_subject(market_name)
    if subject is None:
        return {**snapshot, "oddsGroups": [], "_onewin_status": "UNSUPPORTED_SUBJECT"}
    groups = [
        group for group in snapshot.get("oddsGroups") or []
        if isinstance(group, dict)
        and _context_matches(str(group.get("name") or ""), expected)
        and group_subject(str(group.get("name") or "")) == subject
    ]
    metadata = arb.get("pinnacle_market_metadata") or {}
    try:
        arity = int(str(metadata.get("market_arity")))
    except (TypeError, ValueError):
        arity = 0
    raw = re.sub(r"[^a-zа-я0-9]", "", onewin_sportsbook.raw_counter_selection(arb).lower())
    plain_moneyline = (
        str(arb.get("market") or "").lower() == "moneyline"
        and raw not in {"1x", "1х", "x2", "х2", "12"}
    )
    if plain_moneyline and arity in {2, 3}:
        groups = [group for group in groups if _group_arity(group) == arity]
    missing_arity = plain_moneyline and arity not in {2, 3}
    return {
        **snapshot,
        "oddsGroups": groups,
        "_onewin_status": "MARKET_ARITY_REQUIRED" if missing_arity else None,
    }


def _double_chance_quote(
    arb: dict[str, Any],
    event_id: str,
    snapshot: dict[str, Any],
) -> dict[str, Any] | None:
    raw = onewin_sportsbook.raw_counter_selection(arb).lower().replace("х", "x")
    outcome = re.sub(r"[^a-z0-9]", "", raw)
    if outcome not in {"1x", "x2", "12"}:
        return None
    if outcome != "12":
        reversed_order = _onewin_order_reversed(arb)
        if reversed_order is None:
            return {
                "verified": False,
                "status": "AMBIGUOUS_TEAM_ORDER",
                "current_odds": None,
                "event_id": event_id,
                "source": "onewin-public-ws",
                "detail": "1win participant order is missing or ambiguous",
            }
        if reversed_order:
            outcome = "x2" if outcome == "1x" else "1x"
    base = {
        "verified": False,
        "status": "UNAVAILABLE",
        "current_odds": None,
        "feed_odds": onewin_sportsbook._to_float(arb.get("bk2_odds")),
        "selection": arb.get("bk2_selection"),
        "raw_selection": raw,
        "event_id": event_id,
        "source": "onewin-public-ws",
    }
    matches: list[tuple[int, dict[str, Any], dict[str, Any]]] = []
    blocked = False
    for group in snapshot.get("oddsGroups") or []:
        if "double chance" not in str(group.get("name") or "").lower():
            continue
        for odd in group.get("oddsList") or []:
            if str(odd.get("outcome") or "").lower().replace("х", "x") != outcome:
                continue
            if onewin_sportsbook._to_int(odd.get("status")) == 1:
                group_name = str(group.get("name") or "")
                score = 10 if group_name.strip().lower() == "double chance" else 0
                if group.get("isBase"):
                    score += 1
                matches.append((score, group, odd))
            else:
                blocked = True
    matches.sort(key=lambda row: -row[0])
    best = [row for row in matches if row[0] == matches[0][0]] if matches else []
    if len(best) != 1:
        return {
            **base,
            "status": "SUSPENDED" if blocked and not matches else "AMBIGUOUS_CONTEXT" if len(best) > 1 else "UNAVAILABLE",
            "detail": "Exact 1win double-chance selection is not uniquely open",
        }
    _, group, odd = best[0]
    price = onewin_sportsbook._to_float(odd.get("cf"))
    if price is None or not math.isfinite(price) or price <= 1:
        return {**base, "detail": "1win returned an invalid decimal price"}
    return {
        **base,
        "verified": True,
        "status": "OK",
        "current_odds": price,
        "odds_group_id": str(group.get("id") or ""),
        "odds_group_name": group.get("name"),
        "selection_id": str(odd.get("id") or ""),
        "outcome": odd.get("outcome"),
        "points": onewin_sportsbook._odd_line(odd),
        "detail": f"1win public feed verified {group.get('name')} / {odd.get('name')}",
        "snapshot_ts": snapshot.get("ts"),
    }


def _team_total_quote(
    arb: dict[str, Any],
    event_id: str,
    snapshot: dict[str, Any],
) -> dict[str, Any] | None:
    raw = onewin_sportsbook.raw_counter_selection(arb)
    compact = re.sub(r"[^a-zа-я0-9]", "", raw.lower().replace("ё", "е"))
    match = re.match(r"(?:ит|it)([12])(б|м|over|under)", compact)
    if not match:
        return None
    team = int(match.group(1))
    direction = "over" if match.group(2) in {"б", "over"} else "under"
    line = onewin_sportsbook._line_from_text(raw)
    metadata = arb.get("pinnacle_market_metadata") or {}
    if line is None:
        line = onewin_sportsbook._to_float(metadata.get("counter_line"))
    target_values = (
        (arb.get("home_en"), arb.get("home")) if team == 1
        else (arb.get("away_en"), arb.get("away"))
    )
    other_values = (
        (arb.get("away_en"), arb.get("away")) if team == 1
        else (arb.get("home_en"), arb.get("home"))
    )
    targets = [str(value) for value in target_values if str(value or "").strip()]
    others = [str(value) for value in other_values if str(value or "").strip()]
    base = {
        "verified": False, "status": "UNAVAILABLE", "current_odds": None,
        "feed_odds": onewin_sportsbook._to_float(arb.get("bk2_odds")),
        "selection": arb.get("bk2_selection"), "raw_selection": raw,
        "event_id": event_id, "source": "onewin-public-ws",
    }
    candidates: list[tuple[float, dict[str, Any], dict[str, Any]]] = []
    blocked = False
    for group in snapshot.get("oddsGroups") or []:
        group_name = str(group.get("name") or "")
        lower = group_name.lower()
        if "total" not in lower or "player" in lower:
            continue
        target_score = max((onewin_sportsbook._team_similarity(value, group_name) for value in targets), default=0.0)
        other_score = max((onewin_sportsbook._team_similarity(value, group_name) for value in others), default=0.0)
        identity = target_score - 0.25 * other_score
        if target_score < 45:
            continue
        for odd in group.get("oddsList") or []:
            if str(odd.get("outcome") or "").lower() != direction:
                continue
            odd_line = onewin_sportsbook._odd_line(odd)
            if line is not None and (odd_line is None or abs(odd_line - line) > 0.001):
                continue
            if onewin_sportsbook._to_int(odd.get("status")) != 1:
                blocked = True
                continue
            candidates.append((identity, group, odd))
    candidates.sort(key=lambda row: -row[0])
    best = [row for row in candidates if abs(row[0] - candidates[0][0]) < 0.001] if candidates else []
    if len(best) != 1:
        return {
            **base,
            "status": "SUSPENDED" if blocked and not candidates else "AMBIGUOUS_CONTEXT" if len(best) > 1 else "UNAVAILABLE",
            "detail": "Exact 1win team-total selection is not uniquely open",
        }
    _, group, odd = best[0]
    price = onewin_sportsbook._to_float(odd.get("cf"))
    if price is None or price <= 1:
        return {**base, "detail": "1win returned an invalid decimal price"}
    return {
        **base, "verified": True, "status": "OK", "current_odds": price,
        "odds_group_id": str(group.get("id") or ""), "odds_group_name": group.get("name"),
        "selection_id": str(odd.get("id") or ""), "outcome": odd.get("outcome"),
        "points": onewin_sportsbook._odd_line(odd),
        "detail": f"1win public feed verified {group.get('name')} / {odd.get('name')}",
        "snapshot_ts": snapshot.get("ts"),
    }


def resolve_strict_quote(
    arb: dict[str, Any],
    event_id: str,
    snapshot: dict[str, Any],
    *,
    elapsed_ms: float | None = None,
) -> dict[str, Any]:
    """Resolve only inside the exact Forted map/set/half/property scope."""
    filtered = _filtered_snapshot(arb, snapshot)
    strict_status = filtered.get("_onewin_status")
    if strict_status:
        return {
            "verified": False,
            "status": strict_status,
            "current_odds": None,
            "feed_odds": onewin_sportsbook._to_float(arb.get("bk2_odds")),
            "selection": arb.get("bk2_selection"),
            "raw_selection": onewin_sportsbook.raw_counter_selection(arb),
            "event_id": event_id,
            "source": "onewin-public-ws",
            "detail": "1win market subject or outcome arity is not uniquely supported",
        }
    team_total = _team_total_quote(arb, event_id, filtered)
    if team_total is not None:
        if elapsed_ms is not None:
            team_total["elapsed_ms"] = round(elapsed_ms, 1)
        return team_total
    double_chance = _double_chance_quote(arb, event_id, filtered)
    if double_chance is not None:
        if elapsed_ms is not None:
            double_chance["elapsed_ms"] = round(elapsed_ms, 1)
        return double_chance
    event = {
        "homeTeam": {"name": arb.get("team1_en") or arb.get("home") or ""},
        "awayTeam": {"name": arb.get("team2_en") or arb.get("away") or ""},
    }
    strict_arb = dict(arb)
    context = legacy_market_context(requested_subject(str(arb.get("market_name") or "")))
    if context:
        strict_arb["market_context"] = context
    result = onewin_sportsbook.resolve_quote_from_snapshot(
        strict_arb,
        event_id,
        filtered,
        event=event,
        elapsed_ms=elapsed_ms,
    )
    if result.get("verified") and str(arb.get("market") or "").lower() == "moneyline":
        metadata = arb.get("pinnacle_market_metadata") or {}
        try:
            result["market_arity"] = int(str(metadata.get("market_arity")))
        except (TypeError, ValueError):
            pass
    return result
