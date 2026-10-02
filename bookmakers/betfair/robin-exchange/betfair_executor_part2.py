"""betfair_executor: часть 2 из 2.

Вынесено из betfair_executor.py без изменения логики: перенесён только текст,
ссылки на имена исходного модуля идут через ``betfair_executor.ИМЯ``, поэтому
подмена в тестах продолжает действовать.  Имена возвращаются в
исходный модуль звёздным импортом в его конце.
"""
from __future__ import annotations

from typing import Any
from pathlib import Path
import csv
from datetime import datetime
import hashlib
import json
import math
import os
import tempfile
import time
from datetime import timedelta
from datetime import timezone

import betfair_executor
from betfair_executor import BetfairClient


def _pair_score(want_home: str, want_away: str, got_home: str, got_away: str) -> float:
    wh, wa, gh, ga = map(betfair_executor._compact, (want_home, want_away, got_home, got_away))
    if not wh or not wa or not gh or not ga:
        return 0.0
    score = 0.0
    if wh == gh:
        score += 4
    elif wh in gh or gh in wh:
        score += 2
    if wa == ga:
        score += 4
    elif wa in ga or ga in wa:
        score += 2
    return score

def _catalogue_event_names(market: dict[str, Any]) -> tuple[str, str]:
    name = str((market.get("event") or {}).get("name") or "")
    for sep in (" v ", " vs ", " - ", ":"):
        if sep in name:
            left, right = name.split(sep, 1)
            return left.strip(), right.strip()
    return name.strip(), ""

def _event_pair_score(arb: dict[str, Any], market: dict[str, Any]) -> float:
    home, away = betfair_executor._split_match_name(arb)
    got_home, got_away = betfair_executor._catalogue_event_names(market)
    return max(
        betfair_executor._pair_score(home, away, got_home, got_away),
        betfair_executor._pair_score(home, away, got_away, got_home) - 1,
    )

def _runner_pair_score(arb: dict[str, Any], market: dict[str, Any]) -> float:
    home, away = betfair_executor._split_match_name(arb)
    runners = []
    for runner in market.get("runners") or []:
        name = str(runner.get("runnerName") or "").strip()
        normalized = betfair_executor._norm_text(name)
        if not name or normalized in {"draw", "ничья", "yes", "no"}:
            continue
        if normalized.endswith(" yes") or normalized.endswith(" no"):
            continue
        runners.append(name)
    best = 0.0
    for idx, first in enumerate(runners):
        for second in runners[idx + 1:]:
            best = max(
                best,
                betfair_executor._pair_score(home, away, first, second),
                betfair_executor._pair_score(home, away, second, first) - 1,
            )
    return best

def _event_matches_arb(arb: dict[str, Any], market: dict[str, Any], *, min_score: float = 5.0) -> bool:
    got_home, got_away = betfair_executor._catalogue_event_names(market)
    if not got_home:
        return False
    if betfair_executor._runner_pair_score(arb, market) >= min_score:
        return True
    if not got_away:
        compact_event = betfair_executor._compact(got_home)
        home, away = betfair_executor._split_match_name(arb)
        return bool(betfair_executor._compact(home) and betfair_executor._compact(away) and betfair_executor._compact(home) in compact_event and betfair_executor._compact(away) in compact_event)
    return betfair_executor._event_pair_score(arb, market) >= min_score

def _best_back_price(book: dict[str, Any], selection_id: Any, handicap: Any = None) -> tuple[float | None, float | None]:
    return betfair_executor._best_exchange_price(book, selection_id, handicap, side="BACK")

def _best_exchange_price(book: dict[str, Any], selection_id: Any, handicap: Any = None, *, side: str = "BACK") -> tuple[float | None, float | None]:
    ladder = "availableToLay" if str(side).upper() == "LAY" else "availableToBack"
    for runner in book.get("runners") or []:
        if str(runner.get("selectionId")) != str(selection_id):
            continue
        if handicap not in (None, "") and runner.get("handicap") not in (None, ""):
            if betfair_executor._to_float(runner.get("handicap")) != betfair_executor._to_float(handicap):
                continue
        best = ((runner.get("ex") or {}).get(ladder) or [None])[0] or {}
        return betfair_executor._to_float(best.get("price")), betfair_executor._to_float(best.get("size"))
    return None, None

def _quote_candidate_from_runner(
    market: dict[str, Any],
    runner: dict[str, Any],
    book: dict[str, Any],
    *,
    exchange_side: str,
    inferred_by_price: bool = False,
) -> dict[str, Any] | None:
    if str(book.get("status") or "").upper() not in {"", "OPEN"}:
        return None
    exchange_price, size = betfair_executor._best_exchange_price(book, runner.get("selectionId"), runner.get("handicap"), side=exchange_side)
    if exchange_price is None:
        return None
    display_odds = betfair_executor._exchange_display_odds(exchange_price, exchange_side)
    candidate = {
        "market_id": str(market.get("marketId")),
        "selection_id": runner.get("selectionId"),
        "handicap": runner.get("handicap"),
        "side": exchange_side,
        "runner_name": runner.get("runnerName"),
        "market_name": market.get("marketName"),
        "market_type": (market.get("description") or {}).get("marketType"),
        "odds": display_odds,
        "exchange_odds": exchange_price,
        "available_size": size,
    }
    if inferred_by_price:
        candidate["selection_inferred_by_price"] = True
    return candidate

def _moneyline_price_fallback_candidates(
    arb: dict[str, Any],
    market_catalogue: list[dict[str, Any]],
    books_by_id: dict[str, dict[str, Any]],
    *,
    exchange_side: str,
    expected: float,
) -> list[dict[str, Any]]:
    parsed = betfair_executor._parse_market_selection(arb)
    if parsed.get("kind") != "moneyline" or parsed.get("team") not in {1, 2}:
        return []
    out: list[dict[str, Any]] = []
    for market in market_catalogue:
        market_id = str(market.get("marketId") or "")
        if not market_id:
            continue
        if not betfair_executor._market_context_matches(parsed.get("market_context"), market):
            continue
        if not betfair_executor._is_moneyline_like_market(market, parsed):
            continue
        book = books_by_id.get(market_id) or {}
        for runner in market.get("runners") or []:
            runner_name = betfair_executor._norm_text(runner.get("runnerName"))
            if "draw" in runner_name or "ничья" in runner_name:
                continue
            candidate = betfair_executor._quote_candidate_from_runner(
                market,
                runner,
                book,
                exchange_side=exchange_side,
                inferred_by_price=True,
            )
            if candidate and candidate.get("odds") == expected:
                out.append(candidate)
    return out

def _selection_matches(arb: dict[str, Any], market: dict[str, Any], runner: dict[str, Any]) -> bool:
    parsed = betfair_executor._parse_market_selection(arb)
    runner_name = betfair_executor._norm_text(runner.get("runnerName"))
    market_type = str(((market.get("description") or {}).get("marketType") or "")).upper()
    market_name = betfair_executor._norm_text(market.get("marketName"))
    home, away = betfair_executor._split_match_name(arb)

    if parsed["kind"] == "moneyline":
        if not betfair_executor._market_context_matches(parsed.get("market_context"), market):
            return False
        if not betfair_executor._is_moneyline_like_market(market, parsed):
            return False
        team = parsed.get("team")
        if team == 0:
            return "draw" in runner_name or "ничья" in runner_name
        target = home if team == 1 else away if team == 2 else parsed.get("selection")
        return bool(target and (betfair_executor._compact(target) in betfair_executor._compact(runner.get("runnerName")) or betfair_executor._compact(runner.get("runnerName")) in betfair_executor._compact(target)))

    if parsed["kind"] == "totals":
        if parsed.get("invalid_reason"):
            return False
        if not betfair_executor._market_context_matches(parsed.get("market_context"), market):
            return False
        if parsed.get("team") is None and betfair_executor._is_team_total_market(market.get("marketName") or "", home, away):
            return False
        if not betfair_executor._contexts_compatible(parsed.get("context"), betfair_executor._market_context_from_market(market)):
            return False
        if not betfair_executor._total_team_matches_market(parsed.get("team"), market.get("marketName") or "", home, away):
            return False
        if not parsed.get("direction"):
            return False
        if betfair_executor._runner_total_direction(runner_name) != parsed["direction"]:
            return False
        line = parsed.get("line")
        handicap = betfair_executor._to_float(runner.get("handicap"))
        if line is None or handicap is None:
            return False
        if abs(handicap - float(line)) > 0.01:
            return False
        return "OVER_UNDER" in market_type or "total" in market_name or "over" in runner_name or "under" in runner_name

    if parsed["kind"] == "handicap":
        if parsed.get("invalid_reason"):
            return False
        if "HANDICAP" not in market_type and "handicap" not in market_name:
            return False
        if not betfair_executor._market_context_matches(parsed.get("market_context"), market):
            return False
        if not betfair_executor._contexts_compatible(parsed.get("context"), betfair_executor._market_context_from_market(market)):
            return False
        team = parsed.get("team")
        target = home if team == 1 else away if team == 2 else ""
        if target and betfair_executor._compact(target) not in betfair_executor._compact(runner.get("runnerName")):
            return False
        line = parsed.get("line")
        handicap = betfair_executor._to_float(runner.get("handicap"))
        if line is None or handicap is None:
            return False
        if parsed.get("line_has_sign"):
            return abs(handicap - float(line)) <= 0.01
        return abs(handicap - float(line)) <= 0.01

    return False

async def resolve_live_quote(arb: dict[str, Any], client: BetfairClient) -> dict[str, Any]:
    """Resolve a RobinArb Betfair counter leg to the live Exchange best back."""
    market_id = betfair_executor.extract_market_id(arb)
    event_id = betfair_executor.extract_event_id(arb)
    if betfair_executor.is_betfair_fork(arb) and not market_id and not event_id:
        return {
            "verified": False,
            "status": "MARKET_NOT_FOUND",
            "detail": "Betfair fork did not contain a marketId or eventId field/link",
        }
    home, away = betfair_executor._split_match_name(arb)
    market_catalogue: list[dict[str, Any]] = []
    if market_id:
        market_catalogue = await client.list_market_catalogue({
            "filter": {"marketIds": [market_id]},
            "marketProjection": ["EVENT", "RUNNER_DESCRIPTION", "MARKET_DESCRIPTION", "MARKET_START_TIME"],
            "maxResults": "20",
        })
        if not market_catalogue:
            return {
                "verified": False,
                "status": "MARKET_NOT_FOUND",
                "detail": "Betfair marketId from fork URL was not found",
            }
        if market_catalogue and not any(betfair_executor._event_matches_arb(arb, market) for market in market_catalogue):
            return {
                "verified": False,
                "status": "MATCH_NOT_FOUND",
                "detail": "Betfair marketId event does not match fork teams",
            }
    elif event_id:
        market_catalogue = await client.list_market_catalogue({
            "filter": {"eventIds": [event_id]},
            "marketProjection": ["EVENT", "RUNNER_DESCRIPTION", "MARKET_DESCRIPTION", "MARKET_START_TIME"],
            "sort": "FIRST_TO_START",
            "maxResults": "200",
        })
        if not market_catalogue:
            return {
                "verified": False,
                "status": "MATCH_NOT_FOUND",
                "detail": "Betfair eventId from fork link was not found",
            }
        if market_catalogue and not any(betfair_executor._event_matches_arb(arb, market) for market in market_catalogue):
            return {
                "verified": False,
                "status": "MATCH_NOT_FOUND",
                "detail": "Betfair eventId event does not match fork teams",
            }
    if not market_catalogue:
        now = datetime.now(timezone.utc)
        until = now + timedelta(days=max(1, client.config.catalog_days_ahead))
        events = await client.list_market_catalogue({
            "filter": {
                "eventTypeIds": [betfair_executor._event_type_id(arb.get("sport"))],
                "marketTypeCodes": ["MATCH_ODDS"],
                "marketStartTime": {"from": now.isoformat(), "to": until.isoformat()},
            },
            "marketProjection": ["EVENT", "RUNNER_DESCRIPTION", "MARKET_DESCRIPTION", "MARKET_START_TIME"],
            "sort": "FIRST_TO_START",
            "maxResults": str(client.config.catalog_max_results),
        })
        best_event_id = None
        best_score = 0.0
        for event_market in events:
            score = betfair_executor._event_pair_score(arb, event_market)
            if score > best_score:
                best_score = score
                best_event_id = (event_market.get("event") or {}).get("id")
        if not best_event_id or best_score < 5:
            return {"verified": False, "status": "MATCH_NOT_FOUND", "detail": "Betfair event was not found by team names"}
        market_catalogue = await client.list_market_catalogue({
            "filter": {"eventIds": [str(best_event_id)]},
            "marketProjection": ["EVENT", "RUNNER_DESCRIPTION", "MARKET_DESCRIPTION", "MARKET_START_TIME"],
            "sort": "FIRST_TO_START",
            "maxResults": "200",
        })

    explicit_selection_id = betfair_executor.extract_selection_id(arb)
    exchange_side = str(betfair_executor._parse_market_selection(arb).get("exchange_side") or "BACK").upper()
    runner_candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for market in market_catalogue:
        if not market.get("marketId"):
            continue
        for runner in market.get("runners") or []:
            if explicit_selection_id and str(runner.get("selectionId")) != str(explicit_selection_id):
                continue
            if not betfair_executor._selection_matches(arb, market, runner):
                continue
            runner_candidates.append((market, runner))

    if not runner_candidates:
        detail = "Betfair selection was not found in event markets"
        if explicit_selection_id:
            detail = "Betfair explicit selectionId did not match the parsed fork runner"
        return {"verified": False, "status": "SELECTION_NOT_FOUND", "detail": detail}

    candidate_market_ids = [str(market.get("marketId")) for market, _runner in runner_candidates if market.get("marketId")]
    books = await client.list_market_book(candidate_market_ids)
    books_by_id = {str(item.get("marketId")): item for item in books}
    candidates: list[dict[str, Any]] = []
    expected = betfair_executor._to_float(arb.get("bk2_odds"))
    for market, runner in runner_candidates:
        book = books_by_id.get(str(market.get("marketId"))) or {}
        candidate = betfair_executor._quote_candidate_from_runner(market, runner, book, exchange_side=exchange_side)
        if candidate:
            candidates.append(candidate)
    if not candidates:
        return {"verified": False, "status": "SELECTION_NOT_FOUND", "detail": "Betfair selection was not found in event markets"}
    if expected is not None:
        candidates.sort(key=lambda item: abs(float(item["odds"]) - expected))
        if candidates[0]["odds"] != expected and not explicit_selection_id:
            price_fallbacks = betfair_executor._moneyline_price_fallback_candidates(
                arb,
                market_catalogue,
                books_by_id,
                exchange_side=exchange_side,
                expected=expected,
            )
            if len(price_fallbacks) == 1:
                candidates.insert(0, price_fallbacks[0])
    candidate = candidates[0]
    return {
        "verified": True,
        "status": "OK",
        "current_odds": candidate["odds"],
        "available_size": candidate.get("available_size"),
        "selection": candidate.get("runner_name"),
        "market": candidate.get("market_name"),
        "market_id": candidate.get("market_id"),
        "selection_id": candidate.get("selection_id"),
        "handicap": candidate.get("handicap"),
        "side": candidate.get("side") or "BACK",
        "exchange_odds": candidate.get("exchange_odds"),
        "raw": candidate,
    }

def build_place_orders_payload(quote: dict[str, Any], *, stake: float, odds: float, customer_ref_prefix: str = "rabf") -> dict[str, Any]:
    market_id = quote.get("market_id")
    selection_id = quote.get("selection_id")
    if not market_id or not selection_id:
        raise ValueError("Betfair quote is missing market_id/selection_id")
    side = str(quote.get("side") or "BACK").strip().upper()
    if side not in {"BACK", "LAY"}:
        raise ValueError("Betfair order side must be BACK or LAY")
    stake_f = betfair_executor._to_float(stake)
    odds_f = betfair_executor._to_float(quote.get("exchange_odds") if side == "LAY" and quote.get("exchange_odds") is not None else odds)
    if stake_f is None or stake_f <= 0 or odds_f is None or odds_f <= 1:
        raise ValueError("Betfair order stake/odds are invalid")
    size_f = round(stake_f, 2)
    if size_f <= 0 or not math.isclose(size_f, stake_f, abs_tol=1e-9):
        raise ValueError("Betfair order stake must be positive and use 2-decimal precision")
    instruction: dict[str, Any] = {
        "selectionId": int(selection_id),
        "side": side,
        "orderType": "LIMIT",
        "limitOrder": {
            "size": size_f,
            "price": round(odds_f, 2),
            "persistenceType": "LAPSE",
            "timeInForce": "FILL_OR_KILL",
            "minFillSize": size_f,
        },
    }
    handicap = betfair_executor._to_float(quote.get("handicap"))
    if handicap is not None:
        instruction["handicap"] = handicap
    ref_hash = hashlib.blake2s(f"{time.time()}:{market_id}:{selection_id}".encode(), digest_size=5).hexdigest()
    return {
        "marketId": str(market_id),
        "instructions": [instruction],
        "customerRef": f"{customer_ref_prefix}-{ref_hash}"[:32],
    }

def attempt_paths(data_dir: Path | str) -> tuple[Path, Path]:
    root = Path(data_dir)
    return root / "betfair_attempts.csv", root / "betfair_attempts"

def _iso(ts: float | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if ts is None else ts))

def build_attempt_record(
    arb: dict[str, Any],
    *,
    status: str,
    dry_run: bool,
    stake_plan: dict[str, Any] | None,
    pricing: dict[str, Any] | None,
    pinnacle_verify: dict[str, Any] | None,
    betfair_quote: dict[str, Any] | None,
    match: dict[str, Any] | None,
    failure_reason: str = "",
) -> dict[str, Any]:
    record_id = hashlib.blake2s(
        f"{time.time()}:{arb.get('id')}:{arb.get('bk2_odds')}:{status}".encode("utf-8"),
        digest_size=8,
    ).hexdigest()
    plan = stake_plan or {}
    return {
        "record_id": record_id,
        "created_at": betfair_executor._iso(),
        "status": status,
        "dry_run": "1" if dry_run else "0",
        "arb_id": arb.get("id", ""),
        "sport": arb.get("sport", ""),
        "match": arb.get("match", ""),
        "market": arb.get("market", ""),
        "betfair_selection": arb.get("bk2_selection") or arb.get("side2") or "",
        "betfair_odds_forted": arb.get("bk2_odds", ""),
        "betfair_odds_live": (betfair_quote or {}).get("current_odds", ""),
        "betfair_stake": plan.get("betfair_stake", ""),
        "pinnacle_odds_forted": arb.get("bk1_odds", ""),
        "pinnacle_odds_verified": (pinnacle_verify or {}).get("current_odds", ""),
        "robin_odds": (pricing or {}).get("robin_odds", arb.get("robin_odds", "")),
        "robin_stake": plan.get("robin_stake", ""),
        "counter_odds": arb.get("bk2_odds", ""),
        "forted_profit_pct": arb.get("profit_pct", ""),
        "robin_profit_pct": (pricing or {}).get("robin_profit_pct", arb.get("robin_profit_pct", "")),
        "price_match": (match or {}).get("status", ""),
        "failure_reason": failure_reason,
        "file_path": "",
    }

def write_attempt(data_dir: Path | str, row: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any]:
    csv_path, jsonl_dir = betfair_executor.attempt_paths(data_dir)
    jsonl_dir.mkdir(parents=True, exist_ok=True)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    record_id = str(row["record_id"])
    jsonl_path = jsonl_dir / f"{record_id}.jsonl"
    row = dict(row)
    row["file_path"] = str(jsonl_path)
    with jsonl_path.open("a", encoding="utf-8") as fh:
        for event in events:
            fh.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    lock_path = csv_path.with_suffix(csv_path.suffix + ".lock")
    with betfair_executor._ATTEMPT_WRITE_LOCK:
        with lock_path.open("a+", encoding="utf-8") as lock_fh:
            if betfair_executor.fcntl is not None:
                betfair_executor.fcntl.flock(lock_fh.fileno(), betfair_executor.fcntl.LOCK_EX)
            tmp_name = ""
            try:
                existing_rows: list[dict[str, Any]] = []
                if csv_path.exists():
                    with csv_path.open("r", encoding="utf-8", newline="") as fh:
                        existing_rows = list(csv.DictReader(fh))
                replaced = False
                for idx, existing in enumerate(existing_rows):
                    if existing.get("record_id") == record_id:
                        existing_rows[idx] = row
                        replaced = True
                        break
                if not replaced:
                    existing_rows.append(row)
                with tempfile.NamedTemporaryFile(
                    "w",
                    encoding="utf-8",
                    newline="",
                    dir=str(csv_path.parent),
                    prefix=f".{csv_path.name}.",
                    delete=False,
                ) as fh:
                    tmp_name = fh.name
                    writer = csv.DictWriter(fh, fieldnames=betfair_executor.ATTEMPT_CSV_FIELDS)
                    writer.writeheader()
                    for item in existing_rows:
                        writer.writerow({field: item.get(field, "") for field in betfair_executor.ATTEMPT_CSV_FIELDS})
                os.replace(tmp_name, csv_path)
            finally:
                if tmp_name:
                    try:
                        Path(tmp_name).unlink(missing_ok=True)
                    except OSError:
                        pass
                if betfair_executor.fcntl is not None:
                    betfair_executor.fcntl.flock(lock_fh.fileno(), betfair_executor.fcntl.LOCK_UN)
    return row

__all__ = [
    "_best_back_price",
    "_best_exchange_price",
    "_catalogue_event_names",
    "_event_matches_arb",
    "_event_pair_score",
    "_iso",
    "_moneyline_price_fallback_candidates",
    "_pair_score",
    "_quote_candidate_from_runner",
    "_runner_pair_score",
    "_selection_matches",
    "attempt_paths",
    "build_attempt_record",
    "build_place_orders_payload",
    "resolve_live_quote",
    "write_attempt",
]
