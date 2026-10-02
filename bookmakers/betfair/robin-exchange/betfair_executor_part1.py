"""betfair_executor: часть 1 из 2.

Вынесено из betfair_executor.py без изменения логики: перенесён только текст,
ссылки на имена исходного модуля идут через ``betfair_executor.ИМЯ``, поэтому
подмена в тестах продолжает действовать.  Имена возвращаются в
исходный модуль звёздным импортом в его конце.
"""
from __future__ import annotations

from typing import Any
import math
import os
import re
import unicodedata

import betfair_executor
from betfair_executor import DEFAULT_TOLERANCE


class BetfairError(RuntimeError):
    pass

def _env_bool(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}

def _to_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None

def _norm_text(value: Any) -> str:
    text = str(value or "")
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower().replace("ё", "е")
    return re.sub(r"[^a-zа-я0-9]+", " ", text).strip()

def _compact(value: Any) -> str:
    return re.sub(r"[^a-zа-я0-9]+", "", betfair_executor._norm_text(value))

def _split_match_name(arb: dict[str, Any]) -> tuple[str, str]:
    home_en = str(arb.get("home_en") or arb.get("team1_en") or "").strip()
    away_en = str(arb.get("away_en") or arb.get("team2_en") or "").strip()
    if home_en and away_en:
        return home_en, away_en
    home = str(arb.get("home") or arb.get("team1") or "").strip()
    away = str(arb.get("away") or arb.get("team2") or "").strip()
    if home and away:
        return home, away
    raw = str(arb.get("match") or "")
    for sep in (" vs ", " v ", " - ", ":", "—"):
        if sep in raw:
            left, right = raw.split(sep, 1)
            return left.strip(), right.strip()
    return raw.strip(), ""

def is_betfair_bookmaker(value: Any) -> bool:
    text = str(value or "").strip().lower()
    return any(keyword in text for keyword in betfair_executor.BETFAIR_KEYWORDS)

def is_betfair_fork(arb: dict[str, Any]) -> bool:
    return (
        betfair_executor.is_betfair_bookmaker(arb.get("bk2"))
        or betfair_executor.is_betfair_bookmaker(arb.get("counter_bk"))
        or betfair_executor.is_betfair_bookmaker(arb.get("bk2_url"))
    )

def filter_betfair_arbs(
    arbs: list[dict[str, Any]],
    *,
    limit: int = 5,
    min_profit_pct: float | None = None,
) -> list[dict[str, Any]]:
    candidates = []
    for arb in arbs:
        if not isinstance(arb, dict) or not betfair_executor.is_betfair_fork(arb):
            continue
        if min_profit_pct is not None:
            profit = betfair_executor._to_float(arb.get("profit_pct"))
            if profit is None or profit < min_profit_pct:
                continue
        candidates.append(arb)
    candidates.sort(
        key=lambda item: (
            betfair_executor._to_float(item.get("profit_pct")) if betfair_executor._to_float(item.get("profit_pct")) is not None else -9999.0,
            str(item.get("id") or ""),
        ),
        reverse=True,
    )
    return candidates[: max(0, int(limit))]

def price_match(expected: Any, actual: Any, *, tolerance: float = DEFAULT_TOLERANCE) -> dict[str, Any]:
    expected_f = betfair_executor._to_float(expected)
    actual_f = betfair_executor._to_float(actual)
    tolerance_f = betfair_executor._to_float(tolerance)
    if tolerance_f is None or tolerance_f < 0:
        tolerance_f = 0.0
    if expected_f is None or expected_f <= 1:
        return {"ok": False, "status": "INVALID_EXPECTED"}
    if actual_f is None or actual_f <= 1:
        return {"ok": False, "status": "UNAVAILABLE"}
    difference = abs(expected_f - actual_f)
    ok = difference <= tolerance_f + 1e-12
    return {
        "ok": ok,
        "status": "OK" if ok else "MISMATCH",
    }

def _exchange_display_odds(exchange_odds: float, side: str) -> float:
    if str(side).upper() != "LAY":
        return exchange_odds
    if exchange_odds <= 1:
        return exchange_odds
    return round(exchange_odds / (exchange_odds - 1), 3)

def closing_stakes(arb: dict[str, Any], *, betfair_stake: float) -> dict[str, Any]:
    """Size Robin/Pinnacle legs from a fixed Betfair API order size."""
    betfair_odds = betfair_executor._to_float(arb.get("bk2_odds"))
    pin_odds = betfair_executor._to_float(arb.get("bk1_odds"))
    robin_odds = betfair_executor._to_float(arb.get("robin_odds"))
    stake = betfair_executor._to_float(betfair_stake)
    side = str(arb.get("betfair_side") or "BACK").strip().upper()
    if side not in {"BACK", "LAY"}:
        side = "BACK"
    if stake is None or stake <= 0:
        raise ValueError("betfair_stake must be positive")
    if betfair_odds is None or betfair_odds <= 1:
        raise ValueError("Betfair/Forted odds must be > 1")
    if pin_odds is None or pin_odds <= 1:
        raise ValueError("Pinnacle/Forted odds must be > 1")
    if robin_odds is None or robin_odds <= 1:
        raise ValueError("Robin odds must be > 1")

    exchange_odds = betfair_executor._to_float(arb.get("betfair_exchange_odds") or arb.get("exchange_odds"))
    if side == "LAY":
        if exchange_odds is None:
            exchange_odds = betfair_odds / (betfair_odds - 1)
        if exchange_odds <= 1:
            raise ValueError("Betfair exchange odds must be > 1 for LAY")
        liability = stake * (exchange_odds - 1)
        hedge_return = stake * exchange_odds
        pin_stake = round(hedge_return / pin_odds, 2)
        robin_stake = round(hedge_return / robin_odds, 2)
        pin_profit_if_lay_wins = round(stake - pin_stake, 2)
        pin_profit_if_lay_loses = round(pin_stake * (pin_odds - 1) - liability, 2)
        robin_profit_if_lay_wins = round(stake - robin_stake, 2)
        robin_profit_if_lay_loses = round(robin_stake * (robin_odds - 1) - liability, 2)
        return {
            "betfair_stake": round(stake, 2),
            "betfair_side": side,
            "betfair_odds": betfair_odds,
            "betfair_exchange_odds": exchange_odds,
            "betfair_return": round(stake, 2),
            "betfair_hedge_return": round(hedge_return, 2),
            "betfair_liability": round(liability, 2),
            "pinnacle_stake": pin_stake,
            "pinnacle_odds": pin_odds,
            "pinnacle_profit": min(pin_profit_if_lay_wins, pin_profit_if_lay_loses),
            "pinnacle_profit_if_lay_wins": pin_profit_if_lay_wins,
            "pinnacle_profit_if_lay_loses": pin_profit_if_lay_loses,
            "pinnacle_total_stake": round(liability + pin_stake, 2),
            "robin_stake": robin_stake,
            "robin_odds": robin_odds,
            "robin_profit": min(robin_profit_if_lay_wins, robin_profit_if_lay_loses),
            "robin_profit_if_lay_wins": robin_profit_if_lay_wins,
            "robin_profit_if_lay_loses": robin_profit_if_lay_loses,
            "robin_total_stake": round(liability + robin_stake, 2),
        }

    exchange_odds = exchange_odds or betfair_odds
    donor_return = stake * betfair_odds
    pin_stake = round(donor_return / pin_odds, 2)
    robin_stake = round(donor_return / robin_odds, 2)
    pin_total = round(stake + pin_stake, 2)
    robin_total = round(stake + robin_stake, 2)
    return {
        "betfair_stake": round(stake, 2),
        "betfair_side": side,
        "betfair_odds": betfair_odds,
        "betfair_exchange_odds": exchange_odds,
        "betfair_return": round(donor_return, 2),
        "betfair_hedge_return": round(donor_return, 2),
        "betfair_liability": 0.0,
        "pinnacle_stake": pin_stake,
        "pinnacle_odds": pin_odds,
        "pinnacle_profit": round(donor_return - pin_total, 2),
        "pinnacle_total_stake": pin_total,
        "robin_stake": robin_stake,
        "robin_odds": robin_odds,
        "robin_profit": round(donor_return - robin_total, 2),
        "robin_total_stake": robin_total,
    }

def _sport_key(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if "футбол" in raw or "soccer" in raw or "football" in raw:
        return "soccer"
    if "теннис" in raw or "tennis" in raw:
        return "tennis"
    if "баскет" in raw or "basket" in raw:
        return "basketball"
    if "хоккей" in raw or "hockey" in raw:
        return "hockey"
    if "волей" in raw or "volley" in raw:
        return "volleyball"
    if "handball" in raw or "гандбол" in raw:
        return "handball"
    return raw

def _event_type_id(sport: Any) -> str:
    return betfair_executor.BETFAIR_EVENT_TYPE_IDS.get(betfair_executor._sport_key(sport), betfair_executor.BETFAIR_EVENT_TYPE_IDS["soccer"])

def _exchange_side_and_selection(selection: str) -> tuple[str, str]:
    text = str(selection or "").strip()
    norm = betfair_executor._norm_text(text)
    tokens = norm.split()
    if not tokens:
        return "BACK", text
    side = "BACK"
    prefix = tokens[0]
    if prefix in {"против", "against", "lay"}:
        side = "LAY"
    elif prefix in {"за", "back"}:
        side = "BACK"
    else:
        return side, text
    stripped = re.sub(r"^\s*(?:против|against|lay|за|back)\b[\s:;-]*", "", text, flags=re.IGNORECASE).strip()
    return side, stripped or text

def _parse_market_selection(arb: dict[str, Any]) -> dict[str, Any]:
    market = str(arb.get("market") or "").strip()
    raw_selection = str(arb.get("bk2_selection") or arb.get("side2") or "").strip()
    exchange_side, selection = betfair_executor._exchange_side_and_selection(raw_selection)
    source_market_text = betfair_executor._arb_source_market_text(arb)
    lower_market = market.lower()
    lower_sel = selection.lower().replace(",", ".")
    compact = betfair_executor._compact(selection)
    parsed: dict[str, Any] = {
        "market": market,
        "selection": selection,
        "raw_selection": raw_selection,
        "exchange_side": exchange_side,
        "kind": "unknown",
    }

    is_individual_total = betfair_executor._is_individual_total_text(selection)
    if any(token in lower_market for token in ("total", "тотал")) or betfair_executor._total_direction_from_text(selection):
        direction = betfair_executor._total_direction_from_text(selection)
        line, line_has_sign = betfair_executor._line_from_selection_text(selection)
        metadata = betfair_executor._arb_market_metadata(arb)
        if line is None:
            line, line_has_sign = betfair_executor._line_from_market_text(source_market_text)
        if line is None:
            line = betfair_executor._to_float(metadata.get("line") or metadata.get("handicap"))
        home, away = betfair_executor._split_match_name(arb)
        team = (
            betfair_executor._total_team_from_text(selection, home=home, away=away)
            or betfair_executor._total_team_from_text(source_market_text, home=home, away=away)
            or betfair_executor._to_team(metadata.get("team"))
        )
        context = betfair_executor._market_context_from_text(selection)
        context.update(betfair_executor._market_context_from_text(source_market_text))
        context.update(betfair_executor._market_context_from_metadata(metadata))
        market_context = betfair_executor._arb_market_context(arb)
        parsed.update({
            "kind": "totals",
            "direction": direction,
            "line": line,
            "line_has_sign": line_has_sign,
            "team": team,
            "context": context,
            "market_context": market_context,
            "invalid_reason": "ambiguous_individual_total_team" if is_individual_total and team is None else "",
        })
        return parsed

    if any(token in lower_market for token in ("handicap", "гандикап", "фора")) or re.search(r"(handicap|ф[12])", lower_sel):
        home, away = betfair_executor._split_match_name(arb)
        metadata = betfair_executor._arb_market_metadata(arb)
        team = betfair_executor._handicap_team_from_selection(selection, home=home, away=away) or betfair_executor._to_team(metadata.get("team"))
        line, line_has_sign = betfair_executor._line_from_selection_text(selection)
        if betfair_executor._compact(selection) in {"1", "2", "home", "away", "ф1", "ф2"}:
            line, line_has_sign = None, False
        if line is None:
            line, line_has_sign = betfair_executor._line_from_market_text(source_market_text)
        context = betfair_executor._market_context_from_text(selection)
        context.update(betfair_executor._market_context_from_text(source_market_text))
        context.update(betfair_executor._market_context_from_metadata(metadata))
        parsed.update({
            "kind": "handicap",
            "team": team,
            "line": line,
            "line_has_sign": line_has_sign,
            "context": context,
            "market_context": betfair_executor._arb_market_context(arb),
            "invalid_reason": "ambiguous_handicap_team" if team is None else "",
        })
        return parsed

    if any(token in lower_market for token in ("moneyline", "1x2", "winner", "match odds")) or compact in {"home", "away", "draw", "1", "2", "x"}:
        if compact in {"home", "1"}:
            team = 1
        elif compact in {"away", "2"}:
            team = 2
        elif compact in {"draw", "x", "ничья"}:
            team = 0
        else:
            team = None
        metadata = betfair_executor._arb_market_metadata(arb)
        context = betfair_executor._market_context_from_text(selection)
        context.update(betfair_executor._market_context_from_text(source_market_text))
        context.update(betfair_executor._market_context_from_metadata(metadata))
        parsed.update({"kind": "moneyline", "team": team, "context": context, "market_context": betfair_executor._arb_market_context(arb)})
        return parsed

    return parsed

def _arb_source_market_text(arb: dict[str, Any]) -> str:
    return " ".join(
        str(arb.get(key) or "")
        for key in (
            "market",
            "market_name",
            "display_market",
            "bk2_market",
            "bk2_market_name",
            "betfair_market",
            "betfair_market_name",
        )
    ).strip()

def _line_from_selection_text(value: str) -> tuple[float | None, bool]:
    text = value.replace(",", ".")
    text = text.translate(betfair_executor._SIGN_TRANSLATION)
    paren_matches = re.findall(r"\(([-+]?\d+(?:\.\d+)?)\)", text)
    if paren_matches:
        raw = paren_matches[-1]
        return betfair_executor._to_float(raw), raw.startswith(("+", "-"))
    signed_matches = re.findall(r"[-+]\d+(?:\.\d+)?", text)
    if signed_matches:
        return betfair_executor._to_float(signed_matches[-1]), True
    number_matches = list(re.finditer(r"\d+(?:\.\d+)?", text))
    for match in reversed(number_matches):
        raw = match.group(0)
        prev = text[match.start() - 1].lower() if match.start() > 0 else ""
        before_norm = betfair_executor._norm_text(text[:match.start()])
        after_norm = betfair_executor._norm_text(text[match.end():])
        if raw in {"1", "2"} and prev == "ф":
            continue
        if raw in {"1", "2"} and re.search(r"\b(handicap|фора|гандикап)\s*$", before_norm) and not after_norm:
            continue
        if raw in {"1", "2"} and re.search(r"\b(team|команда)\s*$", before_norm):
            continue
        return betfair_executor._to_float(raw), False
    return None, False

def _line_from_market_text(value: Any) -> tuple[float | None, bool]:
    text = str(value or "").replace(",", ".").translate(betfair_executor._SIGN_TRANSLATION)
    text = re.sub(r"\b(?:game|гейм|set|сет)\s*\d+\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(
        r"\b(?:p\s*\d+|\d+\s*(?:p|п|period|пер(?:иод)?|half|тайм))\b",
        " ",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"\b(?:team|команда)\s*[12]\b", " ", text, flags=re.IGNORECASE)
    return betfair_executor._line_from_selection_text(text)

def _arb_market_metadata(arb: dict[str, Any]) -> dict[str, Any]:
    for key in ("betfair_market_metadata", "bk2_market_metadata"):
        value = arb.get(key)
        if isinstance(value, dict):
            return value
    return {}

def _to_team(value: Any) -> int | None:
    text = str(value or "").strip().lower()
    if text in {"1", "home", "team1", "team_1", "команда1"}:
        return 1
    if text in {"2", "away", "team2", "team_2", "команда2"}:
        return 2
    return None

def _total_direction_from_text(value: Any) -> str | None:
    text = str(value or "").replace(",", ".").translate(betfair_executor._SIGN_TRANSLATION).lower()
    norm = betfair_executor._norm_text(text)
    compact = betfair_executor._compact(text)
    individual = re.search(r"(?:ит|it)\s*[12]?\s*(?:([бbмm<>])|(over|under|more|less))", text)
    if individual:
        token = individual.group(1) or individual.group(2)
        if token in {"б", "b", ">", "over", "more"}:
            return "OVER"
        if token in {"м", "m", "<", "under", "less"}:
            return "UNDER"
    if re.search(r"\b(over|more|greater)\b", norm) or "тб" in compact:
        return "OVER"
    if re.search(r"\b(under|less|lower)\b", norm) or "тм" in compact:
        return "UNDER"
    return None

def _is_individual_total_text(value: Any) -> bool:
    return bool(re.search(r"(?:ит|it)\s*[12]?\s*(?:[бbмm<>]|over|under|more|less)", str(value or "").lower()))

def _total_team_from_text(value: Any, *, home: str = "", away: str = "") -> int | None:
    text = str(value or "").replace(",", ".").translate(betfair_executor._SIGN_TRANSLATION).lower()
    individual = re.search(r"(?:ит|it)\s*([12])\s*(?:[бbмm<>]|over|under|more|less)", text)
    if individual:
        return int(individual.group(1))
    compact = betfair_executor._compact(text)
    compact_home = betfair_executor._compact(home)
    compact_away = betfair_executor._compact(away)
    if compact_away and compact_away in compact:
        return 2
    if compact_home and compact_home in compact:
        return 1
    norm = betfair_executor._norm_text(text)
    if re.search(r"\b(team|команда)\s*1\b", norm):
        return 1
    if re.search(r"\b(team|команда)\s*2\b", norm):
        return 2
    if re.search(r"\b(home|хозяева)\b", norm):
        return 1
    if re.search(r"\b(away|гости)\b", norm):
            return 2
    return None

def _arb_market_context(arb: dict[str, Any]) -> str:
    metadata = betfair_executor._arb_market_metadata(arb)
    explicit = betfair_executor._normalize_market_context(arb.get("market_context") or metadata.get("market_context"))
    if explicit:
        return explicit
    return betfair_executor._market_context_label_from_text(
        arb.get("bk1_event_name"),
        arb.get("bk2_event_name"),
        arb.get("market_name"),
        arb.get("display_market"),
        arb.get("market"),
    )

def _normalize_market_context(value: Any) -> str:
    clean = str(value or "").strip().lower()
    if clean == "cards":
        return "bookings"
    return clean

def _market_context_label_from_text(*values: Any) -> str:
    haystack = " ".join(str(value or "") for value in values).strip().lower()
    if not haystack:
        return ""
    for context, patterns in betfair_executor._MARKET_CONTEXT_PATTERNS:
        if any(pattern in haystack for pattern in patterns):
            return context
    return ""

def _market_context_matches(wanted: str | None, market: dict[str, Any]) -> bool:
    expected = betfair_executor._normalize_market_context(wanted)
    actual = betfair_executor._market_context_label_from_text(
        market.get("marketName"),
        (market.get("description") or {}).get("marketType"),
    )
    if expected:
        return actual == expected
    return actual == ""

def _market_context_from_text(value: Any) -> dict[str, int]:
    text = str(value or "").replace(",", ".").translate(betfair_executor._SIGN_TRANSLATION).lower()
    norm = betfair_executor._norm_text(text)
    context: dict[str, int] = {}
    period = re.match(
        r"\s*(?:p\s*(\d+)|(\d+)\s*(?:p|п|period|пер(?:иод)?|half|тайм))\.?\s*[:;,\-/]?\s+",
        text,
    )
    if period:
        context["period_number"] = int(period.group(1) or period.group(2))
    elif re.search(r"\b(first|1st)\s+(?:half|period)\b", norm):
        context["period_number"] = 1
    elif re.search(r"\b(second|2nd)\s+(?:half|period)\b", norm):
        context["period_number"] = 2

    set_match = re.search(r"\b(?:set|сет)\s*(\d+)\b", norm)
    if set_match:
        context["set_number"] = int(set_match.group(1))
    game_match = re.search(r"\b(?:game|гейм)\s*(\d+)\b", norm)
    if game_match:
        context["game_number"] = int(game_match.group(1))
    return context

def _market_context_from_metadata(metadata: dict[str, Any]) -> dict[str, int]:
    context: dict[str, int] = {}
    for output_key, aliases in (
        ("period_number", ("period_number", "periodNumber", "period_num", "periodNum", "period")),
        ("set_number", ("set_number", "setNumber", "set_num", "setNum", "set")),
        ("game_number", ("game_number", "gameNumber", "game_num", "gameNum", "game")),
    ):
        for alias in aliases:
            value = metadata.get(alias)
            try:
                number = int(value)
            except (TypeError, ValueError):
                continue
            if number > 0:
                context[output_key] = number
                break
    return context

def _market_context_from_market(market: dict[str, Any]) -> dict[str, int]:
    description = market.get("description") or {}
    market_type = description.get("marketType") or ""
    return betfair_executor._market_context_from_text(f"{market.get('marketName') or ''} {market_type}")

def _contexts_compatible(wanted: dict[str, int] | None, market_context: dict[str, int] | None) -> bool:
    wanted = wanted or {}
    market_context = market_context or {}
    for key in ("period_number", "set_number", "game_number"):
        expected = wanted.get(key)
        actual = market_context.get(key)
        if expected is not None and actual != expected:
            return False
        if expected is None and actual is not None:
            return False
    return True

def _total_team_matches_market(team: int | None, market_name: str, home: str, away: str) -> bool:
    if team is None:
        return True
    target = home if team == 1 else away if team == 2 else ""
    compact_market = betfair_executor._compact(market_name)
    if target and betfair_executor._compact(target) and betfair_executor._compact(target) in compact_market:
        return True
    norm_market = betfair_executor._norm_text(market_name)
    if team == 1 and re.search(r"\b(home|team\s*1|команда\s*1)\b", norm_market):
        return True
    if team == 2 and re.search(r"\b(away|team\s*2|команда\s*2)\b", norm_market):
        return True
    return False

def _is_team_total_market(market_name: str, home: str, away: str) -> bool:
    compact_market = betfair_executor._compact(market_name)
    for target in (home, away):
        compact_target = betfair_executor._compact(target)
        if compact_target and compact_target in compact_market:
            return True
    norm_market = betfair_executor._norm_text(market_name)
    return bool(re.search(r"\b(home|away|team\s*[12]|команда\s*[12])\b", norm_market))

def _runner_total_direction(runner_name: str) -> str | None:
    compact = betfair_executor._compact(runner_name)
    norm = betfair_executor._norm_text(runner_name)
    if re.search(r"\b(over|more|greater)\b", norm) or "тб" in compact:
        return "OVER"
    if re.search(r"\b(under|less|lower)\b", norm) or "тм" in compact:
        return "UNDER"
    return None

def _handicap_team_from_selection(value: str, *, home: str = "", away: str = "") -> int | None:
    text = str(value or "").replace(",", ".").translate(betfair_executor._SIGN_TRANSLATION).lower()
    text = re.sub(r"\([-+]?\d+(?:\.\d+)?\)", " ", text)
    text = re.sub(r"[-+]\d+(?:\.\d+)?", " ", text)
    compact = betfair_executor._compact(text)
    norm = betfair_executor._norm_text(text)
    compact_home = betfair_executor._compact(home)
    compact_away = betfair_executor._compact(away)
    if compact_away and compact_away in compact:
        return 2
    if compact_home and compact_home in compact:
        return 1
    if re.search(r"\b(handicap|фора|гандикап)\s*2\b", norm) or re.search(r"\b(ф2|f2)\b", norm):
        return 2
    if re.search(r"\b(handicap|фора|гандикап)\s*1\b", norm) or re.search(r"\b(ф1|f1)\b", norm):
        return 1
    if compact.startswith(("ф2", "f2")) or re.search(r"\b(away|гости)\b", norm):
        return 2
    if compact.startswith(("ф1", "f1")) or re.search(r"\b(home|хозяева)\b", norm):
        return 1
    if re.search(r"\b(team|команда)\s*2\b", norm):
        return 2
    if re.search(r"\b(team|команда)\s*1\b", norm):
        return 1
    tokens = re.findall(r"[a-zа-я]+|\d+", norm)
    if tokens and tokens[0] == "2":
        return 2
    if tokens and tokens[0] == "1":
        return 1
    return None

def _is_match_odds_market(market: dict[str, Any]) -> bool:
    market_type = str(((market.get("description") or {}).get("marketType") or "")).upper()
    market_name = betfair_executor._norm_text(market.get("marketName"))
    return market_type == "MATCH_ODDS" or betfair_executor._compact(market_name) in {"matchodds", "moneyline"}

def _is_moneyline_like_market(market: dict[str, Any], parsed: dict[str, Any]) -> bool:
    market_type = str(((market.get("description") or {}).get("marketType") or "")).upper()
    market_name = betfair_executor._norm_text(market.get("marketName"))
    market_context = betfair_executor._market_context_from_market(market)
    if not betfair_executor._contexts_compatible(parsed.get("context"), market_context):
        return False
    if betfair_executor._is_match_odds_market(market):
        return True
    if "SET_WINNER" in market_type or re.search(r"\bset\s*\d*\s*winner\b", market_name):
        return parsed.get("context", {}).get("set_number") is not None
    if "GAME_WINNER" in market_type or re.search(r"\bgame\s*\d*\s*winner\b", market_name):
        return parsed.get("context", {}).get("game_number") is not None
    if "MATCH_ODDS" in market_type and parsed.get("context"):
        return True
    if re.search(r"\b(?:first|1st|second|2nd)\s+(?:half|period)\s+(?:match\s+odds|winner)\b", market_name):
        return parsed.get("context", {}).get("period_number") is not None
    return False

def _clean_market_id(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    text = text.strip("'\" ")
    return text if re.fullmatch(r"\d+(?:\.\d+)+", text) else None

def _clean_selection_id(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    text = text.strip("'\" ")
    return text if re.fullmatch(r"\d+", text) else None

def _clean_event_id(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    text = text.strip("'\" /")
    return text if re.fullmatch(r"\d{7,}", text) else None

def extract_market_id(value: Any) -> str | None:
    """Return an explicit Betfair marketId from an arb, field, URL, or bare id."""
    if isinstance(value, dict):
        for key in (
            "betfair_market_id",
            "betfairMarketId",
            "bk2_market_id",
            "counter_market_id",
            "market_id",
            "marketId",
        ):
            market_id = betfair_executor._clean_market_id(value.get(key))
            if market_id:
                return market_id
        for key in (
            "betfair_url",
            "bk2_url",
            "bk2_raw_link",
            "url",
            "link",
            "bet_link",
            "mobl",
        ):
            market_id = betfair_executor.extract_market_id(value.get(key))
            if market_id:
                return market_id
        return None

    text = str(value or "").strip()
    if not text:
        return None
    direct = betfair_executor._clean_market_id(text)
    if direct:
        return direct
    for pattern in (
        r"/market/(\d+(?:\.\d+)+)",
        r"(?:^|[?&#])marketId=(\d+(?:\.\d+)+)",
        r"(?:^|[?&#])market_id=(\d+(?:\.\d+)+)",
    ):
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            return match.group(1)
    return None

def extract_selection_id(value: Any) -> str | None:
    """Return an explicit Betfair selectionId from an arb, field, URL, or bare id."""
    if isinstance(value, dict):
        for key in (
            "betfair_selection_id",
            "betfairSelectionId",
            "bk2_selection_id",
            "counter_selection_id",
            "selectionId",
        ):
            selection_id = betfair_executor._clean_selection_id(value.get(key))
            if selection_id:
                return selection_id
        for key in (
            "betfair_url",
            "bk2_url",
            "bk2_raw_link",
            "url",
            "link",
            "bet_link",
            "mobl",
        ):
            selection_id = betfair_executor.extract_selection_id(value.get(key))
            if selection_id:
                return selection_id
        return None

    text = str(value or "").strip()
    if not text:
        return None
    for pattern in (
        r"(?:^|[?&#])selectionId=(\d+)",
        r"(?:^|[?&#])selection_id=(\d+)",
    ):
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            return match.group(1)
    return None

def extract_event_id(value: Any) -> str | None:
    """Return an explicit Betfair eventId from Betfair-specific fields or links."""
    if isinstance(value, dict):
        for key in (
            "betfair_event_id",
            "betfairEventId",
            "bk2_event_id",
            "counter_event_id",
        ):
            event_id = betfair_executor._clean_event_id(value.get(key))
            if event_id:
                return event_id
        for key in (
            "betfair_url",
            "bk2_url",
            "bk2_raw_link",
            "url",
            "link",
            "bet_link",
            "mobl",
        ):
            event_id = betfair_executor.extract_event_id(value.get(key))
            if event_id:
                return event_id
        return None

    text = str(value or "").strip()
    if not text:
        return None
    if betfair_executor.extract_market_id(text):
        return None
    direct = betfair_executor._clean_event_id(text)
    if direct:
        return direct
    for pattern in (
        r"/event/(\d{7,})",
        r"/(\d{7,})(?:[/?#]|$)",
        r"(?:^|[?&#])eventId=(\d{7,})",
        r"(?:^|[?&#])event_id=(\d{7,})",
    ):
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            return match.group(1)
    return None

def _extract_market_id(url: Any) -> str | None:
    return betfair_executor.extract_market_id(url)

def _extract_event_numeric_id(url: Any) -> str | None:
    return betfair_executor.extract_event_id(url)

__all__ = [
    "BetfairError",
    "_arb_market_context",
    "_arb_market_metadata",
    "_arb_source_market_text",
    "_clean_event_id",
    "_clean_market_id",
    "_clean_selection_id",
    "_compact",
    "_contexts_compatible",
    "_env_bool",
    "_event_type_id",
    "_exchange_display_odds",
    "_exchange_side_and_selection",
    "_extract_event_numeric_id",
    "_extract_market_id",
    "_handicap_team_from_selection",
    "_is_individual_total_text",
    "_is_match_odds_market",
    "_is_moneyline_like_market",
    "_is_team_total_market",
    "_line_from_market_text",
    "_line_from_selection_text",
    "_market_context_from_market",
    "_market_context_from_metadata",
    "_market_context_from_text",
    "_market_context_label_from_text",
    "_market_context_matches",
    "_norm_text",
    "_normalize_market_context",
    "_parse_market_selection",
    "_runner_total_direction",
    "_split_match_name",
    "_sport_key",
    "_to_float",
    "_to_team",
    "_total_direction_from_text",
    "_total_team_from_text",
    "_total_team_matches_market",
    "closing_stakes",
    "extract_event_id",
    "extract_market_id",
    "extract_selection_id",
    "filter_betfair_arbs",
    "is_betfair_bookmaker",
    "is_betfair_fork",
    "price_match",
]
