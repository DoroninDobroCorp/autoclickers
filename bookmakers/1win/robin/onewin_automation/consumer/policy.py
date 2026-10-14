"""Owner policy of the 1win queue consumer.

The policy file is private to the operator: its location is an operational fact, so there is no
default path and nothing in it is ever taken from a queue item.  What a queue item may not decide is
decided here: the account identity, the currency, the stake and the ceiling of the stake.

Modes (``disabled`` is the default of everything):

``disabled``  nothing is read, nothing is sent; the process reports its state and exits
``observe``   reads the queue and asks the executor for read-only evidence; never claims, never
              writes the queue, never orders; reports what it WOULD do
``dry``       the full route through the executor's read-only cart; a result is a ``dry_run``
              record in the queue history, never a bet
``real``      hands verified orders to the executor; needs the executor itself to be armed
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

POLICY_SCHEMA = "onewin-consumer-policy.v1"
MODES = ("disabled", "observe", "dry", "real")
ENVIRONMENTS = ("production", "local_stand")
PURPOSES = ("diagnostic_test", "value")
_NAME = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
_ALLOWED = {
    "schema", "mode", "account_id", "currency", "stake", "max_stake", "purpose", "environment", "bookmaker_id",
    "tasks_file", "state_dir", "consumer_id", "executor", "jev", "lease_ms", "poll_interval_ms",
    "executor_deadline_s", "evidence_deadline_s", "jev_veto_on_fail",
}


class PolicyError(ValueError):
    pass


def _positive(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise PolicyError(f"{name} must be a positive finite number")
    return float(value)


@dataclass(frozen=True)
class ExecutorEndpoint:
    url: str
    token_env: str
    timeout_s: float = 10.0


@dataclass(frozen=True)
class JevEndpoint:
    """Advice only.  URL and token are read from the named environment variables; absent = no advice."""
    url_env: str | None = None
    token_env: str | None = None
    timeout_s: float = 2.5


@dataclass(frozen=True)
class Policy:
    mode: str
    account_id: str
    currency: str
    stake: float
    max_stake: float
    purpose: str
    environment: str
    bookmaker_id: str
    tasks_file: str
    state_dir: str
    consumer_id: str
    executor: ExecutorEndpoint
    jev: JevEndpoint = field(default_factory=JevEndpoint)
    lease_ms: int = 30000
    poll_interval_ms: int = 250
    executor_deadline_s: float = 60.0
    evidence_deadline_s: float = 5.0
    jev_veto_on_fail: bool = True

    @property
    def account_dir(self) -> Path:
        # state of every account is isolated under its own directory
        return Path(self.state_dir) / self.account_id

    def with_mode(self, mode: str) -> "Policy":
        """A command-line mode may only LOWER the privilege of the policy file."""
        if mode not in MODES:
            raise PolicyError(f"unknown mode {mode!r}")
        if MODES.index(mode) > MODES.index(self.mode):
            raise PolicyError(f"mode {mode!r} is above the policy mode {self.mode!r}")
        return Policy(**{**self.__dict__, "mode": mode})


def parse_policy(raw: Any) -> Policy:
    if not isinstance(raw, dict):
        raise PolicyError("policy must be a JSON object")
    unknown = sorted(set(raw) - _ALLOWED)
    if unknown:
        raise PolicyError(f"unknown policy fields: {', '.join(unknown)}")
    if raw.get("schema") != POLICY_SCHEMA:
        raise PolicyError(f"schema must be {POLICY_SCHEMA}")
    mode = raw.get("mode", "disabled")
    if mode not in MODES:
        raise PolicyError(f"mode must be one of {MODES}")
    environment = raw.get("environment")
    if environment not in ENVIRONMENTS:
        raise PolicyError(f"environment must be one of {ENVIRONMENTS} (stated explicitly)")
    account_id = raw.get("account_id")
    if not isinstance(account_id, str) or not _NAME.match(account_id):
        raise PolicyError("account_id (policy-owned account identity) is required")
    if raw.get("currency") != "USDT":
        raise PolicyError("currency must be USDT: the stake of the queue item is never used as a currency amount")
    stake = _positive(raw.get("stake"), "stake")
    max_stake = _positive(raw.get("max_stake"), "max_stake")
    if stake > max_stake:
        raise PolicyError("stake exceeds max_stake")
    purpose = raw.get("purpose", "diagnostic_test")
    if purpose not in PURPOSES:
        raise PolicyError(f"purpose must be one of {PURPOSES}")
    if purpose == "diagnostic_test" and (stake != 1.0 or max_stake > 1.0):
        raise PolicyError("a diagnostic test stakes exactly 1 and never above 1")
    bookmaker_id = str(raw.get("bookmaker_id", "1win")).strip().lower()
    if bookmaker_id not in {"1win", "onewin"}:
        raise PolicyError("bookmaker_id must address 1win")
    for name in ("tasks_file", "state_dir"):
        if not isinstance(raw.get(name), str) or not raw[name].strip():
            raise PolicyError(f"{name} is required")
    consumer_id = raw.get("consumer_id") or f"consumer-{account_id}"
    if not isinstance(consumer_id, str) or not _NAME.match(consumer_id):
        raise PolicyError("consumer_id is invalid")
    ex = raw.get("executor")
    if not isinstance(ex, dict) or not isinstance(ex.get("url"), str) or not ex["url"].startswith(("http://127.0.0.1", "http://localhost", "https://")):
        raise PolicyError("executor.url is required (loopback http or https)")
    if not isinstance(ex.get("token_env"), str) or not _ENV_NAME.match(ex["token_env"]):
        raise PolicyError("executor.token_env must name an environment variable")
    executor = ExecutorEndpoint(url=ex["url"].rstrip("/"), token_env=ex["token_env"], timeout_s=_positive(ex.get("timeout_s", 10.0), "executor.timeout_s"))
    jev_raw = raw.get("jev") or {}
    if not isinstance(jev_raw, dict) or set(jev_raw) - {"url_env", "token_env", "timeout_s"}:
        raise PolicyError("jev accepts url_env, token_env, timeout_s only")
    for name in ("url_env", "token_env"):
        if jev_raw.get(name) is not None and not _ENV_NAME.match(str(jev_raw[name])):
            raise PolicyError(f"jev.{name} must name an environment variable")
    jev = JevEndpoint(url_env=jev_raw.get("url_env"), token_env=jev_raw.get("token_env"),
                      timeout_s=_positive(jev_raw.get("timeout_s", 2.5), "jev.timeout_s"))
    return Policy(
        mode=mode, account_id=account_id, currency="USDT", stake=stake, max_stake=max_stake, purpose=purpose,
        environment=environment, bookmaker_id=bookmaker_id, tasks_file=raw["tasks_file"], state_dir=raw["state_dir"],
        consumer_id=consumer_id, executor=executor, jev=jev,
        lease_ms=int(_positive(raw.get("lease_ms", 30000), "lease_ms")),
        poll_interval_ms=int(_positive(raw.get("poll_interval_ms", 250), "poll_interval_ms")),
        executor_deadline_s=_positive(raw.get("executor_deadline_s", 60.0), "executor_deadline_s"),
        evidence_deadline_s=_positive(raw.get("evidence_deadline_s", 5.0), "evidence_deadline_s"),
        jev_veto_on_fail=bool(raw.get("jev_veto_on_fail", True)),
    )


def load_policy(path: str | Path) -> Policy:
    try:
        raw = json.loads(Path(path).read_text())
    except (OSError, ValueError) as exc:
        raise PolicyError(f"policy file unreadable: {exc}") from exc
    return parse_policy(raw)
