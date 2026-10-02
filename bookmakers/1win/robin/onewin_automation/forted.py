"""Pure adapter from the current Forted Rust SSE schema to a 1win quote arb."""
from __future__ import annotations

import math
import re
from typing import Any


class FortedForkError(ValueError):
    pass


def _decimal(value: Any, label: str) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise FortedForkError(f"{label} is invalid") from exc
    if not math.isfinite(parsed) or parsed <= 1:
        raise FortedForkError(f"{label} must be an open decimal price")
    return parsed


def _line(value: str) -> str:
    match = re.search(r"\(\s*([-+]?\d+(?:[.,]\d+)?)\s*\)", value)
    return match.group(1).replace(",", ".") if match else ""


def _selection_label(raw: str) -> tuple[str, str]:
    clean = str(raw or "").strip()
    compact = re.sub(r"\s+", "", clean.lower().replace("ё", "е"))
    point = _line(clean)
    if compact in {"п1", "1", "home"}:
        return "Moneyline", "Home"
    if compact in {"п2", "2", "away"}:
        return "Moneyline", "Away"
    if compact in {"x", "х", "draw", "ничья"}:
        return "Moneyline", "Draw"
    if compact in {"1x", "1х", "x2", "х2", "12"}:
        return "Moneyline", compact.replace("х", "X").upper()
    if compact.startswith(("ф1", "f1", "handicap1")) and point:
        return "Handicap", f"Handicap 1 ({point})"
    if compact.startswith(("ф2", "f2", "handicap2")) and point:
        return "Handicap", f"Handicap 2 ({point})"
    if compact.startswith("тб") and point:
        return "Totals", f"Over ({point})"
    if compact.startswith("тм") and point:
        return "Totals", f"Under ({point})"
    if compact.startswith(("ит1б", "it1over")) and point:
        return "Totals", f"IT1B({point})"
    if compact.startswith(("ит1м", "it1under")) and point:
        return "Totals", f"IT1M({point})"
    if compact.startswith(("ит2б", "it2over")) and point:
        return "Totals", f"IT2B({point})"
    if compact.startswith(("ит2м", "it2under")) and point:
        return "Totals", f"IT2M({point})"
    raise FortedForkError(f"unsupported Forted selection: {clean or '<empty>'}")


def _context_metadata(market_name: str) -> dict[str, Any]:
    lower = str(market_name or "").lower()
    result: dict[str, Any] = {}
    if re.search(r"(?:\d+\s*(?:[-–]|по)\s*\d+\s*минут|\bпервые\s+\d+\s*иннинг|\+|вместе)", lower):
        result["unsupported_context"] = True
    coordinate_patterns = (
        ("map_number", r"(?:\b(\d+)\s*карт(?:а|ы|е|у)\b|\bmap\s*(\d+)\b)"),
        ("set_number", r"(?:\b(\d+)\s*сет(?:а|е|у)?\b|\bset\s*(\d+)\b)"),
    )
    for key, pattern in coordinate_patterns:
        match = re.search(pattern, lower)
        if match:
            result[key] = int(match.group(1) or match.group(2))
    period_patterns = (
        ("half", r"(?:\b(\d+)\s*(?:тайм|половин)|\bhalf\s*(\d+)\b)"),
        ("inning", r"(?:\b(\d+)\s*иннинг|\binning\s*(\d+)\b)"),
        ("quarter", r"(?:\b(\d+)\s*четверт|\bquarter\s*(\d+)\b)"),
        ("period", r"(?:\b(\d+)\s*период|\bperiod\s*(\d+)\b)"),
    )
    for period_type, pattern in period_patterns:
        match = re.search(pattern, lower)
        if match:
            result["period_number"] = int(match.group(1) or match.group(2))
            result["period_type"] = period_type
            break
    return result


def arb_from_forted_fork(fork: dict[str, Any], *, arb_id: str = "") -> dict[str, Any]:
    """Translate exactly one Pinnacle×1win two-source fork.

    This adapter deliberately rejects partial arrays and additional source
    ambiguity instead of guessing which odds/stake segment belongs to 1win.
    """
    sources = fork.get("sources")
    odds = fork.get("odds")
    stakes = [item.strip() for item in str(fork.get("stakes") or "").split(";")]
    if not isinstance(sources, list) or len(sources) != 2:
        raise FortedForkError("exactly two Forted sources are required")
    if not isinstance(odds, list) or len(odds) != 2:
        raise FortedForkError("exactly two Forted prices are required")
    if len(stakes) != 2 or not all(stakes):
        raise FortedForkError("exactly two Forted stake segments are required")

    books = [str(source.get("bk") or "").lower() if isinstance(source, dict) else "" for source in sources]
    pin_indexes = [index for index, name in enumerate(books) if "pinnacle" in name]
    onewin_indexes = [index for index, name in enumerate(books) if "1win" in name]
    if len(pin_indexes) != 1 or len(onewin_indexes) != 1 or pin_indexes[0] == onewin_indexes[0]:
        raise FortedForkError("fork must contain exactly one Pinnacle and one 1win source")
    pin_index = pin_indexes[0]
    onewin_index = onewin_indexes[0]
    onewin_source = sources[onewin_index]
    event_url = str(onewin_source.get("bet_link") or "").strip()
    if not re.search(r"/sport/\d{6,}(?:[/?#]|$)", event_url):
        raise FortedForkError("1win event URL is missing or invalid")

    market, selection = _selection_label(stakes[onewin_index])
    market_name = str(fork.get("market_name") or "").strip()
    metadata = {
        "raw_stake_types": ";".join(stakes),
        "source_index": pin_index + 1,
        **_context_metadata(market_name),
    }
    try:
        market_arity = int(str(fork.get("market_arity")))
    except (TypeError, ValueError):
        market_arity = 0
    if market_arity in {2, 3}:
        metadata["market_arity"] = market_arity
    home = str(fork.get("team1") or sources[pin_index].get("team1") or "").strip()
    away = str(fork.get("team2") or sources[pin_index].get("team2") or "").strip()
    return {
        "id": arb_id or str(fork.get("match_key") or "onewin-forted"),
        "sport": str(fork.get("sport") or ""),
        "home": home,
        "away": away,
        "market": market,
        "market_name": market_name,
        "bk2": str(onewin_source.get("bk") or "1win.pro"),
        "bk2_url": event_url,
        "bk2_raw_link": event_url,
        "bk2_selection": selection,
        "bk2_odds": _decimal(odds[onewin_index], "1win odds"),
        "pinnacle_source_index": pin_index + 1,
        "pinnacle_market_metadata": metadata,
        "team1_en": str(onewin_source.get("team1_en") or "").strip(),
        "team2_en": str(onewin_source.get("team2_en") or "").strip(),
        "home_en": str(sources[pin_index].get("team1_en") or "").strip(),
        "away_en": str(sources[pin_index].get("team2_en") or "").strip(),
    }
