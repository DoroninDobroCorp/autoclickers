"""One complete route through the PRODUCT consumer command line on the local stand, written out as evidence:
observe -> dry -> real (accepted) -> repeat of the same message -> an unknown answer (unresolved) ->
reconciliation by native key.  Every stage records the money requests the stand really received.

  python consumer_route_report.py --out report.json
"""
from __future__ import annotations

import argparse
import json
import platform
import sys
import tempfile
import time
from pathlib import Path

from consumer_harness import (Producer, Stand, case, configure_stand, replay_offset, reports, run_consumer, write_policy)
from onewin_automation.consumer.journal import Journal
from onewin_automation.queue_adapter import queue_item_identity


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    tmp = Path(tempfile.mkdtemp(prefix="consumer-route-"))
    offset = replay_offset()
    flags = ("--max-items", "1", "--test-clock-offset", repr(offset))
    out: dict = {"schema": "onewin-consumer-route-report.v1", "host": {"python": sys.version.split()[0], "platform": platform.platform()},
                 "components": {"REAL": ["TaskBuilder + TasksManager (queue_worker.mjs)", "onewin_automation.consumer (command line)",
                                         "common engine: queue_adapter, readiness, order, cart_plan, receipt_export",
                                         "executor_core + executor_service (HTTP, owner lock, recovery)",
                                         "OneWinLiveCart + DurableAttemptStore + transport guard in a real browser"],
                                "STUB": ["bookmaker: local TLS stand (bet ids STAND-n)", "executor evidence: synthetic, labelled",
                                         "Jev: not configured in this report (see the Jev section of the HANDOFF)"]},
                 "stages": {}}
    import urllib.request
    from consumer_harness import TOKEN
    # ---- 0: dry, through the consumer, on an executor that is itself dry (no order can even be accepted)
    dry_stand = Stand(tmp / "executor-dry", mode="dry", clock_offset=offset).start()
    try:
        configure_stand(dry_stand, "P1 T> 1")
        dry_prod = Producer(tmp / "tasks-dry.json")
        dry_item = dry_prod.add(case("P1 T> 1"))
        dry_policy = write_policy(tmp, mode="dry", stand_url=dry_stand.url, tasks_file=dry_prod.tasks_file, state_dir=tmp / "state-dry")
        rc, lines = run_consumer(dry_policy, *flags)
        log = dry_stand.log()
        out["stages"]["0_dry_through_the_consumer"] = {
            "rc": rc, "reports": reports(lines), "stand_money_requests_total": log["money_requests"], "stand_calls": log["calls"],
            "queue_history": [{k: h.get(k) for k in ("status", "dryRun", "testMode", "ticketId")} for h in dry_prod.history()],
            "journal_phases": Journal(tmp / "state-dry" / "acct-1" / "journal.jsonl").items()[queue_item_identity(dry_item)]["order"]}
        dry_prod.close()
    finally:
        dry_stand.stop()

    stand = Stand(tmp / "executor", mode="real", clock_offset=offset).start()
    try:
        req = urllib.request.Request(f"{stand.url}/v1/health", headers={"authorization": f"Bearer {TOKEN}"})
        with urllib.request.urlopen(req, timeout=10) as reply:
            health = json.loads(reply.read())
        out["executor_health"] = {k: health.get(k) for k in ("contract", "mode", "transport_environment", "guard_version", "live_gate_open", "store", "browser")}
        configure_stand(stand)
        prod = Producer(tmp / "tasks.json")
        item = prod.add()
        key = queue_item_identity(item)
        out["queue_item"] = {"id": item["id"], "key": key, "bookmakerId": item["bookmakerId"], "event": item["pair"]["event_id"],
                             "outcome": item["outcome"], "queue_stake": item["stake"]}
        policy = write_policy(tmp, mode="real", stand_url=stand.url, tasks_file=prod.tasks_file, state_dir=tmp / "state")
        state = tmp / "state" / "acct-1"

        def snapshot(label, rc, lines):
            log = stand.log()
            out["stages"][label] = {"rc": rc, "reports": [r for r in reports(lines)], "events": [l for l in lines if l.get("event")],
                                    "stand_money_requests_total": log["money_requests"], "stand_calls": log["calls"],
                                    "queue": {"current": prod.current()["item"] is not None, "processing": prod.current()["processing"],
                                              "history": [{k: h.get(k) for k in ("status", "ticketId", "testMode", "dryRun", "step", "error")} for h in prod.history()]}}

        rc, lines = run_consumer(policy, "--mode", "observe", *flags)
        snapshot("1_observe", rc, lines)
        rc, lines = run_consumer(policy, *flags)
        snapshot("2_real_accepted", rc, lines)
        req = urllib.request.Request(f"{stand.url}/v1/attempts/{key}", headers={"authorization": f"Bearer {TOKEN}"})
        with urllib.request.urlopen(req, timeout=10) as reply:
            attempt = json.loads(reply.read())["attempt"]
        out["attempt_after_accept"] = {
            "status": attempt["status"], "stake": attempt["stake"], "currency": attempt["currency"], "event_id": attempt["event_id"],
            "market_id": attempt["market_id"], "selection_id": attempt["selection_id"], "expected_odds": attempt["expected_odds"],
            "receipt": {k: attempt["receipt"].get(k) for k in ("bet_id", "accepted_cf", "amount", "currency", "condition_mismatches")},
            "native_request": attempt["native_request"], "wire_idempotency_key_at_stand": stand.log()["money"][0]["body"]["idempotencyKey"],
            "executor_provenance": attempt["payload"]["executor_provenance"], "provenance": attempt["payload"]["provenance"],
            "purpose": attempt["payload"]["purpose"], "correlation": attempt["payload"]["correlation"],
            "source_quotes": {k: (v if k != "margins" else len(v)) for k, v in attempt["payload"]["source_quotes"].items()},
            "advisory": attempt["payload"]["advisory"], "policy": attempt["payload"]["policy"],
            "evidence_expiries": attempt["payload"]["evidence"]["expiries"],
        }
        out["export_after_accept"] = json.loads((state / "exports" / f"{key}.json").read_text())
        out["journal_phases"] = Journal(state / "journal.jsonl").items()[key]["order"]
        # the same message once more
        prod.add(id=item["id"])
        rc, lines = run_consumer(policy, *flags)
        snapshot("3_redelivered_same_message", rc, lines)
        # an unknown bookmaker answer on another selection
        stand.config(answer={"result": {"error": {"code": "something_new"}}})
        second = case("P1 T> 1")
        prod.add(second)
        configure_stand(stand, "P1 T> 1")
        rc, lines = run_consumer(policy, *flags)
        snapshot("4_unknown_answer_unresolved", rc, lines)
        key2 = queue_item_identity(prod.history()[-1] and {"id": prod.history()[-1]["taskId"], "bookmakerId": "1win"})
        rc, lines = run_consumer(policy, "--key", key2, "--bet-id", "STAND-2", "--evidence", "stand history searched by the native idempotency key",
                                 "--operator", "drill", command="reconcile")
        out["stages"]["5_reconcile_by_native_key"] = {"rc": rc, "result": lines[-1] if lines else None,
                                                      "export": json.loads((state / "exports" / f"{key2}.json").read_text())["receipt"],
                                                      "queue_history": [{k: h.get(k) for k in ("status", "ticketId", "testMode")} for h in prod.history()],
                                                      "stand_money_requests_total": stand.log()["money_requests"]}
        prod.close()
    finally:
        stand.stop()
    Path(args.out).write_text(json.dumps(out, indent=2, sort_keys=True, default=str))
    print(json.dumps({"ok": True, "out": args.out, "money_total": out["stages"]["5_reconcile_by_native_key"]["stand_money_requests_total"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
