"""Fast anonymous sportsbook-price verification for 1win forks.

The public 1win match page receives current odds from top-parser's Socket.IO
feed.  This module speaks the small Engine.IO / Socket.IO subset required for
an odds snapshot, then resolves the exact Forted selection without logging in
or calling a bet endpoint.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import re
import time
import unicodedata
from dataclasses import dataclass
from typing import Any

from rapidfuzz import fuzz
from websockets.sync.client import connect


DEFAULT_PARTNER_ID = "44ba10e5-7df2-47ab-a44d-dc93803c7a6e"
DEFAULT_PUSH_URL = "wss://api-gateway.top-parser.com/push-server-v2/"
DEFAULT_ORIGIN = "https://1win.pro"


class OneWinSportsbookError(RuntimeError):
    def __init__(self, message, *, stage=None, partial_snapshots=None, received_at=None, elapsed_ms=None):
        super().__init__(message)
        # Diagnostics only. Existing callers still receive an exception; the
        # standalone read-only auditor can retain already received evidence.
        self.stage = stage
        self.partial_snapshots = partial_snapshots or {}
        self.received_at = received_at or {}
        self.elapsed_ms = elapsed_ms


@dataclass(frozen=True)
class OneWinSportsbookConfig:
    partner_id: str = DEFAULT_PARTNER_ID
    push_url: str = DEFAULT_PUSH_URL
    origin: str = DEFAULT_ORIGIN
    proxy_url: str = ""
    timeout_sec: float = 5.0
    cache_ttl_sec: float = 0.75

    @classmethod
    def from_env(cls) -> "OneWinSportsbookConfig":
        return cls(
            partner_id=os.getenv("ONEWIN_SPORTSBOOK_PARTNER_ID", DEFAULT_PARTNER_ID).strip() or DEFAULT_PARTNER_ID,
            push_url=os.getenv("ONEWIN_SPORTSBOOK_PUSH_URL", DEFAULT_PUSH_URL).strip() or DEFAULT_PUSH_URL,
            origin=os.getenv("ONEWIN_SPORTSBOOK_ORIGIN", DEFAULT_ORIGIN).strip() or DEFAULT_ORIGIN,
            proxy_url=os.getenv("ONEWIN_SPORTSBOOK_PROXY", "").strip(),
            timeout_sec=max(1.0, float(os.getenv("ONEWIN_SPORTSBOOK_TIMEOUT_SEC", "5"))),
            cache_ttl_sec=max(0.0, float(os.getenv("ONEWIN_SPORTSBOOK_CACHE_TTL_SEC", "0.75"))),
        )

    def configured(self) -> bool:
        return bool(self.partner_id and self.push_url and self.origin)


def is_onewin_fork(arb: dict[str, Any]) -> bool:
    values = " ".join(str(arb.get(key) or "") for key in (
        "bk1", "bk2", "counter_bk", "bk1_url", "bk2_url", "bk1_raw_link", "bk2_raw_link",
    )).lower()
    return bool(re.search(r"(?:^|[^a-z0-9])1win(?:\.pro)?(?:[^a-z0-9]|$)", values))


def extract_event_id(arb: dict[str, Any]) -> str | None:
    for key in ("onewin_event_id", "bk2_raw_link", "bk2_url", "bk1_raw_link", "bk1_url"):
        raw = str(arb.get(key) or "").strip()
        if not raw or "1win" not in raw.lower() and key != "onewin_event_id":
            continue
        match = re.search(r"(?:/sport/|[-/])(\d{6,})(?:[/?#]|$)", raw)
        if match:
            return match.group(1)
        if key == "onewin_event_id" and raw.isdigit():
            return raw
    return None


def _to_float(value: Any) -> float | None:
    try:
        parsed = float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _to_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _metadata(arb: dict[str, Any]) -> dict[str, Any]:
    value = arb.get("pinnacle_market_metadata") or arb.get("market_metadata") or {}
    return value if isinstance(value, dict) else {}


def raw_counter_selection(arb: dict[str, Any]) -> str:
    """Return the original Forted segment belonging to the counter bookmaker."""
    raw_pair = str(_metadata(arb).get("raw_stake_types") or "").strip()
    segments = [segment.strip() for segment in raw_pair.split(";") if segment.strip()]
    pin_index = _to_int(arb.get("pinnacle_source_index"))
    if segments and pin_index in {1, 2}:
        counter_index = 1 if pin_index == 2 else 2
        if len(segments) >= counter_index:
            return segments[counter_index - 1]
    return str(arb.get("bk2_selection") or arb.get("side2") or "").strip()


def _line_from_text(value: Any) -> float | None:
    text = str(value or "").replace(",", ".").translate(str.maketrans({"−": "-", "–": "-", "—": "-"}))
    match = re.search(r"\(\s*([-+]?\d+(?:\.\d+)?)\s*\)", text)
    return _to_float(match.group(1)) if match else None


def _selection_descriptor(arb: dict[str, Any]) -> dict[str, Any]:
    selection = raw_counter_selection(arb)
    clean = selection.strip()
    lower = clean.lower().replace("ё", "е")
    compact = re.sub(r"[^a-zа-я0-9]+", "", lower)
    metadata = _metadata(arb)
    context = {
        "set": _to_int(arb.get("set_number") or metadata.get("set_number")),
        "period": _to_int(arb.get("period_number") or metadata.get("period_number") or metadata.get("period")),
        "period_type": str(arb.get("period_type") or metadata.get("period_type") or "").strip().lower(),
        "game": _to_int(arb.get("game_number") or metadata.get("game_number")),
        "market": str(arb.get("market_context") or metadata.get("market_context") or "").strip().lower(),
    }
    _fill_context_from_market_name(context, arb.get("market_name"), arb.get("market_code"))
    line = _line_from_text(clean)
    if line is None:
        line = _to_float(metadata.get("counter_line"))

    if compact.startswith(("ит1", "it1")):
        return {"kind": "team_total", "team": 1, "designation": "over" if "б" in compact or "over" in compact else "under", "line": line, "context": context, "selection": selection}
    if compact.startswith(("ит2", "it2")):
        return {"kind": "team_total", "team": 2, "designation": "over" if "б" in compact or "over" in compact else "under", "line": line, "context": context, "selection": selection}
    if compact.startswith("тб") or lower.startswith("over"):
        return {"kind": "total", "designation": "over", "line": line, "context": context, "selection": selection}
    if compact.startswith("тм") or lower.startswith("under"):
        return {"kind": "total", "designation": "under", "line": line, "context": context, "selection": selection}
    if compact.startswith(("ф1", "f1", "handicap1")):
        return {"kind": "handicap", "team": 1, "designation": "1", "line": line, "context": context, "selection": selection}
    if compact.startswith(("ф2", "f2", "handicap2")):
        return {"kind": "handicap", "team": 2, "designation": "2", "line": line, "context": context, "selection": selection}
    if compact in {"п1", "1", "home"}:
        return {"kind": "moneyline", "team": 1, "designation": "1", "line": None, "context": context, "selection": selection}
    if compact in {"п2", "2", "away"}:
        return {"kind": "moneyline", "team": 2, "designation": "2", "line": None, "context": context, "selection": selection}
    if compact in {"x", "х", "draw", "ничья"}:
        return {"kind": "moneyline", "team": 0, "designation": "x", "line": None, "context": context, "selection": selection}
    return {"kind": None, "selection": selection, "context": context, "_unknown": True}


_CONTEXT_RE = re.compile(
    r"\b(?:(?:\d+(?:st|nd|rd|th)|first|second|third|fourth)\s+"
    r"(?:set|half|quarter|period|inning|game)|first\s+5\s+innings|"
    r"set\s+\d+|half\s+\d+|quarter\s+\d+|period\s+\d+|inning\s+\d+|game\s+\d+)\b",
    re.IGNORECASE,
)


_MARKET_PERIOD_TYPES = {
    "иннинг": "inning",
    "inning": "inning",
    "половин": "half",
    "тайм": "half",
    "half": "half",
    "четверт": "quarter",
    "quarter": "quarter",
    "период": "period",
    "period": "period",
}


def _fill_context_from_market_name(context: dict[str, Any], market_name: Any, market_code: Any) -> None:
    """Recover Forted period metadata that is sometimes present only in its label."""
    if context.get("set") or context.get("game") or context.get("period"):
        return
    name = str(market_name or "").lower().replace("ё", "е")
    match = re.search(
        r"(?<!\d)(\d+)\s*(иннинг|inning|половин|тайм|half|четверт|quarter|период|period)",
        name,
    )
    if match:
        context["period"] = int(match.group(1))
        context["period_type"] = _MARKET_PERIOD_TYPES[match.group(2)]
        return
    code_match = re.fullmatch(r"\s*(\d+)и\s*", str(market_code or "").lower())
    if code_match:
        context["period"] = int(code_match.group(1))
        context["period_type"] = "inning"


def _group_is_contextual(name: str) -> bool:
    return bool(_CONTEXT_RE.search(name or ""))


def _ordinal(number: int) -> str:
    if 10 <= number % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(number % 10, "th")
    return f"{number}{suffix}"


def _explicit_context_matches(group_name: str, context: dict[str, Any]) -> bool | None:
    lower = group_name.lower()
    if context.get("game"):
        number = int(context["game"])
        return bool(re.search(rf"\b(?:{_ordinal(number)}\s+game|game\s+{number})\b", lower))
    if context.get("set"):
        number = int(context["set"])
        return bool(re.search(rf"\b(?:{_ordinal(number)}\s+set|set\s+{number})\b", lower))
    if context.get("period"):
        number = int(context["period"])
        period_type = str(context.get("period_type") or "").lower()
        allowed_types = {
            "inning": ("inning",),
            "half": ("half",),
            "quarter": ("quarter",),
            "period": ("period",),
        }.get(period_type, ("half", "quarter", "period", "inning"))
        type_pattern = "|".join(allowed_types)
        marker = rf"\b(?:{_ordinal(number)}\s+(?:{type_pattern})|(?:{type_pattern})\s+{number})\b"
        if re.search(marker, lower):
            return True
        if period_type == "half" and number == 1:
            return bool(re.search(r"\b(?:1st|first)\s+5\s+innings?\b", lower))
        return bool(re.search(marker, lower))
    return None


def _has_explicit_context(context: dict[str, Any]) -> bool:
    return any(context.get(key) for key in ("set", "period", "game"))


def _group_kind(group: dict[str, Any], descriptor: dict[str, Any], event: dict[str, Any] | None) -> str | None:
    name = str(group.get("name") or "")
    lower = name.lower()
    if "handicap" in lower or "spread" in lower:
        return "handicap"
    if "total" in lower:
        # 1win names baseball player props as "Total. Player hits/doubles/...".
        # A matching O/U line is not enough to identify those as the event total.
        if lower.startswith("total. player") or " player " in f" {lower} ":
            return None
        if descriptor.get("kind") == "team_total" and event:
            team_key = "homeTeam" if descriptor.get("team") == 1 else "awayTeam"
            team_name = str((event.get(team_key) or {}).get("name") or "").lower()
            if team_name and team_name.split()[0] in lower:
                return "team_total"
        tail = lower.rsplit(".", 1)[-1].strip()
        if descriptor.get("kind") == "total" and tail.endswith(" total") and tail != "total":
            return None
        if any(token in lower for token in ("winner &", "result &", "correct score", "both teams", "race to")):
            return None
        return "total"
    if "winner" in lower or "result" in lower or "moneyline" in lower:
        return "moneyline"
    return None


_CYRILLIC_TO_LATIN = str.maketrans({
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "i", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c",
    "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
})


def _normalized_team_name(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or "").lower()).translate(_CYRILLIC_TO_LATIN)
    text = "".join(char for char in text if not unicodedata.combining(char))
    text = re.sub(r"\b(?:games?|women|w|men|fc|cf|bc|club)\b", " ", text)
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _team_similarity(left: Any, right: Any) -> float:
    first = _normalized_team_name(left)
    second = _normalized_team_name(right)
    if not first or not second:
        return 0.0
    return max(float(fuzz.ratio(first, second)), float(fuzz.token_set_ratio(first, second)))


def _canonical_counter_team(arb: dict[str, Any], fallback: int | None) -> int | None:
    selection = str(arb.get("bk2_selection") or arb.get("side2") or "").lower()
    compact = re.sub(r"[^a-zа-я0-9]+", "", selection.replace("ё", "е"))
    if compact in {"home", "п1", "1"} or compact.startswith(("handicap1", "ф1", "f1")):
        return 1
    if compact in {"away", "п2", "2"} or compact.startswith(("handicap2", "ф2", "f2")):
        return 2
    return fallback


def _market_context_matches(group_name: str, market_context: str) -> bool:
    lower = group_name.lower()
    context = market_context.lower().strip()
    tokens_by_context = {
        "corners": ("corner",),
        "cards": ("card", "booking"),
        "yellow_cards": ("yellow card",),
        "offsides": ("offside",),
        "throw_ins": ("throw-in", "throw in"),
        "fouls": ("foul",),
        "goal_kicks": ("goal kick",),
        "shots": ("shot",),
    }
    wanted = tokens_by_context.get(context)
    if wanted:
        return any(token in lower for token in wanted)
    prop_tokens = tuple(token for values in tokens_by_context.values() for token in values)
    return not any(token in lower for token in prop_tokens)


def _odd_line(odd: dict[str, Any]) -> float | None:
    variables = odd.get("vars") if isinstance(odd.get("vars"), dict) else {}
    line = _to_float(variables.get("v1"))
    if line is not None:
        return line
    name = str(odd.get("name") or "")
    matches = re.findall(r"[-+]?\d+(?:\.\d+)?", name)
    return _to_float(matches[-1]) if matches else None


def _candidate_rows(
    descriptor: dict[str, Any],
    snapshot: dict[str, Any],
    event: dict[str, Any] | None = None,
    *,
    include_blocked: bool = False,
) -> list[tuple[int, dict[str, Any], dict[str, Any], bool]]:
    requested_kind = descriptor.get("kind")
    requested_line = descriptor.get("line")
    requested_designation = str(descriptor.get("designation") or "").lower()
    context = descriptor.get("context") or {}
    explicit_context = _has_explicit_context(context)
    market_context = str(context.get("market") or "")
    rows: list[tuple[int, dict[str, Any], dict[str, Any], bool]] = []
    for group in snapshot.get("oddsGroups") or []:
        if not isinstance(group, dict) or _group_kind(group, descriptor, event) != requested_kind:
            continue
        group_name = str(group.get("name") or "")
        if not _market_context_matches(group_name, market_context):
            continue
        context_match = _explicit_context_matches(group_name, context)
        if explicit_context and context_match is not True:
            continue
        contextual = _group_is_contextual(group_name)
        for odd in group.get("oddsList") or []:
            if not isinstance(odd, dict):
                continue
            if not include_blocked and _to_int(odd.get("status")) != 1:
                continue
            if requested_kind not in {"moneyline", "handicap"} and str(odd.get("outcome") or "").lower() != requested_designation:
                continue
            odd_line = _odd_line(odd)
            if requested_line is not None:
                if odd_line is None or abs(odd_line - float(requested_line)) > 0.001:
                    continue
            score = 0
            if group.get("isBase"):
                score += 4
            if explicit_context:
                score += 8
            elif not contextual:
                score += 6
            if requested_kind == "moneyline" and not contextual:
                score += 2
            rows.append((score, group, odd, contextual))
    rows.sort(key=lambda row: -row[0])
    return rows


def resolve_quote_from_snapshot(
    arb: dict[str, Any],
    event_id: str,
    snapshot: dict[str, Any],
    *,
    event: dict[str, Any] | None = None,
    elapsed_ms: float | None = None,
) -> dict[str, Any]:
    descriptor = _selection_descriptor(arb)
    base = {
        "verified": False,
        "status": "UNAVAILABLE",
        "current_odds": None,
        "feed_odds": _to_float(arb.get("bk2_odds")),
        "selection": arb.get("bk2_selection"),
        "raw_selection": descriptor.get("selection"),
        "event_id": event_id,
        "source": "onewin-public-ws",
    }
    if elapsed_ms is not None:
        base["elapsed_ms"] = round(elapsed_ms, 1)
    if descriptor.get("_unknown") or not descriptor.get("kind"):
        return {**base, "status": "UNSUPPORTED_SELECTION", "detail": "1win selection format is not supported"}

    candidates = _candidate_rows(descriptor, snapshot, event)
    if not candidates:
        blocked = _candidate_rows(descriptor, snapshot, event, include_blocked=True)
        if blocked:
            return {**base, "status": "SUSPENDED", "detail": "Exact 1win selection is currently suspended"}
        return {**base, "detail": "1win snapshot has no exact open selection"}

    context = descriptor.get("context") or {}
    explicit_context = _has_explicit_context(context)
    if descriptor.get("kind") in {"moneyline", "handicap"}:
        team_number = _canonical_counter_team(arb, descriptor.get("team"))
        target_name = str(arb.get("home") if team_number == 1 else arb.get("away") if team_number == 2 else "")
        other_name = str(arb.get("away") if team_number == 1 else arb.get("home") if team_number == 2 else "")
        preferred_outcome = ""
        if _to_int(arb.get("pinnacle_source_index")) == 2 and target_name:
            source_names = (arb.get("team1_en"), arb.get("team2_en"))
            source_scores = [_team_similarity(target_name, name) - 0.25 * _team_similarity(other_name, name) for name in source_names]
            if max(source_scores, default=0.0) >= 45 and abs(source_scores[0] - source_scores[1]) >= 8:
                preferred_outcome = "1" if source_scores[0] > source_scores[1] else "2"
        if target_name:
            rescored = []
            for score, group, odd, contextual in candidates:
                identity = _team_similarity(target_name, odd.get("name")) - 0.25 * _team_similarity(other_name, odd.get("name"))
                if preferred_outcome and str(odd.get("outcome") or "").lower() == preferred_outcome:
                    identity += 100
                rescored.append((score + identity / 10, group, odd, contextual))
            rescored.sort(key=lambda row: -row[0])
            if rescored and (
                preferred_outcome
                or _team_similarity(target_name, rescored[0][2].get("name")) >= 45
            ):
                candidates = rescored
            else:
                candidates = [row for row in candidates if str(row[2].get("outcome") or "").lower() == str(descriptor.get("designation") or "").lower()]
        else:
            candidates = [row for row in candidates if str(row[2].get("outcome") or "").lower() == str(descriptor.get("designation") or "").lower()]
        if not candidates:
            expected_outcome = preferred_outcome or str(descriptor.get("designation") or "").lower()
            blocked = _candidate_rows(descriptor, snapshot, event, include_blocked=True)
            if any(str(row[2].get("outcome") or "").lower() == expected_outcome for row in blocked):
                return {**base, "status": "SUSPENDED", "detail": "Exact 1win team selection is currently suspended"}
            return {**base, "detail": "1win snapshot has no exact team selection"}
    if not explicit_context and candidates[0][3]:
        contextual_groups = {str(group.get("id")) for _, group, _, _ in candidates}
        if len(contextual_groups) > 1:
            return {**base, "status": "AMBIGUOUS_CONTEXT", "detail": "Exact selection exists in multiple 1win periods"}

    score, group, odd, contextual = candidates[0]
    _ = score
    current_odds = _to_float(odd.get("cf"))
    if current_odds is None or current_odds <= 1:
        return {**base, "detail": "1win returned an invalid decimal price"}
    return {
        **base,
        "verified": True,
        "status": "OK",
        "current_odds": current_odds,
        "detail": f"1win public feed verified {group.get('name')} / {odd.get('name')}",
        "odds_group_id": str(group.get("id") or ""),
        "odds_group_name": group.get("name"),
        "selection_id": str(odd.get("id") or ""),
        "outcome": odd.get("outcome"),
        "points": _odd_line(odd),
        "context_inferred": bool(contextual and not explicit_context),
        "snapshot_ts": snapshot.get("ts"),
    }


def _socket_url(config: OneWinSportsbookConfig) -> str:
    separator = "&" if "?" in config.push_url else "?"
    return (
        f"{config.push_url}{separator}Language=en-001&externalPartnerId={config.partner_id}"
        "&EIO=4&transport=websocket"
    )


def _fetch_snapshots_sync(
    event_ids: list[str],
    config: OneWinSportsbookConfig,
) -> tuple[dict[str, dict[str, Any]], float]:
    requested = list(dict.fromkeys(str(event_id) for event_id in event_ids if str(event_id).isdigit()))
    if not requested:
        return {}, 0.0
    started = time.monotonic()
    snapshots: dict[str, dict[str, Any]] = {}
    received_at: dict[str, float] = {}
    stage = "websocket_connect"
    try:
        with connect(
            _socket_url(config),
            origin=config.origin,
            proxy=config.proxy_url or None,
            open_timeout=config.timeout_sec,
            close_timeout=0.5,
            ping_interval=None,
            max_size=4 * 1024 * 1024,
        ) as socket:
            stage = "engineio_handshake"
            opened = socket.recv(timeout=config.timeout_sec)
            if not isinstance(opened, str) or not opened.startswith("0"):
                raise OneWinSportsbookError("1win Engine.IO handshake was not received")
            socket.send("40")
            stage = "socketio_handshake"
            deadline = time.monotonic() + config.timeout_sec
            while time.monotonic() < deadline:
                frame = socket.recv(timeout=max(0.1, deadline - time.monotonic()))
                if frame == "2":
                    socket.send("3")
                elif isinstance(frame, str) and frame.startswith("40"):
                    break
            else:
                raise OneWinSportsbookError("1win Socket.IO handshake timed out")

            payload = ["subscribe", {
                "messageType": "subscribe-match-odds",
                "data": {"matchIds": [int(value) for value in requested], "isBaseOddsGroups": False},
            }]
            socket.send("42" + json.dumps(payload, separators=(",", ":")))
            stage = "snapshot_receipt"
            while len(snapshots) < len(requested) and time.monotonic() < deadline:
                frame = socket.recv(timeout=max(0.1, deadline - time.monotonic()))
                if frame == "2":
                    socket.send("3")
                    continue
                if not isinstance(frame, str) or not frame.startswith("42"):
                    continue
                message = json.loads(frame[2:])
                body = message[1] if isinstance(message, list) and len(message) > 1 else {}
                if body.get("messageType") != "match-odds-snapshot" or not isinstance(body.get("data"), dict):
                    continue
                data = body["data"]
                match_id = str(data.get("matchId") or "")
                if match_id in requested:
                    snapshots[match_id] = data
                    received_at[match_id] = time.time()
    except Exception as exc:  # noqa: BLE001 - normalize transport errors for API callers
        raise OneWinSportsbookError(
            str(exc).strip() or repr(exc), stage=stage, partial_snapshots=snapshots,
            received_at=received_at, elapsed_ms=(time.monotonic() - started) * 1000,
        ) from exc
    return snapshots, (time.monotonic() - started) * 1000


class OneWinSportsbookClient:
    def __init__(self, config: OneWinSportsbookConfig | None = None):
        self.config = config or OneWinSportsbookConfig.from_env()
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
            snapshots, elapsed_ms = await asyncio.to_thread(_fetch_snapshots_sync, missing, self.config)
            stored_at = time.monotonic()
            for event_id, snapshot in snapshots.items():
                self._cache[event_id] = (stored_at, snapshot, elapsed_ms)

    async def resolve_live_quote(self, arb: dict[str, Any]) -> dict[str, Any]:
        event_id = extract_event_id(arb)
        if not event_id:
            return {"verified": False, "status": "ONEWIN_IDENTIFIER_MISSING", "detail": "1win event URL/id is missing", "current_odds": None, "source": "onewin-public-ws"}
        if not self.config.configured():
            return {"verified": False, "status": "ONEWIN_NOT_CONFIGURED", "detail": "1win public feed is not configured", "current_odds": None, "source": "onewin-public-ws"}
        try:
            await self.prefetch([arb])
        except Exception as exc:  # noqa: BLE001
            return {"verified": False, "status": "ONEWIN_SOURCE_ERROR", "detail": str(exc).strip() or repr(exc), "current_odds": None, "event_id": event_id, "source": "onewin-public-ws"}
        cached = self._cache.get(event_id)
        if not cached:
            return {"verified": False, "status": "UNAVAILABLE", "detail": "1win returned no odds snapshot for this event", "current_odds": None, "event_id": event_id, "source": "onewin-public-ws"}
        return resolve_quote_from_snapshot(arb, event_id, cached[1], elapsed_ms=cached[2])

    async def resolve_many(self, arbs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        await self.prefetch(arbs)
        return [await self.resolve_live_quote(arb) for arb in arbs]
