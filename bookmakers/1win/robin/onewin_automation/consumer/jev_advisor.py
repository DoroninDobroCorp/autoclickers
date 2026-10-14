"""Jev as an adviser: a bounded review that can only make the consumer more careful.

``review_with_jev`` of the common engine does the contract work (dry-run task required, decision
vocabulary, confidence range, clock before and after the call, every failure -> INVESTIGATE).  What
this module adds is what the engine cannot know:

* the gateway client: one HTTP call, no retry (a retry would spend the source deadline), and its
  timeout is the smaller of the configured one and what is left of the task;
* the transport is never the reason a task is refused: down / slow / late / malformed answers are
  INVESTIGATE with a reason and change nothing;
* a decision never arms execution (``execution_ready`` is False in every answer) and the model's
  confidence is reported as what it is, an uncalibrated self-assessment.
"""
from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable

from ..common import review_with_jev


@dataclass
class _Question:
    prompt: str
    options: dict[str, str | None]
    type: str = "choice"


@dataclass
class _Answer:
    choice: str
    confidence: Any
    probabilities: dict[str, float]


@dataclass
class _Result:
    choices: dict[str, _Answer]
    model: str


def _question(*, prompt: str, options: dict[str, str | None]) -> _Question:
    return _Question(prompt=prompt, options=options)


class GatewayError(RuntimeError):
    pass


class MinimalGatewayClient:
    """The wire contract of the Jev gateway (POST {state, questions} with a bearer token), without
    the retry, alerting and global state of the larger client library."""

    def __init__(self, url: str, token: str, timeout_s: float):
        self.url, self._token, self.timeout_s = url, token, max(0.05, float(timeout_s))

    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        request = urllib.request.Request(self.url, data=json.dumps(payload, allow_nan=False).encode(), method="POST", headers={
            "authorization": f"Bearer {self._token}", "content-type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as reply:  # noqa: S310 (operator-configured URL)
                body = reply.read(2_000_000)
        except urllib.error.HTTPError as exc:
            raise GatewayError(f"HTTP {exc.code}") from exc
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            raise GatewayError(type(exc).__name__) from exc
        try:
            parsed = json.loads(body)
        except ValueError as exc:
            raise GatewayError("answer is not JSON") from exc
        if not isinstance(parsed, dict):
            raise GatewayError("answer is not an object")
        return parsed

    async def system_one(self, state: dict[str, Any], questions: dict[str, _Question]) -> _Result:
        wire = {key: {"type": "choice", "prompt": q.prompt, "options": q.options} for key, q in questions.items()}
        data = await asyncio.get_running_loop().run_in_executor(None, self._post, {"state": state, "questions": wire})
        answers = data.get("answers")
        if not isinstance(answers, dict):
            raise GatewayError("no answers")
        choices: dict[str, _Answer] = {}
        for key, answer in answers.items():
            if isinstance(answer, dict) and "choice" in answer:
                choices[key] = _Answer(choice=answer.get("choice", ""), confidence=answer.get("confidence"),
                                       probabilities=answer.get("probabilities") if isinstance(answer.get("probabilities"), dict) else {})
        return _Result(choices=choices, model=str(data.get("model", "")))


class JevAdvisor:
    def __init__(self, *, url: str | None, token: str | None, timeout_s: float, client_factory: Callable[..., Any] | None = None,
                 question_factory: Callable[..., Any] | None = None):
        """``client_factory(url, token, timeout_s)`` and ``question_factory(prompt=, options=)`` may be replaced by the
        larger Jev client library of the operator's machine; the defaults are the minimal wire client of this module."""
        self.url, self._token, self.timeout_s = url, token, timeout_s
        self._client_factory = client_factory or MinimalGatewayClient
        self._question_factory = question_factory or _question

    @classmethod
    def from_policy(cls, endpoint) -> "JevAdvisor":
        url = os.environ.get(endpoint.url_env or "", "") if endpoint.url_env else ""
        token = os.environ.get(endpoint.token_env or "", "") if endpoint.token_env else ""
        return cls(url=url or None, token=token or None, timeout_s=endpoint.timeout_s)

    @property
    def configured(self) -> bool:
        return bool(self.url and self._token)

    def advise(self, task: dict[str, Any], *, clock: Callable[[], float], now: float | None = None) -> dict[str, Any]:
        """Always returns an ``automation-review.v1`` record; never raises, never blocks past the deadline."""
        if not self.configured:
            return {"schema_version": "automation-review.v1", "status": "NOT_CONFIGURED", "execution_ready": False,
                    "reason": "jev_not_configured", "confidence_is_calibrated": False}
        left = float(task["expires_at"]) - (clock() if now is None else now)
        budget = min(self.timeout_s, left - 0.25)
        if budget < 0.2:
            return {"schema_version": "automation-review.v1", "status": "INVESTIGATE", "execution_ready": False,
                    "reason": "no_time_left_for_review", "confidence_is_calibrated": False}
        client = self._client_factory(self.url, self._token, budget)

        async def _run() -> dict[str, Any]:
            return await asyncio.wait_for(review_with_jev(dict(task), client, self._question_factory, clock=clock), timeout=budget + 0.5)

        try:
            result = asyncio.run(_run())
        except Exception as exc:  # noqa: BLE001 - advice must never break the route
            return {"schema_version": "automation-review.v1", "status": "INVESTIGATE", "execution_ready": False,
                    "reason": "review_unavailable_or_invalid", "error_type": type(exc).__name__, "confidence_is_calibrated": False}
        result.setdefault("confidence_is_calibrated", False)
        result["execution_ready"] = False
        return result
