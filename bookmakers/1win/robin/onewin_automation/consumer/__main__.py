"""Command line of the 1win queue consumer.

  python -m onewin_automation.consumer run       --policy <policy.json> [--mode observe|dry|real] [--max-items N] [--idle-exit-s S]
  python -m onewin_automation.consumer status    --policy <policy.json>
  python -m onewin_automation.consumer reconcile --policy <policy.json> --key K (--bet-id ID | --not-placed) --evidence TEXT --operator NAME

Nothing is enabled by default: the policy file states the mode (default ``disabled``), the account,
the currency, the stake and the environment; a command-line ``--mode`` can only lower it.  Output is
one JSON object per line on stdout; there are no secrets in it.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from typing import Any

from .core import Consumer, PreflightError
from .executor_client import ExecutorClient, ExecutorRefused, ExecutorUnavailable
from .journal import InstanceLockError
from .jev_advisor import JevAdvisor
from .policy import MODES, PolicyError, load_policy
from .queue_client import QueueClient, QueueError


def _emit(record: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(record, sort_keys=True, default=str) + "\n")
    sys.stdout.flush()


def _clock(offset: float | None, environment: str):
    """Wall time, or wall time shifted by a fixed offset (replay of a recorded input at its own time).
    The offset is the same for every process of a drill, so their clocks agree."""
    if offset is None:
        return time.time
    if environment != "local_stand":
        raise PolicyError("--test-clock-offset exists only for a local_stand policy")
    return lambda: time.time() + offset


def build(policy, args) -> Consumer:
    queue = QueueClient(policy.tasks_file, bookmaker=policy.bookmaker_id, producer_ops=False)
    executor = ExecutorClient.from_policy(policy.executor)
    clock = _clock(getattr(args, "test_clock_offset", None), policy.environment)
    return Consumer(policy, queue=queue, executor=executor, advisor=JevAdvisor.from_policy(policy.jev), clock=clock)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="onewin_automation.consumer", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--policy", required=True)
    run.add_argument("--mode", choices=MODES)
    run.add_argument("--max-items", type=int)
    run.add_argument("--idle-exit-s", type=float)
    run.add_argument("--test-clock-offset", type=float, help="seconds added to the wall clock, to replay a recorded input at its own time; local_stand policies only")
    status = sub.add_parser("status")
    status.add_argument("--policy", required=True)
    rec = sub.add_parser("reconcile")
    rec.add_argument("--policy", required=True)
    rec.add_argument("--key", required=True)
    group = rec.add_mutually_exclusive_group(required=True)
    group.add_argument("--bet-id")
    group.add_argument("--not-placed", action="store_true")
    rec.add_argument("--evidence", required=True)
    rec.add_argument("--operator", required=True)
    args = parser.parse_args(argv)

    try:
        policy = load_policy(args.policy)
        if getattr(args, "mode", None):
            policy = policy.with_mode(args.mode)
    except PolicyError as exc:
        _emit({"event": "refused", "reason": f"policy:{exc}"})
        return 2

    if args.command == "status":
        _emit({"event": "status", "mode": policy.mode, "environment": policy.environment, "account_id": policy.account_id,
               "currency": policy.currency, "stake": policy.stake, "purpose": policy.purpose, "consumer_id": policy.consumer_id})
        return 0

    if args.command == "run" and policy.mode == "disabled":
        _emit({"event": "disabled", "reason": "policy mode is disabled: nothing was read, nothing was sent"})
        return 0

    consumer = None
    try:
        consumer = build(policy, args)
        consumer.preflight()
        if args.command == "reconcile":
            consumer.open() if policy.mode in ("dry", "real") else None
            _emit({"event": "reconciled", **consumer.reconcile(args.key, bet_id=args.bet_id, not_placed=args.not_placed,
                                                                 evidence=args.evidence, operator=args.operator)})
            return 0
        consumer.open()
        stopping = {"flag": False}
        signal.signal(signal.SIGTERM, lambda *_: stopping.update(flag=True))
        signal.signal(signal.SIGINT, lambda *_: stopping.update(flag=True))
        _emit({"event": "started", "mode": policy.mode, "environment": policy.environment, "account_id": policy.account_id,
               "consumer_id": policy.consumer_id, "pid": os.getpid()})
        handled = consumer.run(max_items=args.max_items, idle_exit_s=args.idle_exit_s, stop=lambda: stopping["flag"], emit=_emit)
        _emit({"event": "stopped", "handled": handled})
        return 0
    except PolicyError as exc:
        _emit({"event": "refused", "reason": f"policy:{exc}"})
        return 2
    except PreflightError as exc:
        _emit({"event": "refused", "reason": "preflight", "problems": exc.problems})
        return 3
    except InstanceLockError as exc:
        _emit({"event": "refused", "reason": f"instance_lock:{exc}"})
        return 5
    except (ExecutorUnavailable, ExecutorRefused, QueueError) as exc:
        _emit({"event": "refused", "reason": f"{type(exc).__name__}:{exc}"})
        return 4
    finally:
        if consumer is not None:
            consumer.close()
            try:
                consumer.queue.close()
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    raise SystemExit(main())
