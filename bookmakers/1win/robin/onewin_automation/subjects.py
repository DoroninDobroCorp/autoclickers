"""Exact request/group subject classification shared by snapshot and identity gates."""
from __future__ import annotations

import re


_DEFINITIONS: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = (
    ("shots_on_target", ("удар в створ", "удары в створ", "shot on target", "shots on target"), ("shot on target", "shots on target")),
    ("goal_kicks", ("удар от ворот", "удары от ворот", "goal kick", "goal kicks"), ("goal kick",)),
    ("kills", ("убийства", "kill", "kills"), ("kill",)),
    ("corners", ("угловые", "corner", "corners"), ("corner",)),
    ("yellow_cards", ("желтые карты", "yellow cards"), ("yellow card",)),
    ("cards", ("карточки", "card", "cards", "bookings"), ("card", "booking")),
    ("offsides", ("офсайды", "offside", "offsides"), ("offside",)),
    ("fouls", ("фолы", "нарушения", "foul", "fouls"), ("foul",)),
    ("shots", ("удары", "shot", "shots"), ("shot",)),
    ("throw_ins", ("ауты", "throw-in", "throw-ins"), ("throw-in", "throw in")),
    ("aces", ("эйсы", "ace", "aces"), ("ace",)),
    ("double_faults", ("двойные ошибки", "double fault", "double faults"), ("double fault",)),
)

_GENERIC = frozenset({
    "", "total", "тотал", "goal", "goals", "гол", "голы", "point", "points",
    "очко", "очки", "game", "games", "гейм", "геймы", "round", "rounds",
    "раунд", "раунды", "map", "maps", "карта", "карты", "set", "sets", "сет",
    "сеты", "period", "periods", "период", "периоды", "winner", "победитель",
    "исход", "result", "результат", "handicap", "фора",
})


def requested_subject(market_name: str) -> str | None:
    source = str(market_name or "").lower().replace("ё", "е")
    subject = re.sub(r"\s+", " ", source.split(",", 1)[0]).strip()
    for canonical, aliases, _markers in _DEFINITIONS:
        if subject in aliases:
            return canonical
    return "base" if subject in _GENERIC else None


def group_subject(group_name: str) -> str:
    lower = str(group_name or "").lower()
    for canonical, _aliases, markers in _DEFINITIONS:
        if any(marker in lower for marker in markers):
            return canonical
    return "base"


def legacy_market_context(subject: str | None) -> str:
    return {
        "corners": "corners",
        "cards": "cards",
        "yellow_cards": "yellow_cards",
        "offsides": "offsides",
        "fouls": "fouls",
        "throw_ins": "throw_ins",
        "goal_kicks": "goal_kicks",
        "shots": "shots",
        "shots_on_target": "shots",
    }.get(subject or "", "")
