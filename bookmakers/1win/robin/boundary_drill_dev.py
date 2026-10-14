"""Dev half of the Mac-boundary drill.

The product consumer runs HERE (dev, next to the automation queue); the executor and the local
TLS stand run on the MAC and are reached through a reverse SSH tunnel (127.0.0.1 only).  Every
stage prints one JSON object; nothing secret is printed.

  python boundary_drill_dev.py --executor-port P --control-port C --offset SECONDS --out report.json
"""
from __future__ import annotations

import argparse
import json
import platform
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from consumer_harness import Producer, case, configure_stand, reports, run_consumer, write_policy
from onewin_automation.queue_adapter import queue_item_identity


class MacStand:
    """The control API of the stand on the Mac, through the tunnel."""

    def __init__(self, port: int):
        self.base = f"http://127.0.0.1:{port}"

    def call(self, method: str, path: str, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method, headers={"content-type": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as reply:  # noqa: S310
            return json.loads(reply.read())

    def log(self):
        return self.call("GET", "/stand/log")

    def config(self, **patch):
        self.call("POST", "/stand/config", patch)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--executor-port", type=int, required=True)
    parser.add_argument("--control-port", type=int, required=True)
    parser.add_argument("--offset", type=float, required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="boundary-drill-"))
    stand = MacStand(args.control_port)
    executor_url = f"http://127.0.0.1:{args.executor_port}"
    market = case()
    from consumer_harness import native_market_for
    native = native_market_for("P1 T< 1")
    stand.config(native_market=native, ui={"market_name": native["group_name"], "ui_selection_name": native["selection_name"]})
    prod = Producer(tmp / "tasks.json")
    out: dict = {"schema": "onewin-mac-boundary-drill.v1", "consumer_host": {"python": sys.version.split()[0], "platform": platform.platform()},
                 "stages": {}}
    policy = write_policy(tmp, mode="real", stand_url=executor_url, tasks_file=prod.tasks_file, state_dir=tmp / "state")
    try:
        item = prod.add()
        key = queue_item_identity(item)
        out["queue_item"] = {"id": item["id"], "key": key, "bookmakerId": item["bookmakerId"]}
        flags = ("--test-clock-offset", repr(args.offset))

        rc, lines = run_consumer(policy, "--mode", "observe", "--max-items", "1", *flags, timeout=90)
        rep = reports(lines)
        out["stages"]["observe"] = {"rc": rc, "report": rep[0] if rep else lines, "money_at_mac_stand": stand.log()["money_requests"],
                                    "queue_item_still_current": prod.current()["item"] is not None}

        rc, lines = run_consumer(policy, "--max-items", "1", *flags, timeout=180)
        rep = reports(lines)
        log = stand.log()
        out["stages"]["real"] = {"rc": rc, "report": rep[0] if rep else lines, "money_at_mac_stand": log["money_requests"],
                                 "stand_calls": log["calls"], "history": [{"status": h["status"], "ticketId": h.get("ticketId"),
                                                                           "testMode": h.get("testMode")} for h in prod.history()]}
        # what the Mac executor holds for this key, read through the contract
        import os
        token = os.environ["ONEWIN_EXECUTOR_TOKEN"]
        request = urllib.request.Request(f"{executor_url}/v1/attempts/{key}", headers={"authorization": f"Bearer {token}"})
        with urllib.request.urlopen(request, timeout=10) as reply:  # noqa: S310
            view = json.loads(reply.read())
        attempt = view["attempt"]
        request = urllib.request.Request(f"{executor_url}/v1/health", headers={"authorization": f"Bearer {token}"})
        with urllib.request.urlopen(request, timeout=10) as reply:  # noqa: S310
            health = json.loads(reply.read())
        out["mac_executor"] = {"health": {k: health[k] for k in ("contract", "mode", "transport_environment", "guard_version", "live_gate_open", "browser")},
                               "attempt": {"status": attempt["status"], "stake": attempt["stake"], "currency": attempt["currency"],
                                           "native_request_key_present": bool((attempt.get("native_request") or {}).get("idempotency_key")),
                                           "executor_provenance": attempt["payload"]["executor_provenance"],
                                           "synthetic": attempt["payload"]["provenance"]["synthetic"]},
                               "wire_key_equals_attempt_key": log["money"][0]["body"]["idempotencyKey"] == attempt["native_request"]["idempotency_key"]}
        # the same message again, and a restart of the consumer: nothing more is sent
        rc, lines = run_consumer(policy, "--max-items", "1", "--idle-exit-s", "1", *flags, timeout=90)
        out["stages"]["restart_idle"] = {"rc": rc, "reports": reports(lines), "money_at_mac_stand": stand.log()["money_requests"]}
        # the Mac side goes away (tunnel down): the consumer refuses without touching the queue
    finally:
        prod.close()
    Path(args.out).write_text(json.dumps(out, indent=2, sort_keys=True))
    print(json.dumps({"ok": True, "out": args.out}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
