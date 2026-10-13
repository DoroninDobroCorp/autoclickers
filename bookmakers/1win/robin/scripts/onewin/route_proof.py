#!/usr/bin/env python3
"""Isolated route proof: real queue -> common task -> Jev (real client) -> verified order -> real
executor cart in a real Chromium -> durable attempt -> queue write-back -> receipt export.

No money, no external bookmaker, no account. What is REAL and what is a STUB is written into the
report (`components`); nothing here is evidence of a bookmaker bet.

  REAL   core/node TaskBuilder + TasksManager (queue file, restart, cancel, write-back)
  REAL   onewin_automation queue_adapter / common / cart_plan / receipt_export (committed bytes, sha256 recorded)
  REAL   Mac client GatewayJevClient (library); the gateway is the real Netlify gateway for one call
         and a LOCAL STUB gateway for the failure modes (down, slow, 5xx, 401, malformed, late)
  REAL   OneWinLiveCart + DurableAttemptStore + transport guard in a real Chromium
  STUB   the bookmaker: a local TLS stand answering make-bet-v2 (its "bet ids" are STAND-n)
  STUB   executor evidence (native ids, commission, account state, native market text): synthetic,
         labelled; the only real facts about 1win are in the separate read-only account probe
  NOT IN THE ROUTE  BaseBettor/BetProcessor (their 1win adapter refuses live placement), the Mac
         client's own Telegram-signal orchestrator (a separate executor, never fed by automation)
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROBIN = HERE.parent.parent
NODE = os.environ.get("NODE", "node")
RUNNER = HERE / "route_node_runner.mjs"


def node(command: str, args: list[str], payload: dict | None = None, *, timeout: int = 180, allow_failure: bool = False) -> dict:
    proc = subprocess.run([NODE, str(RUNNER), command, *args], input=json.dumps(payload or {}), text=True,
                          capture_output=True, timeout=timeout, cwd=str(HERE))
    if proc.returncode != 0 and not allow_failure:
        raise RuntimeError(f"{command} failed rc={proc.returncode}: {proc.stderr[-1500:]}")
    lines = [line for line in proc.stdout.strip().splitlines() if line.startswith("{")]
    result = json.loads(lines[-1]) if lines else {}
    result["_returncode"] = proc.returncode
    return result


class StubGateway:
    """Local stand-in of the Jev gateway wire contract (POST /<mode>/api/jev)."""

    def __init__(self):
        self.calls: list[str] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):  # silence
                pass

            def do_POST(self):
                mode = self.path.strip("/").split("/")[0]
                length = int(self.headers.get("content-length") or 0)
                self.rfile.read(length)
                outer.calls.append(mode)
                if mode == "drop":
                    self.connection.close()
                    return
                if mode == "slow":
                    time.sleep(3.0)
                if mode == "late":
                    time.sleep(0.6)
                if mode == "http500":
                    self.send_response(500); self.end_headers(); self.wfile.write(b"upstream"); return
                if mode == "http401":
                    self.send_response(401); self.end_headers(); self.wfile.write(b"no"); return
                if mode == "malformed":
                    self.send_response(200); self.end_headers(); self.wfile.write(b"<html>not json</html>"); return
                body = json.dumps({"answers": {"decision": {"type": "choice", "choice": "PASS", "confidence": 0.97,
                                   "probabilities": {"PASS": 0.97, "INVESTIGATE": 0.02, "FAIL": 0.01}}},
                                   "model": "jev-1.13.0", "usage": {"input_tokens": 1, "output_tokens": 1}}).encode()
                self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def url(self, mode: str) -> str:
        return f"http://127.0.0.1:{self.port}/{mode}/api/jev"

    def close(self):
        self.server.shutdown()


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--automation-sha", required=True)
    parser.add_argument("--frame", required=True, help="recorded calculator frame (unchanged), replayed at its own computed_at")
    parser.add_argument("--mac-client", default="/Users/macbookprom1/VovkaNowEngineer/universal_autobetting")
    parser.add_argument("--outcome", default="P1 T< 1")
    parser.add_argument("--event-index", type=int, default=0, help="which event of the frame carries the outcome")
    parser.add_argument("--real-jev", action="store_true", help="one call through the real gateway (advice only)")
    parser.add_argument("--jev-source", help="path of a copy of dev:/srv/jev/netlify/functions/jev.ts: run its REAL code in an isolated instance (SDK stubbed)")
    parser.add_argument("--skip-slow", action="store_true", help="skip the 18 s response-timeout scenario")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    started = time.time()

    # ---- the Mac client must not reach Telegram from this proof
    for name in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "OPERATOR_CHAT_ID", "SIGNAL_CHAT_IDS"):
        os.environ[name] = ""
    os.chdir(args.mac_client)
    sys.path.insert(0, args.mac_client)

    # ---- the committed bytes of the automation modules
    pkg_dir = Path(tempfile.mkdtemp(prefix="onewin_route_pkg_")) / "onewin_automation"
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    hashes = {}
    for name in ("axes.py", "native_axes.py", "common.py", "queue_adapter.py", "cart_plan.py", "receipt_export.py"):
        source = ROBIN / "onewin_automation" / name
        (pkg_dir / name).write_bytes(source.read_bytes())
        hashes[name] = hashlib.sha256(source.read_bytes()).hexdigest()
    sys.path.insert(0, str(pkg_dir.parent))
    from onewin_automation.cart_plan import cart_plan_from_order
    from onewin_automation.common import (CommonTaskError, DurableDryRunStore, assess_live_readiness, instant,
                                          review_with_jev, verify_live_execution_conditions)
    from onewin_automation.queue_adapter import common_task_from_queue_item, queue_item_identity
    from onewin_automation.receipt_export import export_attempt_receipt

    # ---- recorded, unchanged input (replay: no clock is refreshed to look live)
    raw = Path(args.frame).read_bytes()
    document = json.loads(raw)
    frame = document.get("frame", document)
    replay_now = instant(frame["computed_at"])
    candidates = [ev for ev in frame["data"] if any(o["outcome"] == args.outcome for o in ev["outcome"])]
    event = candidates[args.event_index]
    outcome = next(o for o in event["outcome"] if o["outcome"] == args.outcome)
    pair = {k: v for k, v in event.items() if k != "outcome"}
    one_win = pair["second"]
    donor = outcome["donor_quote"]
    execution = donor["execution"]
    market_axes = donor["market_axes"]

    report: dict = {
        "schema": "onewin-route-proof.v1",
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "automation_sha": args.automation_sha, "module_sha256": hashes,
        "replay": True, "money_sent": False,
        "node": subprocess.run([NODE, "--version"], capture_output=True, text=True).stdout.strip(),
        "python": sys.version.split()[0],
        "input": {"frame_sha256": hashlib.sha256(raw).hexdigest(), "computed_at": frame["computed_at"], "event_id": event["event_id"],
                  "sport": event.get("sportName"), "is_live": event.get("isLive"), "outcome": args.outcome,
                  "donor_axes": market_axes, "clocks_refreshed": False},
        "components": {
            "REAL": ["core/node TaskBuilder + TasksManager", "onewin_automation queue_adapter/common/cart_plan/receipt_export",
                     "Mac client GatewayJevClient (library)", "OneWinLiveCart + DurableAttemptStore + transport guard in real Chromium"],
            "STUB": ["bookmaker (local TLS stand; bet ids STAND-n)", "executor evidence: native ids / commission / account / native text (synthetic)",
                     "Jev gateway for failure modes (local stub); one call to the real gateway when --real-jev"],
            "NOT_IN_ROUTE": ["BaseBettor/BetProcessor (1win adapter refuses live)", "Mac client Telegram-signal orchestrator"],
        },
        "checks": {}, "scenarios": {},
    }
    checks = report["checks"]
    work = Path(tempfile.mkdtemp(prefix="onewin_route_"))

    native_market = {"sport_id": 18, "group_name": "1st half. Total", "selection_name": "Under 1.0", "points": 1.0,
                     "home_name": one_win["homeName"], "away_name": one_win["awayName"], "outcome_code": "under"}
    SYNTH_SOURCE = "synthetic-route-proof-fixture (not a bookmaker fact)"

    def executor_quote(task, *, at, commission=0.0, contract=True):
        d, ex = task["quote"], task["quote"]["execution"]
        return {"identity_verified_by": "onewin-executor", "verified": True, "provider_id_namespace": ex["provider_id_namespace"],
                "provider_event_key": ex["provider_event_key"], "native_event_id": ex["provider_event_key"],
                "native_market_id": ex["provider_market_key"], "native_selection_id": ex["provider_selection_key"],
                "source_market": d["source_market"], "odds": d["odds"], "source_ts": at, "currency": "USDT",
                "commission": commission, "max_stake": 8.45, "axes": copy.deepcopy(d["market_axes"]),
                "live_submit_contract_verified": contract, "live_submit_contract_source": SYNTH_SOURCE if contract else None,
                "native_market": copy.deepcopy(native_market)}

    def account_state(at):
        return {"logged_in": True, "account_identity_verified": True, "account_identity_source": SYNTH_SOURCE,
                "currency": "USDT", "available_balance": 8.45, "observed_at": at}

    # =========================================================================== 1. real queue
    qfile = str(work / "tasks.json")
    queued = node("queue-add", ["--file", qfile], {"pair": pair, "outcome": outcome, "stake": 1})
    item = queued["item"]
    restarted = node("queue-current", ["--file", qfile])["item"]
    checks["queue_item_created_by_real_taskbuilder_and_tasksmanager"] = bool(queued["added"] and item)
    checks["queue_item_survives_restart_unchanged"] = restarted == item
    task = common_task_from_queue_item(item, stake=1.0, stake_currency="USDT", now=replay_now)
    task_again = common_task_from_queue_item(restarted, stake=1.0, stake_currency="USDT", now=replay_now)
    key = task["idempotency_key"]
    checks["same_identity_after_restart"] = key == task_again["idempotency_key"] == queue_item_identity(item)
    checks["identity_preserved_event_market_selection_axes_odds_clocks"] = (
        task["event_id"] == pair["event_id"] and task["quote"]["execution"] == donor["execution"]
        and task["axes"] == market_axes and task["quote"]["odds"] == donor["odds"]
        and task["quote"]["observed_at"] == donor["observed_at"] and task["valuation_basis"]["roi_basis"] == outcome.get("roi_basis", "unknown"))
    checks["bia_is_reference_only"] = (task["reference_source"] == "BIA" and task["reference_role"] == "reference"
                                       and task["pinnacle_attributed"] is False and task["execution_ready"] is False)
    report["task"] = {"idempotency_key": key, "queue_task_id": item["id"], "expires_at": task["expires_at"],
                      "is_live": task["is_live"], "ttl_seconds": 5 if task["is_live"] else 60,
                      "quote_clock_utc": donor.get("observed_at"), "purpose": "diagnostic_route_proof_no_money"}

    # duplicate message (same item delivered twice) and restart before/after a durable dry-run attempt
    dry_path = work / "dry.sqlite"
    store = DurableDryRunStore(dry_path)
    first = store.prepare(task, now=replay_now + 0.1)
    second = store.prepare(task_again, now=replay_now + 0.15)
    store.close()
    store = DurableDryRunStore(dry_path)
    after_restart = store.prepare(task_again, now=replay_now + 0.2)
    drift = copy.deepcopy(task_again)
    drift["quote"]["odds"] += 0.5
    try:
        store.prepare(drift, now=replay_now + 0.3)
        drift_refused = False
    except CommonTaskError:
        drift_refused = True
    store.reconcile(key, status="WITHDRAWN", revision=1)
    replay_terminal = store.prepare(task, now=replay_now + 0.4)["status"]
    try:
        store.reconcile(key, status="DRY_RUN_VERIFIED", revision=2)
        rearmed = True
    except CommonTaskError:
        rearmed = False
    store.close()
    checks["duplicate_message_is_duplicate_not_second_task"] = (first["duplicate"] is False and second["duplicate"] is True and after_restart["duplicate"] is True)
    checks["changed_payload_on_same_identity_refused"] = drift_refused
    checks["withdrawn_task_replays_as_withdrawn_and_cannot_be_rearmed"] = replay_terminal == "WITHDRAWN" and rearmed is False

    # =========================================================================== 2. Jev (advice only)
    sys.path.insert(0, args.mac_client)
    import autobet.jev_client as jev_module
    from autobet.jev_client import GatewayJevClient, JevChoice, close_shared_http_client
    jev_module._alert_unavailable_throttled = lambda message: None  # no Telegram from the proof
    gateway = StubGateway()
    jev_results: dict = {}
    base_task = copy.deepcopy(task)

    async def review(mode_url: str, *, timeout_ms: int = 1500, clock=None):
        jev_module._auth_failed = False
        t0 = time.monotonic()
        clk = clock or (lambda: replay_now + 0.3 + (time.monotonic() - t0))
        try:
            return await review_with_jev(copy.deepcopy(base_task), GatewayJevClient(url=mode_url, token="stub-token", timeout_ms=timeout_ms),
                                         JevChoice, clock=clk)
        finally:
            await close_shared_http_client()

    jev_results["stub_ok"] = await review(gateway.url("ok"))
    jev_results["stub_down"] = await review(gateway.url("drop"))
    jev_results["stub_restored_after_down"] = await review(gateway.url("ok"))
    jev_results["stub_slow_timeout"] = await review(gateway.url("slow"), timeout_ms=700)
    jev_results["stub_http500"] = await review(gateway.url("http500"))
    jev_results["stub_http401"] = await review(gateway.url("http401"))
    jev_results["stub_malformed"] = await review(gateway.url("malformed"))
    # late answer: the task expires while the gateway thinks
    expiry = base_task["expires_at"]
    stages = {"after": False}

    def late_clock():
        return expiry + 0.1 if stages["after"] else expiry - 0.3

    class _LateClient(GatewayJevClient):
        async def system_one(self, state, questions):
            result = await super().system_one(state, questions)
            stages["after"] = True
            return result
    jev_module._auth_failed = False
    try:
        jev_results["stub_late_after_deadline"] = await review_with_jev(
            copy.deepcopy(base_task), _LateClient(url=gateway.url("late"), token="stub-token", timeout_ms=3000), JevChoice, clock=late_clock)
    finally:
        await close_shared_http_client()
    if args.real_jev:
        jev_module._auth_failed = False
        t0 = time.monotonic()
        try:
            jev_results["real_gateway"] = await review_with_jev(
                copy.deepcopy(base_task), GatewayJevClient(timeout_ms=9000), JevChoice,
                clock=lambda: replay_now + 0.3 + (time.monotonic() - t0))
        finally:
            await close_shared_http_client()
    gateway.close()

    # the REAL gateway function (auth, validation, mapping) in an isolated instance with a stubbed SDK
    if args.jev_source:
        runner = HERE / "jev_gateway_isolated.mjs"

        def start_gateway(mode: str):
            proc = subprocess.Popen([NODE, "--experimental-strip-types", str(runner), "--source", args.jev_source, "--token", "iso-token",
                                     "--mode", mode], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            line = proc.stdout.readline()
            return proc, json.loads(line)["port"]

        report["jev_gateway_source"] = {"path_basename": Path(args.jev_source).name,
                                        "sha256": hashlib.sha256(Path(args.jev_source).read_bytes()).hexdigest(),
                                        "stubbed": "TypeSafe SDK (no model, no credential)"}
        procs = []
        try:
            for mode in ("ok", "api502", "sdk_error"):
                proc, port = start_gateway(mode)
                procs.append(proc)
                url = f"http://127.0.0.1:{port}/api/jev"
                jev_module._auth_failed = False
                try:
                    jev_results[f"isolated_real_code_{mode}"] = await review_with_jev(
                        copy.deepcopy(base_task), GatewayJevClient(url=url, token="iso-token", timeout_ms=3000), JevChoice,
                        clock=lambda: replay_now + 0.3)
                finally:
                    await close_shared_http_client()
                if mode == "ok":
                    jev_module._auth_failed = False
                    try:
                        jev_results["isolated_real_code_wrong_token"] = await review_with_jev(
                            copy.deepcopy(base_task), GatewayJevClient(url=url, token="nope", timeout_ms=3000), JevChoice, clock=lambda: replay_now + 0.3)
                    finally:
                        await close_shared_http_client()
                    jev_module._auth_failed = False
                    huge = copy.deepcopy(base_task)
                    huge["padding"] = "x" * (1_200_000)
                    try:
                        jev_results["isolated_real_code_payload_over_1mb"] = await review_with_jev(
                            huge, GatewayJevClient(url=url, token="iso-token", timeout_ms=5000), JevChoice, clock=lambda: replay_now + 0.3)
                    finally:
                        await close_shared_http_client()
        finally:
            for proc in procs:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except Exception:
                    proc.kill()
        jev_module._auth_failed = False
        iso = {k: v for k, v in jev_results.items() if k.startswith("isolated_real_code_")}
        checks["isolated_real_gateway_code_answers_advice_only"] = (
            iso["isolated_real_code_ok"]["status"] == "INVESTIGATE" and iso["isolated_real_code_ok"]["execution_ready"] is False
            and iso["isolated_real_code_ok"].get("reason") is None)
        checks["isolated_real_gateway_code_failures_degrade_to_investigate"] = all(
            iso[m]["status"] == "INVESTIGATE" and iso[m].get("reason") == "review_unavailable_or_invalid"
            for m in ("isolated_real_code_wrong_token", "isolated_real_code_payload_over_1mb", "isolated_real_code_api502", "isolated_real_code_sdk_error"))
    report["jev"] = jev_results
    checks["jev_never_arms_execution_in_any_mode"] = all(r.get("execution_ready") is False for r in jev_results.values())
    checks["jev_unavailable_modes_degrade_to_investigate"] = all(
        jev_results[m]["status"] == "INVESTIGATE" and jev_results[m].get("reason") == "review_unavailable_or_invalid"
        for m in ("stub_down", "stub_slow_timeout", "stub_http500", "stub_http401", "stub_malformed", "stub_late_after_deadline"))
    checks["jev_restored_gateway_answers_again"] = jev_results["stub_restored_after_down"]["status"] == "PASS"
    checks["jev_confidence_is_not_calibrated"] = all(r.get("confidence_is_calibrated", False) is False for r in jev_results.values())

    # =========================================================================== 3. engine decisions
    completed = executor_quote(task, at=replay_now + 0.2)
    account = account_state(replay_now + 0.2)
    at = replay_now + 0.5

    def decide(quote_mut=None, account_mut=None, when=at, task_obj=None, *, native_mut=None):
        t = task_obj or task
        q = {**completed, **(quote_mut or {})}
        if native_mut is not None:
            q["native_market"] = native_mut
        a = {**account, **(account_mut or {})}
        verdict = assess_live_readiness(t, q, a, now=when, diagnostic_only=True)
        refused = False
        try:
            verify_live_execution_conditions(t, q, a, now=when, diagnostic_only=True)
        except CommonTaskError:
            refused = True
        return {"assess_ready": verdict["execution_ready"], "verify_refused": refused, "blockers": verdict["execution_blockers"]}

    base_decision = decide()
    checks["complete_synthetic_evidence_is_ready"] = base_decision["assess_ready"] is True and base_decision["verify_refused"] is False
    unknown_commission = decide({"commission": None, "live_submit_contract_verified": False, "live_submit_contract_source": None})
    checks["unknown_commission_and_unproven_wire_contract_block"] = (
        unknown_commission["assess_ready"] is False and {"unverified_commission", "unverified_live_submit_wire_contract"} <= set(unknown_commission["blockers"]))
    ttl = report["task"]["ttl_seconds"]
    negatives = {
        "executor_quote_older_than_ttl": decide({"source_ts": at - (ttl + 1)}),
        "executor_quote_exactly_ttl_old": decide({"source_ts": at - ttl}),
        "executor_quote_from_the_future": decide({"source_ts": at + 60}),
        "price_drift": decide({"odds": donor["odds"] + 0.01}),
        "other_selection": decide({"native_selection_id": "10:1:0"}),
        "other_event": decide({"native_event_id": "999000111"}),
        "period_changed": decide({"axes": {**market_axes, "period": "ft"}}),
        "unit_changed": decide({"axes": {**market_axes, "unit": "points"}}),
        "side_changed": decide({"axes": {**market_axes, "side": "over"}}),
        "native_text_is_another_period": decide(native_mut={**native_market, "group_name": "2nd half. Total"}),
        "native_text_missing": decide({"native_market": None}),
        "unknown_account": decide(account_mut={"account_identity_verified": None}),
        "wrong_currency": decide({"currency": "EUR"}),
        "wrong_account_currency": decide(account_mut={"currency": "EUR"}),
        "insufficient_capacity": decide({"max_stake": 0.5}),
        "insufficient_balance": decide(account_mut={"available_balance": 0.5}),
        "stale_task": decide(when=at + 3600),
        "cache_repeat_does_not_extend": decide({"source_ts": completed["source_ts"]}, when=at + ttl + 1),
    }
    report["engine_negatives"] = negatives
    checks["every_engine_negative_refused_and_assess_agrees_with_verify"] = all(
        (not v["assess_ready"]) and v["verify_refused"] for v in negatives.values())
    # prematch: 60 s from the source clock, inside passes, at the edge and beyond is refused
    checks["prematch_ttl_is_sixty_seconds_from_source"] = (
        decide({"source_ts": at - 59.9})["assess_ready"] is True and decide({"source_ts": at - 60.0})["assess_ready"] is False)
    # live: 5 s from the source clock. The recorded frame is prematch and its quotes are minutes old, so the
    # live variant is built from a COPY of the input whose three quote clocks are aligned (labelled below).
    t0 = instant(donor["observed_at"]) if donor.get("source_ts") is None else instant(donor["source_ts"])
    live_pair = copy.deepcopy(pair)
    live_pair["isLive"] = True
    live_outcome = copy.deepcopy(outcome)
    for quote in [live_outcome["reference_quote"], live_outcome["donor_quote"], *live_outcome["margin_quotes"]]:
        quote["source_ts"] = t0
        quote.pop("state_confirmation", None)
    try:
        live_item = {**copy.deepcopy(item), "pair": live_pair, "outcomeData": live_outcome}
        live_task = common_task_from_queue_item(live_item, stake=1.0, stake_currency="USDT", now=t0 + 0.1)
        live_exec = executor_quote(live_task, at=t0 + 0.05)

        def live_decide(when):
            v = assess_live_readiness(live_task, live_exec, account_state(t0 + 0.05), now=when, diagnostic_only=True)
            try:
                verify_live_execution_conditions(live_task, live_exec, account_state(t0 + 0.05), now=when, diagnostic_only=True)
                refused = False
            except CommonTaskError:
                refused = True
            return {"assess_ready": v["execution_ready"], "verify_refused": refused, "blockers": v["execution_blockers"]}
        live_edge = {"at_4_9s": live_decide(t0 + 4.9), "at_5_0s": live_decide(t0 + 5.0), "at_5_2s": live_decide(t0 + 5.2),
                     "input": "copy of the recorded event with isLive=true and the three quote clocks aligned to the donor clock (synthetic variation)"}
        report["live_ttl_edges"] = live_edge
        checks["live_ttl_is_five_seconds_from_source"] = (
            live_edge["at_4_9s"]["assess_ready"] is True and live_edge["at_4_9s"]["verify_refused"] is False
            and live_edge["at_5_0s"]["assess_ready"] is False and live_edge["at_5_0s"]["verify_refused"] is True
            and live_edge["at_5_2s"]["assess_ready"] is False)
    except CommonTaskError as exc:
        report["live_ttl_edges"] = {"error": str(exc)}
        checks["live_ttl_is_five_seconds_from_source"] = False

    # =========================================================================== 4. executor in a real browser
    from types import SimpleNamespace
    clock_start = replay_now + 1.0
    market_name, ui_selection_name = "1st half. Total", "Under 1"

    def build_case(name: str):
        """One queue item -> task -> verified order -> plan, per case: the identity is the item's own."""
        d = work / name
        d.mkdir()
        qfile = str(d / "tasks.json")
        node("queue-add", ["--file", qfile], {"pair": pair, "outcome": outcome, "stake": 1})
        case_item = node("queue-current", ["--file", qfile])["item"]
        case_task = common_task_from_queue_item(case_item, stake=1.0, stake_currency="USDT", now=replay_now)
        case_order = verify_live_execution_conditions(case_task, executor_quote(case_task, at=replay_now + 0.2),
                                                      account_state(replay_now + 0.2), now=replay_now + 0.5, diagnostic_only=True)
        case_plan = cart_plan_from_order(case_order, event_url=f"https://1win.pro/betting/match/sport/{case_order['event_id']}",
                                         market_name=market_name, ui_selection_name=ui_selection_name)
        return SimpleNamespace(qfile=qfile, sfile=str(d / "attempts.json"), item=case_item, task=case_task, order=case_order,
                               plan=case_plan, key=case_task["idempotency_key"], qid=case_item["id"])

    def consume(case, scenario=None, *, plan_obj=None, allow_failure=False, timeout=120, clock=None):
        return node("consume", ["--file", case.qfile], {"plan": plan_obj or case.plan, "store_path": case.sfile,
                                                         "clock_start": clock if clock is not None else clock_start,
                                                         "scenario": scenario or {}}, timeout=timeout, allow_failure=allow_failure)

    def exported(case):
        attempt = node("store-read", ["--store", case.sfile, "--key", case.key])["attempt"]
        return attempt, export_attempt_receipt(attempt, transport_environment="local_stand")

    scenarios = report["scenarios"]

    # 4.1 accepted once, identity everywhere
    case = build_case("accept")
    order, plan = case.order, case.plan
    report["order"] = {"idempotency_key": order["idempotency_key"], "event_id": order["event_id"], "market_id": order["market_id"],
                       "selection_id": order["selection_id"], "odds": order["odds"], "stake": order["stake"], "currency": order["currency"],
                       "purpose": order["purpose"], "correlation": order["correlation"], "source_quotes": order["source_quotes"],
                       "evidence_expiries": order["evidence"]["expiries"], "settlement_facts": order["settlement_facts"],
                       "expires_at": order["expires_at"]}
    checks["order_identity_equals_queue_item_identity"] = (
        order["idempotency_key"] == case.key == plan["idempotency_key"] == queue_item_identity(case.item)
        and order["correlation"]["queue_task_id"] == case.qid)
    run = consume(case)
    att, exp = exported(case)
    body = (run["stand"]["bodies"] or [None])[0] or {}
    scenarios["accept"] = {"result": run["result"], "attempt_status": att["status"], "stand_money_requests": run["stand"]["money_requests"],
                           "request": body, "queue_write_back": run["queue_write_back"], "export": exp}
    checks["accept_single_request_with_exact_identity"] = (
        run["result"]["status"] == "ACCEPTED" and run["stand"]["money_requests"] == 1
        and body.get("oddId") == order["selection_id"] and str(body.get("matchId")) == str(order["event_id"])
        and body.get("amount") == order["stake"] and body.get("currencyCode") == "USDT" and body.get("cf") == order["odds"])
    checks["queue_written_back_and_receipt_export_is_synthetic_pending"] = (
        run["queue_write_back"] is True and exp["synthetic"] is True and exp["settlement"] == "pending"
        and exp["outcome"] == "accepted" and exp["idempotency_key"] == case.key and exp["identity"]["selection_id"] == order["selection_id"])
    checks["purpose_correlation_and_source_quotes_survive_into_the_durable_attempt_and_export"] = (
        att["payload"].get("purpose") == "diagnostic_test" and exp["purpose"] == "diagnostic_test"
        and att["payload"]["correlation"]["queue_task_id"] == case.qid == exp["queue_task_id"]
        and att["payload"]["source_quotes"]["donor"]["odds"] == donor["odds"]
        and att["payload"]["source_quotes"]["donor"]["observed_at"] == donor["observed_at"]
        and exp["source_quotes"]["reference"]["source"] == "BIA")
    checks["transport_guard_coverage_proven_on_the_document_used"] = (
        run["result"]["transport_guard"]["coverage"] is not None and all(run["result"]["transport_guard"]["coverage"].values()))

    # 4.2 replay of the same message / second intent after ACCEPTED, in a fresh process
    replay = consume(case, allow_failure=True)
    other = copy.deepcopy(case.plan)
    other["idempotency_key"] = "another-intent-same-selection"
    second_intent = consume(case, plan_obj=other, allow_failure=True)
    scenarios["replay_same_key_after_accept"] = {"thrown": replay.get("thrown"), "stand_money_requests": replay["stand"]["money_requests"]}
    scenarios["second_intent_same_selection"] = {"thrown": second_intent.get("thrown"), "stand_money_requests": second_intent["stand"]["money_requests"]}
    checks["replay_and_second_intent_send_nothing"] = (
        "DUPLICATE_IDEMPOTENCY_KEY" in str(replay.get("thrown")) and replay["stand"]["money_requests"] == 0
        and "DUPLICATE_SELECTION_ATTEMPT" in str(second_intent.get("thrown")) and second_intent["stand"]["money_requests"] == 0)

    # 4.3 restart after the durable claim, before any request: the process dies, nothing was sent
    case = build_case("crash_after_claim")
    crashed = consume(case, {"crash_after": "PRE_CHECK_PASSED"}, allow_failure=True)
    survived = node("store-read", ["--store", case.sfile, "--key", case.key])["attempt"]
    rerun = consume(case, allow_failure=True)
    scenarios["restart_after_durable_claim_before_send"] = {"first_run_returncode": crashed["_returncode"], "attempt_after_crash": survived["status"],
                                                           "rerun_thrown": rerun.get("thrown"), "rerun_stand_money_requests": rerun["stand"]["money_requests"]}
    checks["restart_after_claim_never_sends"] = (crashed["_returncode"] != 0 and survived["status"] == "PRE_CHECK_PASSED"
                                                 and "DUPLICATE_IDEMPOTENCY_KEY" in str(rerun.get("thrown")) and rerun["stand"]["money_requests"] == 0)

    # 4.4 crash after the request reached the bookmaker: outcome unknown, restart never re-sends
    case = build_case("crash_after_send")
    crashed = consume(case, {"crash_when_stand_receives": True}, allow_failure=True)
    survived = node("store-read", ["--store", case.sfile, "--key", case.key])["attempt"]
    rerun = consume(case, allow_failure=True)
    scenarios["crash_after_request_reached_bookmaker"] = {"first_run_returncode": crashed["_returncode"], "attempt_after_crash": survived["status"],
                                                          "rerun_thrown": rerun.get("thrown"), "rerun_stand_money_requests": rerun["stand"]["money_requests"]}
    checks["crash_after_send_leaves_submitting_and_rerun_refuses"] = (
        crashed["_returncode"] != 0 and survived["status"] == "SUBMITTING"
        and "DUPLICATE_IDEMPOTENCY_KEY" in str(rerun.get("thrown")) and rerun["stand"]["money_requests"] == 0)

    # 4.5 unclear result by timeout: INDETERMINATE, no second request, reconcile from history by identity
    if not args.skip_slow:
        case = build_case("timeout")
        slow = consume(case, {"delay_ms": 18000}, timeout=150)
        history = slow["stand"]["history"] or []
        sent_key = (slow["stand"]["bodies"] or [{}])[0].get("idempotencyKey")
        found = [h for h in history if h.get("idempotencyKey") == sent_key and h.get("oddId") == case.order["selection_id"]]
        again = consume(case, allow_failure=True)
        if found:
            node("reconcile", [], {"store_path": case.sfile, "key": case.key, "kind": "receipt_reconciled",
                                   "data": {"bet_id": found[0]["betId"], "source": "stand-history-by-idempotencyKey"}})
        att, exp = exported(case)
        scenarios["timeout_unclear_result"] = {"status": slow["result"]["status"], "attempt_status_before_reconcile": slow["attempt"]["status"],
                                               "stand_money_requests": slow["stand"]["money_requests"], "history_matches": len(found),
                                               "second_run_thrown": again.get("thrown"), "second_run_requests": again["stand"]["money_requests"], "export": exp}
        checks["timeout_unclear_result_is_indeterminate_reconciled_without_second_send"] = (
            slow["result"]["status"] == "INDETERMINATE" and slow["stand"]["money_requests"] == 1 and len(found) == 1
            and "DUPLICATE_IDEMPOTENCY_KEY" in str(again.get("thrown")) and again["stand"]["money_requests"] == 0
            and exp["outcome"] == "accepted_reconciled" and exp["unresolved"] is False and exp["synthetic"] is True)

    # 4.6 cancelled / withdrawn / expired
    case = build_case("cancelled_before_consume")
    cancelled = node("queue-cancel", ["--file", case.qfile, "--id", str(case.qid)])
    run = consume(case, allow_failure=True)
    scenarios["cancelled_in_queue_before_execution"] = {"cancel": {"cancelled": cancelled["result"].get("cancelled")}, "thrown": run.get("thrown"),
                                                        "result_status": (run.get("result") or {}).get("status"),
                                                        "stand_money_requests": run["stand"]["money_requests"],
                                                        "attempt_status": (run.get("attempt") or {}).get("status")}
    checks["task_cancelled_in_queue_is_not_executed"] = (
        cancelled["result"].get("cancelled") is True and run["stand"]["money_requests"] == 0
        and (run.get("attempt") or {}).get("status") in ("WITHDRAWN", None)
        and ((run.get("result") or {}).get("status") == "ABORTED_PRE_SUBMIT" or bool(run.get("thrown"))))

    for name, scn in (("withdrawn_after_submitting_record", {"withdraw_after": "SUBMITTING"}),
                      ("expired_between_submitting_record_and_post", {"clock_jump_after": "SUBMITTING", "clock_jump_seconds": 3600})):
        case = build_case(name)
        run = consume(case, scn)
        scenarios[name] = {"status": run["result"]["status"], "attempt_status": run["attempt"]["status"],
                           "stand_money_requests": run["stand"]["money_requests"], "blocked_reasons": run["result"]["blocked_reasons"],
                           "not_sent_reason": (run["attempt"]["not_sent_proof"] or {}).get("reason")}
        checks[f"{name}_forwards_nothing"] = (run["stand"]["money_requests"] == 0 and run["attempt"]["status"] == "WITHDRAWN"
                                              and run["result"]["status"] == "ABORTED_PRE_SUBMIT")
    case = build_case("expired_plan")
    run = consume(case, allow_failure=True, clock=case.order["expires_at"] + 1)
    scenarios["expired_plan_at_start"] = {"thrown": run.get("thrown"), "stand_money_requests": run["stand"]["money_requests"]}
    checks["expired_plan_is_refused_before_any_claim"] = (
        ("TASK_EXPIRED" in str(run.get("thrown")) or "EVIDENCE_EXPIRED" in str(run.get("thrown"))) and run["stand"]["money_requests"] == 0
        and run.get("attempt") is None)

    # 4.7 board price drift and bookmaker answers
    case = build_case("price_drift_on_board")
    run = consume(case, {"board_price": case.plan["selection"]["price"] + 0.3})
    scenarios["price_drift_on_board"] = {"status": run["result"]["status"], "error": run["result"]["error"], "attempt_status": run["attempt"]["status"],
                                         "stand_money_requests": run["stand"]["money_requests"]}
    checks["board_price_drift_forwards_nothing"] = run["stand"]["money_requests"] == 0 and run["attempt"]["status"] == "WITHDRAWN"
    answers = {
        "bookmaker_rejects_odd_cf_changed": ({"result": {"error": {"code": "odd_cf_changed"}}}, "REJECTED"),
        "bookmaker_rejects_min_bet_amount_v2": ({"result": {"error": {"code": "min_bet_amount_v2"}}}, "REJECTED"),
        "bookmaker_unknown_answer": ({"result": {"error": {"code": "something_new"}}}, "INDETERMINATE"),
        "bookmaker_unauthenticated": ({"errors": [{"code": "unauthenticated_error"}]}, "INDETERMINATE"),
    }
    for name, (answer, expected) in answers.items():
        case = build_case(name)
        run = consume(case, {"answer": answer})
        att, exp = exported(case)
        scenarios[name] = {"status": run["result"]["status"], "attempt_status": att["status"], "stand_money_requests": run["stand"]["money_requests"],
                           "export_outcome": exp["outcome"], "export_unresolved": exp["unresolved"], "queue_write_back": run["queue_write_back"]}
        checks[f"{name}_is_{expected.lower()}_with_one_request"] = (
            run["result"]["status"] == expected and att["status"] == expected and run["stand"]["money_requests"] == 1 and exp["synthetic"] is True)

    report["elapsed_seconds"] = round(time.time() - started, 1)
    flat = {k: v for k, v in checks.items() if isinstance(v, bool)}
    report["summary"] = {"checks_total": len(flat), "checks_true": sum(flat.values()), "failed": [k for k, v in flat.items() if not v]}
    Path(args.out).write_text(json.dumps(report, indent=2, default=str) + "\n")
    print(json.dumps(report["summary"], indent=2))
    return 0 if not report["summary"]["failed"] else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
