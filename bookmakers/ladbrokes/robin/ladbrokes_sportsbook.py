"""Fast read-only Ladbrokes sportsbook price verification via OpenBet SiteServer."""
from __future__ import annotations

import asyncio
import math
import os
import re
import time
import unicodedata
from dataclasses import dataclass
from typing import Any

import httpx
from rapidfuzz import fuzz


DEFAULT_SITESERVER_URL = (
    "https://ss-aka-ori.ladbrokes.com/openbet-ssviewer/Drilldown/2.86/"
    "EventToOutcomeForEvent"
)


class LadbrokesSportsbookError(RuntimeError):
    pass


@dataclass(frozen=True)
class LadbrokesSportsbookConfig:
    siteserver_url: str = DEFAULT_SITESERVER_URL
    proxy_url: str = ""
    timeout_sec: float = 5.0
    cache_ttl_sec: float = 0.75
    max_batch_size: int = 40

    @classmethod
    def from_env(cls) -> "LadbrokesSportsbookConfig":
        return cls(
            siteserver_url=os.getenv("LADBROKES_SPORTSBOOK_SITESERVER_URL", DEFAULT_SITESERVER_URL).strip() or DEFAULT_SITESERVER_URL,
            proxy_url=os.getenv("LADBROKES_SPORTSBOOK_PROXY", "").strip(),
            timeout_sec=max(1.0, float(os.getenv("LADBROKES_SPORTSBOOK_TIMEOUT_SEC", "5"))),
            cache_ttl_sec=max(0.0, float(os.getenv("LADBROKES_SPORTSBOOK_CACHE_TTL_SEC", "0.75"))),
            max_batch_size=max(1, min(100, int(os.getenv("LADBROKES_SPORTSBOOK_MAX_BATCH_SIZE", "40")))),
        )

    def configured(self) -> bool:
        return bool(self.siteserver_url)


def is_ladbrokes_fork(arb: dict[str, Any]) -> bool:
    values = " ".join(str(arb.get(key) or "") for key in (
        "bk1", "bk2", "counter_bk", "bk1_url", "bk2_url", "bk1_raw_link", "bk2_raw_link",
    )).lower()
    return "ladbrokes" in values


def extract_event_id(arb: dict[str, Any]) -> str | None:
    for key in ("ladbrokes_event_id", "bk2_raw_link", "bk2_url", "bk1_raw_link", "bk1_url"):
        raw = str(arb.get(key) or "").strip()
        if not raw or (key != "ladbrokes_event_id" and "ladbrokes" not in raw.lower()):
            continue
        if key == "ladbrokes_event_id" and raw.isdigit():
            return raw
        matches = re.findall(r"/(\d{6,})(?:/|[?#]|$)", raw)
        if matches:
            return matches[-1]
    return None


def _to_float(value: Any) -> float | None:
    try:
        parsed = float(str(value).strip().rstrip(",").replace(",", "."))
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _to_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _line_from_text(value: Any) -> float | None:
    text = str(value or "").replace(",", ".").translate(str.maketrans({"−": "-", "–": "-", "—": "-"}))
    match = re.search(r"\(\s*([-+]?\d+(?:\.\d+)?)\s*\)", text)
    return _to_float(match.group(1)) if match else None


def _selection_descriptor(arb: dict[str, Any]) -> dict[str, Any]:
    selection = str(arb.get("bk2_selection") or arb.get("side2") or "").strip()
    lower = selection.lower().replace("ё", "е")
    compact = re.sub(r"[^a-zа-я0-9:]+", "", lower)
    period_prefix = re.match(r"^\s*(\d+)\s*([чпс])\s+", lower)
    if period_prefix:
        lower = lower[period_prefix.end():]
        selection_body = selection[period_prefix.end():]
    else:
        selection_body = selection
    context = {
        "set": _to_int(arb.get("set_number")),
        "game": _to_int(arb.get("game_number")),
        "market": str(arb.get("market_context") or "").strip().lower(),
        "scope": str(arb.get("market_scope") or "").strip().lower(),
        "period_number": int(period_prefix.group(1)) if period_prefix else _to_int(arb.get("period_number")),
        "period_type": (
            "quarter" if period_prefix and period_prefix.group(2) == "ч"
            else "half" if period_prefix and period_prefix.group(2) == "п"
            else "set" if period_prefix
            else str(arb.get("period_type") or "").strip().lower()
        ),
    }
    compact = re.sub(r"[^a-zа-я0-9:]+", "", lower)
    line = _line_from_text(selection_body)
    score_handicap = re.fullmatch(r"([12])(\d+):(\d+)", compact)
    if score_handicap:
        return {"kind": "score_handicap", "team": int(score_handicap.group(1)), "score": (int(score_handicap.group(2)), int(score_handicap.group(3))), "context": context, "selection": selection}
    if compact in {"1x", "x1"}:
        return {"kind": "double_chance", "teams": {0, 1}, "context": context, "selection": selection}
    if compact in {"x2", "2x"}:
        return {"kind": "double_chance", "teams": {0, 2}, "context": context, "selection": selection}
    if compact == "12":
        return {"kind": "double_chance", "teams": {1, 2}, "context": context, "selection": selection}
    team_total = re.match(r"^(?:ит|it)([12])(б|м|over|under)", compact)
    if team_total:
        direction = "over" if team_total.group(2) in {"б", "over"} else "under"
        return {
            "kind": "team_total", "team": int(team_total.group(1)), "direction": direction,
            "line": line, "context": context, "selection": selection,
        }
    if compact.startswith("over") or compact.startswith("тб"):
        return {"kind": "total", "direction": "over", "line": line, "context": context, "selection": selection}
    if compact.startswith("under") or compact.startswith("тм"):
        return {"kind": "total", "direction": "under", "line": line, "context": context, "selection": selection}
    if compact.startswith(("handicap1", "ф1", "f1")):
        return {"kind": "handicap", "team": 1, "line": line, "context": context, "selection": selection}
    if compact.startswith(("handicap2", "ф2", "f2")):
        return {"kind": "handicap", "team": 2, "line": line, "context": context, "selection": selection}
    if compact in {"home", "п1", "1"}:
        return {"kind": "moneyline", "team": 1, "context": context, "selection": selection}
    if compact in {"away", "п2", "2"}:
        return {"kind": "moneyline", "team": 2, "context": context, "selection": selection}
    if compact in {"draw", "x", "х", "ничья"}:
        return {"kind": "moneyline", "team": 0, "context": context, "selection": selection}
    return {"kind": None, "context": context, "selection": selection, "_unknown": True}


_CYRILLIC_TO_LATIN = str.maketrans({
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh", "з": "z",
    "и": "i", "й": "i", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r",
    "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
})

_TEAM_NAME_ALIASES = {
    "северная македония": "north macedonia", "швеция": "sweden", "болгария": "bulgaria", "дания": "denmark",
    "англия": "england", "аргентина": "argentina", "франция": "france", "испания": "spain",
    "американская лига": "american league", "звезды американской лиги": "american league stars",
    "национальная лига": "national league",
}


def _normalized_name(value: Any) -> str:
    text = str(value or "").lower().replace("ё", "е")
    for source, target in _TEAM_NAME_ALIASES.items():
        text = text.replace(source, target)
    text = unicodedata.normalize("NFKD", text).translate(_CYRILLIC_TO_LATIN)
    text = "".join(char for char in text if not unicodedata.combining(char))
    text = re.sub(r"\b(?:games?|women|men|u\d+|fc|cf|bc|club)\b", " ", text)
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _similarity(left: Any, right: Any) -> float:
    first, second = _normalized_name(left), _normalized_name(right)
    if not first or not second:
        return 0.0
    return max(float(fuzz.ratio(first, second)), float(fuzz.token_set_ratio(first, second)))


def _target_names(arb: dict[str, Any], team: int | None) -> tuple[list[str], list[str]]:
    if team not in {1, 2}:
        return [], []
    target = str(arb.get("home") if team == 1 else arb.get("away") or "")
    other = str(arb.get("away") if team == 1 else arb.get("home") or "")
    target_names = [target]
    other_names = [other]
    source_names = [str(arb.get("team1_en") or ""), str(arb.get("team2_en") or "")]
    if any(source_names):
        scores = [_similarity(target, value) - 0.25 * _similarity(other, value) for value in source_names]
        if max(scores, default=0) >= 35 and abs(scores[0] - scores[1]) >= 5:
            chosen = 0 if scores[0] > scores[1] else 1
            target_names.append(source_names[chosen])
            other_names.append(source_names[1 - chosen])
    return target_names, other_names


def _market_text(market: dict[str, Any]) -> str:
    return f"{market.get('name') or ''} {market.get('templateMarketName') or ''}".strip().lower()


def _context_matches(text: str, context: dict[str, Any]) -> bool:
    market_context = str(context.get("market") or "")
    props = {
        "corners": ("corner",), "cards": ("card", "booking"), "yellow_cards": ("yellow card",),
        "bookings": ("card", "booking"),
        "offsides": ("offside",), "throw_ins": ("throw-in", "throw in"), "fouls": ("foul",),
        "goal_kicks": ("goal kick",), "shots": ("shot",),
    }
    wanted = props.get(market_context)
    if wanted and not any(token in text for token in wanted):
        return False
    if not wanted and any(token in text for values in props.values() for token in values):
        return False
    set_number = context.get("set")
    ordinal_word = {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth"}.get(set_number)
    set_patterns = rf"set\s*{set_number}|{set_number}(?:st|nd|rd|th)\s+set"
    if ordinal_word:
        set_patterns += rf"|{ordinal_word}\s+set"
    if set_number and not re.search(rf"\b(?:{set_patterns})\b", text):
        return False
    game_number = context.get("game")
    if set_number and game_number is None and re.search(r"\bgame\s*\d+\b", text):
        return False
    game_word = {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth"}.get(game_number)
    game_patterns = rf"game\s*{game_number}|{game_number}(?:st|nd|rd|th)\s+game"
    if game_word:
        game_patterns += rf"|{game_word}\s+game"
    if game_number and not re.search(rf"\b(?:{game_patterns})\b", text):
        return False
    period_number = context.get("period_number")
    period_type = str(context.get("period_type") or "")
    if period_number and period_type:
        ordinal = {1: "1st", 2: "2nd", 3: "3rd"}.get(int(period_number), f"{period_number}th")
        word = {1: "first", 2: "second", 3: "third", 4: "fourth"}.get(int(period_number))
        period_patterns = rf"{ordinal}\s+{period_type}|{period_type}\s*{period_number}"
        if word:
            period_patterns += rf"|{word}\s+{period_type}"
        if int(period_number) == 1 and period_type == "half":
            period_patterns += r"|half[ -]?time"
        if not re.search(rf"\b(?:{period_patterns})\b", text):
            return False
    return True


def _market_scope(market: dict[str, Any]) -> str:
    """Classify a market period structurally, without using the expected price."""
    text = _market_text(market)
    if re.search(r"\b(?:1st|first)\s+half\b|\bhalf[ -]?time\b", text):
        return "first_half"
    if re.search(r"\b(?:2nd|second)\s+half\b", text):
        return "second_half"
    period = re.search(r"\b(?:(\d+)(?:st|nd|rd|th)\s+period|period\s*(\d+))\b", text)
    if period:
        return f"period_{period.group(1) or period.group(2)}"
    quarter = re.search(r"\b(?:(\d+)(?:st|nd|rd|th)\s+quarter|quarter\s*(\d+))\b", text)
    if quarter:
        return f"quarter_{quarter.group(1) or quarter.group(2)}"
    first_innings = re.search(r"\b(?:first|1st)\s+(\d+)\s+innings?\b", text)
    if first_innings:
        return f"first_{first_innings.group(1)}_innings"
    inning = re.search(r"\b(?:(\d+)(?:st|nd|rd|th)\s+innings?|innings?\s*(\d+))\b", text)
    if inning:
        return f"inning_{inning.group(1) or inning.group(2)}"
    set_match = re.search(r"\b(?:set\s*(\d+)|(\d+)(?:st|nd|rd|th)\s+set)\b", text)
    if set_match:
        return f"set_{set_match.group(1) or set_match.group(2)}"
    game = re.search(r"\b(?:game\s*(\d+)|(\d+)(?:st|nd|rd|th)\s+game)\b", text)
    if game:
        return f"game_{game.group(1) or game.group(2)}"
    return "full"


def _has_explicit_period_context(descriptor: dict[str, Any]) -> bool:
    context = descriptor.get("context") or {}
    return context.get("scope") == "full" or any(
        context.get(key) is not None for key in ("set", "game", "period_number")
    )


def _market_kind_matches(
    market: dict[str, Any], descriptor: dict[str, Any], *, include_contextual: bool = False,
) -> bool:
    text = _market_text(market)
    kind = descriptor.get("kind")
    if not _context_matches(text, descriptor.get("context") or {}):
        return False
    if (descriptor.get("context") or {}).get("scope") == "full" and _market_scope(market) != "full":
        return False
    if kind in {"total", "team_total"}:
        market_context = str((descriptor.get("context") or {}).get("market") or "")
        has_total_shape = "total" in text or (market_context and "overunder" in text.replace("/", ""))
        if not has_total_shape or any(token in text for token in ("bands", "odd/even", "moneyline and", "result and", "both teams")):
            return False
        name = str(market.get("name") or "").lower()
        template = str(market.get("templateMarketName") or "").lower()
        if kind == "total" and any(token in template for token in ("home team", "away team", "team total")):
            return False
        if kind == "total" and re.search(r"(?:corner|card|offside|shot|foul).*?\b(?:[a-z][a-z .'-]+)\s+total\b", name) and "first half" not in name and "second half" not in name:
            return False
        return True
    if kind == "handicap":
        if descriptor.get("line") == 0 and "draw no bet" in text and (include_contextual or "half" not in text):
            return True
        if not any(token in text for token in ("handicap", "spread")):
            return False
        return include_contextual or not any(token in text for token in (
            "half handicap", "quarter handicap", "half spread", "quarter spread",
            "set 1 handicap", "set 2 handicap", "set 3 handicap",
        ))
    if kind == "score_handicap":
        score = descriptor.get("score") or ()
        market_shape = any(token in text for token in ("handicap result", "match result"))
        if include_contextual:
            market_shape = market_shape or "handicap" in text
        return market_shape and score and all(str(value) in text for value in score)
    if kind == "double_chance":
        return "double chance" in text and (include_contextual or not any(token in text for token in ("half", "quarter", "set")))
    if kind == "moneyline":
        excluded = ("double", "and total", "and both", "handicap")
        if not include_contextual:
            excluded = ("half", "quarter", "set", "game", *excluded)
        market_shape = any(token in text for token in (
            "money line", "moneyline", "match result", "to win match", "match betting",
        ))
        if include_contextual:
            market_shape = market_shape or "current set winner" in text or "game winner" in text
            market_shape = market_shape or bool(re.search(r"\bset\s*\d+\s+result\b", text))
            market_shape = market_shape or bool(re.search(
                r"\b(?:first|second|1st|2nd)[ -]+half\s+result\b", text,
            ))
        return (
            market_shape
            and not any(token in text for token in excluded)
        )
    return False


def _outcome_price(outcome: dict[str, Any]) -> tuple[float | None, dict[str, Any] | None]:
    for child in outcome.get("children") or []:
        price = child.get("price") if isinstance(child, dict) else None
        if not isinstance(price, dict) or str(price.get("isActive") or "true").lower() == "false":
            continue
        value = _to_float(price.get("priceDec"))
        if value is not None and value > 1:
            return value, price
    return None, None


def _outcome_line(outcome: dict[str, Any], price: dict[str, Any], market: dict[str, Any]) -> float | None:
    for value in (price.get("handicapValueDec"), price.get("rawHandicapValue"), outcome.get("rawHandicapValue"), market.get("rawHandicapValue")):
        parsed = _to_float(value)
        if parsed is not None:
            return parsed
    numbers = re.findall(r"[-+]?\d+(?:\.\d+)?", str(market.get("name") or ""))
    return _to_float(numbers[-1]) if numbers else None


def _team_score(arb: dict[str, Any], team: int, outcome_name: str) -> float:
    target_names, other_names = _target_names(arb, team)
    target = max((_similarity(value, outcome_name) for value in target_names), default=0.0)
    other = max((_similarity(value, outcome_name) for value in other_names), default=0.0)
    return target - 0.25 * other


def _market_priority(arb: dict[str, Any], market: dict[str, Any], descriptor: dict[str, Any]) -> float:
    name = str(market.get("name") or "").strip().lower()
    template = str(market.get("templateMarketName") or "").strip().lower()
    kind = descriptor.get("kind")
    sport = str(arb.get("sport") or "").lower()
    if kind == "moneyline":
        if name == "money line":
            return 24 if sport in {"basketball", "baseball"} else 16
        if name == "match betting":
            return 24 if sport in {"soccer", "tennis"} else 14
        return 4
    if kind == "double_chance":
        return 24 if name == "double chance" else 8
    if kind == "handicap":
        if descriptor.get("line") == 0 and name == "draw no bet":
            return 24
        if name.startswith(("games handicap", "set handicap", "match handicap")):
            return 16
        if template in {"handicap 2-way", "game handicap", "games handicap", "set handicap", "spread"}:
            return 12
    if kind == "score_handicap":
        return 20
    return 0


def resolve_quote_from_event(arb: dict[str, Any], event_id: str, event: dict[str, Any], *, elapsed_ms: float | None = None) -> dict[str, Any]:
    descriptor = _selection_descriptor(arb)
    base = {
        "verified": False, "status": "UNAVAILABLE", "current_odds": None, "feed_odds": _to_float(arb.get("bk2_odds")),
        "selection": arb.get("bk2_selection"), "event_id": event_id, "source": "ladbrokes-openbet",
    }
    if elapsed_ms is not None:
        base["elapsed_ms"] = round(elapsed_ms, 1)
    if descriptor.get("_unknown") or not descriptor.get("kind"):
        return {**base, "status": "UNSUPPORTED_SELECTION", "detail": "Ladbrokes selection format is not supported"}
    rows: list[tuple[float, dict[str, Any], dict[str, Any], dict[str, Any], float]] = []
    for child in event.get("children") or []:
        market = child.get("market") if isinstance(child, dict) else None
        if not isinstance(market, dict) or not _market_kind_matches(market, descriptor, include_contextual=True):
            continue
        if str(market.get("marketStatusCode") or "A") != "A":
            continue
        for outcome_child in market.get("children") or []:
            outcome = outcome_child.get("outcome") if isinstance(outcome_child, dict) else None
            if not isinstance(outcome, dict) or str(outcome.get("outcomeStatusCode") or "A") != "A":
                continue
            price_value, price = _outcome_price(outcome)
            if price_value is None or price is None:
                continue
            name = str(outcome.get("name") or "")
            lower = name.lower()
            score = _market_priority(arb, market, descriptor)
            kind = descriptor["kind"]
            if kind in {"total", "team_total"}:
                if descriptor["direction"] not in lower:
                    continue
                line = _outcome_line(outcome, price, market)
                if descriptor.get("line") is not None and (line is None or abs(abs(line) - abs(float(descriptor["line"]))) > 0.001):
                    continue
                if kind == "team_total" and _team_score(arb, descriptor["team"], _market_text(market)) < 35:
                    continue
                score += 8 if not re.search(r"\b(?:half|quarter|set|game)\b", _market_text(market)) else 0
            elif kind == "handicap":
                line = _outcome_line(outcome, price, market)
                if descriptor.get("line") == 0 and "draw no bet" in _market_text(market):
                    line = 0.0
                if descriptor.get("line") is not None and (line is None or abs(line - float(descriptor["line"])) > 0.001):
                    continue
                identity_score = _team_score(arb, descriptor["team"], name)
                if identity_score < 35:
                    continue
                score += identity_score / 10
            elif kind in {"moneyline", "score_handicap"}:
                team = descriptor.get("team")
                if kind == "score_handicap":
                    score_pair = descriptor.get("score") or (0, 0)
                    desired_line = abs(float(score_pair[0]) - float(score_pair[1]))
                    line = _outcome_line(outcome, price, market)
                    if line is None or abs(line - desired_line) > 0.001:
                        continue
                if team == 0:
                    if "draw" not in lower:
                        continue
                    score += 10
                else:
                    identity_score = _team_score(arb, int(team), name)
                    if identity_score < 35:
                        continue
                    score += identity_score / 10
            elif kind == "double_chance":
                wanted = descriptor["teams"]
                has_draw = "draw" in lower
                if (0 in wanted) != has_draw:
                    continue
                team_scores = [_team_score(arb, team, name) for team in (1, 2)]
                wanted_team = next((team for team in wanted if team in {1, 2}), None)
                if wanted_team is None:
                    if not all(token in lower for token in ("home", "away")) and "draw" in lower:
                        continue
                else:
                    identity_score = team_scores[wanted_team - 1]
                    if identity_score < 35:
                        continue
                    score += identity_score / 10
            rows.append((score, market, outcome, price, price_value))
    if not rows:
        return {**base, "detail": "Ladbrokes returned no exact open selection"}
    if not _has_explicit_period_context(descriptor):
        scopes = sorted({_market_scope(row[1]) for row in rows})
        if len(scopes) > 1:
            markets = sorted({str(row[1].get("name") or "") for row in rows if row[1].get("name")})
            return {
                **base,
                "status": "AMBIGUOUS_CONTEXT",
                "detail": "Forted omitted the Ladbrokes period; this exact selection exists in multiple scopes",
                "candidate_scopes": scopes,
                "candidate_markets": markets[:12],
            }
    rows.sort(key=lambda row: -row[0])
    if len(rows) > 1 and abs(rows[0][0] - rows[1][0]) < 0.25 and rows[0][2].get("id") != rows[1][2].get("id"):
        return {**base, "status": "AMBIGUOUS_SELECTION", "detail": "Multiple Ladbrokes outcomes match without a safe structural tie-break"}
    _, market, outcome, price, current_odds = rows[0]
    return {
        **base, "verified": True, "status": "OK", "current_odds": current_odds,
        "detail": f"Ladbrokes OpenBet verified {market.get('name')} / {outcome.get('name')}",
        "market_id": str(market.get("id") or ""), "market_name": market.get("name"),
        "selection_id": str(outcome.get("id") or ""), "outcome_name": outcome.get("name"),
        "price_id": str(price.get("id") or ""), "points": _outcome_line(outcome, price, market),
    }


def _fetch_events_sync(event_ids: list[str], config: LadbrokesSportsbookConfig) -> tuple[dict[str, dict[str, Any]], float]:
    requested = list(dict.fromkeys(str(value) for value in event_ids if str(value).isdigit()))
    if not requested:
        return {}, 0.0
    started = time.monotonic()
    events: dict[str, dict[str, Any]] = {}
    try:
        with httpx.Client(
            proxy=config.proxy_url or None,
            timeout=config.timeout_sec,
            headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
            follow_redirects=True,
        ) as client:
            for offset in range(0, len(requested), config.max_batch_size):
                batch = requested[offset:offset + config.max_batch_size]
                response = client.get(
                    f"{config.siteserver_url.rstrip('/')}/{','.join(batch)}",
                    params=[
                        ("simpleFilter", "market.marketStatusCode:equals:A"),
                        ("simpleFilter", "outcome.outcomeStatusCode:equals:A"),
                        ("translationLang", "en"),
                    ],
                )
                response.raise_for_status()
                payload = response.json()
                for child in ((payload.get("SSResponse") or {}).get("children") or []):
                    event = child.get("event") if isinstance(child, dict) else None
                    if isinstance(event, dict) and str(event.get("id") or "") in requested:
                        events[str(event["id"])] = event
    except Exception as exc:  # noqa: BLE001
        raise LadbrokesSportsbookError(str(exc).strip() or repr(exc)) from exc
    return events, (time.monotonic() - started) * 1000


class LadbrokesSportsbookClient:
    def __init__(self, config: LadbrokesSportsbookConfig | None = None):
        self.config = config or LadbrokesSportsbookConfig.from_env()
        self._cache: dict[str, tuple[float, dict[str, Any], float]] = {}
        self._batch_lock = asyncio.Lock()

    async def prefetch(self, arbs: list[dict[str, Any]]) -> None:
        event_ids = [event_id for arb in arbs if (event_id := extract_event_id(arb))]
        now = time.monotonic()
        missing = [event_id for event_id in event_ids if not self._cache.get(event_id) or now - self._cache[event_id][0] > self.config.cache_ttl_sec]
        if not missing:
            return
        async with self._batch_lock:
            now = time.monotonic()
            missing = [event_id for event_id in missing if not self._cache.get(event_id) or now - self._cache[event_id][0] > self.config.cache_ttl_sec]
            if not missing:
                return
            events, elapsed_ms = await asyncio.to_thread(_fetch_events_sync, missing, self.config)
            stored_at = time.monotonic()
            for event_id, event in events.items():
                self._cache[event_id] = (stored_at, event, elapsed_ms)

    async def resolve_live_quote(self, arb: dict[str, Any]) -> dict[str, Any]:
        event_id = extract_event_id(arb)
        if not event_id:
            return {"verified": False, "status": "LADBROKES_IDENTIFIER_MISSING", "detail": "Ladbrokes event URL/id is missing", "current_odds": None, "source": "ladbrokes-openbet"}
        if not self.config.configured():
            return {"verified": False, "status": "LADBROKES_NOT_CONFIGURED", "detail": "Ladbrokes SiteServer is not configured", "current_odds": None, "source": "ladbrokes-openbet"}
        try:
            await self.prefetch([arb])
        except Exception as exc:  # noqa: BLE001
            return {"verified": False, "status": "LADBROKES_SOURCE_ERROR", "detail": str(exc), "current_odds": None, "event_id": event_id, "source": "ladbrokes-openbet"}
        cached = self._cache.get(event_id)
        if not cached:
            return {"verified": False, "status": "UNAVAILABLE", "detail": "Ladbrokes returned no event", "current_odds": None, "event_id": event_id, "source": "ladbrokes-openbet"}
        return resolve_quote_from_event(arb, event_id, cached[1], elapsed_ms=cached[2])

    async def resolve_many(self, arbs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        await self.prefetch(arbs)
        return [await self.resolve_live_quote(arb) for arb in arbs]
