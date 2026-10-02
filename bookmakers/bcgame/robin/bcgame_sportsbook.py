"""Fast read-only BC.Game sportsbook verification via its public BTI event API."""
from __future__ import annotations

import asyncio
import math
import os
import re
import time
import unicodedata
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx
from rapidfuzz import fuzz


DEFAULT_BTI_BASE_URL = "https://prod20402-174135692.442hattrick.com"
DEFAULT_BETBY_API_URL = "https://api-k-c7818b61-623.sptpub.com"
DEFAULT_BETBY_BRAND_ID = "2103509236163162112"
DEFAULT_PROVIDER_SUPPORT_URL = "https://bc.game/api/platform-sports/v14/home/sport/provider/support/"


class BCGameSportsbookError(RuntimeError):
    pass


@dataclass(frozen=True)
class BCGameSportsbookConfig:
    base_url: str = DEFAULT_BTI_BASE_URL
    betby_api_url: str = DEFAULT_BETBY_API_URL
    betby_brand_id: str = DEFAULT_BETBY_BRAND_ID
    provider_support_url: str = DEFAULT_PROVIDER_SUPPORT_URL
    discover_provider_settings: bool = True
    provider_settings_ttl_sec: float = 3600.0
    proxy_url: str = ""
    timeout_sec: float = 6.0
    cache_ttl_sec: float = 0.75
    token_ttl_sec: float = 900.0
    max_concurrency: int = 12

    @classmethod
    def from_env(cls) -> "BCGameSportsbookConfig":
        return cls(
            base_url=os.getenv("BCGAME_BTI_BASE_URL", DEFAULT_BTI_BASE_URL).strip().rstrip("/") or DEFAULT_BTI_BASE_URL,
            betby_api_url=os.getenv("BCGAME_BETBY_API_URL", DEFAULT_BETBY_API_URL).strip().rstrip("/") or DEFAULT_BETBY_API_URL,
            betby_brand_id=os.getenv("BCGAME_BETBY_BRAND_ID", DEFAULT_BETBY_BRAND_ID).strip() or DEFAULT_BETBY_BRAND_ID,
            provider_support_url=os.getenv("BCGAME_PROVIDER_SUPPORT_URL", DEFAULT_PROVIDER_SUPPORT_URL).strip() or DEFAULT_PROVIDER_SUPPORT_URL,
            discover_provider_settings=os.getenv("BCGAME_PROVIDER_DISCOVERY", "1").strip().lower() not in {"0", "false", "no", "off"},
            provider_settings_ttl_sec=max(60.0, float(os.getenv("BCGAME_PROVIDER_SETTINGS_TTL_SEC", "3600"))),
            proxy_url=os.getenv("BCGAME_BTI_PROXY", "").strip(),
            timeout_sec=max(1.0, float(os.getenv("BCGAME_BTI_TIMEOUT_SEC", "6"))),
            cache_ttl_sec=max(0.0, float(os.getenv("BCGAME_BTI_CACHE_TTL_SEC", "0.75"))),
            token_ttl_sec=max(30.0, float(os.getenv("BCGAME_BTI_TOKEN_TTL_SEC", "900"))),
            max_concurrency=max(1, min(30, int(os.getenv("BCGAME_BTI_MAX_CONCURRENCY", "12")))),
        )

    def configured(self) -> bool:
        return bool(self.base_url and self.betby_api_url and self.betby_brand_id)


def is_bcgame_fork(arb: dict[str, Any]) -> bool:
    values = " ".join(str(arb.get(key) or "") for key in (
        "bk1", "bk2", "counter_bk", "bk1_url", "bk2_url", "bk1_raw_link", "bk2_raw_link",
    )).lower()
    return "bc.game" in values


def extract_event_id(arb: dict[str, Any]) -> str | None:
    for key in ("bcgame_event_id", "bk2_raw_link", "bk2_url", "bk1_raw_link", "bk1_url"):
        raw = str(arb.get(key) or "").strip()
        if key == "bcgame_event_id" and raw.isdigit():
            return raw
        if not raw or (key != "bcgame_event_id" and "bc.game" not in raw.lower() and "bti-sports.io" not in raw.lower() and not raw.startswith("=/")):
            continue
        values = re.findall(r"(?:^|[/=])(\d{12,})(?=$|[/?#])", raw)
        if values:
            return values[-1]
    return None


def _is_compact_betby_arb(arb: dict[str, Any]) -> bool:
    return any(str(arb.get(key) or "").strip().startswith("=/") for key in ("bk2_raw_link", "bk2_url", "bk1_raw_link", "bk1_url"))


def _provider_settings_from_payload(payload: Any) -> tuple[str | None, str | None]:
    data = payload.get("data") if isinstance(payload, dict) else None
    providers = data.get("sportProviders") if isinstance(data, dict) else None
    bti_base: str | None = None
    betby_brand: str | None = None
    for provider in providers or []:
        if not isinstance(provider, dict):
            continue
        name = str(provider.get("name") or "").lower()
        if name == "bti":
            bti = provider.get("btiBrand") or {}
            flags = bti.get("brandFlagMap") if isinstance(bti, dict) else {}
            candidate = str((flags or {}).get("light") or "").strip().rstrip("/")
            parsed = urlparse(candidate)
            hostname = str(parsed.hostname or "").lower()
            if parsed.scheme == "https" and (hostname.endswith(".442hattrick.com") or hostname.endswith(".bti-sports.io")):
                bti_base = candidate
        elif name == "betby":
            betby = provider.get("betByBrand") or {}
            candidate = str(betby.get("brandFlag") if isinstance(betby, dict) else "").strip()
            if candidate.isdigit() and len(candidate) >= 12:
                betby_brand = candidate
    return bti_base, betby_brand


def _to_float(value: Any) -> float | None:
    try:
        result = float(str(value).strip().replace(",", "."))
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _to_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _at(values: Any, index: int, default: Any = None) -> Any:
    return values[index] if isinstance(values, list) and len(values) > index else default


def _english(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("EN") or value.get("en") or next(iter(value.values()), ""))
    return str(value or "")


def _clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", _english(value).strip()).lower()


_CYRILLIC_TO_LATIN = str.maketrans({
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh", "з": "z",
    "и": "i", "й": "i", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r",
    "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
})


def _normalized_name(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or "").lower().replace("ё", "е")).translate(_CYRILLIC_TO_LATIN)
    text = "".join(char for char in text if not unicodedata.combining(char))
    text = re.sub(r"\b(?:games?|women|men|u\d+|fc|cf|bc|club|fk|pfc|afk)\b", " ", text)
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _similarity(left: Any, right: Any) -> float:
    first, second = _normalized_name(left), _normalized_name(right)
    if not first or not second:
        return 0.0
    return max(float(fuzz.ratio(first, second)), float(fuzz.token_set_ratio(first, second)))


def _event_team_number(arb: dict[str, Any], event: dict[str, Any], logical_team: int) -> int:
    """Map Forted's home/away numbering to the provider's participant order."""
    if logical_team not in {1, 2}:
        return logical_team
    local_target = str(arb.get("home") if logical_team == 1 else arb.get("away") or "")
    local_other = str(arb.get("away") if logical_team == 1 else arb.get("home") or "")
    source_names = [str(arb.get("team1_en") or ""), str(arb.get("team2_en") or "")]
    aliases = [local_target]
    source_scores = [_similarity(local_target, name) - 0.25 * _similarity(local_other, name) for name in source_names]
    if max(source_scores, default=0) >= 35 and abs(source_scores[0] - source_scores[1]) >= 5:
        aliases.append(source_names[0 if source_scores[0] > source_scores[1] else 1])
    participants = [str(item.get("name") or "") for item in (event.get("participants") or [])[:2]]
    if len(participants) < 2:
        return logical_team
    scores = [max((_similarity(alias, participant) for alias in aliases), default=0.0) for participant in participants]
    if max(scores) >= 35 and abs(scores[0] - scores[1]) >= 5:
        return 1 if scores[0] > scores[1] else 2
    return logical_team


def _selection_descriptor(arb: dict[str, Any]) -> dict[str, Any]:
    raw = str(arb.get("bk2_selection") or arb.get("side2") or "").strip()
    body = re.sub(r"^\s*\d+\s*[чпск]\s+", "", raw, flags=re.I)
    lower = body.lower().replace("ё", "е").replace("−", "-").replace("–", "-").replace("—", "-")
    compact = re.sub(r"[^a-zа-я0-9:+.-]+", "", lower)
    line_match = re.search(r"\(\s*([-+]?\d+(?:[.,]\d+)?)\s*\)", body)
    line = _to_float(line_match.group(1)) if line_match else None
    context = _desired_context(arb)
    exact_score = re.fullmatch(r"(\d+)\s*:\s*(\d+)", lower)
    if exact_score:
        return {"kind": "exact_score", "score": f"{int(exact_score.group(1))}:{int(exact_score.group(2))}", "context": context, "selection": raw}
    if compact in {"1x", "x1", "1х", "х1"}:
        return {"kind": "double_chance", "teams": {0, 1}, "context": context, "selection": raw}
    if compact in {"x2", "2x", "х2", "2х"}:
        return {"kind": "double_chance", "teams": {0, 2}, "context": context, "selection": raw}
    if compact == "12":
        return {"kind": "double_chance", "teams": {1, 2}, "context": context, "selection": raw}
    qualify = re.match(r"^(?:к|team)([12])(?:пройдет|пройдёт|toqualify|toadvance)", compact)
    if qualify:
        return {"kind": "qualify", "team": int(qualify.group(1)), "context": context, "selection": raw}
    team_total = re.match(r"^(?:ит|it)([12])(б|м|over|under)", compact)
    if team_total:
        return {
            "kind": "team_total", "team": int(team_total.group(1)),
            "direction": "over" if team_total.group(2) in {"б", "over"} else "under",
            "line": line, "context": context, "selection": raw,
        }
    if compact.startswith(("over", "тб")):
        return {"kind": "total", "direction": "over", "line": line, "context": context, "selection": raw}
    if compact.startswith(("under", "тм")):
        return {"kind": "total", "direction": "under", "line": line, "context": context, "selection": raw}
    handicap = re.match(r"^(?:handicap|ф|f)([12])", compact)
    if handicap:
        return {"kind": "handicap", "team": int(handicap.group(1)), "line": line, "context": context, "selection": raw}
    if compact in {"home", "п1", "1"}:
        return {"kind": "moneyline", "team": 1, "context": context, "selection": raw}
    if compact in {"away", "п2", "2"}:
        return {"kind": "moneyline", "team": 2, "context": context, "selection": raw}
    if compact in {"draw", "x", "х", "ничья"}:
        return {"kind": "moneyline", "team": 0, "context": context, "selection": raw}
    return {"kind": None, "context": context, "selection": raw, "_unknown": True}


def _desired_context(arb: dict[str, Any]) -> str:
    set_number = _to_int(arb.get("set_number"))
    game_number = _to_int(arb.get("game_number"))
    period_number = _to_int(arb.get("period_number"))
    period_type = str(arb.get("period_type") or "").lower()
    market_name = str(arb.get("market_name") or "").lower().replace("ё", "е")
    if game_number:
        return f"game_{game_number}"
    if set_number:
        return f"set_{set_number}"
    if period_number and period_type:
        return f"{period_type}_{period_number}"
    match = re.search(r"(\d+)\s*(?:карта|map)", market_name)
    if match:
        return f"map_{match.group(1)}"
    match = re.search(r"(\d+)\s*(?:сет|set)", market_name)
    if match:
        return f"set_{match.group(1)}"
    match = re.search(r"(\d+)\s*(?:тайм|half)", market_name)
    if match:
        return f"half_{match.group(1)}"
    if "1 половин" in market_name or "first half" in market_name:
        return "half_1"
    return "full"


def _market_scope(text: str) -> str:
    lowered = text.lower()
    patterns = (
        ("map", r"\b(?:(\d+)(?:st|nd|rd|th)?\s+map|map\s*(\d+))\b"),
        ("set", r"\b(?:(\d+)(?:st|nd|rd|th)?\s+set|set\s*(\d+))\b"),
        ("game", r"\b(?:game\s*(\d+)|(\d+)(?:st|nd|rd|th)\s+game)\b"),
        ("quarter", r"\b(?:(\d+)(?:st|nd|rd|th)\s+quarter|quarter\s*(\d+))\b"),
        ("period", r"\b(?:(\d+)(?:st|nd|rd|th)\s+period|period\s*(\d+))\b"),
        ("inning", r"\b(?:(\d+)(?:st|nd|rd|th)\s+innings?|innings?\s*(\d+))\b"),
    )
    for kind, pattern in patterns:
        match = re.search(pattern, lowered)
        if match:
            return f"{kind}_{match.group(1) or match.group(2)}"
    if re.search(r"\b(?:1st|first)\s+half\b|\bhalf[ -]?time\b|\b(?:1st|first)\s+5\s+innings?\b", lowered):
        return "half_1"
    if re.search(r"\b(?:2nd|second)\s+half\b", lowered):
        return "half_2"
    return "full"


def _decode_selection(raw: list[Any]) -> dict[str, Any]:
    return {
        "id": str(_at(raw, 0, "")), "betslip": _english(_at(raw, 1)), "name": _english(_at(raw, 2)),
        "type_name": _english(_at(raw, 3)), "disabled": bool(_at(raw, 5, False)),
        "odds": _to_float(_at(raw, 6)), "side": _to_int(_at(raw, 9)), "type": _to_int(_at(raw, 10)),
        "outcome": _english(_at(raw, 11)), "points": _to_float(_at(raw, 16)), "removed": bool(_at(raw, 13, False)),
    }


def _decode_market(raw: list[Any]) -> dict[str, Any]:
    market_type = _at(raw, 5, []) or []
    result = {
        "id": str(_at(raw, 0, "")), "name": _english(_at(raw, 1)), "betslip": _english(_at(raw, 3)),
        "type_name": _english(_at(market_type, 1)), "short_name": _english(_at(market_type, 5)),
        "title": _english(_at(raw, 11)), "selections": [], "suspended": bool(_at(raw, 15, False)),
        "removed": bool(_at(raw, 23, False)),
    }
    result["text"] = " ".join(str(result[key] or "") for key in ("name", "betslip", "type_name", "short_name", "title")).lower()
    result["scope"] = _market_scope(result["text"])
    result["selections"] = [_decode_selection(value) for value in (_at(raw, 13, []) or []) if isinstance(value, list)]
    return result


def decode_event(raw: list[Any]) -> dict[str, Any]:
    markets: list[dict[str, Any]] = []
    seen: set[str] = set()
    for container_index in (33, 20):
        for value in (_at(raw, container_index, []) or []):
            if not isinstance(value, list) or str(_at(value, 0, "")) in seen:
                continue
            seen.add(str(_at(value, 0, "")))
            markets.append(_decode_market(value))
    participants = []
    for item in (_at(raw, 8, []) or []):
        if isinstance(item, list):
            participants.append({"id": str(_at(item, 0, "")), "name": _english(_at(item, 1)), "role": _to_int(_at(item, 2))})
    return {
        "id": str(_at(raw, 0, "")), "sport": _english(_at(raw, 4)), "name": _english(_at(raw, 10)),
        "is_live": bool(_at(raw, 13, False)), "suspended": bool(_at(raw, 32, False)),
        "participants": participants, "markets": markets,
    }


def _specifier_values(value: Any) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in str(value or "").split("|"):
        if "=" in item:
            key, raw = item.split("=", 1)
            result[key.strip()] = raw.strip()
    return result


def _format_number(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value)


def _betby_template(template: Any, specifiers: dict[str, str], competitors: list[dict[str, Any]]) -> str:
    text = str(template or "")
    first = str((competitors[0] if len(competitors) > 0 else {}).get("name") or "Home")
    second = str((competitors[1] if len(competitors) > 1 else {}).get("name") or "Away")
    text = text.replace("{$competitor1}", first).replace("{$competitor2}", second)
    for key, raw in specifiers.items():
        text = text.replace(f"{{!{key}}}", raw).replace(f"{{{key}}}", raw)
    hcp = _to_float(specifiers.get("hcp"))
    if hcp is not None:
        text = text.replace("{+hcp}", f"{hcp:+g}").replace("{-hcp}", f"{-hcp:+g}")
    return re.sub(r"\s+", " ", text).strip()


def _betby_outcome_templates(description: dict[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    for variants in (description.get("variants") or {}).values():
        for variant in variants or []:
            for outcome in variant.get("outcomes") or []:
                result[str(outcome.get("id") or "")] = str(outcome.get("name") or "")
    return result


def decode_betby_event(event_id: str, raw: dict[str, Any], descriptions: dict[str, Any], *, is_live: bool) -> dict[str, Any]:
    desc = raw.get("desc") or {}
    competitors = list(desc.get("competitors") or [])
    markets: list[dict[str, Any]] = []
    for market_id, specifier_rows in (raw.get("markets") or {}).items():
        market_description = descriptions.get(str(market_id)) or {}
        outcome_templates = _betby_outcome_templates(market_description)
        for specifier_key, outcomes in (specifier_rows or {}).items():
            specifiers = _specifier_values(specifier_key)
            market_name = _betby_template(market_description.get("name") or market_id, specifiers, competitors)
            description_name = str(market_description.get("name") or "").lower()
            semantic = "draw_no_bet" if "draw no bet" in description_name else "asian_handicap" if "handicap" in description_name else ""
            market = {
                "id": f"{market_id}:{specifier_key}", "name": market_name, "betslip": market_name,
                "type_name": str(market_description.get("market_type") or ""), "short_name": "", "title": "",
                "suspended": False, "removed": False, "selections": [], "semantic": semantic,
            }
            market["text"] = f"{market_name} {market.get('type_name') or ''}".lower()
            market["scope"] = _market_scope(market["text"])
            for outcome_id, price_data in (outcomes or {}).items():
                template = outcome_templates.get(str(outcome_id), str(outcome_id))
                outcome_name = _betby_template(template, specifiers, competitors)
                teams: set[int] = set()
                if "{$competitor1}" in template:
                    teams.add(1)
                if "{$competitor2}" in template:
                    teams.add(2)
                if "draw" in template.lower():
                    teams.add(0)
                side = 1 if teams == {1} else 3 if teams == {2} else 2 if teams == {0} else None
                points = _to_float(specifiers.get("total"))
                if "hcp" in specifiers:
                    hcp = _to_float(specifiers.get("hcp"))
                    points = -hcp if hcp is not None and "{$competitor2}" in template else hcp
                elif semantic == "draw_no_bet":
                    points = 0.0
                odds = _to_float((price_data or {}).get("k"))
                market["selections"].append({
                    "id": f"{market_id}:{specifier_key}:{outcome_id}", "betslip": outcome_name,
                    "name": outcome_name, "type_name": market_name, "disabled": odds is None or odds <= 1,
                    "removed": False, "odds": odds, "side": side, "type": None, "outcome": outcome_name,
                    "points": points, "teams": teams,
                })
            markets.append(market)
    return {
        "id": event_id, "sport": str(desc.get("sport") or ""), "name": str(desc.get("slug") or ""),
        "is_live": bool(is_live), "suspended": False, "participants": competitors,
        "markets": markets, "_source": "bcgame-betby",
    }


def _market_kind_matches(market: dict[str, Any], descriptor: dict[str, Any]) -> bool:
    text = str(market.get("text") or "")
    if market.get("scope") != descriptor.get("context"):
        return False
    kind = descriptor.get("kind")
    excluded_combo = any(token in text for token in ("winner &", "winner and", "result and", "odd/even", "bands", "correct score"))
    if kind == "total":
        return ("total" in text or "o/u" in text or "over/under" in text) and not excluded_combo and not any(token in text for token in ("home total", "away total", ": total", "total games odd"))
    if kind == "team_total":
        return ("total" in text or "o/u" in text or "over/under" in text) and not excluded_combo
    if kind == "handicap":
        if descriptor.get("line") is not None and abs(float(descriptor["line"])) <= 0.001 and market.get("semantic") == "asian_handicap":
            return False
        return "handicap" in text or "spread" in text or "draw no bet" in text
    if kind == "exact_score":
        return "exact score" in text or "correct score" in text
    if kind == "double_chance":
        return "double chance" in text
    if kind == "qualify":
        return any(token in text for token in ("to qualify", "to advance", "qualification", "advance to"))
    if kind == "moneyline":
        return any(token in text for token in ("winner", "money line", "moneyline", "match result", "match betting", "fight result")) and not any(token in text for token in ("winner &", "winner and", "correct score", "handicap"))
    return False


def _selection_matches(selection: dict[str, Any], market: dict[str, Any], descriptor: dict[str, Any]) -> bool:
    if selection.get("disabled") or selection.get("removed") or not selection.get("odds") or float(selection["odds"]) <= 1:
        return False
    text = f"{selection.get('betslip') or ''} {selection.get('name') or ''} {selection.get('outcome') or ''}".lower()
    kind = descriptor["kind"]
    if kind in {"total", "team_total"}:
        if descriptor["direction"] not in text:
            return False
        wanted_line = descriptor.get("line")
        points = selection.get("points")
        if wanted_line is not None and (points is None or abs(float(points) - float(wanted_line)) > 0.001):
            return False
        if kind == "team_total":
            event_team = descriptor.get("event_team", descriptor["team"])
            wanted_side = 1 if event_team == 1 else 3
            market_text = str(market.get("text") or "")
            side_text = "home" if event_team == 1 else "away"
            if side_text not in market_text and selection.get("side") != wanted_side:
                return False
        return True
    if kind == "handicap":
        event_team = descriptor.get("event_team", descriptor["team"])
        wanted_side = 1 if event_team == 1 else 3
        if selection.get("side") != wanted_side:
            return False
        wanted_line = descriptor.get("line")
        points = selection.get("points")
        return wanted_line is None or (points is not None and abs(float(points) - float(wanted_line)) <= 0.001)
    if kind == "exact_score":
        return bool(re.search(rf"(?<!\d){re.escape(descriptor['score'])}(?!\d)", text))
    if kind in {"moneyline", "qualify"}:
        team = descriptor.get("event_team", descriptor["team"])
        if team == 0:
            return "draw" in text or selection.get("side") == 2
        return selection.get("side") == (1 if team == 1 else 3)
    if kind == "double_chance":
        wanted = descriptor.get("event_teams", descriptor["teams"])
        if selection.get("teams"):
            return set(selection["teams"]) == set(wanted)
        has_draw = bool(re.search(r"\b(?:draw|tie|x)\b", text))
        if (0 in wanted) != has_draw:
            return False
        if wanted == {1, 2}:
            return selection.get("side") == 2 or any(token in text for token in ("home or away", "home/away", "1 or 2", "12"))
        wanted_side = 1 if 1 in wanted else 3
        return selection.get("side") == wanted_side or ("home" in text if wanted_side == 1 else "away" in text)
    return False


def resolve_quote_from_event(arb: dict[str, Any], event_id: str, event: dict[str, Any], *, elapsed_ms: float | None = None) -> dict[str, Any]:
    descriptor = _selection_descriptor(arb)
    if descriptor.get("team") in {1, 2}:
        descriptor["event_team"] = _event_team_number(arb, event, int(descriptor["team"]))
    if descriptor.get("kind") == "double_chance":
        descriptor["event_teams"] = {
            _event_team_number(arb, event, team) if team in {1, 2} else team
            for team in descriptor.get("teams") or set()
        }
    if descriptor.get("kind") == "exact_score" and _event_team_number(arb, event, 1) == 2:
        home_score, away_score = str(descriptor.get("score") or "0:0").split(":", 1)
        descriptor["score"] = f"{away_score}:{home_score}"
    base = {
        "verified": False, "status": "UNAVAILABLE", "current_odds": None,
        "feed_odds": _to_float(arb.get("bk2_odds")), "selection": arb.get("bk2_selection"),
        "event_id": event_id, "source": event.get("_source") or "bcgame-bti",
    }
    if elapsed_ms is not None:
        base["elapsed_ms"] = round(elapsed_ms, 1)
    if descriptor.get("_unknown") or not descriptor.get("kind"):
        return {**base, "status": "UNSUPPORTED_SELECTION", "detail": "BC.Game selection format is not supported"}
    rows: list[tuple[dict[str, Any], dict[str, Any]]] = []
    candidate_markets: list[str] = []
    for market in event.get("markets") or []:
        if market.get("suspended") or market.get("removed") or not _market_kind_matches(market, descriptor):
            continue
        candidate_markets.append(str(market.get("name") or ""))
        for selection in market.get("selections") or []:
            if _selection_matches(selection, market, descriptor):
                rows.append((market, selection))
    if not rows:
        return {
            **base, "detail": "BC.Game returned no exact open selection",
            "desired_kind": descriptor.get("kind"), "desired_scope": descriptor.get("context"),
            "candidate_markets": sorted(set(candidate_markets))[:12],
        }
    unique = {(selection["id"], market["id"]): (market, selection) for market, selection in rows}
    if len(unique) > 1:
        return {
            **base, "status": "AMBIGUOUS_SELECTION", "detail": "Multiple BC.Game outcomes match the same structural selection",
            "candidate_markets": sorted({market["name"] for market, _ in unique.values()})[:12],
        }
    market, selection = next(iter(unique.values()))
    provider = "Betby" if event.get("_source") == "bcgame-betby" else "BTI"
    return {
        **base, "verified": True, "status": "OK", "current_odds": selection["odds"],
        "detail": f"BC.Game {provider} verified {market.get('name')} / {selection.get('betslip') or selection.get('name')}",
        "market_id": market["id"], "market_name": market["name"], "selection_id": selection["id"],
        "outcome_name": selection.get("betslip") or selection.get("name"), "points": selection.get("points"),
        "event_name": event.get("name"), "event_live": event.get("is_live"),
    }


class BCGameSportsbookClient:
    def __init__(self, config: BCGameSportsbookConfig | None = None):
        self.config = config or BCGameSportsbookConfig.from_env()
        self._cache: dict[str, tuple[float, dict[str, Any] | None, float]] = {}
        self._cache_lock = asyncio.Lock()
        self._token_lock = asyncio.Lock()
        self._tokens: tuple[float, str, str, str] | None = None
        self._provider_lock = asyncio.Lock()
        self._provider_settings: tuple[float, str, str] | None = None
        self._betby_lock = asyncio.Lock()
        self._betby_snapshots: dict[str, tuple[float, dict[str, Any], float]] = {}
        self._betby_descriptions: tuple[float, str, dict[str, Any]] | None = None
        self._client = httpx.AsyncClient(
            proxy=self.config.proxy_url or None, timeout=self.config.timeout_sec,
            follow_redirects=True, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json, text/plain, */*"},
        )

    async def _get_provider_settings(self, *, force: bool = False) -> tuple[str, str]:
        fallback = (self.config.base_url, self.config.betby_brand_id)
        if not self.config.discover_provider_settings:
            return fallback
        now = time.monotonic()
        cached = self._provider_settings
        if not force and cached and now - cached[0] <= self.config.provider_settings_ttl_sec:
            return cached[1], cached[2]
        async with self._provider_lock:
            now = time.monotonic()
            cached = self._provider_settings
            if not force and cached and now - cached[0] <= self.config.provider_settings_ttl_sec:
                return cached[1], cached[2]
            try:
                response = await self._client.post(
                    self.config.provider_support_url, content=b"",
                    headers={"Content-Type": "application/json"},
                )
                response.raise_for_status()
                discovered_base, discovered_brand = _provider_settings_from_payload(response.json())
                settings = (discovered_base or fallback[0], discovered_brand or fallback[1])
            except Exception:  # noqa: BLE001 - verified fallback keeps quote checks available
                settings = fallback
            self._provider_settings = (time.monotonic(), settings[0], settings[1])
            return settings

    async def _get_tokens(self, *, force: bool = False) -> tuple[str, str, str]:
        base_url, _brand = await self._get_provider_settings()
        now = time.monotonic()
        if not force and self._tokens and self._tokens[1] == base_url and now - self._tokens[0] <= self.config.token_ttl_sec:
            return self._tokens[1], self._tokens[2], self._tokens[3]
        async with self._token_lock:
            base_url, _brand = await self._get_provider_settings()
            now = time.monotonic()
            if not force and self._tokens and self._tokens[1] == base_url and now - self._tokens[0] <= self.config.token_ttl_sec:
                return self._tokens[1], self._tokens[2], self._tokens[3]
            response = await self._client.get(f"{base_url}/en/asian-view")
            response.raise_for_status()
            internal = re.search(r"'internalToken':'([^']+)'", response.text)
            session = re.search(r"'sessionToken':'([^']+)'", response.text)
            if not internal or not session:
                raise BCGameSportsbookError("BC.Game anonymous session tokens were not present")
            self._tokens = (time.monotonic(), base_url, internal.group(1), session.group(1))
            return self._tokens[1], self._tokens[2], self._tokens[3]

    async def _fetch_event(self, event_id: str) -> tuple[dict[str, Any] | None, float]:
        started = time.monotonic()
        base_url, internal, session = await self._get_tokens()
        url = f"{base_url}/api/eventpage/events/{event_id}"
        params = {"hideX25X75Selections": "false"}
        response = await self._client.get(url, params=params, headers={"Authorization": internal, "Session": session})
        if response.status_code in {401, 403}:
            base_url, internal, session = await self._get_tokens(force=True)
            url = f"{base_url}/api/eventpage/events/{event_id}"
            response = await self._client.get(url, params=params, headers={"Authorization": internal, "Session": session})
        if response.status_code == 404:
            return None, (time.monotonic() - started) * 1000
        response.raise_for_status()
        payload = response.json()
        raw_events = payload.get("data") if isinstance(payload, dict) else None
        event = decode_event(raw_events[0]) if isinstance(raw_events, list) and raw_events and isinstance(raw_events[0], list) else None
        return event, (time.monotonic() - started) * 1000

    async def _get_betby_descriptions(self) -> dict[str, Any]:
        _base_url, brand_id = await self._get_provider_settings()
        now = time.monotonic()
        if self._betby_descriptions and self._betby_descriptions[1] == brand_id and now - self._betby_descriptions[0] <= 3600:
            return self._betby_descriptions[2]
        url = (
            f"{self.config.betby_api_url}/api/v3/descriptions/brand/"
            f"{brand_id}/markets/en"
        )
        response = await self._client.get(url)
        response.raise_for_status()
        payload = response.json()
        descriptions = payload if isinstance(payload, dict) else {}
        self._betby_descriptions = (time.monotonic(), brand_id, descriptions)
        return descriptions

    async def _fetch_betby_snapshot(self, mode: str) -> tuple[dict[str, Any], float]:
        _base_url, brand_id = await self._get_provider_settings()
        cache_key = f"{brand_id}:{mode}"
        now = time.monotonic()
        cached = self._betby_snapshots.get(cache_key)
        if cached and now - cached[0] <= self.config.cache_ttl_sec:
            return cached[1], cached[2]
        async with self._betby_lock:
            now = time.monotonic()
            _base_url, brand_id = await self._get_provider_settings()
            cache_key = f"{brand_id}:{mode}"
            cached = self._betby_snapshots.get(cache_key)
            if cached and now - cached[0] <= self.config.cache_ttl_sec:
                return cached[1], cached[2]
            started = time.monotonic()
            base = (
                f"{self.config.betby_api_url}/api/v4/{mode}/brand/"
                f"{brand_id}/en/"
            )
            root_response = await self._client.get(f"{base}0")
            root_response.raise_for_status()
            root = root_response.json()
            versions = list(root.get("top_events_versions") or []) + list(root.get("rest_events_versions") or [])
            responses = await asyncio.gather(*(self._client.get(f"{base}{version}") for version in versions))
            events: dict[str, Any] = {}
            for response in responses:
                response.raise_for_status()
                chunk = response.json()
                if isinstance(chunk, dict):
                    events.update(chunk.get("events") or {})
            elapsed = (time.monotonic() - started) * 1000
            self._betby_snapshots[cache_key] = (time.monotonic(), events, elapsed)
            return events, elapsed

    async def prefetch(self, arbs: list[dict[str, Any]]) -> None:
        indexed = [(arb, event_id) for arb in arbs if (event_id := extract_event_id(arb))]
        now = time.monotonic()
        missing = [(arb, event_id) for arb, event_id in indexed if not self._cache.get(event_id) or now - self._cache[event_id][0] > self.config.cache_ttl_sec]
        if not missing:
            return
        compact = [(arb, event_id) for arb, event_id in missing if _is_compact_betby_arb(arb)]
        direct = [(arb, event_id) for arb, event_id in missing if not _is_compact_betby_arb(arb)]
        if compact:
            descriptions = await self._get_betby_descriptions()
            for mode in ("live", "prematch"):
                rows = [(arb, event_id) for arb, event_id in compact if ("live" if arb.get("is_live") else "prematch") == mode]
                if not rows:
                    continue
                events, elapsed = await self._fetch_betby_snapshot(mode)
                stored_at = time.monotonic()
                for _arb, event_id in rows:
                    raw = events.get(event_id)
                    event = decode_betby_event(event_id, raw, descriptions, is_live=mode == "live") if isinstance(raw, dict) else None
                    self._cache[event_id] = (stored_at, event, elapsed)
        missing_ids = list(dict.fromkeys(event_id for _arb, event_id in direct))
        if not missing_ids:
            return
        semaphore = asyncio.Semaphore(self.config.max_concurrency)

        async def fetch(event_id: str) -> tuple[str, dict[str, Any] | None, float]:
            async with semaphore:
                event, elapsed = await self._fetch_event(event_id)
                return event_id, event, elapsed

        results = await asyncio.gather(*(fetch(event_id) for event_id in missing_ids), return_exceptions=True)
        first_error: Exception | None = None
        async with self._cache_lock:
            stored_at = time.monotonic()
            for result in results:
                if isinstance(result, Exception):
                    first_error = first_error or result
                    continue
                event_id, event, elapsed = result
                self._cache[event_id] = (stored_at, event, elapsed)
        if first_error and not any(event_id in self._cache for event_id in missing_ids):
            raise BCGameSportsbookError(str(first_error).strip() or repr(first_error)) from first_error

    async def resolve_live_quote(self, arb: dict[str, Any]) -> dict[str, Any]:
        event_id = extract_event_id(arb)
        if not event_id:
            return {"verified": False, "status": "BCGAME_IDENTIFIER_MISSING", "detail": "BC.Game event URL/id is missing", "current_odds": None, "source": "bcgame-bti"}
        if not self.config.configured():
            return {"verified": False, "status": "BCGAME_NOT_CONFIGURED", "detail": "BC.Game BTI endpoint is not configured", "current_odds": None, "source": "bcgame-bti"}
        try:
            await self.prefetch([arb])
        except Exception as exc:  # noqa: BLE001
            return {"verified": False, "status": "BCGAME_SOURCE_ERROR", "detail": str(exc), "current_odds": None, "event_id": event_id, "source": "bcgame-bti"}
        cached = self._cache.get(event_id)
        if not cached or not cached[1]:
            return {"verified": False, "status": "UNAVAILABLE", "detail": "BC.Game returned no event", "current_odds": None, "event_id": event_id, "source": "bcgame-bti"}
        return resolve_quote_from_event(arb, event_id, cached[1], elapsed_ms=cached[2])

    async def resolve_many(self, arbs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        try:
            await self.prefetch(arbs)
        except Exception:
            pass
        results: list[dict[str, Any]] = []
        for arb in arbs:
            event_id = extract_event_id(arb)
            cached = self._cache.get(event_id or "")
            if not event_id:
                results.append({
                    "verified": False, "status": "BCGAME_IDENTIFIER_MISSING",
                    "detail": "BC.Game event URL/id is missing", "current_odds": None,
                    "source": "bcgame-bti",
                })
            elif not cached or not cached[1]:
                results.append({
                    "verified": False, "status": "UNAVAILABLE", "detail": "BC.Game returned no event",
                    "current_odds": None, "event_id": event_id, "source": "bcgame-bti",
                })
            else:
                results.append(resolve_quote_from_event(arb, event_id, cached[1], elapsed_ms=cached[2]))
        return results

    async def aclose(self) -> None:
        await self._client.aclose()
