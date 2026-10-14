"""Test driver: the PRODUCT consumer (same build() as the command line) with a hook that kills the
process at a named durable point, exactly as a crash would.

  consumer_driver.py <policy.json> <crash-point> <clock-offset|none>

Points: after_claim, after_built, after_handoff_recorded, after_submit_returned, after_observed,
after_decided, after_queue_written, after_export.
"""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace

from onewin_automation.consumer.__main__ import build
from onewin_automation.consumer.core import Hooks
from onewin_automation.consumer.policy import load_policy


class CrashAt(Hooks):
    def __init__(self, point: str):
        self.point = point

    def at(self, point: str, **context) -> None:
        if point == self.point:
            sys.stdout.write(f'{{"event": "crash", "point": "{point}"}}\n')
            sys.stdout.flush()
            os._exit(137)


def main() -> int:
    policy_path, point, offset = sys.argv[1], sys.argv[2], sys.argv[3]
    policy = load_policy(policy_path)
    consumer = build(policy, SimpleNamespace(test_clock_offset=None if offset == "none" else float(offset)))
    consumer.hooks = CrashAt(point)
    consumer.preflight()
    consumer.open()
    consumer.run(max_items=1)
    consumer.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
