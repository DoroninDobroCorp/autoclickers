"""Client of the executor contract ``automation-executor.v1`` (see scripts/onewin/executor_service.mjs)."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

CONTRACT = "automation-executor.v1"
ORDER_SCHEMA = "automation-executor-order.v1"


class ExecutorUnavailable(RuntimeError):
    """The executor could not be asked (network, timeout, malformed answer): nothing is known."""


class ExecutorRefused(RuntimeError):
    """The executor answered with a refusal of its own (HTTP error with a code)."""

    def __init__(self, status: int, code: str, message: str = ""):
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code


class ExecutorClient:
    def __init__(self, url: str, token: str, *, timeout_s: float = 10.0):
        if not token or len(token) < 16:
            raise ValueError("executor token missing or too short")
        self.url = url.rstrip("/")
        self._token = token
        self.timeout_s = timeout_s

    @classmethod
    def from_policy(cls, endpoint) -> "ExecutorClient":
        token = os.environ.get(endpoint.token_env, "")
        if not token:
            raise ExecutorUnavailable(f"environment variable {endpoint.token_env} is not set")
        return cls(endpoint.url, token, timeout_s=endpoint.timeout_s)

    def _call(self, method: str, path: str, body: Any = None, *, timeout_s: float | None = None) -> Any:
        data = None if body is None else json.dumps(body, allow_nan=False).encode()
        request = urllib.request.Request(f"{self.url}{path}", data=data, method=method, headers={
            "authorization": f"Bearer {self._token}", "content-type": "application/json", "accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout_s or self.timeout_s) as reply:  # noqa: S310 (own URL)
                payload = reply.read()
        except urllib.error.HTTPError as exc:
            try:
                error = json.loads(exc.read() or b"{}").get("error") or {}
            except ValueError:
                error = {}
            raise ExecutorRefused(exc.code, str(error.get("code", "HTTP_ERROR")), str(error.get("message", ""))) from exc
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            raise ExecutorUnavailable(str(exc)) from exc
        try:
            return json.loads(payload)
        except ValueError as exc:
            raise ExecutorUnavailable("executor answered with something that is not JSON") from exc

    def health(self) -> dict[str, Any]:
        out = self._call("GET", "/v1/health")
        if out.get("contract") != CONTRACT:
            raise ExecutorUnavailable(f"unexpected contract {out.get('contract')!r}")
        return out

    def evidence(self, request: dict[str, Any], *, timeout_s: float | None = None) -> dict[str, Any]:
        return self._call("POST", "/v1/evidence", request, timeout_s=timeout_s)

    def submit(self, envelope: dict[str, Any]) -> dict[str, Any]:
        return self._call("POST", "/v1/orders", envelope)

    def dry_run(self, envelope: dict[str, Any], *, timeout_s: float | None = None) -> dict[str, Any]:
        return self._call("POST", "/v1/dry-runs", envelope, timeout_s=timeout_s)

    def attempt(self, key: str) -> dict[str, Any]:
        return self._call("GET", f"/v1/attempts/{urllib.parse.quote(key, safe='')}")

    def withdraw(self, key: str, reason: str) -> dict[str, Any]:
        return self._call("POST", f"/v1/attempts/{urllib.parse.quote(key, safe='')}/withdraw", {"reason": reason})

    def recover(self) -> dict[str, Any]:
        return self._call("POST", "/v1/recover", {})

    def add_revision(self, key: str, kind: str, data: dict[str, Any]) -> dict[str, Any]:
        return self._call("POST", f"/v1/attempts/{urllib.parse.quote(key, safe='')}/revisions", {"kind": kind, "data": data})
