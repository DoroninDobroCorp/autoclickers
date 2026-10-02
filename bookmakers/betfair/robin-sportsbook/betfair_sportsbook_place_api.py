"""Direct HTTP API client for Betfair Sportsbook bet placement.

Reproduces the implyBets -> placeBet flow captured from real Betfair
Sportsbook traffic (dev, 2026-07-15; live-verified against the real API on
2026-07-15) instead of the ~12s Playwright click flow in
betfair_sportsbook_basket.py. Session auth is a cookie exported from the
worker's already-logged-in persistent browser profile (GET
/session-cookies on betfair_sportsbook_basket_worker.cjs) so no second
login is performed. Requests must be routed through the same egress proxy
as the browser worker (BETFAIR_PROXY) -- Betfair geoblocks the plain
datacenter IP of the request source regardless of a valid session cookie.

Real response shapes (verified live, 2026-07-15):

    implyBets response (relevant fields)::

        {
          "respCode": "SUCCESS",
          "betFailures": [], "legFailures": [],
          "betCombinations": [{
            "betReference": "<one-time token>",
            "averageOdds": 2.0,
            "betMinStake": 0.11, "betMaxStake": 1.72,
          }],
        }

    placeBet response has a top-level "respCode"; a non-"SUCCESS" code with
    an ordinary HTTP 200 (observed live: "ACCESS_DENIED") is a clean
    rejection, not a network failure -- it must not be treated as
    PLACE_INDETERMINATE.

betReference is a one-time cryptographic signature of the selection: it is
never cached across attempts and never logged in full (only its length).

Story 2.2b fix-1 (P1, money-safety): placeBet is sent with
acceptLowerOdds=false, never true. A bare acceptLowerOdds=true has no lower
bound -- Betfair can fill at any price below the requested one, and the
returned "odds" would still be the pre-placement implyBets quote, not the
real fill, silently producing a negative arb. On a clean
REQUESTED_PRICE_NOT_AVAILABLE rejection (observed live: Betfair's response to
acceptLowerOdds=false when the price has moved down since implyBets) place()
reruns the full implyBets -> price-check -> placeBet cycle with a fresh
one-time betReference, bounded by MAX_PRICE_RETRIES. After every successful
placeBet, the executed/matched odds are parsed out of the response and
compared against the pre-placement quote; a divergence beyond tolerance does
not raise (the bet is already live) -- it sets reconciliation_required and
reports the real fill price instead of the stale implyBets one.
"""
from __future__ import annotations

import math
import os
import time
from dataclasses import dataclass
from typing import Any

import httpx

# Public Betfair Sportsbook client application key (visible in Betfair's own
# JS bundle, identical for every visitor) captured from real dev traffic
# 2026-07-15. Not a secret; overridable via env for a key rotation.
DEFAULT_APP_KEY = "K61C39rIC0WKzoQ7"

IMPLY_BETS_URL = "https://sib.betfair.com/www/sports/fixedodds/transactional/v1/implyBets"
MARKET_PRICES_URL = "https://smp.betfair.com/www/sports/fixedodds/readonly/v1/getMarketPrices"
PLACE_BET_URL = "https://spb.betfair.com/www/sports/fixedodds/transactional/v1/placeBet"

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
)

SESSION_UNAVAILABLE = "SESSION_UNAVAILABLE"
IMPLY_FAILED = "IMPLY_FAILED"
IMPLY_NETWORK_FAILED = "IMPLY_NETWORK_FAILED"
PRICE_CHANGED = "PRICE_CHANGED"
PLACE_REJECTED = "PLACE_REJECTED"
PLACE_INDETERMINATE = "PLACE_INDETERMINATE"
# Story 2.2b: raised when the worker's /resolve-market cannot map a
# foreign-namespace (Paddy) market_id to a real Betfair market_id -- pre-stake
# (no money moved), callers must treat this like SESSION_UNAVAILABLE (safe to
# fall back to the browser worker).
RESOLVE_FAILED = "RESOLVE_FAILED"
# Reconcile regress1 P1-2 (money-critical, final cross-family audit fix):
# raised when the worker's /resolve-market reports a DEFINITIVE semantic
# rejection (status="MARKET_REJECTED") -- ambiguous catalog market, no
# resolvable market id, runner ambiguous/not-active, an ownership urn
# mismatch, or all-blind line evidence. This is NOT the same as
# RESOLVE_FAILED: a resolve failure is an infra/transport problem (safe to
# fall back to the browser worker's own, separate matcher); a semantic
# reject is the strict catalog matcher having already looked and definitively
# refused -- callers (server.py) must treat MARKET_REJECTED as terminal and
# must NEVER fall back to the DOM basket path on it, since DOM's separate
# (looser) matcher re-resolving the same rejected selection is exactly how a
# wrong same-named market/runner could get placed live.
MARKET_REJECTED = "MARKET_REJECTED"
# Story 2.2b fix-1 (P1): a clean, structured placeBet rejection under
# acceptLowerOdds=false when the price has ticked down since implyBets. No
# money moved on this attempt -- place() retries the full cycle (fresh
# implyBets + fresh betReference) up to MAX_PRICE_RETRIES before giving up;
# an exhausted retry budget still raises this code (never PLACE_INDETERMINATE
# -- every attempt that reaches this code was a clean, definitive reject).
REQUESTED_PRICE_NOT_AVAILABLE = "REQUESTED_PRICE_NOT_AVAILABLE"

# Story 2.2b fix-1 (P1): bounded number of full-cycle retries on a clean
# REQUESTED_PRICE_NOT_AVAILABLE rejection. Each retry is a brand new
# implyBets call (fresh one-time betReference, AC-7) -- never a bare retry of
# the same placeBet body.
MAX_PRICE_RETRIES = 2


@dataclass(frozen=True)
class BetfairSportsbookPlaceApiConfig:
    app_key: str = DEFAULT_APP_KEY
    worker_url: str = "http://127.0.0.1:8898"
    proxy_url: str = ""
    timeout_sec: float = 15.0
    # Keep request placement and the browser fallback on the same one-cent
    # price tolerance.  Values above one cent are rejected before submit.
    price_tolerance: float = 0.01

    @classmethod
    def from_env(cls) -> "BetfairSportsbookPlaceApiConfig":
        return cls(
            app_key=os.getenv("BETFAIR_SPB_APP_KEY", "").strip() or DEFAULT_APP_KEY,
            worker_url=os.getenv(
                "BETFAIR_SPORTSBOOK_BASKET_URL", "http://127.0.0.1:8898"
            ).strip().rstrip("/"),
            proxy_url=(
                os.getenv("BETFAIR_PROXY", "").strip()
                or os.getenv("PADDY_SPORTSBOOK_PROXY", "").strip()
            ),
            timeout_sec=max(2.0, float(os.getenv("BETFAIR_SPB_API_TIMEOUT_SEC", "5.0"))),
            # Deliberately fixed to the same one-cent tolerance used by the
            # browser worker so the two placement paths cannot disagree.
            price_tolerance=0.01,
        )


_last_customer_ref_us = 0


# Story 2.2b fix-1 (P1): only real Betfair-issued identifiers -- never a
# fabricated one. `_extract_real_order_id` returns None (not a fake
# placeholder) when none of these are present in the response.
_REAL_ORDER_ID_PATHS: tuple[tuple[Any, ...], ...] = (
    ("betId",),
    ("betReceiptId",),
    ("orderId",),
    ("receiptId",),
    ("betResults", 0, "betId"),
    ("betResults", 0, "betReceiptId"),
    ("betResults", 0, "orderId"),
    ("placedBets", 0, "betId"),
    ("placedBets", 0, "betReceiptId"),
    ("placedBets", 0, "orderId"),
    ("result", 0, "betId"),
    ("result", 0, "betReceiptId"),
    ("result", 0, "orderId"),
)


# Nested per-runner failure reporting alongside an overall 2xx/SUCCESS
# envelope (Story 2.2b fix-1, P1: "проверять вложенные failures
# result[].runners[].failureCode").
_RUNNER_CONTAINER_KEYS = ("result", "betResults", "placedBets")


# Определения вынесены в файлы-части; модуль остаётся единым
# пространством имён — импорт возвращает их имена сюда, поэтому
# подмена betfair_sportsbook_place_api.X в тестах продолжает действовать.
from betfair_sportsbook_place_api_part1 import *  # noqa: F401,F403,E402
from betfair_sportsbook_place_api_part2 import *  # noqa: F401,F403,E402
