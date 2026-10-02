"""betfair_sportsbook_place_api: часть 2 из 2.

Вынесено из betfair_sportsbook_place_api.py без изменения логики: перенесён только текст,
ссылки на имена исходного модуля идут через ``betfair_sportsbook_place_api.ИМЯ``, поэтому
подмена в тестах продолжает действовать.  Имена возвращаются в
исходный модуль звёздным импортом в его конце.
"""
from __future__ import annotations

from typing import Any
import httpx
import os

import betfair_sportsbook_place_api
from betfair_sportsbook_place_api import BetfairSportsbookPlaceApiConfig


class BetfairSportsbookPlaceApiClient:
    def __init__(
        self,
        config: BetfairSportsbookPlaceApiConfig | None = None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.config = config or betfair_sportsbook_place_api.BetfairSportsbookPlaceApiConfig.from_env()
        self._transport = transport

    def _client_kwargs(self) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"timeout": self.config.timeout_sec}
        if self._transport is not None:
            kwargs["transport"] = self._transport
        elif self.config.proxy_url:
            kwargs["proxy"] = self.config.proxy_url
        return kwargs

    def _worker_client_kwargs(self) -> dict[str, Any]:
        # The worker runs on localhost -- never routed through BETFAIR_PROXY --
        # but still honours an injected transport so tests can mock it. Do
        # not cap this at 10 seconds: a cold browser market resolution
        # routinely completes just after that boundary.
        kwargs: dict[str, Any] = {"timeout": max(30.0, self.config.timeout_sec)}
        if self._transport is not None:
            kwargs["transport"] = self._transport
        return kwargs

    async def _worker_fixed_odds_request(
        self, stage: str, payload: dict[str, Any]
    ) -> tuple[int, Any, str]:
        async with httpx.AsyncClient(**self._worker_client_kwargs()) as client:
            response = await client.post(
                f"{self.config.worker_url}/fixed-odds-request",
                json={"stage": stage, "payload": payload},
            )
        try:
            wrapper = response.json()
        except ValueError as exc:
            raise RuntimeError(
                f"worker fixed-odds request returned non-JSON ({response.status_code})"
            ) from exc
        if response.status_code >= 400 or not isinstance(wrapper, dict) or not wrapper.get("ok"):
            detail = str(wrapper.get("detail") or "") if isinstance(wrapper, dict) else ""
            raise RuntimeError(detail or f"worker fixed-odds request failed ({response.status_code})")
        return (
            int(wrapper.get("upstream_status") or 0),
            wrapper.get("data"),
            str(wrapper.get("body_prefix") or ""),
        )

    @staticmethod
    def _headers(cookie: str) -> dict[str, str]:
        # Mirror the browser's placeBet request headers exactly (captured from
        # live traffic). The spb write endpoint rejects (ACCESS_DENIED) requests
        # missing the sec-ch-ua client-hint headers the real Chromium sends.
        return {
            "accept": "*/*",
            "accept-language": "en-GB",
            "content-type": "application/json",
            "cookie": cookie,
            "origin": "https://www.betfair.com",
            "referer": "https://www.betfair.com/",
            "user-agent": betfair_sportsbook_place_api.DEFAULT_USER_AGENT,
            "sec-ch-ua": '"Chromium";v="147", "Not.A/Brand";v="8"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Linux"',
        }

    async def _fetch_sso_cookie_direct(self) -> str | None:
        try:
            proxy = self.config.proxy_url
            username = os.getenv("BETFAIR_USERNAME", "polezhaev2101@gmail.com")
            password = os.getenv("BETFAIR_PASSWORD", "P6z@Xq9#LvT!")
            data = {
                "username": username,
                "password": password,
                "product": "home",
                "redirectMethod": "POST",
                "url": "https://www.betfair.com/betting/",
            }
            kwargs = {"timeout": 5.0}
            if proxy:
                kwargs["proxy"] = proxy
            async with httpx.AsyncClient(**kwargs) as client:
                r = await client.post("https://identitysso.betfair.com/api/login", data=data)
                ssoid = r.cookies.get("ssoid") or r.headers.get("set-cookie", "").split("ssoid=")[-1].split(";")[0]
                if ssoid and len(ssoid) > 5:
                    return f"ssoid={ssoid}; loggedIn=true"
        except Exception as exc:
            log.warning("direct sso fetch failed: %s", exc)
        return None

    async def fetch_session_cookie(self) -> str:
        """GET the worker's /session-cookies (AC-1).

        The worker exports `context.cookies()` from its already-logged-in
        persistent browser profile -- this client never logs in itself.
        """
        try:
            async with httpx.AsyncClient(**self._worker_client_kwargs()) as client:
                response = await client.get(f"{self.config.worker_url}/session-cookies")
        except Exception as exc:  # noqa: BLE001 - any transport failure means no session
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.SESSION_UNAVAILABLE, f"worker /session-cookies request failed: {exc}"
            ) from exc
        try:
            data = response.json()
        except ValueError as exc:
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.SESSION_UNAVAILABLE, f"worker /session-cookies returned non-JSON response ({response.status_code})"
            ) from exc
        if response.status_code >= 400 or not isinstance(data, dict) or not data.get("ok"):
            detail = str((data or {}).get("detail") or "") if isinstance(data, dict) else ""
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.SESSION_UNAVAILABLE, detail or "worker has no active Betfair session"
            )
        cookie = str(data.get("cookie") or "").strip()
        if not cookie:
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(betfair_sportsbook_place_api.SESSION_UNAVAILABLE, "worker returned an empty session cookie")
        return cookie

    async def imply_bets(self, *, cookie: str, market_id: str, selection_id: Any) -> dict[str, Any]:
        """POST implyBets -- builds the coupon and returns a one-time betReference (AC-2).

        implyBets is the pre-stake stage -- no money moves here, so any
        transport-level failure (connection refused/timeout, or an
        unexpected exception constructing the client, e.g. a bad proxy
        kwarg) is caught broadly and raised as IMPLY_NETWORK_FAILED, not
        IMPLY_FAILED -- callers must treat it like SESSION_UNAVAILABLE (safe
        to fall back to the browser worker) rather than a clean reject.
        """
        body = betfair_sportsbook_place_api.build_imply_bets_payload(market_id=market_id, selection_id=selection_id)
        if self._transport is None:
            try:
                status_code, data, body_prefix = await self._worker_fixed_odds_request("imply", body)
            except Exception as exc:  # noqa: BLE001 - pre-stake transport failure
                raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                    betfair_sportsbook_place_api.IMPLY_NETWORK_FAILED, f"implyBets browser request failed: {exc}"
                ) from exc
            if data is None:
                raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                    betfair_sportsbook_place_api.IMPLY_FAILED,
                    f"implyBets returned non-JSON response ({status_code}): {body_prefix[:120]}",
                )
        else:
            try:
                async with httpx.AsyncClient(**self._client_kwargs()) as client:
                    response = await client.post(
                        betfair_sportsbook_place_api.IMPLY_BETS_URL,
                        params={"_ak": self.config.app_key},
                        json=body,
                        headers=self._headers(cookie),
                    )
            except Exception as exc:  # noqa: BLE001 - pre-stake transport failure
                raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                    betfair_sportsbook_place_api.IMPLY_NETWORK_FAILED, f"implyBets request failed: {exc}"
                ) from exc
            status_code = response.status_code
            try:
                data = response.json()
            except ValueError as exc:
                raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                    betfair_sportsbook_place_api.IMPLY_FAILED, f"implyBets returned non-JSON response ({status_code})"
                ) from exc
        if status_code >= 400 or not isinstance(data, dict):
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.IMPLY_FAILED, f"implyBets HTTP {status_code}: {str(data)[:200]}"
            )
        resp_code = str(data.get("respCode") or "").upper()
        if resp_code and resp_code != "SUCCESS":
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(betfair_sportsbook_place_api.IMPLY_FAILED, f"implyBets rejected: {resp_code}")
        failures = data.get("betFailures") or data.get("legFailures")
        if failures:
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(betfair_sportsbook_place_api.IMPLY_FAILED, f"implyBets leg failure: {str(failures)[:200]}")
        combos = data.get("betCombinations")
        if not isinstance(combos, list) or not combos or not isinstance(combos[0], dict):
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(betfair_sportsbook_place_api.IMPLY_FAILED, "implyBets response has no betCombinations")
        combo = combos[0]
        bet_reference = str(combo.get("betReference") or "").strip()
        if not bet_reference:
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(betfair_sportsbook_place_api.IMPLY_FAILED, "implyBets response has no betReference")
        odds = betfair_sportsbook_place_api._to_float(combo.get("averageOdds"))
        if odds is None:
            odds = betfair_sportsbook_place_api._to_float(betfair_sportsbook_place_api._dig(combo, "winAvgOdds", "trueOdds", "decimalOdds", "decimalOdds"))
        return {
            "bet_reference": bet_reference,
            "odds": odds,
            "min_stake": betfair_sportsbook_place_api._to_float(combo.get("betMinStake")),
            "max_stake": betfair_sportsbook_place_api._to_float(combo.get("betMaxStake")),
        }

    async def get_market_prices(self, *, cookie: str, market_id: str) -> dict[str, Any] | None:
        """POST getMarketPrices -- current market runner odds/status.

        Not on the hot placement path (implyBets already returns a live
        price -- see `place()`); available standalone for pre-flight checks
        or diagnostics (DOD-1).
        """
        body = betfair_sportsbook_place_api.build_market_prices_payload(market_ids=[market_id])
        try:
            async with httpx.AsyncClient(**self._client_kwargs()) as client:
                response = await client.post(
                    betfair_sportsbook_place_api.MARKET_PRICES_URL,
                    params={"priceHistory": "1", "_ak": self.config.app_key},
                    json=body,
                    headers=self._headers(cookie),
                )
        except httpx.HTTPError as exc:
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(betfair_sportsbook_place_api.IMPLY_FAILED, f"getMarketPrices request failed: {exc}") from exc
        try:
            data = response.json()
        except ValueError as exc:
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.IMPLY_FAILED, f"getMarketPrices returned non-JSON response ({response.status_code})"
            ) from exc
        if response.status_code >= 400 or not isinstance(data, list):
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.IMPLY_FAILED, f"getMarketPrices HTTP {response.status_code}: unexpected response"
            )
        return data[0] if data and isinstance(data[0], dict) else None

    async def resolve_market(
        self,
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
        """POST the worker's /resolve-market (Story 2.2b).

        The worker resolves a possibly foreign Paddy event through Betfair's
        request search, reads the full request catalog, and fetches the exact
        market/runner card through GraphQL. It fails closed on any ambiguity
        or mismatch. This never places a bet and is pre-stake.
        """
        body = betfair_sportsbook_place_api.build_resolve_market_payload(
            event_url=event_url,
            selection_id=selection_id,
            market_name=market_name,
            selection=selection,
            expected_odds=expected_odds,
            selection_label=selection_label,
            expected_line=expected_line,
            market_type=market_type,
        )
        try:
            cookie = await self.fetch_session_cookie()
            if cookie:
                body["cookie"] = cookie
        except Exception as exc:
            log.warning("Failed to fetch fast session cookie for resolve_market: %s", exc)
        try:
            async with httpx.AsyncClient(**self._worker_client_kwargs()) as client:
                response = await client.post(f"{self.config.worker_url}/resolve-market", json=body)
        except Exception as exc:  # noqa: BLE001 - pre-stake: any transport failure is safe to fall back
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.RESOLVE_FAILED, f"worker /resolve-market request failed: {exc}"
            ) from exc
        try:
            data = response.json()
        except ValueError as exc:
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.RESOLVE_FAILED, f"worker /resolve-market returned non-JSON response ({response.status_code})"
            ) from exc
        if response.status_code >= 400 or not isinstance(data, dict) or not data.get("ok"):
            detail = str((data or {}).get("detail") or "") if isinstance(data, dict) else ""
            # Reconcile regress1 P1-2 (money-critical): a worker-reported
            # MARKET_REJECTED is a DEFINITIVE semantic decision by the strict
            # catalog matcher/evidence gates -- never conflate it with the
            # generic (infra, safe-to-retry-elsewhere) RESOLVE_FAILED.
            status = str((data or {}).get("status") or "") if isinstance(data, dict) else ""
            if status == "MARKET_REJECTED":
                raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                    betfair_sportsbook_place_api.MARKET_REJECTED, detail or "worker rejected the market/selection match"
                )
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.RESOLVE_FAILED, detail or f"worker /resolve-market failed (HTTP {response.status_code})"
            )
        market_id = str(data.get("betfair_market_id") or "").strip()
        resolved_selection_id = str(data.get("betfair_selection_id") or "").strip()
        if not market_id or not resolved_selection_id:
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.RESOLVE_FAILED, "worker /resolve-market returned no betfair market/selection id"
            )
        return {
            "market_id": market_id,
            "selection_id": resolved_selection_id,
            "odds": betfair_sportsbook_place_api._to_float(data.get("odds")),
            "market_name": data.get("market_name"),
            "event_url": data.get("event_url") or event_url,
            "event_mapping_mode": data.get("event_mapping_mode"),
        }

    async def place_bet(
        self,
        *,
        cookie: str,
        market_id: str,
        selection_id: Any,
        stake: float,
        expected_odds: float,
        bet_reference: str,
        customer_ref: str,
        dry_run: bool,
    ) -> dict[str, Any]:
        """POST placeBet (AC-4/AC-5). betReference is single-use -- never retry with the same one.

        Story 2.2b fix-2 (P2, money-safety): no accept_lower_odds parameter
        at all -- acceptLowerOdds is hard-coded False inside
        build_place_bet_payload, so the "never true" invariant is enforced
        by the function signature, not by every call site happening to pass
        False.
        """
        body = betfair_sportsbook_place_api.build_place_bet_payload(
            market_id=market_id,
            selection_id=selection_id,
            stake=stake,
            expected_odds=expected_odds,
            bet_reference=bet_reference,
            customer_ref=customer_ref,
            dry_run=dry_run,
        )
        if self._transport is None:
            try:
                status_code, data, body_prefix = await self._worker_fixed_odds_request("place", body)
            except Exception as exc:  # the request may already have left the browser
                raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                    betfair_sportsbook_place_api.PLACE_INDETERMINATE, f"placeBet browser request failed after send: {exc}"
                ) from exc
            if data is None:
                raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                    betfair_sportsbook_place_api.PLACE_INDETERMINATE,
                    f"placeBet returned non-JSON response ({status_code}): {body_prefix[:120]}",
                )
        else:
            try:
                async with httpx.AsyncClient(**self._client_kwargs()) as client:
                    response = await client.post(
                        betfair_sportsbook_place_api.PLACE_BET_URL,
                        params={"_ak": self.config.app_key},
                        json=body,
                        headers=self._headers(cookie),
                    )
            except httpx.HTTPError as exc:
                raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                    betfair_sportsbook_place_api.PLACE_INDETERMINATE, f"placeBet request failed after send: {exc}"
                ) from exc
            status_code = response.status_code
            try:
                data = response.json()
            except ValueError as exc:
                raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                    betfair_sportsbook_place_api.PLACE_INDETERMINATE, f"placeBet returned non-JSON response ({status_code})"
                ) from exc
        if not isinstance(data, dict):
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.PLACE_INDETERMINATE, f"placeBet returned an unexpected response shape ({status_code})"
            )
        resp_code = str(data.get("respCode") or "").upper()
        runner_failures = betfair_sportsbook_place_api._extract_runner_failures(data)
        if status_code >= 500:
            # Server-side error after the bet may have been accepted.
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.PLACE_INDETERMINATE, f"placeBet server error {status_code}: {resp_code or 'no respCode'}"
            )
        if resp_code == betfair_sportsbook_place_api.REQUESTED_PRICE_NOT_AVAILABLE or "REQUESTED_PRICE_NOT_AVAILABLE" in runner_failures:
            # Story 2.2b fix-1 (P1): a clean rejection under
            # acceptLowerOdds=false, distinct from every other non-SUCCESS
            # respCode -- no money moved, place() retries the full cycle.
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.REQUESTED_PRICE_NOT_AVAILABLE, f"placeBet rejected: {resp_code or runner_failures}"
            )
        if resp_code and resp_code != "SUCCESS":
            # A structured, synchronous rejection (e.g. observed live:
            # ACCESS_DENIED) is a clean failure, not indeterminate.
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.PLACE_REJECTED, 
                f"placeBet rejected: {resp_code} (response: {data})"
            )
        if status_code >= 400:
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.PLACE_REJECTED, f"placeBet HTTP {status_code}: {resp_code or str(data)[:200]}"
            )
        # Story 2.2b fix-1 (P1): an overall SUCCESS/2xx envelope can still
        # carry a per-runner failureCode -- that is not proof the bet went
        # through as requested and must not be reported as a clean success.
        runner_failures = betfair_sportsbook_place_api._extract_runner_failures(data)
        if runner_failures:
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.PLACE_INDETERMINATE,
                f"placeBet response reports runner failure(s) despite {resp_code or 'HTTP 200'}: "
                f"{runner_failures[:5]}",
            )
        # Story 2.2b fix-1 (P1): a live placement without any real
        # bet/order/receipt ID in the response is not distinguishable from a
        # bet that silently failed to register -- treat it as indeterminate,
        # never as BET_PLACED with a fabricated ID. dryRun path may still be
        # softer (Betfair's own sandbox validation does not always echo one).
        if not dry_run and betfair_sportsbook_place_api._extract_real_order_id(data) is None:
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.PLACE_INDETERMINATE, "placeBet returned no real bet/order/receipt ID for a live placement"
            )
        return data

    async def prepare(
        self,
        *,
        market_id: str,
        selection_id: Any,
        stake: float,
        expected_odds: float,
        tolerance: float | None = None,
        event_url: str = "",
        market_name: str = "",
        selection: str = "",
        selection_label: str | None = None,
        expected_line: float | None = None,
        market_type: str | None = None,
    ) -> dict[str, Any]:
        """Resolve the real Betfair runner and run implyBets, but never place.

        This is the request-only equivalent of preparing a betslip: it checks
        the current price and stake limits and obtains a valid Betfair coupon
        reference, then deliberately stops before the placeBet endpoint.
        """
        resolved_event_url = event_url
        event_mapping_mode = "event_url"
        if str(event_url or "").strip():
            resolved = await self.resolve_market(
                event_url=event_url,
                selection_id=selection_id,
                market_name=market_name,
                selection=selection,
                expected_odds=expected_odds,
                selection_label=selection_label,
                expected_line=expected_line,
                market_type=market_type,
            )
            market_id = resolved["market_id"]
            selection_id = resolved["selection_id"]
            resolved_event_url = str(resolved.get("event_url") or event_url)
            event_mapping_mode = str(resolved.get("event_mapping_mode") or "event_url")
        cookie = await self.fetch_session_cookie()
        imply = await self.imply_bets(cookie=cookie, market_id=market_id, selection_id=selection_id)
        actual_odds = imply.get("odds")
        tol = self.config.price_tolerance if tolerance is None else tolerance
        if actual_odds is None or abs(actual_odds - expected_odds) > tol + 1e-9:
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.PRICE_CHANGED, f"Sportsbook price changed: expected {expected_odds}, got {actual_odds}"
            )
        min_stake = imply.get("min_stake")
        max_stake = imply.get("max_stake")
        if min_stake is not None and stake + 1e-9 < min_stake:
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.IMPLY_FAILED, f"Stake {stake} is below Betfair minimum {min_stake}"
            )
        if max_stake is not None and stake - 1e-9 > max_stake:
            raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                betfair_sportsbook_place_api.IMPLY_FAILED, f"Stake {stake} exceeds Betfair maximum {max_stake}"
            )
        return {
            "ok": True,
            "status": "BETSLIP_READY_REQUESTS",
            "provider": "betfair-sportsbook",
            "dry_run": True,
            "event_url": resolved_event_url,
            "event_mapping_mode": event_mapping_mode,
            "market_id": str(market_id),
            "selection_id": str(selection_id),
            "odds": actual_odds,
            "stake": stake,
            "min_stake": min_stake,
            "max_stake": max_stake,
            "coupon_validated": bool(imply.get("bet_reference")),
            "submit_blocked": True,
        }

    async def place(
        self,
        *,
        market_id: str,
        selection_id: Any,
        stake: float,
        expected_odds: float,
        dry_run: bool,
        tolerance: float | None = None,
        event_url: str = "",
        market_name: str = "",
        selection: str = "",
        selection_label: str | None = None,
        expected_line: float | None = None,
        market_type: str | None = None,
    ) -> dict[str, Any]:
        """Full implyBets -> placeBet flow (AC-1..AC-5, AC-7).

        Fetches a fresh session cookie and a fresh (single-use) betReference
        on every call -- betReference must never be cached or reused across
        attempts (AC-7).

        Story 2.2b: when `event_url` is given, `market_id`/`selection_id` are
        always re-resolved through the worker's /resolve-market first and the
        caller-supplied values (which may be a foreign-namespace Paddy
        market_id) are discarded in favour of the resolved real Betfair ones
        -- implyBets rejects a Paddy market_id with MARKET_NOT_FOUND.
        Resolution happens before fetching the session cookie / calling
        implyBets, so a resolve failure (RESOLVE_FAILED) is pre-stake and
        must be treated like SESSION_UNAVAILABLE by callers (safe to fall
        back to the browser worker). Callers that never pass event_url keep
        the pre-2.2b behaviour of using market_id/selection_id as given.

        Story 2.2b fix-1 (P1): placeBet always uses acceptLowerOdds=false. A
        clean REQUESTED_PRICE_NOT_AVAILABLE reject (no money moved) reruns
        this whole loop -- fresh implyBets, fresh price check, fresh
        one-time betReference -- up to MAX_PRICE_RETRIES times before the
        error is allowed to propagate. Every successful placeBet has its
        executed odds parsed out of the response and compared against the
        quote actually used for that attempt; a divergence beyond tolerance
        does not raise (the bet is live) -- the result carries
        reconciliation_required=True and the real fill price.
        """
        if str(event_url or "").strip():
            resolved = await self.resolve_market(
                event_url=event_url,
                selection_id=selection_id,
                market_name=market_name,
                selection=selection,
                expected_odds=expected_odds,
                selection_label=selection_label,
                expected_line=expected_line,
                market_type=market_type,
            )
            market_id = resolved["market_id"]
            selection_id = resolved["selection_id"]
        cookie = await self.fetch_session_cookie()
        tol = self.config.price_tolerance if tolerance is None else tolerance

        bet_reference = ""
        customer_ref = ""
        actual_odds: float | None = None
        result: dict[str, Any] | None = None
        for attempt in range(betfair_sportsbook_place_api.MAX_PRICE_RETRIES + 1):
            imply = await self.imply_bets(cookie=cookie, market_id=market_id, selection_id=selection_id)
            bet_reference = imply["bet_reference"]
            actual_odds = imply.get("odds")
            if actual_odds is None or abs(actual_odds - expected_odds) > tol + 1e-9:
                raise betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError(
                    betfair_sportsbook_place_api.PRICE_CHANGED, f"Sportsbook price changed: expected {expected_odds}, got {actual_odds}"
                )
            customer_ref = betfair_sportsbook_place_api.build_customer_ref()
            try:
                result = await self.place_bet(
                    cookie=cookie,
                    market_id=market_id,
                    selection_id=selection_id,
                    stake=stake,
                    expected_odds=actual_odds,
                    bet_reference=bet_reference,
                    customer_ref=customer_ref,
                    dry_run=dry_run,
                )
            except betfair_sportsbook_place_api.BetfairSportsbookPlaceApiError as exc:
                if exc.code == betfair_sportsbook_place_api.REQUESTED_PRICE_NOT_AVAILABLE and attempt < betfair_sportsbook_place_api.MAX_PRICE_RETRIES:
                    continue
                raise
            break

        assert result is not None  # loop always either returns, raises, or breaks with a result

        # dryRun never places real money -- only a live placement's executed
        # odds are meaningful for reconciliation.
        executed_odds = betfair_sportsbook_place_api._extract_executed_odds(result) if not dry_run else None
        reconciliation_required = False
        reported_odds = actual_odds
        if not dry_run and executed_odds is None:
            # Story 2.2b fix-2 (P1, money-critical): a live placement with a
            # real betId but no parseable executed-odds field in the
            # response is NOT proof the fill happened at the pre-placement
            # implyBets quote -- reporting `reported_odds = actual_odds`
            # here would silently pass a stale, possibly-wrong price off as
            # the real fill and hide a negative arb. Report the fill as
            # genuinely unknown and always require reconciliation.
            reported_odds = None
            reconciliation_required = True
        elif executed_odds is not None:
            # Always prefer the REAL fill price over the pre-placement quote
            # once we have one; only flag reconciliation when it diverges
            # beyond tolerance -- the bet is already live either way, this
            # is never a reason to raise.
            reported_odds = executed_odds
            if abs(executed_odds - actual_odds) > tol + 1e-9:
                reconciliation_required = True

        response: dict[str, Any] = {
            "status": "DRY_RUN_OK" if dry_run else "BET_PLACED",
            "provider": "betfair-sportsbook-api",
            "dry_run": dry_run,
            "market_id": str(market_id),
            "selection_id": str(selection_id),
            "odds": reported_odds,
            "expected_odds": actual_odds,
            "stake": stake,
            "customer_ref": customer_ref,
            "order_id": betfair_sportsbook_place_api._extract_order_id(result, customer_ref, dry_run=dry_run),
            # betReference is one-time and must never be logged/returned in full.
            "bet_reference_len": len(bet_reference),
        }
        if reconciliation_required:
            response["reconciliation_required"] = True
        return response

__all__ = [
    "BetfairSportsbookPlaceApiClient",
]
