"""Fast public-price verification for Paddy Power / Betfair Sportsbook forks.

Paddy Power and Betfair Sportsbook share fixed-odds prices, but those prices
are unrelated to the Betfair Exchange order book.  This module reads Paddy's
public sportsbook JSON endpoints with a browser TLS fingerprint, resolves the
exact event/market/runner, and returns the current bookmaker decimal price.

No login or bet submission endpoint is used here.
"""
from __future__ import annotations

import asyncio
import math
import os
import re
import threading
import time
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any
from urllib.parse import quote

from curl_cffi import requests as curl_requests


DEFAULT_APP_KEY = "vsd0Rm5ph2sS2uaK"
DEFAULT_EVENT_PAGE_URL = "https://apisms.paddypower.com/smspp/event-page/v5"
DEFAULT_MARKETS_URL = "https://apisms.paddypower.com/smspp/markets/v3"
DEFAULT_ORIGIN = "https://www.paddypower.com"

_SIGN_TRANSLATION = str.maketrans({"−": "-", "–": "-", "—": "-", "﹣": "-", "－": "-", "＋": "+"})
_CYRILLIC_TRANSLATION = str.maketrans({
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "i", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
})

_BASE_MARKET_TYPE_CODES = {
    "MATCH_ODDS", "MONEY_LINE", "DOUBLE_CHANCE", "HANDICAP_BETTING",
    "SET_HANDICAP_TW", "ALTERNATIVE_SET_HANDICAP", "SET_X_GAME_HANDICAP",
    "SET_X_GAME_HANDICAP_3_WAY", "ALTERNATIVE_GAME_HANDICAP_1MI",
    "OVER_UNDER_GAME_HANDICAP", "GAME_HANDICAP_3WAY", "V_OVER_UNDER",
    "V_OVER_UNDER_HALF_TIME", "TOTAL_MATCH_GAMES", "ALTERNATIVE_TOTAL_GAMES",
    "TOTAL_PLAYER_A_GAMES", "TOTAL_PLAYER_B_GAMES", "SET_X_TOTAL_GAMES_3-WAY",
    "TOTAL_MATCH_GAMES_3WAY", "V_HOME_TEAM_TOTAL_GOALS", "V_AWAY_TEAM_TOTAL_GOALS",
    "V_HOME_TEAM_FIRST_HALF_GOALS", "V_AWAY_TEAM_FIRST_HALF_GOALS",
    "V_HOME_TEAM_SECOND_HALF_GOALS", "V_AWAY_TEAM_SECOND_HALF_GOALS",
}

EXACT_UNAVAILABLE_STATUSES = frozenset({
    "EXACT_SELECTION_SUPERSEDED",
    "SUSPENDED",
    "PRICE_UNAVAILABLE",
})
_IDENTITY_MEMORY_LIMIT = 4096


class PaddySportsbookError(RuntimeError):
    pass


@dataclass(frozen=True)
class PaddySportsbookConfig:
    proxy_url: str = ""
    app_key: str = DEFAULT_APP_KEY
    event_page_url: str = DEFAULT_EVENT_PAGE_URL
    markets_url: str = DEFAULT_MARKETS_URL
    timeout_sec: float = 5.0
    request_attempts: int = 2
    cache_ttl_sec: float = 0.75
    impersonate: str = "chrome"

    @classmethod
    def from_env(cls) -> "PaddySportsbookConfig":
        return cls(
            proxy_url=os.getenv("PADDY_SPORTSBOOK_PROXY", "").strip(),
            app_key=os.getenv("PADDY_SPORTSBOOK_APP_KEY", DEFAULT_APP_KEY).strip() or DEFAULT_APP_KEY,
            event_page_url=os.getenv("PADDY_SPORTSBOOK_EVENT_PAGE_URL", DEFAULT_EVENT_PAGE_URL).strip(),
            markets_url=os.getenv("PADDY_SPORTSBOOK_MARKETS_URL", DEFAULT_MARKETS_URL).strip(),
            timeout_sec=max(1.0, float(os.getenv("PADDY_SPORTSBOOK_TIMEOUT_SEC", "5"))),
            request_attempts=max(1, int(os.getenv("PADDY_SPORTSBOOK_REQUEST_ATTEMPTS", "2"))),
            cache_ttl_sec=max(0.0, float(os.getenv("PADDY_SPORTSBOOK_CACHE_TTL_SEC", "0.75"))),
            impersonate=os.getenv("PADDY_SPORTSBOOK_IMPERSONATE", "chrome").strip() or "chrome",
        )

    def configured(self) -> bool:
        return bool(self.proxy_url and self.event_page_url and self.markets_url and self.app_key)


def is_sportsbook_fork(arb: dict[str, Any]) -> bool:
    values = " ".join(str(arb.get(key) or "") for key in (
        "bk1", "bk2", "counter_bk", "bk1_url", "bk2_url", "bk1_raw_link", "bk2_raw_link",
    )).lower()
    if "paddypower" in values or "paddy power" in values:
        return True
    if "betfair" not in values or "/exchange/" in values or "betfair exchange" in values:
        return False
    return "/sport/" in values or "/betting/" in values or "sportsbook" in values


def extract_event_id(arb: dict[str, Any]) -> str | None:
    for key in ("paddy_event_id", "sportsbook_event_id", "bk2_raw_link", "bk2_url", "bk1_raw_link", "bk1_url"):
        raw = str(arb.get(key) or "").strip()
        if not raw:
            continue
        match = re.search(r"-(\d{6,})(?:[/?#]|$)", raw)
        if match:
            return match.group(1)
        match = re.search(r"(?:[?&#])eventI[dD]=([0-9]{6,})", raw)
        if match:
            return match.group(1)
    return None


def _norm(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or "").lower().translate(_CYRILLIC_TRANSLATION))
    text = "".join(char for char in text if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _compact(value: Any) -> str:
    return _norm(value).replace(" ", "")


def _ascii_header_url(value: Any) -> str:
    """Encode non-ASCII URL characters before passing the value to libcurl."""
    return quote(str(value or ""), safe=":/?#[]@!$&'()*+,;=%")


def _to_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _to_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _split_pair(value: Any) -> tuple[str, str]:
    raw = str(value or "").strip()
    for separator in (" vs ", " v ", " @ ", " at ", " - ", " — ", ":"):
        if separator in raw:
            left, right = raw.split(separator, 1)
            return left.strip(), right.strip()
    return raw, ""


def _similarity(first: Any, second: Any) -> float:
    a, b = _compact(first), _compact(second)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return min(len(a), len(b)) / max(len(a), len(b)) + 0.35
    return SequenceMatcher(None, a, b).ratio()


def _canonical_pair(arb: dict[str, Any]) -> tuple[str, str]:
    home = str(arb.get("home") or "").strip()
    away = str(arb.get("away") or "").strip()
    if home and away:
        return home, away
    return _split_pair(arb.get("match"))


def _api_pair(event: dict[str, Any]) -> tuple[str, str]:
    return _split_pair(event.get("name"))


def _team_mapping(arb: dict[str, Any], event: dict[str, Any]) -> tuple[dict[int, int], float]:
    """Map canonical fork teams 1/2 to Paddy event HOME/AWAY indices 1/2."""
    canonical = _canonical_pair(arb)
    api = _api_pair(event)
    direct_parts = (_similarity(canonical[0], api[0]), _similarity(canonical[1], api[1]))
    reverse_parts = (_similarity(canonical[0], api[1]), _similarity(canonical[1], api[0]))
    direct = sum(direct_parts)
    reverse = sum(reverse_parts)
    if max(direct, reverse) >= 0.8:
        if reverse > direct:
            return {1: 2, 2: 1}, reverse
        return {1: 1, 2: 2}, direct

    # Some feeds only expose reliable English names in Paddy's own order.
    en_pair = (str(arb.get("team1_en") or ""), str(arb.get("team2_en") or ""))
    en_direct = _similarity(en_pair[0], api[0]) + _similarity(en_pair[1], api[1])
    en_reverse = _similarity(en_pair[0], api[1]) + _similarity(en_pair[1], api[0])
    if max(en_direct, en_reverse) > max(direct, reverse):
        if en_reverse > en_direct:
            return {1: 2, 2: 1}, en_reverse
        return {1: 1, 2: 2}, en_direct
    return ({1: 2, 2: 1} if reverse > direct else {1: 1, 2: 2}), max(direct, reverse)


def _selection_team(value: Any) -> int | None:
    text = str(value or "").strip().lower().replace("ё", "е")
    compact = re.sub(r"[^a-zа-я0-9]+", "", text)
    if compact in {"home", "1", "п1", "ф1", "f1"} or compact.startswith(("handicap1", "фора1", "ф1", "f1", "ит1", "it1")):
        return 1
    if compact in {"away", "2", "п2", "ф2", "f2"} or compact.startswith(("handicap2", "фора2", "ф2", "f2", "ит2", "it2")):
        return 2
    if compact.startswith(("к1пройдет", "к1пройдет", "team1toqualify", "1toqualify")):
        return 1
    if compact.startswith(("к2пройдет", "к2пройдет", "team2toqualify", "2toqualify")):
        return 2
    match = re.match(r"\s*([12])\s*\(", text)
    return int(match.group(1)) if match else None


def _line_from_text(value: Any) -> float | None:
    text = str(value or "").replace(",", ".").translate(_SIGN_TRANSLATION)
    parenthesized = re.findall(r"\(([-+]?\d+(?:\.\d+)?)\)", text)
    if parenthesized:
        return _to_float(parenthesized[-1])
    signed = re.findall(r"[-+]\d+(?:\.\d+)?", text)
    if signed:
        return _to_float(signed[-1])
    numbers = re.findall(r"\d+(?:\.\d+)?", text)
    return _to_float(numbers[-1]) if numbers else None


def _score_handicap(value: Any, team: int | None) -> float | None:
    match = re.search(r"\(([-+]?\d+)\s*:\s*([-+]?\d+)\)", str(value or ""))
    if not match or team not in {1, 2}:
        return None
    first, second = float(match.group(1)), float(match.group(2))
    return first - second if team == 1 else second - first


def _direction(value: Any) -> str | None:
    text = str(value or "").lower()
    compact = re.sub(r"[^a-zа-я0-9<>]+", "", text)
    if re.search(r"\b(over|more|greater)\b", text) or "тб" in compact or re.search(r"(?:ит|it)\s*[12]?\s*[бb>]", text):
        return "OVER"
    if re.search(r"\b(under|less|lower)\b", text) or "тм" in compact or re.search(r"(?:ит|it)\s*[12]?\s*[мm<]", text):
        return "UNDER"
    return None


def _double_chance(value: Any) -> set[int] | None:
    compact = re.sub(r"[^a-zа-я0-9]+", "", str(value or "").lower())
    if compact in {"1x", "x1", "homeordraw"}:
        return {1, 0}
    if compact in {"x2", "2x", "awayordraw"}:
        return {2, 0}
    if compact in {"12", "homeoraway"}:
        return {1, 2}
    return None


def _metadata(arb: dict[str, Any]) -> dict[str, Any]:
    value = arb.get("pinnacle_market_metadata") or arb.get("market_metadata") or {}
    return value if isinstance(value, dict) else {}


def _descriptor(arb: dict[str, Any]) -> dict[str, Any]:
    family = str(arb.get("market") or _metadata(arb).get("family") or "").strip().lower()
    selection = str(arb.get("bk2_selection") or arb.get("side2") or "").strip()
    meta = _metadata(arb)
    context = {
        "set": _to_int(arb.get("set_number") or meta.get("set_number")),
        "game": _to_int(arb.get("game_number") or meta.get("game_number")),
        "period": _to_int(meta.get("period_number") or meta.get("period")),
    }
    market_context = str(arb.get("market_context") or meta.get("market_context") or "").strip().lower()
    if "total" in family or "тотал" in family:
        individual_text = f"{selection} {meta.get('raw_selection') or ''}"
        individual = bool(re.search(r"(?:ит|it)\s*[12]|individual|player\s+[ab]?\s*total", individual_text, re.IGNORECASE))
        return {
            "kind": "totals", "selection": selection,
            "team": (_selection_team(selection) or _to_int(meta.get("team"))) if individual else None,
            "line": _line_from_text(selection) or _to_float(meta.get("line") or meta.get("handicap")),
            "direction": _direction(selection), "context": context, "market_context": market_context,
        }
    if "handicap" in family or "фора" in family or "гандикап" in family:
        team = _selection_team(selection)
        pin_line = _to_float(meta.get("line") or meta.get("handicap"))
        if re.sub(r"[^a-zа-я0-9]+", "", selection.lower()) in {"home", "away", "1", "2", "п1", "п2"}:
            return {
                "kind": "moneyline", "selection": selection, "team": team, "context": context,
                "market_context": market_context, "opposed_half_handicap": True,
            }
        line = _score_handicap(selection, team)
        if line is None:
            line = _line_from_text(selection)
        if line is None:
            line = -pin_line if pin_line is not None else None
        return {
            "kind": "handicap", "selection": selection, "team": team, "line": line,
            "context": context, "market_context": market_context,
        }
    chance = _double_chance(selection)
    if chance:
        return {
            "kind": "double_chance", "selection": selection, "teams": chance,
            "context": context, "market_context": market_context,
        }
    compact = re.sub(r"[^a-zа-я0-9]+", "", selection.lower())
    if compact in {"draw", "x", "ничья"}:
        team = 0
    else:
        team = _selection_team(selection)
    qualifier = bool(re.search(r"пройд[её]т|to\s+qualify", selection, re.IGNORECASE))
    return {
        "kind": "moneyline", "selection": selection, "team": team, "context": context,
        "market_context": market_context, "qualifier": qualifier,
    }


def _outcome_identity_key(arb: dict[str, Any], event_id: str | None = None) -> tuple[str, ...]:
    """Stable logical Paddy outcome identity, independent from price and fork id."""
    desc = _descriptor(arb)
    context = desc.get("context") or {}
    line = _to_float(desc.get("line"))
    return (
        str(event_id or extract_event_id(arb) or ""),
        str(desc.get("kind") or ""),
        str(desc.get("team") if desc.get("team") is not None else ""),
        ",".join(str(value) for value in sorted(desc.get("teams") or set())),
        "" if line is None else f"{line:.6f}",
        str(desc.get("direction") or ""),
        str(context.get("set") or ""),
        str(context.get("game") or ""),
        str(context.get("period") or ""),
        str(desc.get("market_context") or ""),
        "1" if desc.get("qualifier") else "0",
    )


def _mapping_value(mapping: Any, key: Any) -> Any:
    if not isinstance(mapping, dict):
        return None
    if key in mapping:
        return mapping[key]
    text = str(key)
    if text in mapping:
        return mapping[text]
    if text.isdigit() and int(text) in mapping:
        return mapping[int(text)]
    return None


def _exact_identity_change(
    snapshot: dict[str, Any], event_id: str, identity: dict[str, Any]
) -> tuple[str, str] | None:
    """Prove that a previously verified exact runner changed in a newer snapshot."""
    if snapshot.get("_paddy_markets_complete") is not True:
        return None
    attachments = snapshot.get("attachments") or {}
    event = _mapping_value(attachments.get("events"), event_id)
    if not isinstance(event, dict):
        return None
    market_id = str(identity.get("market_id") or "")
    selection_id = str(identity.get("selection_id") or "")
    if not market_id or not selection_id:
        return None
    market_row = _mapping_value(attachments.get("markets"), market_id)
    if not isinstance(market_row, dict):
        return (
            "EXACT_SELECTION_SUPERSEDED",
            f"Previously verified Paddy market {market_id} is absent from the newer complete event snapshot",
        )
    runner_row = next(
        (
            row for row in market_row.get("runners") or []
            if isinstance(row, dict) and str(row.get("selectionId") or "") == selection_id
        ),
        None,
    )
    if not isinstance(runner_row, dict):
        return (
            "EXACT_SELECTION_SUPERSEDED",
            f"Previously verified Paddy selection {selection_id} is absent from market {market_id}",
        )
    expected_line = _to_float(identity.get("expected_line"))
    actual_line = _runner_line(market_row, runner_row)
    if expected_line is not None and (
        actual_line is None or abs(expected_line - actual_line) > 0.01
    ):
        if actual_line is None:
            detail = f"Paddy selection {selection_id} no longer carries its verified line {expected_line:g}"
        else:
            detail = f"Paddy selection {selection_id} moved from line {expected_line:g} to {actual_line:g}"
        return "EXACT_SELECTION_SUPERSEDED", detail
    return None


def _dynamic_market_codes(arb: dict[str, Any], layout: dict[str, Any]) -> list[str]:
    codes = set(_BASE_MARKET_TYPE_CODES)
    for card in (layout.get("cards") or {}).values():
        if isinstance(card, dict):
            codes.update(str(value) for value in card.get("marketTypes") or [] if value)
    desc = _descriptor(arb)
    line = desc.get("line")
    line_text = ("%g" % line) if isinstance(line, (int, float)) else ""
    context = desc.get("context") or {}
    if desc.get("kind") == "totals" and line_text:
        for prefix in ("HOME_TEAM_OVER/UNDER", "AWAY_TEAM_OVER/UNDER"):
            codes.add(f"{prefix}_{line_text}_GOALS")
        if context.get("set"):
            codes.add(f"SET_{context['set']}_TOTAL_GAMES_OVER/UNDER_{line_text}")
    return sorted(codes)


def _market_context(market: dict[str, Any]) -> dict[str, int | None]:
    text = f"{market.get('marketName') or ''} {market.get('marketType') or ''}".replace("_", " ")
    norm = _norm(text)
    set_number = None
    for pattern in (r"\bset\s*0?(\d+)\b", r"\b(\d+)(?:st|nd|rd|th)\s+set\b"):
        match = re.search(pattern, norm)
        if match:
            set_number = int(match.group(1))
            break
    game_number = None
    match = re.search(r"\bgame\s*0?(\d+)\b", norm)
    if match:
        game_number = int(match.group(1))
    period = None
    if re.search(r"\b(first|1st)\s+half\b", norm) or "HALF_TIME" in str(market.get("marketType") or "").upper():
        period = 1
    elif re.search(r"\b(second|2nd)\s+half\b", norm):
        period = 2
    return {"set": set_number, "game": game_number, "period": period}


def _context_matches(wanted: dict[str, Any], market: dict[str, Any]) -> bool:
    actual = _market_context(market)
    for key in ("set", "game", "period"):
        expected = wanted.get(key)
        if expected is not None and actual.get(key) != expected:
            return False
        if expected is None and actual.get(key) is not None:
            return False
    return True


def _market_context_matches(wanted: str, market: dict[str, Any]) -> bool:
    text = _norm(f"{market.get('marketName') or ''} {market.get('marketType') or ''}")
    groups = {
        "corners": ("corner",), "bookings": ("booking", "card"), "cards": ("booking", "card"),
        "shots": ("shot",), "shots_on_target": ("shot on target", "shots on target"),
        "offsides": ("offside",), "throw_ins": ("throw in", "throwin"), "free_kicks": ("free kick",),
    }
    patterns = groups.get(str(wanted or "").lower(), ())
    if patterns:
        return any(pattern in text for pattern in patterns)
    return not any(pattern in text for values in groups.values() for pattern in values)


def _runner_odds(runner: dict[str, Any]) -> float | None:
    odds = (((runner.get("winRunnerOdds") or {}).get("trueOdds") or {}).get("decimalOdds") or {}).get("decimalOdds")
    return _to_float(odds)


def _market_is_line_bearing(market: dict[str, Any]) -> bool:
    """Return true only for market families whose numbers are price lines.

    Period markets such as ``Set 1 Winner`` contain a number in their title,
    but that number identifies the period and must never become an
    ``expected_line`` or be appended to a participant as ``(1)``.
    """
    market_type = str(market.get("marketType") or "").upper()
    market_name = _norm(market.get("marketName"))
    return (
        "HANDICAP" in market_type
        or "OVER_UNDER" in market_type
        or "OVER/UNDER" in market_type
        or "TOTAL" in market_type
        or "handicap" in market_name
        or "over/under" in market_name
        or "total" in market_name
    )


def _runner_line(market: dict[str, Any], runner: dict[str, Any]) -> float | None:
    if not _market_is_line_bearing(market):
        return None
    runner_name = str(runner.get("runnerName") or "")
    line = _line_from_text(runner_name)
    if line is not None:
        return line
    handicap = _to_float(runner.get("handicap"))
    if handicap not in (None, 0.0):
        return handicap
    return _line_from_text(market.get("marketName"))


def _runner_selection_label(market: dict[str, Any], runner: dict[str, Any]) -> str:
    """Preserve a line that Paddy stores only in ``handicap``.

    Some expanded-market rows expose ``runnerName='Under'`` and keep the
    actual total (for example 93.5) only in ``runner.handicap``. Passing the
    bare word to the Betfair basket fallback makes it indistinguishable from
    every other Under runner on the page. Include the already-verified line
    in the label so both request and UI fallbacks stay bound to one outcome.
    """
    name = str(runner.get("runnerName") or "").strip()
    line = _runner_line(market, runner)
    if not name or line is None or _line_from_text(name) is not None:
        return name
    return f"{name} ({line:g})"


def _runner_team(runner: dict[str, Any], api_pair: tuple[str, str]) -> int | None:
    result = str((runner.get("result") or {}).get("type") or "").upper()
    if result == "HOME":
        return 1
    if result == "AWAY":
        return 2
    if result == "DRAW" or "draw" in _norm(runner.get("runnerName")):
        return 0
    name = runner.get("runnerName")
    home_score, away_score = _similarity(name, api_pair[0]), _similarity(name, api_pair[1])
    if max(home_score, away_score) >= 0.55:
        return 1 if home_score >= away_score else 2
    return None


def _market_team(market: dict[str, Any], api_pair: tuple[str, str]) -> int | None:
    name = _norm(market.get("marketName"))
    market_type = str(market.get("marketType") or "").upper()
    if "PLAYER_A" in market_type or "TEAM_A" in market_type:
        return 1
    if "PLAYER_B" in market_type or "TEAM_B" in market_type:
        return 2
    if re.search(r"\b(home|player a|team a)\b", name):
        return 1
    if re.search(r"\b(away|player b|team b)\b", name):
        return 2
    home_score, away_score = _similarity(market.get("marketName"), api_pair[0]), _similarity(market.get("marketName"), api_pair[1])
    # Market titles such as "Match Total Games" can look deceptively close
    # to a short participant name such as "Matt Hulme". A weak fuzzy match
    # misclassifies the ordinary match total as a player total and rejects a
    # valid runner. Only a strong participant-name signal may infer a team.
    if max(home_score, away_score) >= 0.8:
        return 1 if home_score >= away_score else 2
    return None


def _runner_chance(runner: dict[str, Any], api_pair: tuple[str, str]) -> set[int]:
    name = _norm(runner.get("runnerName"))
    teams: set[int] = set()
    if "draw" in name:
        teams.add(0)
    if _compact(api_pair[0]) and _compact(api_pair[0]) in _compact(name):
        teams.add(1)
    if _compact(api_pair[1]) and _compact(api_pair[1]) in _compact(name):
        teams.add(2)
    return teams


def _semantic_candidates(
    arb: dict[str, Any], event: dict[str, Any], markets: dict[str, Any]
) -> tuple[list[tuple[dict[str, Any], dict[str, Any]]], dict[str, Any]]:
    desc = _descriptor(arb)
    mapping, event_score = _team_mapping(arb, event)
    api_pair = _api_pair(event)
    if not api_pair[0] or not api_pair[1] or event_score < 0.75:
        return [], {**desc, "event_score": event_score, "event_mismatch": True}

    expected_team = desc.get("team")
    api_team = mapping.get(expected_team) if expected_team in {1, 2} else expected_team
    expected_chance = {mapping.get(team, team) if team else 0 for team in desc.get("teams") or set()}
    candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for market in markets.values():
        if (
            not isinstance(market, dict)
            or not _context_matches(desc.get("context") or {}, market)
            or not _market_context_matches(str(desc.get("market_context") or ""), market)
        ):
            continue
        market_type = str(market.get("marketType") or "").upper()
        market_name = _norm(market.get("marketName"))
        kind = desc.get("kind")
        if kind == "moneyline":
            context = desc.get("context") or {}
            if desc.get("qualifier"):
                if "QUALIF" not in market_type and "qualif" not in market_name:
                    continue
            elif desc.get("market_context"):
                if not any(token in market_type or token in market_name for token in ("MATCH", "WINNER", "RESULT")):
                    continue
            elif context.get("set"):
                if "WINNER" not in market_type or "SET" not in market_type:
                    continue
            elif context.get("game"):
                if "WINNER" not in market_type or "GAME" not in market_type:
                    continue
            elif market_type not in {"MATCH_ODDS", "MONEY_LINE"} and _compact(market_name) not in {"matchodds", "moneyline"}:
                continue
        elif kind == "double_chance":
            if "DOUBLE_CHANCE" not in market_type and "double chance" not in market_name:
                continue
        elif kind == "handicap":
            if "HANDICAP" not in market_type and "handicap" not in market_name:
                continue
            sport_text = _norm(
                f"{arb.get('sport') or ''} {arb.get('league') or ''} "
                f"{arb.get('bk2_raw_link') or ''} {arb.get('bk2_url') or ''}"
            )
            line = abs(float(desc.get("line"))) if desc.get("line") is not None else None
            if "tennis" in sport_text or "теннис" in str(arb.get("sport") or "").lower():
                context = desc.get("context") or {}
                # A Forted first-set handicap carries set_number=1 but is a
                # game handicap *inside that set* (Paddy: "Set 1 Game
                # Handicap -1.5"). The old line-size heuristic treated every
                # +/-1.5 as a match set handicap and discarded the exact live
                # market. Keep that heuristic only for match-level rows;
                # explicit set context already disambiguates the market.
                if not context.get("set") and line is not None and line <= 1.5 and "game handicap" in market_name:
                    continue
                if line is not None and line > 1.5 and "set handicap" in market_name:
                    continue
        elif kind == "totals":
            runner_text = " ".join(str(row.get("runnerName") or "") for row in market.get("runners") or [])
            if not ("OVER_UNDER" in market_type or "OVER/UNDER" in market_type or "total" in market_name or (_direction(runner_text) is not None)):
                continue
            # The expanded endpoint also returns same-line compound markets
            # (WDW & O/U, BTTS & O/U, Match Odds and O/U).  Their runners have
            # the same direction/line but are a different bet altogether.
            if (
                any(token in market_type for token in ("BOTH_TEAMS", "BTTS", "WDW_AND", "MATCH_ODDS_AND"))
                or market_name.startswith(("both teams to score ", "btts ", "wdw ", "match odds and "))
                or " double" in market_name
                or ("moneyline" in market_name and "total" in market_name)
            ):
                continue
            team = desc.get("team")
            actual_market_team = _market_team(market, api_pair)
            if team in {1, 2} and actual_market_team != mapping.get(team):
                continue
            if team is None and actual_market_team is not None:
                continue

        for runner in market.get("runners") or []:
            if not isinstance(runner, dict):
                continue
            if kind == "double_chance":
                if _runner_chance(runner, api_pair) != expected_chance:
                    continue
            elif kind in {"moneyline", "handicap"}:
                if api_team is None or _runner_team(runner, api_pair) != api_team:
                    continue
            if kind == "handicap":
                line = desc.get("line")
                actual_line = _runner_line(market, runner)
                if line is None or actual_line is None or abs(float(line) - actual_line) > 0.01:
                    continue
            if kind == "totals":
                if _direction(runner.get("runnerName")) != desc.get("direction"):
                    continue
                line = desc.get("line")
                actual_line = _runner_line(market, runner)
                if line is None or actual_line is None or abs(float(line) - actual_line) > 0.01:
                    continue
            candidates.append((market, runner))
    return candidates, {**desc, "event_score": event_score, "team_mapping": mapping}


def resolve_quote_from_snapshot(
    arb: dict[str, Any],
    event_id: str,
    snapshot: dict[str, Any],
    *,
    elapsed_ms: float | None = None,
    fetched_at: float | None = None,
) -> dict[str, Any]:
    attachments = snapshot.get("attachments") or {}
    events = attachments.get("events") or {}
    event = events.get(str(event_id)) or events.get(int(event_id) if str(event_id).isdigit() else event_id)
    if not isinstance(event, dict):
        return {"verified": False, "status": "EVENT_NOT_FOUND", "detail": "Paddy event is absent", "current_odds": None}
    markets = attachments.get("markets") or {}
    candidates, detail = _semantic_candidates(arb, event, markets)
    if detail.get("event_mismatch"):
        return {
            "verified": False, "status": "MATCH_NOT_FOUND",
            "detail": f"Paddy event teams do not match the fork (score={detail.get('event_score', 0):.3f})",
            "current_odds": None, "event_id": event_id, "source": "paddy-sportsbook-api",
        }
    if not candidates:
        return {
            "verified": False, "status": "SELECTION_NOT_FOUND",
            "detail": f"Exact Paddy market/runner was not found among {len(markets)} markets",
            "current_odds": None, "event_id": event_id, "source": "paddy-sportsbook-api",
        }

    # Exact duplicates occasionally appear in multiple tabs. Collapse only
    # identical market/selection coordinates; never choose by expected price.
    unique: dict[tuple[str, str, str], tuple[dict[str, Any], dict[str, Any]]] = {}
    for market, runner in candidates:
        key = (str(market.get("marketId") or ""), str(runner.get("selectionId") or ""), str(runner.get("handicap") or ""))
        unique[key] = (market, runner)
    candidates = list(unique.values())
    if len(candidates) > 1:
        non_three_way = [
            item for item in candidates
            if "3WAY" not in str(item[0].get("marketType") or "").upper()
            and "3-WAY" not in str(item[0].get("marketType") or "").upper()
            and "3 way" not in _norm(item[0].get("marketName"))
        ]
        if non_three_way:
            candidates = non_three_way
    if len(candidates) != 1:
        labels = ", ".join(f"{m.get('marketName')} / {r.get('runnerName')}" for m, r in candidates[:4])
        return {
            "verified": False, "status": "AMBIGUOUS_SELECTION",
            "detail": f"Multiple exact Paddy runners matched: {labels}", "current_odds": None,
            "event_id": event_id, "source": "paddy-sportsbook-api",
        }

    market, runner = candidates[0]
    market_status = str(market.get("marketStatus") or "").upper()
    runner_status = str(runner.get("runnerStatus") or "").upper()
    odds = _runner_odds(runner)
    if market_status not in {"", "OPEN"} or runner_status not in {"", "ACTIVE"}:
        return {
            "verified": False, "status": "SUSPENDED", "detail": "Paddy market or runner is suspended",
            "current_odds": None, "event_id": event_id, "market_id": market.get("marketId"),
            "selection_id": runner.get("selectionId"), "source": "paddy-sportsbook-api",
        }
    if odds is None or odds <= 1:
        return {
            "verified": False, "status": "PRICE_UNAVAILABLE", "detail": "Paddy runner has no active decimal price",
            "current_odds": None, "event_id": event_id, "market_id": market.get("marketId"),
            "selection_id": runner.get("selectionId"), "source": "paddy-sportsbook-api",
        }
    result = {
        "verified": True, "status": "OK", "detail": f"Paddy Sportsbook verified {market.get('marketName')} / {runner.get('runnerName')}",
        "current_odds": odds, "event_id": event_id, "market_id": str(market.get("marketId") or ""),
        "selection_id": runner.get("selectionId"), "selection": runner.get("runnerName"),
        "selection_label": _runner_selection_label(market, runner),
        # Story reconcile Фаза3 (audit C, item 7): expose the already-verified
        # numeric line separately from the bare/line-enriched selection text
        # so a server-side placement guard can require it for line-bearing
        # markets instead of only ever binding on ambiguous selection text.
        "expected_line": _runner_line(market, runner),
        "market_name": market.get("marketName"), "market_type": market.get("marketType"),
        "side": "BACK", "available_size": None, "source": "paddy-sportsbook-api", "timestamp": time.time(),
    }
    if elapsed_ms is not None:
        result["elapsed_ms"] = round(elapsed_ms, 1)
    if fetched_at is not None:
        # Story reconcile Фаза3 (audit C, item 3 -- freshness): the per-call
        # "timestamp" above is stamped at call time and is therefore ~now on
        # every cache hit regardless of how old the underlying snapshot
        # actually is -- it cannot prove freshness. `snapshot_fetched_at` is
        # the real wall-clock time this snapshot was fetched from Paddy (set
        # once per network fetch / cache-fill in
        # PaddySportsbookClient.resolve_live_quote), which a placement guard
        # can actually age-check.
        result["snapshot_fetched_at"] = fetched_at
    return result


def _safe_error_body(response: Any) -> str:
    text = str(getattr(response, "text", "") or "").replace("\n", " ")[:160]
    return text or "empty response"


def _fetch_snapshot_sync(arb: dict[str, Any], event_id: str, config: PaddySportsbookConfig) -> tuple[dict[str, Any], float]:
    started = time.monotonic()
    referrer = _ascii_header_url(
        str(arb.get("bk2_raw_link") or arb.get("bk2_url") or DEFAULT_ORIGIN + "/").strip()
    )
    headers = {"Accept": "application/json, text/plain, */*", "Origin": DEFAULT_ORIGIN, "Referer": referrer}
    event_params = {
        "eventId": event_id, "language": "en", "regionCode": "UK", "countryCode": "GB",
        "currencyCode": "GBP", "exchangeLocale": "en_GB", "capiJurisdiction": "intl",
        "loggedIn": "false", "includePrices": "true", "betexRegion": "GBR",
        "priceHistory": "1", "_ak": config.app_key,
    }
    last_error = ""
    for attempt in range(config.request_attempts):
        try:
            with curl_requests.Session(
                impersonate=config.impersonate, proxy=config.proxy_url, timeout=config.timeout_sec
            ) as session:
                response = session.get(config.event_page_url, params=event_params, headers=headers)
                if response.status_code != 200:
                    raise PaddySportsbookError(f"event page HTTP {response.status_code}: {_safe_error_body(response)}")
                payload = response.json()
                if not isinstance(payload, dict):
                    raise PaddySportsbookError("event page returned non-object JSON")
                attachments = payload.setdefault("attachments", {})
                markets = attachments.setdefault("markets", {})
                codes = _dynamic_market_codes(arb, payload.get("layout") or {})
                market_body = {
                    "exchangeLocale": "en_GB", "currencyCode": "GBP", "language": "en", "regionCode": "UK",
                    "eventIds": [int(event_id)], "marketTypeCodes": codes,
                    "includePrices": True, "includeCashoutEligibility": True, "priceHistory": 1,
                }
                expanded = session.post(
                    config.markets_url, params={"_ak": config.app_key}, json=market_body,
                    headers={**headers, "Content-Type": "application/json"},
                )
                markets_complete = False
                if expanded.status_code == 200:
                    extra = expanded.json()
                    if isinstance(extra, dict) and isinstance(extra.get("markets"), dict):
                        markets.update(extra["markets"])
                        markets_complete = True
                elif not markets:
                    raise PaddySportsbookError(f"markets HTTP {expanded.status_code}: {_safe_error_body(expanded)}")
                # Absence is evidence only when the expanded market request
                # succeeded. The event-page subset alone may omit a live
                # alternative and must never create a false tombstone.
                payload["_paddy_markets_complete"] = markets_complete
                return payload, (time.monotonic() - started) * 1000
        except Exception as exc:  # noqa: BLE001 - convert network/library errors to a stable verifier result
            last_error = str(exc).strip() or repr(exc)
            if attempt + 1 < config.request_attempts:
                time.sleep(0.08 * (attempt + 1))
    raise PaddySportsbookError(last_error or "Paddy sportsbook request failed")


class PaddySportsbookClient:
    def __init__(self, config: PaddySportsbookConfig | None = None):
        self.config = config or PaddySportsbookConfig.from_env()
        # Story reconcile Фаза3 (audit C, item 3 -- freshness): the 4th tuple
        # element is the real wall-clock time this snapshot was fetched
        # (time.time(), set once per network fetch), independent of
        # time.monotonic() cache bookkeeping and independent of how many
        # times a cache hit re-serves it. This is what lets a caller actually
        # prove data age instead of trusting a per-call "now" timestamp.
        self._cache: dict[str, tuple[float, dict[str, Any], float, float]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        # Never infer replacement merely because a neighboring handicap or
        # total appeared: sportsbooks legitimately expose alternatives
        # together. Remember only identities Paddy verified exactly, then let
        # a newer complete snapshot retire that exact market/runner.
        self._identity_memory_lock = threading.RLock()
        self._verified_identities: dict[tuple[str, ...], dict[str, Any]] = {}
        self._unavailable_identities: dict[tuple[str, ...], dict[str, Any]] = {}

    def _prune_identity_memory(self) -> None:
        for store, timestamp_key in (
            (self._verified_identities, "verified_at"),
            (self._unavailable_identities, "observed_at"),
        ):
            overflow = len(store) - _IDENTITY_MEMORY_LIMIT
            if overflow <= 0:
                continue
            oldest = sorted(
                store,
                key=lambda key: float(store[key].get(timestamp_key) or 0.0),
            )[:overflow]
            for key in oldest:
                store.pop(key, None)

    def _observe_exact_result(
        self,
        arb: dict[str, Any],
        event_id: str,
        snapshot: dict[str, Any],
        result: dict[str, Any],
        fetched_at: float,
    ) -> dict[str, Any]:
        key = _outcome_identity_key(arb, event_id)
        status = str(result.get("status") or "")
        with self._identity_memory_lock:
            previous = self._verified_identities.get(key)
            if (
                status == "SELECTION_NOT_FOUND"
                and previous is not None
                and fetched_at > float(previous.get("snapshot_fetched_at") or 0.0)
            ):
                changed = _exact_identity_change(snapshot, event_id, previous)
                if changed is not None:
                    status, detail = changed
                    result = {
                        **result,
                        "verified": False,
                        "status": status,
                        "detail": detail,
                        "event_id": event_id,
                        "market_id": previous.get("market_id"),
                        "selection_id": previous.get("selection_id"),
                        "expected_line": previous.get("expected_line"),
                        "source": "paddy-sportsbook-api",
                    }
            if result.get("verified") is True and status == "OK":
                self._verified_identities[key] = {
                    "event_id": event_id,
                    "market_id": str(result.get("market_id") or ""),
                    "selection_id": str(result.get("selection_id") or ""),
                    "expected_line": result.get("expected_line"),
                    "snapshot_fetched_at": fetched_at,
                    "verified_at": time.time(),
                }
                self._unavailable_identities.pop(key, None)
            elif status in EXACT_UNAVAILABLE_STATUSES:
                self._unavailable_identities[key] = {
                    "status": status,
                    "detail": str(result.get("detail") or "Exact Paddy selection is unavailable"),
                    "event_id": event_id,
                    "market_id": result.get("market_id"),
                    "selection_id": result.get("selection_id"),
                    "observed_at": fetched_at,
                }
            self._prune_identity_memory()
        return result

    def recent_unavailability(
        self, arb: dict[str, Any], *, max_age_sec: float
    ) -> dict[str, Any] | None:
        key = _outcome_identity_key(arb)
        now = time.time()
        with self._identity_memory_lock:
            evidence = self._unavailable_identities.get(key)
            if evidence is None:
                return None
            observed_at = float(evidence.get("observed_at") or 0.0)
            if now - observed_at > max(0.0, max_age_sec):
                # Do not let a Forted TTL ghost become actionable again just
                # because the Paddy absence aged ten seconds. Release the
                # tombstone only when Forted itself re-observed this logical
                # row after the absence; a genuinely returning line gets that
                # new timestamp, while the old retained row does not.
                try:
                    forted_observed_at = float(arb.get("updated_at") or 0.0)
                except (TypeError, ValueError):
                    forted_observed_at = 0.0
                if forted_observed_at > observed_at:
                    self._unavailable_identities.pop(key, None)
                    return None
                if forted_observed_at <= 0:
                    self._unavailable_identities.pop(key, None)
                    return None
            return dict(evidence)

    async def resolve_live_quote(self, arb: dict[str, Any]) -> dict[str, Any]:
        event_id = extract_event_id(arb)
        if not event_id:
            return {
                "verified": False, "status": "PADDY_IDENTIFIER_MISSING",
                "detail": "Paddy event URL/id is missing", "current_odds": None,
            }
        if not self.config.configured():
            return {
                "verified": False, "status": "PADDY_NOT_CONFIGURED",
                "detail": "PADDY_SPORTSBOOK_PROXY is not configured", "current_odds": None,
            }
        lock = self._locks.setdefault(event_id, asyncio.Lock())
        async with lock:
            cached = self._cache.get(event_id)
            now = time.monotonic()
            if cached and now - cached[0] <= self.config.cache_ttl_sec:
                snapshot, elapsed_ms, fetched_at = cached[1], cached[2], cached[3]
            else:
                try:
                    snapshot, elapsed_ms = await asyncio.to_thread(_fetch_snapshot_sync, arb, event_id, self.config)
                except Exception as exc:  # noqa: BLE001
                    return {
                        "verified": False, "status": "PADDY_SOURCE_ERROR",
                        "detail": str(exc).strip() or repr(exc), "current_odds": None,
                        "event_id": event_id, "source": "paddy-sportsbook-api",
                    }
                fetched_at = time.time()
                self._cache[event_id] = (now, snapshot, elapsed_ms, fetched_at)
            result = resolve_quote_from_snapshot(
                arb, event_id, snapshot, elapsed_ms=elapsed_ms, fetched_at=fetched_at
            )
            # Keep the real fetch clock on negative semantic results too;
            # call time cannot prove that a suspended/removed line is current.
            result.setdefault("snapshot_fetched_at", fetched_at)
            return self._observe_exact_result(arb, event_id, snapshot, result, fetched_at)
