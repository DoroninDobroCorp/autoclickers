"""betfair_sportsbook_place_api: часть 1 из 2.

Вынесено из betfair_sportsbook_place_api.py без изменения логики: перенесён только текст,
ссылки на имена исходного модуля идут через ``betfair_sportsbook_place_api.ИМЯ``, поэтому
подмена в тестах продолжает действовать.  Имена возвращаются в
исходный модуль звёздным импортом в его конце.
"""
from __future__ import annotations

from typing import Any
import math
import time

import betfair_sportsbook_place_api


class BetfairSportsbookPlaceApiError(RuntimeError):
    """Raised for every failure mode of this client.

    `code` is one of the module-level constants above and is what callers
    (server.py) branch on -- PLACE_INDETERMINATE in particular must never be
    treated as a clean failure (the bet may have gone through).
    IMPLY_NETWORK_FAILED is pre-stake (implyBets never spends money) and must
    be treated the same as SESSION_UNAVAILABLE -- safe to fall back to the
    browser worker, unlike PLACE_INDETERMINATE/PLACE_REJECTED which are
    definitive because a real placeBet was sent.
    """

    def __init__(self, code: str, message: str = ""):
        self.code = code
        super().__init__(message or code)

def _to_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None

def _dig(data: Any, *path: Any) -> Any:
    current = data
    for key in path:
        if isinstance(key, int):
            if not isinstance(current, list) or key >= len(current):
                return None
            current = current[key]
        else:
            if not isinstance(current, dict):
                return None
            current = current.get(key)
    return current

def build_customer_ref(now_us: int | None = None) -> str:
    """`00000001` + a 12-digit microsecond timestamp (AC-7).

    Monotonic within the process so two calls in the same microsecond (e.g.
    back-to-back in tests) still produce distinct refs.
    """
    global _last_customer_ref_us
    us = now_us if now_us is not None else int(time.time() * 1_000_000)
    if us <= betfair_sportsbook_place_api._last_customer_ref_us:
        us = betfair_sportsbook_place_api._last_customer_ref_us + 1
    betfair_sportsbook_place_api._last_customer_ref_us = us
    return f"00000001{us % 10 ** 12:012d}"

def _selection_id_int(value: Any) -> int:
    text = str(value).strip()
    try:
        return int(text)
    except (TypeError, ValueError) as exc:
        raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(betfair_sportsbook_place_api.IMPLY_FAILED, f"selection_id is not numeric: {value!r}") from exc

def build_imply_bets_payload(*, market_id: str, selection_id: Any) -> dict[str, Any]:
    market_id = str(market_id).strip()
    if not market_id:
        raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(betfair_sportsbook_place_api.IMPLY_FAILED, "market_id is required")
    return {
        "betLegs": [
            {
                "betRunners": [
                    {"runner": {"marketId": market_id, "selectionId": betfair_sportsbook_place_api._selection_id_int(selection_id)}}
                ],
                "legType": "SIMPLE_SELECTION",
                "isBoostedLeg": False,
            }
        ]
    }

def build_market_prices_payload(*, market_ids: list[str]) -> dict[str, Any]:
    return {"marketIds": [str(item).strip() for item in market_ids if str(item).strip()]}

def build_resolve_market_payload(
    *,
    event_url: str,
    selection_id: Any,
    market_name: str,
    selection: str,
    expected_odds: float,
    selection_label: str | None = None,
    expected_line: float | None = None,
    market_type: str | None = None,
) -> dict[str, Any]:
    """Body for the worker's POST /resolve-market (Story 2.2b, AC-1).

    No market_id here -- that is exactly what the worker resolves through
    Betfair event-search and full market-card requests using the exact
    `market_name`/`selection` identity and live price.

    Reconcile regress1 P1-3 (money-critical, final cross-family audit fix):
    `selection_label` (line-enriched wanted text, e.g. "Under (93.5)"),
    `expected_line` (the already-verified numeric line), and `market_type`
    (Paddy's raw market classification, needed by the worker's structural
    matcher for the generic-Handicap-arity guard) are threaded through here
    too, not just the legacy DOM `/basket` payload -- previously this
    endpoint only ever sent market_name/selection/expected_odds, so the
    worker's own split-contract guard (resolveSelectionContract) could never
    fire on a real /resolve-market call and a line-bearing market's expected
    line silently re-derived the old (weaker), unverified way. All three are
    OPTIONAL and omitted entirely from the body when absent/blank, so this
    stays exactly backward compatible with every existing caller/test that
    predates the split contract.
    """
    event_url = str(event_url or "").strip()
    market_name = str(market_name or "").strip()
    selection = str(selection or "").strip()
    if not event_url:
        raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(betfair_sportsbook_place_api.RESOLVE_FAILED, "event_url is required to resolve the betfair market_id")
    if not market_name or not selection:
        raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
            betfair_sportsbook_place_api.RESOLVE_FAILED, "market_name and selection are required to resolve the betfair market_id"
        )
    odds_f = betfair_sportsbook_place_api._to_float(expected_odds)
    if odds_f is None or odds_f <= 1:
        raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(betfair_sportsbook_place_api.RESOLVE_FAILED, "expected_odds must be > 1 to resolve the betfair market_id")
    body: dict[str, Any] = {
        "event_url": event_url,
        "selection_id": str(selection_id).strip(),
        "market_name": market_name,
        "selection": selection,
        "expected_odds": odds_f,
    }
    label = str(selection_label or "").strip()
    if label:
        body["selection_label"] = label
    line = betfair_sportsbook_place_api._to_float(expected_line)
    if line is not None:
        body["expected_line"] = line
    mtype = str(market_type or "").strip()
    if mtype:
        body["market_type"] = mtype
    return body

def build_place_bet_payload(
    *,
    market_id: str,
    selection_id: Any,
    stake: float,
    expected_odds: float,
    bet_reference: str,
    customer_ref: str,
    dry_run: bool,
) -> dict[str, Any]:
    market_id = str(market_id).strip()
    if not market_id:
        raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(betfair_sportsbook_place_api.IMPLY_FAILED, "market_id is required")
    if not bet_reference:
        raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(betfair_sportsbook_place_api.IMPLY_FAILED, "bet_reference is required")
    stake_f = betfair_sportsbook_place_api._to_float(stake)
    odds_f = betfair_sportsbook_place_api._to_float(expected_odds)
    if stake_f is None or stake_f <= 0:
        raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(betfair_sportsbook_place_api.IMPLY_FAILED, "stake must be positive")
    if odds_f is None or odds_f <= 1:
        raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(betfair_sportsbook_place_api.IMPLY_FAILED, "expected_odds must be > 1")
    return {
        # Story 2.2b fix-2 (P2, money-safety): hard-coded False, with no
        # caller-facing override at all -- acceptLowerOdds=true has no lower
        # bound -- Betfair could fill at any price below the requested one
        # and the response would still carry the pre-placement quote, not
        # the real fill, hiding a negative arb. False rejects cleanly
        # (REQUESTED_PRICE_NOT_AVAILABLE, no money moved) when the price
        # ticks down between implyBets and placeBet; place() handles that by
        # retrying the full cycle with a fresh quote.
        "acceptLowerOdds": False,
        "betDefinitions": [
            {
                "betNo": 0,
                "betType": "SINGLE",
                "legs": [
                    {
                        "betRunners": [
                            {"runner": {"marketId": market_id, "selectionId": betfair_sportsbook_place_api._selection_id_int(selection_id)}}
                        ],
                        "bsp": False,
                        "guaranteedPrice": False,
                        "isBanker": False,
                        "legType": "SIMPLE_SELECTION",
                        "options": [],
                        "winExpectedOdds": {
                            "decimalOdds": {"decimalOdds": odds_f},
                            "fractionalOdds": {"denominator": 1, "numerator": 1},
                        },
                    }
                ],
                "stakePerLine": round(stake_f, 2),
                "takeEachway": False,
                "isBoostedBet": False,
                "betReference": bet_reference,
            }
        ],
        "customerRef": customer_ref,
        "dryRun": bool(dry_run),
        "useAvailableBonus": False,
        "walletAllocationType": "WALLET_CONSTRAINTS",
    }

def _extract_real_order_id(data: dict[str, Any]) -> str | None:
    for path in betfair_sportsbook_place_api._REAL_ORDER_ID_PATHS:
        value = betfair_sportsbook_place_api._dig(data, *path)
        if value:
            return str(value)
    return None

def _extract_runner_failures(data: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    for container_key in betfair_sportsbook_place_api._RUNNER_CONTAINER_KEYS:
        container = data.get(container_key)
        if not isinstance(container, list):
            continue
        for item in container:
            if not isinstance(item, dict):
                continue
            runners = item.get("runners")
            if not isinstance(runners, list):
                continue
            for runner in runners:
                if isinstance(runner, dict):
                    code = runner.get("failureCode")
                    if code:
                        failures.append(str(code))
    return failures

# Story 2.2b fix-1 (P1): the executed/matched price from the placeBet
# response itself, not the pre-placement implyBets quote -- so a fill that
# drifted (Betfair accepted a lower price) can be reconciled against the
# real price instead of silently being reported at the stale expected one.
def _extract_executed_odds(data: dict[str, Any]) -> float | None:
    for path in (
        ("result", 0, "runners", 0, "odds", "trueOdds", "decimalOdds", "decimalOdds"),
        ("betResults", 0, "matchedOdds"),
        ("betResults", 0, "averagePriceMatched"),
        ("betResults", 0, "runners", 0, "odds", "trueOdds", "decimalOdds", "decimalOdds"),
        ("placedBets", 0, "averagePriceMatched"),
        ("placedBets", 0, "matchedOdds"),
    ):
        value = betfair_sportsbook_place_api._to_float(betfair_sportsbook_place_api._dig(data, *path))
        if value is not None:
            return value
    return None

def _extract_order_id(data: dict[str, Any], customer_ref: str, *, dry_run: bool) -> str:
    real_id = betfair_sportsbook_place_api._extract_real_order_id(data)
    if real_id:
        return real_id
    if dry_run:
        # Betfair's own dryRun sandbox validates without spending money and
        # does not always echo an ID back -- a synthetic one is safe here.
        return f"bf-api-{customer_ref}"
    # Unreachable in practice: place_bet() raises PLACE_INDETERMINATE before
    # returning when dry_run=False and no real ID is present (see below), so
    # place() never calls this helper without a real ID for a live
    # placement. Fail closed anyway rather than ever fabricate one.
    raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
        betfair_sportsbook_place_api.PLACE_INDETERMINATE, "no real bet/order/receipt ID for a live placement"
    )

__all__ = [
    "BetfairSportsbookPlaceApiError",
    "_dig",
    "_extract_executed_odds",
    "_extract_order_id",
    "_extract_real_order_id",
    "_extract_runner_failures",
    "_selection_id_int",
    "_to_float",
    "build_customer_ref",
    "build_imply_bets_payload",
    "build_market_prices_payload",
    "build_place_bet_payload",
    "build_resolve_market_payload",
]
