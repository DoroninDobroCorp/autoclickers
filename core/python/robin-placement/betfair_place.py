"""Размещение ставки на Betfair: через сервис-исполнитель и напрямую по API.

Вынесено из server.py без изменения логики: код перенесён дословно.
"""

from bookmaker_urls import _betfair_sportsbook_path
from bookmaker_urls import _slugify_url_part
from fastapi import HTTPException
from market_text import _to_float_or_none
from typing import Any
from urllib.parse import quote
from urllib.parse import unquote
from urllib.parse import urljoin
from urllib.parse import urlparse
import asyncio
import bcgame_sportsbook
import betfair_executor
import betfair_sportsbook_basket
import betfair_sportsbook_place_api
import ladbrokes_sportsbook
import logging
import math
import onewin_sportsbook
import os
import paddy_sportsbook
import re
import time

log = logging.getLogger("robinarb")  # тот же объект логгера, что и в server.py


ROBINARB_BETFAIR_LOW_PRIORITY_QUIET_SEC = max(
    0.0, float(os.getenv("ROBINARB_BETFAIR_LOW_PRIORITY_QUIET_SEC", "1.0"))
)


# Фаза 3 (audit C, P0 live-placement hardening): the maximum age (wall-clock,
# from paddy_sportsbook's real snapshot fetch time -- see
# PaddySportsbookClient.resolve_live_quote / resolve_quote_from_snapshot's
# `snapshot_fetched_at`) a Betfair Sportsbook quote may have before
# _resolve_betfair_placement_odds refuses to use it to price a live
# placement. This is deliberately generous relative to the Paddy quote
# cache's own cache_ttl_sec (0.75s default) to tolerate normal request
# latency between resolving the quote and placing against it, while still
# rejecting a genuinely stale quote instead of trusting an unverified
# "timestamp" that is always ~now regardless of underlying data age.
ROBINARB_BETFAIR_PLACEMENT_MAX_QUOTE_AGE_SEC = max(
    0.0, float(os.getenv("ROBINARB_BETFAIR_PLACEMENT_MAX_QUOTE_AGE_SEC", "3.0"))
)

# A positive Paddy absence/suspension is a quote too. Its short freshness TTL
# is followed by one extra proof: the old Forted row stays blocked until Forted
# re-observes that same logical outcome after the absence. This prevents a
# 90-second pool ghost while allowing a genuinely returning line immediately.
ROBINARB_PADDY_UNAVAILABLE_EVIDENCE_TTL_SEC = max(
    1.0, float(os.getenv("ROBINARB_PADDY_UNAVAILABLE_EVIDENCE_TTL_SEC", "10.0"))
)


def _betfair_place_via_api_enabled() -> bool:
    return os.getenv("BETFAIR_PLACE_VIA_API", "0").strip().lower() in {"1", "true", "yes", "on"}


def _canonical_betfair_sportsbook_path(arb: dict[str, Any], event_id: str) -> str:
    """Reuse the bookmaker's canonical Latin event path when it is available."""
    wanted_id = str(event_id or "").strip()
    for key in ("bk2_url", "bk2_raw_link", "betfair_url", "bookmaker_url"):
        raw = str(arb.get(key) or "").strip()
        if not raw:
            continue
        parsed = urlparse(raw)
        host = parsed.hostname.lower() if parsed.hostname else ""
        path = unquote(parsed.path or "")
        if host in {"betfair.com", "www.betfair.com"} and "/betting/" in path.lower():
            if re.search(rf"/e-{re.escape(wanted_id)}(?:/|$)", path, flags=re.IGNORECASE):
                return f"{path.rstrip('/')}?tab=all-markets"
            continue
        if host not in {"paddypower.com", "www.paddypower.com"}:
            continue
        parts = [part for part in path.split("/") if part]
        if len(parts) < 3 or not parts[-1].endswith(f"-{wanted_id}"):
            continue
        sport_slug = _slugify_url_part(parts[-3])
        league_slug = _slugify_url_part(parts[-2])
        match_slug = _slugify_url_part(parts[-1][: -(len(wanted_id) + 1)])
        if sport_slug and league_slug and match_slug:
            return f"/betting/{sport_slug}/{league_slug}/{match_slug}/e-{wanted_id}?tab=all-markets"
    return ""


async def _place_betfair_via_api(
    arb: dict[str, Any],
    quote: dict[str, Any],
    *,
    stake: float,
    expected_odds: float,
) -> dict[str, Any] | None:
    """Fast path for AC-6 (BETFAIR_PLACE_VIA_API): direct HTTP placement via
    betfair_sportsbook_place_api instead of the ~12s browser click flow.

    Story 2.2b: `quote.market_id` is the Paddy-namespace market_id (that is
    all paddy_sportsbook.resolve_live_quote can give us) -- implyBets rejects
    it with MARKET_NOT_FOUND. The real Betfair event_url is built and passed
    through to the client's place() so it always re-resolves the actual
    Betfair event/market/selection IDs through SearchView and market-card
    GraphQL requests before implyBets.

    Returns None for SESSION_UNAVAILABLE (worker not logged in /
    unreachable), IMPLY_NETWORK_FAILED (implyBets transport failure --
    pre-stake, no money moved yet), RESOLVE_FAILED (market_id resolution
    failed -- also pre-stake), or when the Betfair event_url itself cannot be
    built, so the caller can fall back to the browser worker. Any other
    outcome (PRICE_CHANGED, a clean PLACE_REJECTED, or PLACE_INDETERMINATE)
    is definitive and must not be retried through the browser worker -- that
    could double-place the same bet.
    """
    market_id = str(quote.get("market_id") or "").strip()
    selection_id = quote.get("selection_id")
    event_url = None
    try:
        event_url = _betfair_sportsbook_event_url(arb, quote)
    except Exception:
        pass
    if not event_url and (not market_id or not selection_id):
        return None
    market_name = str(quote.get("market_name") or arb.get("market") or "").strip()
    # Reconcile regress1 P1-3 (money-critical, final cross-family audit fix):
    # `selection` is the REAL bare runner name; the line-enriched intent
    # (e.g. "Under (93.5)") is threaded through SEPARATELY as
    # `selection_label`, plus the already-verified `expected_line` and raw
    # `market_type` -- previously this single `selection` variable carried
    # whichever of selection_label/selection/arb-fallback existed first, so
    # the worker's split-contract guard (resolveSelectionContract) never saw
    # a genuinely bare selection at all and its "expected_line required for
    # a line-bearing market" gate could never fire on this fast path. The
    # browser-worker basket path (betfair_sportsbook_basket.build_prepare_payload)
    # got the same fix.
    bare_selection = str(
        quote.get("selection")
        or arb.get("bk2_selection")
        or arb.get("side2")
        or ""
    ).strip()
    selection_label = str(quote.get("selection_label") or bare_selection or "").strip()
    expected_line = _to_float_or_none(quote.get("expected_line"))
    market_type = str(quote.get("market_type") or "").strip()
    try:
        event_url = _betfair_sportsbook_event_url(arb, quote)
    except Exception:
        # Without a real Betfair event_url the market_id cannot be resolved
        # and the raw Paddy market_id is guaranteed to fail implyBets --
        # fall back to the browser worker rather than surface a confusing
        # definitive reject for what is really a quote-building gap.
        return None
    try:
        res = await betfair_sportsbook_place_api.BetfairSportsbookPlaceApiClient().place(
            market_id=market_id,
            selection_id=selection_id,
            stake=stake,
            expected_odds=expected_odds,
            dry_run=False,
            event_url=event_url,
            market_name=market_name,
            selection=bare_selection,
            selection_label=selection_label,
            expected_line=expected_line,
            market_type=market_type,
        )
    except betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError as exc:
        if exc.code in (
            betfair_sportsbook_place_api.SESSION_UNAVAILABLE,
            betfair_sportsbook_place_api.IMPLY_NETWORK_FAILED,
            betfair_sportsbook_place_api.RESOLVE_FAILED,
        ):
            return None
        # Reconcile regress1 P1-2 (money-critical): MARKET_REJECTED is a
        # DEFINITIVE semantic decision by the strict catalog matcher/evidence
        # gates -- deliberately NOT in the safe-fallback tuple above, so it
        # falls through to the generic `raise HTTPException(422, ...)` below
        # instead of ever reaching the permissive DOM basket path.
        if exc.code == betfair_sportsbook_place_api.PLACE_INDETERMINATE:
            # Mirror the browser worker's PLACE_INDETERMINATE contract below:
            # the bet may be live, the caller must not refund the stake.
            return {
                "status": "UNKNOWN",
                "error_code": "BETFAIR_PLACE_INDETERMINATE",
                "reconciliation_required": True,
                "detail": str(exc),
            }
        raise HTTPException(422, {"error": "betfair_place_rejected", "reason": f"{exc.code}: {exc}"})
    # Story 2.2b fix-2 (P1, money-critical): place() can return a
    # SUCCESS/BET_PLACED result that still carries
    # reconciliation_required=True (a divergent fill, or -- see
    # betfair_sportsbook_place_api.py's own money-safety fix -- an
    # unparseable fill price that must not be reported as the stale
    # pre-placement quote). Reporting a flat "ACCEPTED" here regardless
    # would lose that: the bet endpoint below only marks a bet
    # pending_reconciliation when status is UNKNOWN/PENDING, so a bet whose
    # real fill is unknown or divergent would otherwise be recorded as a
    # clean, already-reconciled "accepted" bet.
    reconciliation_required = bool(res.get("reconciliation_required"))
    return {
        "status": "UNKNOWN" if reconciliation_required else "ACCEPTED",
        "current_odds": res.get("odds"),
        "expected_odds": expected_odds,
        "wager_id": res.get("order_id"),
        "reconciliation_required": reconciliation_required,
        "reconciliation": {
            "betslip_id": res.get("selection_id"),
            "order_id": res.get("order_id"),
            "dry_run": False,
        },
    }


def _is_betfair_sportsbook_leg(arb: dict[str, Any]) -> bool:
    """Story reconcile Фаза3 (audit C, item 4 -- scoping): the ONLY forks
    that may ever reach the Betfair fixed-odds placement client
    (BetfairSportsbookPlaceApiClient / BetfairSportsbookBasketClient) are
    genuine Betfair *Sportsbook* forks. `betfair_executor.is_betfair_fork`
    alone also matches Betfair Exchange (same bookmaker keyword family);
    `paddy_sportsbook.is_sportsbook_fork` is what actually excludes
    `/exchange/` links. Requiring both here is the same test spec-C
    demanded for `_resolve_betfair_placement_odds` below, applied one layer
    higher so OneWin/Ladbrokes/BCGame/Exchange never even reach the
    Betfair-specific event_url/payload-building code, let alone the price
    guard.
    """
    return betfair_executor.is_betfair_fork(arb) and paddy_sportsbook.is_sportsbook_fork(arb)


def _resolve_betfair_placement_odds(
    arb: dict[str, Any],
    quote: dict[str, Any] | None,
) -> float | None:
    """Story 2.6 (P0 money-fix) + reconcile Фаза3 hardening (audit C): the
    expected_odds used to price-check a live Betfair Sportsbook placement
    (side=robinbet) must be the REAL, identity-bound Betfair quote for the
    exact selection being placed -- never the synthetic Robin offer price
    (`robin_odds` / `compute_robin_odds` in robin_margin.py, a
    Pinnacle-margin-derived internal ranking/display price that has never
    been calibrated against Betfair).

    Cross-family audit (2026-07-15, spec-C) found that passing robin_odds as
    expected_odds into the direct-API fast path (`_place_betfair_via_api` ->
    betfair_sportsbook_place_api.place()) made the live price-check reject
    Betfair's *correct* Forted-derived price as PRICE_CHANGED /
    REQUESTED_PRICE_NOT_AVAILABLE whenever it diverged from the synthetic
    robin_odds -- which is the normal case, not an edge case. robin_odds
    stays exactly as before for offer/ranking/display purposes; this helper
    only decides what gates live execution.

    `quote` MUST be the result of a *fresh* `_resolve_counter_bookmaker_quote`
    / `_resolve_betfair_quote` call made against this SAME `arb` --
    paddy_sportsbook's own semantic matching (event/market/selection) binds
    the quote to arb's identity. The event_id cross-check below is a
    defense-in-depth guard against a caller accidentally passing a quote
    resolved for a different arb, not the primary identity mechanism.

    Returns None (fail-closed) when no fresh, verified, identity-bound
    Betfair price is available for this exact selection; callers MUST reject
    the placement rather than silently fall back to robin_odds. Every check
    below is a hard requirement -- missing/partial data fails closed, it is
    never treated as "not applicable so skip this check" (that was the exact
    class of gap spec-C found in the pre-hardening version: an empty
    event_id on either side silently passed the mismatch check instead of
    being rejected).
    """
    if not _is_betfair_sportsbook_leg(arb):
        return None
    if not isinstance(quote, dict):
        return None
    if quote.get("verified") is not True or str(quote.get("status") or "") != "OK":
        return None
    if str(quote.get("source") or "") != "paddy-sportsbook-api":
        return None
    price = _to_float_or_none(quote.get("current_odds"))
    if price is None or not math.isfinite(price) or price <= 1:
        return None
    market_id = str(quote.get("market_id") or "").strip()
    selection_id = quote.get("selection_id")
    if not market_id or selection_id is None or str(selection_id).strip() == "":
        return None
    # Both event ids must be present AND equal -- a caller-supplied quote
    # with either side blank is not proof of anything and must fail closed
    # (pre-hardening, an empty id on either side skipped this check).
    expected_event_id = paddy_sportsbook.extract_event_id(arb)
    quote_event_id = quote.get("event_id")
    if not expected_event_id or not quote_event_id:
        return None
    if str(quote_event_id) != str(expected_event_id):
        return None
    # Freshness: prove the quote's underlying Paddy snapshot is actually
    # recent using the real fetch timestamp (paddy_sportsbook's
    # `snapshot_fetched_at`, set once per network fetch/cache-fill), not the
    # per-call "timestamp" field which is stamped at call time and is
    # therefore ~now on every cache hit regardless of how old the cached
    # snapshot actually is.
    fetched_at = _to_float_or_none(quote.get("snapshot_fetched_at"))
    if fetched_at is None:
        return None
    age = time.time() - fetched_at
    if age < -0.5 or age > ROBINARB_BETFAIR_PLACEMENT_MAX_QUOTE_AGE_SEC:
        return None
    # Line-bearing markets (selection_label enriched beyond the bare
    # selection, e.g. "Under (93.5)" vs "Under") must carry a proven numeric
    # expected_line -- otherwise the identity guard above is binding to a
    # market/runner pair without ever having confirmed the actual line, which
    # defeats the point for handicap/totals markets (Фаза2 left this
    # resolve-contract gap for the server side to close).
    bare_selection = str(quote.get("selection") or "").strip()
    label_selection = str(quote.get("selection_label") or "").strip()
    if label_selection and label_selection != bare_selection:
        expected_line = _to_float_or_none(quote.get("expected_line"))
        if expected_line is None or not math.isfinite(expected_line):
            return None
    return price


async def _place_betfair_via_service(
    arb: dict[str, Any],
    quote: dict[str, Any],
    *,
    stake: float,
    expected_odds: float,
) -> dict[str, Any]:
    is_betfair_leg = _is_betfair_sportsbook_leg(arb)
    # There is deliberately NO direct-API attempt here, before the quote is
    # resolved.  The only fast path is the guarded one further down, after
    # `_resolve_counter_bookmaker_quote` and `_resolve_betfair_placement_odds`.
    # A pre-resolve attempt used to live here (commit 59f620f, "sub-ms
    # inter-leg hedging") and was removed: it submitted with the CALLER's
    # `quote` and `expected_odds`, which on the /api/bet path are `{}` and the
    # synthetic robin_odds figure -- i.e. it placed real money at a price
    # nobody had verified against Betfair, with no event-id identity binding
    # and no snapshot-freshness check, which is exactly what every guard below
    # exists to prevent.  It also retried through the guarded path after an
    # exception, so one indeterminate submit could become two live bets.
    # Latency is not a reason to submit an unverified price; if the ~ms of the
    # resolve step ever has to go, cache the resolve, do not skip it.
    try:
        betfair_quote = await _resolve_counter_bookmaker_quote(arb)
    except Exception as exc:
        if is_betfair_leg:
            # Story reconcile Фаза3 (audit C, item 3): normalize resolver
            # exceptions for the Betfair leg to the same pre-submit 409 the
            # "no verified price" branch below uses, rather than a generic
            # 422 -- both mean the same thing to the caller (do not submit,
            # refund the reserve) and should be classified the same way.
            raise HTTPException(
                409,
                {
                    "error": "betfair_quote_unavailable",
                    "reason": f"Failed to resolve a fresh Betfair Sportsbook quote: {exc}",
                },
            )
        raise HTTPException(422, {"error": "betfair_place_rejected", "reason": f"Failed to verify Betfair quote: {exc}"})

    if not is_betfair_leg:
        # Story reconcile Фаза3 (audit C, item 4 -- scoping): this function is
        # historically named for Betfair but `_resolve_counter_bookmaker_quote`
        # dispatches it for OneWin/Ladbrokes/BCGame quotes too. None of those
        # bookmakers have a working fixed-odds placement client here --
        # building a Betfair-shaped event_url/basket payload from a foreign
        # quote below would either crash confusingly or, worse, silently bind
        # to the wrong market. Fail closed explicitly instead of relying on
        # incidental downstream errors. (The primary gate is the
        # `live_place_required` classifier check in /api/bet; this is
        # defense-in-depth for any other/future caller of this function.)
        raise HTTPException(
            409,
            {
                "error": "betfair_service_not_supported",
                "reason": (
                    "Live placement via the Betfair Sportsbook fixed-odds service is only "
                    "available for Betfair Sportsbook forks"
                ),
            },
        )

    # Story 2.6 (P0) / Фаза3 hardening: override the caller-supplied
    # (robin_odds-based) expected_odds with the REAL Betfair price we just
    # resolved -- see _resolve_betfair_placement_odds's docstring. This is
    # the single point both the direct-API fast path below AND the
    # browser-worker basket path (build_prepare_payload already reads
    # quote["current_odds"] independently) end up using, so both stay
    # consistent. Fail-closed: no fresh, verified, identity-bound Betfair
    # price -> refuse the placement before any submit, do NOT place against
    # the synthetic robin_odds. The reserved stake is refunded by the
    # endpoint's HTTPException handler.
    try:
        betfair_placement_odds = _resolve_betfair_placement_odds(arb, betfair_quote)
    except Exception as exc:  # noqa: BLE001 - never let a guard bug fall through to a submit
        raise HTTPException(
            409,
            {
                "error": "betfair_quote_unavailable",
                "reason": f"Betfair placement price validation failed: {exc}",
            },
        )
    if betfair_placement_odds is None:
        raise HTTPException(
            409,
            {
                "error": "betfair_quote_unavailable",
                "reason": (
                    (betfair_quote or {}).get("detail")
                    or "No fresh, verified Betfair Sportsbook price is available for this selection"
                ),
            },
        )
    expected_odds = betfair_placement_odds

    reconciliation_context = {
        "event_id": str(betfair_quote.get("event_id") or "").strip(),
        "selection_id": str(betfair_quote.get("selection_id") or "").strip(),
        "stake": round(float(stake), 2),
        "expected_odds": float(expected_odds),
    }

    def with_reconciliation_context(result: dict[str, Any]) -> dict[str, Any]:
        enriched = dict(result)
        existing = enriched.get("reconciliation") if isinstance(enriched.get("reconciliation"), dict) else {}
        enriched["reconciliation"] = {**reconciliation_context, **existing}
        return enriched

    if _betfair_place_via_api_enabled():
        try:
            api_result = await _place_betfair_via_api(arb, betfair_quote, stake=stake, expected_odds=expected_odds)
        except HTTPException:
            # A structured, definitive outcome (PRICE_CHANGED / PLACE_REJECTED
            # / a clean validation failure) -- propagate so the caller's
            # refund handler (except HTTPException) refunds the reserved
            # stake. Money-safety: never swallow this into the generic
            # except below.
            raise
        except Exception as exc:  # noqa: BLE001 - see money-safety note below
            # Anything else is NOT a structured BetfairSportsbookPlaceApiError
            # (e.g. a bad proxy kwarg blowing up httpx.AsyncClient
            # construction, or any other unanticipated bug). We cannot prove
            # whether placeBet was ever sent, so this must never crash past
            # the refund handler above (which only catches HTTPException) --
            # that would leave the stake reserved with nothing marking it
            # for reconciliation. Mirror the PLACE_INDETERMINATE contract:
            # hold the balance, flag reconciliation_required, do NOT fall
            # back to the browser worker (that could double-place a bet that
            # actually went through).
            log.error("betfair api placement raised an unexpected exception: %s", exc)
            return with_reconciliation_context({
                "status": "UNKNOWN",
                "error_code": "BETFAIR_PLACE_INDETERMINATE",
                "reconciliation_required": True,
                "detail": f"unexpected error in betfair API placement: {exc}",
            })
        if api_result is not None:
            return with_reconciliation_context(api_result)
        # SESSION_UNAVAILABLE / IMPLY_NETWORK_FAILED (pre-stake, no money at
        # risk) -- fall through to the browser worker path below.

    try:
        event_url = _betfair_sportsbook_event_url(arb, betfair_quote)
    except Exception as exc:
        raise HTTPException(400, {"error": "betfair_place_unavailable", "reason": f"Betfair event URL resolution failed: {exc}"})
    try:
        payload = betfair_sportsbook_basket.build_prepare_payload(
            arb=arb,
            quote=betfair_quote,
            event_url=event_url,
            stake=stake,
            dry_run=False,
        )
    except Exception as exc:
        raise HTTPException(
            422,
            {
                "error": "betfair_payload_failed",
                "reason": f"Failed to build Betfair placement payload: {exc}",
            }
        )
    try:
        res = await betfair_sportsbook_basket.BetfairSportsbookBasketClient().prepare(payload)
        status = res.get("status")
        if status == "BET_PLACED":
            return with_reconciliation_context({
                "status": "ACCEPTED",
                "current_odds": res.get("odds"),
                "expected_odds": expected_odds,
                "wager_id": f"bf-{int(time.time())}",
                "reconciliation": {
                    "betslip_id": res.get("selection_id"),
                    "order_id": f"bf-{int(time.time())}",
                    "dry_run": False,
                }
            })
        else:
            raise HTTPException(422, {"error": "betfair_place_rejected", "reason": f"Betfair worker returned status: {status}"})
    except Exception as exc:
        if isinstance(exc, HTTPException):
            raise
        reason = str(exc)
        # Story 2.2b fix-1 (P1): a typed BetfairSportsbookBasketIndeterminateError
        # means the POST /basket left this process and the worker's own queue
        # may still process/place it asynchronously even though this client
        # gave up waiting (transport read/write/protocol timeout AFTER send,
        # not a connect failure) -- proof of neither success nor failure.
        # Checked by isinstance first (robust); the substring fallback below
        # still covers the worker's own in-band PLACE_INDETERMINATE message
        # (the confirmation UI failing to render/match after a real click).
        # Mirrors the Pinnacle UNKNOWN/PENDING contract (see except-clauses
        # above in _place_pinnacle_via_service): the caller must NOT refund
        # the reserved stake on a bet that may be live.
        if isinstance(exc, betfair_sportsbook_basket.BetfairSportsbookBasketIndeterminateError) or "PLACE_INDETERMINATE" in reason:
            return with_reconciliation_context({
                "status": "UNKNOWN",
                "error_code": "BETFAIR_PLACE_INDETERMINATE",
                "reconciliation_required": True,
                "detail": reason,
            })
        raise HTTPException(
            422,
            {
                "error": "betfair_place_rejected",
                "reason": reason,
            }
        )


_BETFAIR_VERIFY_LOCK = asyncio.Lock()


_BETFAIR_VERIFY_STATE_LOCK = asyncio.Lock()


_BETFAIR_VERIFY_HIGH_PRIORITY_WAITERS = 0


_BETFAIR_VERIFY_LAST_HIGH_PRIORITY_AT = 0.0


_BETFAIR_VERIFY_HIGH_PRIORITY_SCOPES = frozenset({"basket"})


_PADDY_VERIFY_CLIENT: paddy_sportsbook.PaddySportsbookClient | None = None


_PADDY_VERIFY_CLIENT_FINGERPRINT = ""


_ONEWIN_VERIFY_CLIENT: onewin_sportsbook.OneWinSportsbookClient | None = None


_ONEWIN_VERIFY_CLIENT_FINGERPRINT = ""


_LADBROKES_VERIFY_CLIENT: ladbrokes_sportsbook.LadbrokesSportsbookClient | None = None


_LADBROKES_VERIFY_CLIENT_FINGERPRINT = ""


_BCGAME_VERIFY_CLIENT: bcgame_sportsbook.BCGameSportsbookClient | None = None


_BCGAME_VERIFY_CLIENT_FINGERPRINT = ""


def _shared_paddy_verify_client() -> paddy_sportsbook.PaddySportsbookClient:
    global _PADDY_VERIFY_CLIENT
    global _PADDY_VERIFY_CLIENT_FINGERPRINT
    cfg = paddy_sportsbook.PaddySportsbookConfig.from_env()
    fingerprint = "|".join((
        cfg.proxy_url, cfg.app_key, cfg.event_page_url, cfg.markets_url,
        str(cfg.timeout_sec), str(cfg.request_attempts), str(cfg.cache_ttl_sec), cfg.impersonate,
    ))
    if _PADDY_VERIFY_CLIENT is None or _PADDY_VERIFY_CLIENT_FINGERPRINT != fingerprint:
        _PADDY_VERIFY_CLIENT = paddy_sportsbook.PaddySportsbookClient(cfg)
        _PADDY_VERIFY_CLIENT_FINGERPRINT = fingerprint
    return _PADDY_VERIFY_CLIENT


def _paddy_hard_unavailability(quote: dict[str, Any] | None) -> tuple[str, str] | None:
    if not isinstance(quote, dict):
        return None
    status = str(quote.get("status") or "").strip().upper()
    if status not in paddy_sportsbook.EXACT_UNAVAILABLE_STATUSES:
        return None
    detail = str(quote.get("detail") or "Exact Paddy selection is unavailable").strip()
    return f"PADDY_{status}", detail


def _recent_paddy_hard_unavailability(arb: dict[str, Any]) -> tuple[str, str] | None:
    if not paddy_sportsbook.is_sportsbook_fork(arb):
        return None
    evidence = _shared_paddy_verify_client().recent_unavailability(
        arb,
        max_age_sec=ROBINARB_PADDY_UNAVAILABLE_EVIDENCE_TTL_SEC,
    )
    return _paddy_hard_unavailability(evidence)


def _shared_onewin_verify_client() -> onewin_sportsbook.OneWinSportsbookClient:
    global _ONEWIN_VERIFY_CLIENT
    global _ONEWIN_VERIFY_CLIENT_FINGERPRINT
    cfg = onewin_sportsbook.OneWinSportsbookConfig.from_env()
    fingerprint = "|".join((
        cfg.partner_id, cfg.push_url, cfg.origin, cfg.proxy_url,
        str(cfg.timeout_sec), str(cfg.cache_ttl_sec),
    ))
    if _ONEWIN_VERIFY_CLIENT is None or _ONEWIN_VERIFY_CLIENT_FINGERPRINT != fingerprint:
        _ONEWIN_VERIFY_CLIENT = onewin_sportsbook.OneWinSportsbookClient(cfg)
        _ONEWIN_VERIFY_CLIENT_FINGERPRINT = fingerprint
    return _ONEWIN_VERIFY_CLIENT


def _shared_ladbrokes_verify_client() -> ladbrokes_sportsbook.LadbrokesSportsbookClient:
    global _LADBROKES_VERIFY_CLIENT
    global _LADBROKES_VERIFY_CLIENT_FINGERPRINT
    cfg = ladbrokes_sportsbook.LadbrokesSportsbookConfig.from_env()
    fingerprint = "|".join((
        cfg.siteserver_url, cfg.proxy_url, str(cfg.timeout_sec),
        str(cfg.cache_ttl_sec), str(cfg.max_batch_size),
    ))
    if _LADBROKES_VERIFY_CLIENT is None or _LADBROKES_VERIFY_CLIENT_FINGERPRINT != fingerprint:
        _LADBROKES_VERIFY_CLIENT = ladbrokes_sportsbook.LadbrokesSportsbookClient(cfg)
        _LADBROKES_VERIFY_CLIENT_FINGERPRINT = fingerprint
    return _LADBROKES_VERIFY_CLIENT


def _shared_bcgame_verify_client() -> bcgame_sportsbook.BCGameSportsbookClient:
    global _BCGAME_VERIFY_CLIENT
    global _BCGAME_VERIFY_CLIENT_FINGERPRINT
    cfg = bcgame_sportsbook.BCGameSportsbookConfig.from_env()
    fingerprint = "|".join((
        cfg.base_url, cfg.betby_api_url, cfg.betby_brand_id, cfg.provider_support_url,
        str(cfg.discover_provider_settings), str(cfg.provider_settings_ttl_sec), cfg.proxy_url,
        str(cfg.timeout_sec), str(cfg.cache_ttl_sec), str(cfg.token_ttl_sec),
        str(cfg.max_concurrency),
    ))
    if _BCGAME_VERIFY_CLIENT is None or _BCGAME_VERIFY_CLIENT_FINGERPRINT != fingerprint:
        _BCGAME_VERIFY_CLIENT = bcgame_sportsbook.BCGameSportsbookClient(cfg)
        _BCGAME_VERIFY_CLIENT_FINGERPRINT = fingerprint
    return _BCGAME_VERIFY_CLIENT


async def _resolve_counter_bookmaker_quote(arb: dict[str, Any]) -> dict[str, Any]:
    if onewin_sportsbook.is_onewin_fork(arb):
        return await _shared_onewin_verify_client().resolve_live_quote(arb)
    if ladbrokes_sportsbook.is_ladbrokes_fork(arb):
        return await _shared_ladbrokes_verify_client().resolve_live_quote(arb)
    if bcgame_sportsbook.is_bcgame_fork(arb):
        return await _shared_bcgame_verify_client().resolve_live_quote(arb)
    if betfair_executor.is_betfair_fork(arb):
        quote = await _resolve_betfair_quote(arb, scope="basket", wait=True)
        return quote or {
            "verified": False,
            "status": "UNAVAILABLE",
            "detail": "Counter-bookmaker quote is unavailable",
            "current_odds": None,
        }
    return {
        "verified": False,
        "status": "UNSUPPORTED_BOOKMAKER",
        "detail": f"Independent price verification is not implemented for {arb.get('bk2') or 'this bookmaker'}",
        "current_odds": None,
    }


async def _reserve_betfair_verify_slot(scope: str, *, wait: bool) -> bool:
    """Reserve a Betfair quote slot without letting RobinWork delay a basket.

    RobinWork is best-effort: it never queues behind an active exchange lookup
    and backs off while an interactive basket quote is waiting or was just
    completed. Basket checks wait for the single in-flight lookup instead.
    """
    high_priority = scope in _BETFAIR_VERIFY_HIGH_PRIORITY_SCOPES
    global _BETFAIR_VERIFY_HIGH_PRIORITY_WAITERS
    global _BETFAIR_VERIFY_LAST_HIGH_PRIORITY_AT

    if high_priority:
        async with _BETFAIR_VERIFY_STATE_LOCK:
            _BETFAIR_VERIFY_HIGH_PRIORITY_WAITERS += 1
        await _BETFAIR_VERIFY_LOCK.acquire()
        return True

    async with _BETFAIR_VERIFY_STATE_LOCK:
        quiet_remaining = ROBINARB_BETFAIR_LOW_PRIORITY_QUIET_SEC - (
            time.time() - _BETFAIR_VERIFY_LAST_HIGH_PRIORITY_AT
        )
        busy = _BETFAIR_VERIFY_LOCK.locked()
        priority_waiting = _BETFAIR_VERIFY_HIGH_PRIORITY_WAITERS > 0
    if busy or priority_waiting or quiet_remaining > 0:
        return False

    # A basket request may arrive between the state check and lock acquisition.
    # Low-priority work never waits; once it loses that race it is skipped.
    if _BETFAIR_VERIFY_LOCK.locked():
        return False
    await _BETFAIR_VERIFY_LOCK.acquire()
    async with _BETFAIR_VERIFY_STATE_LOCK:
        if _BETFAIR_VERIFY_HIGH_PRIORITY_WAITERS > 0:
            _BETFAIR_VERIFY_LOCK.release()
            return False
    return True


async def _release_betfair_verify_slot(scope: str, *, registered_waiter: bool) -> None:
    global _BETFAIR_VERIFY_HIGH_PRIORITY_WAITERS
    global _BETFAIR_VERIFY_LAST_HIGH_PRIORITY_AT
    if _BETFAIR_VERIFY_LOCK.locked():
        _BETFAIR_VERIFY_LOCK.release()
    if registered_waiter:
        async with _BETFAIR_VERIFY_STATE_LOCK:
            _BETFAIR_VERIFY_HIGH_PRIORITY_WAITERS = max(0, _BETFAIR_VERIFY_HIGH_PRIORITY_WAITERS - 1)
            _BETFAIR_VERIFY_LAST_HIGH_PRIORITY_AT = time.time()


async def _resolve_betfair_quote(
    arb: dict[str, Any],
    *,
    scope: str,
    wait: bool,
) -> dict[str, Any] | None:
    """Read the mirrored fixed-odds Sportsbook quote with basket priority."""
    if not betfair_executor.is_betfair_fork(arb):
        return None
    sportsbook = paddy_sportsbook.is_sportsbook_fork(arb)
    if not sportsbook:
        return {
            "verified": False,
            "status": "WRONG_SOURCE_EXCHANGE",
            "detail": "Exchange forks are ignored; Betfair Sportsbook fixed odds are required",
            "current_odds": None,
        }

    high_priority = scope in _BETFAIR_VERIFY_HIGH_PRIORITY_SCOPES
    reserved = await _reserve_betfair_verify_slot(scope, wait=wait)
    if not reserved:
        return {
            "verified": False,
            "status": "SKIPPED_PRIORITY",
            "detail": "Betfair quote skipped so an interactive basket check keeps priority",
            "current_odds": None,
        }
    try:
        return await _shared_paddy_verify_client().resolve_live_quote(arb)
    except Exception as exc:  # noqa: BLE001 - a quote failure must not break RobinWork
        return {
            "verified": False,
            "status": "ERROR",
            "detail": _betfair_exception_detail(exc),
            "current_odds": None,
        }
    finally:
        await _release_betfair_verify_slot(scope, registered_waiter=high_priority)


def _betfair_exception_detail(exc: Exception) -> str:
    detail = str(exc).strip()
    if detail:
        return detail
    return f"{type(exc).__name__}: {repr(exc)}"


def _betfair_sportsbook_event_url(arb: dict[str, Any], quote: dict[str, Any]) -> str:
    event_id = str(quote.get("event_id") or paddy_sportsbook.extract_event_id(arb) or "").strip()
    if not event_id:
        raise betfair_sportsbook_basket.BetfairSportsbookBasketError("sportsbook event id is unavailable")
    path = _canonical_betfair_sportsbook_path(arb, event_id) or _betfair_sportsbook_path(
        event_id=event_id,
        sport=arb.get("sport"),
        league=arb.get("league"),
        event_name=arb.get("event_name") or arb.get("league"),
        home=arb.get("home") or arb.get("team1") or arb.get("team1_en"),
        away=arb.get("away") or arb.get("team2") or arb.get("team2_en"),
    )
    return urljoin("https://www.betfair.com", path)
