"""Betfair leg planner for RobinArb forks.

This legacy module retains shared fork parsing, closing-stake maths and attempt
logging used by RobinArb. The active Betfair integration is fixed-odds
Sportsbook; Exchange placeOrders is permanently disabled here as a defence in
depth measure.
"""
from __future__ import annotations

import asyncio
import csv
import hashlib
import json
import math
import os
import re
import tempfile
import threading
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlparse

import httpx

try:
    import fcntl
except ImportError:  # pragma: no cover - this service runs on Unix-like hosts
    fcntl = None


BETFAIR_KEYWORDS = ("betfair.com", "betfair exchange", "betfair", "paddypower.com", "paddypower", "paddy")
DEFAULT_TOLERANCE = 0.0
DEFAULT_BETTING_ENDPOINT = "https://api.betfair.com/exchange/betting/json-rpc/v1"
DEFAULT_ACCOUNT_ENDPOINT = "https://api.betfair.com/exchange/account/json-rpc/v1"
DEFAULT_LOGIN_ENDPOINT = "https://identitysso.betfair.com/api/login"
DEFAULT_KEEP_ALIVE_ENDPOINT = "https://identitysso.betfair.com/api/keepAlive"
DEFAULT_APP_CONFIG_URL = "https://www.betfair.com/exchange/plus/football"
DEFAULT_APP_KEY_CACHE_PATH = "stats_data/betfair_app_key.txt"
DEFAULT_MARKET_BOOK_BATCH_SIZE = 40
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125 Safari/537.36"
)

BETFAIR_EVENT_TYPE_IDS = {
    "soccer": "1",
    "football": "1",
    "tennis": "2",
    "basketball": "7522",
    "hockey": "7524",
    "ice_hockey": "7524",
    "volleyball": "998917",
    "handball": "468328",
    "baseball": "7511",
    "american_football": "6423",
}

ATTEMPT_CSV_FIELDS = [
    "record_id",
    "created_at",
    "status",
    "dry_run",
    "arb_id",
    "sport",
    "match",
    "market",
    "betfair_selection",
    "betfair_odds_forted",
    "betfair_odds_live",
    "betfair_stake",
    "pinnacle_odds_forted",
    "pinnacle_odds_verified",
    "robin_odds",
    "robin_stake",
    "counter_odds",
    "forted_profit_pct",
    "robin_profit_pct",
    "price_match",
    "failure_reason",
    "file_path",
]

_ATTEMPT_WRITE_LOCK = threading.Lock()
_SIGN_TRANSLATION = str.maketrans({
    "−": "-",
    "–": "-",
    "—": "-",
    "﹣": "-",
    "－": "-",
    "＋": "+",
})
_MARKET_CONTEXT_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("shots_on_target", ("shots on target", "shot on target", "sot", "удары в створ")),
    ("free_kicks", ("free kicks", "free kick", "штрафные", "штрафн")),
    ("throw_ins", ("throw-ins", "throw ins", "throwin", "вбрасывания", "ауты")),
    ("corners", ("corners", "corner", "угловые", "углов")),
    ("bookings", ("bookings", "booking", "cards", "card", "карточки", "карточ")),
    ("shots", ("shots", "shot", "удары", "удар")),
    ("offsides", ("offsides", "offside", "офсайды", "офсайд")),
)


@dataclass
class BetfairConfig:
    app_key: str = ""
    username: str = ""
    password: str = ""
    session_token: str = ""
    proxy_url: str = ""
    betting_endpoint: str = DEFAULT_BETTING_ENDPOINT
    account_endpoint: str = DEFAULT_ACCOUNT_ENDPOINT
    login_endpoint: str = DEFAULT_LOGIN_ENDPOINT
    keep_alive_endpoint: str = DEFAULT_KEEP_ALIVE_ENDPOINT
    app_config_url: str = DEFAULT_APP_CONFIG_URL
    app_key_cache_path: str = DEFAULT_APP_KEY_CACHE_PATH
    user_agent: str = DEFAULT_USER_AGENT
    timeout_sec: float = 15.0
    request_attempts: int = 3
    retry_sleep_sec: float = 0.35
    catalog_days_ahead: int = 3
    catalog_max_results: int = 100
    market_book_batch_size: int = DEFAULT_MARKET_BOOK_BATCH_SIZE
    allow_real_submit: bool = False

    @classmethod
    def from_env(cls) -> "BetfairConfig":
        return cls(
            app_key=os.getenv("BETFAIR_APP_KEY", "").strip(),
            username=os.getenv("BETFAIR_USERNAME", "").strip(),
            password=os.getenv("BETFAIR_PASSWORD", "").strip(),
            session_token=os.getenv("BETFAIR_SESSION_TOKEN", "").strip(),
            proxy_url=os.getenv("BETFAIR_PROXY", "").strip(),
            betting_endpoint=os.getenv("BETFAIR_BETTING_ENDPOINT", DEFAULT_BETTING_ENDPOINT),
            account_endpoint=os.getenv("BETFAIR_ACCOUNT_ENDPOINT", DEFAULT_ACCOUNT_ENDPOINT),
            login_endpoint=os.getenv("BETFAIR_LOGIN_ENDPOINT", DEFAULT_LOGIN_ENDPOINT),
            keep_alive_endpoint=os.getenv("BETFAIR_KEEP_ALIVE_ENDPOINT", DEFAULT_KEEP_ALIVE_ENDPOINT),
            app_config_url=os.getenv("BETFAIR_APP_CONFIG_URL", DEFAULT_APP_CONFIG_URL),
            app_key_cache_path=os.getenv("BETFAIR_APP_KEY_CACHE_PATH", DEFAULT_APP_KEY_CACHE_PATH).strip(),
            user_agent=os.getenv("BETFAIR_USER_AGENT", DEFAULT_USER_AGENT),
            timeout_sec=float(os.getenv("BETFAIR_TIMEOUT_SEC", "15")),
            request_attempts=max(1, int(os.getenv("BETFAIR_REQUEST_ATTEMPTS", "3"))),
            retry_sleep_sec=max(0.0, float(os.getenv("BETFAIR_RETRY_SLEEP_SEC", "0.35"))),
            catalog_days_ahead=int(os.getenv("BETFAIR_CATALOG_DAYS_AHEAD", "3")),
            catalog_max_results=int(os.getenv("BETFAIR_CATALOG_MAX_RESULTS", "100")),
            market_book_batch_size=int(os.getenv("BETFAIR_MARKET_BOOK_BATCH_SIZE", str(DEFAULT_MARKET_BOOK_BATCH_SIZE))),
            allow_real_submit=_env_bool("BETFAIR_ALLOW_REAL_SUBMIT"),
        )

    def configured_for_read(self) -> bool:
        return bool(self.session_token or (self.username and self.password))


class BetfairClient:
    def __init__(self, config: BetfairConfig | None = None, *, transport: httpx.AsyncBaseTransport | None = None):
        self.config = config or BetfairConfig.from_env()
        self._transport = transport
        self._json_rpc_id = 1

    async def close(self) -> None:
        return None

    @staticmethod
    def _safe_url_label(url: str) -> str:
        parsed = urlparse(str(url or ""))
        if parsed.netloc:
            return f"{parsed.netloc}{parsed.path or ''}"
        return str(url or "")[:120]

    def _request_error_detail(self, url: str, exc: Exception) -> str:
        label = self._safe_url_label(url)
        if isinstance(exc, httpx.HTTPStatusError):
            response = exc.response
            text = (response.text or "").replace("\n", " ")[:200]
            return f"Betfair HTTP {response.status_code} for {label}: {text}"
        message = str(exc).strip() or repr(exc)
        return f"Betfair HTTP request failed for {label}: {type(exc).__name__}: {message}"

    async def _maybe_retry(self, attempt: int) -> None:
        if attempt + 1 >= max(1, self.config.request_attempts):
            return
        if self.config.retry_sleep_sec > 0:
            await asyncio.sleep(self.config.retry_sleep_sec * (attempt + 1))

    async def _request_json(self, url: str, *, method: str = "GET", headers: dict[str, str] | None = None, json_body: Any = None, data: Any = None) -> Any:
        kwargs: dict[str, Any] = {
            "timeout": self.config.timeout_sec,
            "transport": self._transport,
        }
        if self.config.proxy_url:
            kwargs["proxy"] = self.config.proxy_url
        last_error: Exception | None = None
        for attempt in range(max(1, self.config.request_attempts)):
            try:
                async with httpx.AsyncClient(**kwargs) as client:
                    response = await client.request(method, url, headers=headers, json=json_body, data=data)
                    response.raise_for_status()
                    text = response.text
                    try:
                        return response.json()
                    except ValueError as exc:
                        raise BetfairError(f"Betfair non-JSON response: {text[:200]}") from exc
            except BetfairError:
                raise
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code < 500:
                    raise BetfairError(self._request_error_detail(url, exc)) from exc
                last_error = exc
                await self._maybe_retry(attempt)
            except httpx.HTTPError as exc:
                last_error = exc
                await self._maybe_retry(attempt)
        assert last_error is not None
        raise BetfairError(self._request_error_detail(url, last_error)) from last_error

    async def _request_text(self, url: str) -> str:
        kwargs: dict[str, Any] = {
            "timeout": self.config.timeout_sec,
            "transport": self._transport,
        }
        if self.config.proxy_url:
            kwargs["proxy"] = self.config.proxy_url
        last_error: Exception | None = None
        for attempt in range(max(1, self.config.request_attempts)):
            try:
                async with httpx.AsyncClient(**kwargs) as client:
                    response = await client.get(
                        url,
                        headers={
                            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                            "User-Agent": self.config.user_agent,
                        },
                    )
                    response.raise_for_status()
                    return response.text
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code < 500:
                    raise BetfairError(self._request_error_detail(url, exc)) from exc
                last_error = exc
                await self._maybe_retry(attempt)
            except httpx.HTTPError as exc:
                last_error = exc
                await self._maybe_retry(attempt)
        assert last_error is not None
        raise BetfairError(self._request_error_detail(url, last_error)) from last_error

    @staticmethod
    def _valid_app_key(value: str) -> bool:
        return bool(re.fullmatch(r"[A-Za-z0-9_-]{8,}", str(value or "").strip()))

    def _cached_app_key_path(self) -> Path | None:
        raw = str(self.config.app_key_cache_path or "").strip()
        return Path(raw) if raw else None

    def _read_cached_app_key(self) -> str:
        path = self._cached_app_key_path()
        if not path:
            return ""
        try:
            app_key = path.read_text(encoding="utf-8").strip()
        except OSError:
            return ""
        return app_key if self._valid_app_key(app_key) else ""

    def _write_cached_app_key(self, app_key: str) -> None:
        if not self._valid_app_key(app_key):
            return
        path = self._cached_app_key_path()
        if not path:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=str(path.parent), delete=False) as handle:
                handle.write(app_key)
                handle.write("\n")
                tmp_name = handle.name
            os.replace(tmp_name, path)
        except OSError:
            return

    async def ensure_app_key(self) -> str:
        if self.config.app_key:
            return self.config.app_key
        cached = self._read_cached_app_key()
        if cached:
            self.config.app_key = cached
            return self.config.app_key
        html = await self._request_text(self.config.app_config_url)
        app_key = self._extract_app_key_from_html(html)
        if app_key:
            self.config.app_key = app_key
            self._write_cached_app_key(app_key)
            return self.config.app_key
        raise BetfairError("Betfair app key was not found")

    @staticmethod
    def _extract_app_key_from_html(html: str) -> str:
        text = str(html or "")
        app_key_index = text.find('"appKey"')
        app_key_block = text[app_key_index:app_key_index + 1200] if app_key_index >= 0 else text
        for label in ("Linux", "EDSKey"):
            pattern = rf'"{re.escape(label)}"\s*:\s*"([^"]+)"'
            match = re.search(pattern, app_key_block)
            if match:
                return match.group(1)
        for pattern in (
            r'"EDSKey"\s*:\s*"([^"]+)"',
            r'"appKey"\s*:\s*"([^"]+)"',
            r"appKey['\"]?\s*[:=]\s*['\"]([^'\"]+)",
            r"X-Application['\"]?\s*[:=]\s*['\"]([^'\"]+)",
        ):
            match = re.search(pattern, app_key_block)
            if match:
                return match.group(1)
        return ""

    async def login(self) -> str:
        await self.ensure_app_key()
        if self.config.session_token:
            return self.config.session_token
        if not self.config.username or not self.config.password:
            raise BetfairError("Betfair credentials are not configured")
        body = {
            "username": self.config.username,
            "password": self.config.password,
        }
        payload = urlencode(body)
        response = await self._request_json(
            self.config.login_endpoint,
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Application": self.config.app_key,
            },
            data=payload,
        )
        status = str(response.get("status") or "").upper()
        token = response.get("token") or response.get("sessionToken")
        if status != "SUCCESS" or not token:
            raise BetfairError(str(response.get("error") or response.get("loginStatus") or "Betfair login failed"))
        self.config.session_token = str(token)
        return self.config.session_token

    async def json_rpc(self, service: str, method: str, params: dict[str, Any]) -> Any:
        await self.login()
        endpoint = self.config.account_endpoint if service == "account" else self.config.betting_endpoint
        namespace = "AccountAPING" if service == "account" else "SportsAPING"
        payload = {
            "jsonrpc": "2.0",
            "method": f"{namespace}/v1.0/{method}",
            "params": params,
            "id": self._json_rpc_id,
        }
        self._json_rpc_id += 1
        response = await self._request_json(
            endpoint,
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "X-Application": self.config.app_key,
                "X-Authentication": self.config.session_token,
            },
            json_body=payload,
        )
        if response.get("error"):
            raise BetfairError(json.dumps(response["error"], ensure_ascii=False))
        if "result" not in response:
            raise BetfairError("Betfair JSON-RPC response did not include result")
        return response["result"]

    async def list_market_catalogue(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        result = await self.json_rpc("betting", "listMarketCatalogue", params)
        return result if isinstance(result, list) else []

    async def list_market_book(self, market_ids: list[str]) -> list[dict[str, Any]]:
        unique_market_ids = [str(item) for item in dict.fromkeys(market_ids) if item]
        if not unique_market_ids:
            return []
        batch_size = max(1, int(self.config.market_book_batch_size or DEFAULT_MARKET_BOOK_BATCH_SIZE))
        out: list[dict[str, Any]] = []
        for idx in range(0, len(unique_market_ids), batch_size):
            result = await self.json_rpc(
                "betting",
                "listMarketBook",
                {
                    "marketIds": unique_market_ids[idx:idx + batch_size],
                    "priceProjection": {
                        "priceData": ["EX_BEST_OFFERS"],
                        "exBestOffersOverrides": {"bestPricesDepth": 1},
                    },
                },
            )
            if isinstance(result, list):
                out.extend(result)
        return out

    async def place_orders(self, payload: dict[str, Any]) -> dict[str, Any]:
        del payload
        raise BetfairError(
            "Betfair Exchange placeOrders is permanently disabled; "
            "RobinArb uses the fixed-odds Sportsbook dry-run betslip."
        )


# Определения вынесены в файлы-части; модуль остаётся единым
# пространством имён — импорт возвращает их имена сюда, поэтому
# подмена betfair_executor.X в тестах продолжает действовать.
from betfair_executor_part1 import *  # noqa: F401,F403,E402
from betfair_executor_part2 import *  # noqa: F401,F403,E402
