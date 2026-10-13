"""Review regressions for the Python durable attempt store (task 3 follow-up)."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import unittest

from onewin_automation.common import CommonTaskError, DurableAttemptStore
from onewin_automation.config import OneWinAutomationConfig
from onewin_automation.placement import BasketValidationError, PlacementGate, PlacementIndeterminate

HERE = Path(__file__).resolve().parent
PAYLOAD = {"idempotency_key": "k", "stake": 1.0, "currency": "USDT", "event_id": "1", "market_id": "2",
           "selection_id": "10:1:0", "expected_odds": 1.87}


class SealedTerminalRecords(unittest.TestCase):
    def store(self, directory):
        store = DurableAttemptStore(Path(directory) / "attempts.sqlite")
        self.assertTrue(store.claim("k", stake=1.0, currency="USDT", payload=PAYLOAD, now=1000))
        store.record_status("k", "SUBMITTING", now=1001)
        return store

    def test_second_accepted_cannot_replace_receipt(self):
        with tempfile.TemporaryDirectory() as d:
            store = self.store(d)
            store.record_status("k", "ACCEPTED", receipt={"bet_id": "first"}, now=1002)
            with self.assertRaises(CommonTaskError):
                store.record_status("k", "ACCEPTED", receipt={"bet_id": "changed"}, now=1003)
            self.assertEqual(store.get_attempt("k")["receipt"]["bet_id"], "first")
            store.close()

    def test_identical_terminal_repeat_is_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            store = self.store(d)
            store.record_status("k", "ACCEPTED", receipt={"bet_id": "first"}, now=1002)
            before = store.get_attempt("k")
            self.assertEqual(store.record_status("k", "ACCEPTED", receipt={"bet_id": "first"}, now=1009), "ACCEPTED")
            self.assertEqual(store.get_attempt("k"), before)
            store.close()

    def test_terminal_error_text_is_sealed(self):
        with tempfile.TemporaryDirectory() as d:
            store = self.store(d)
            store.record_status("k", "REJECTED", receipt={"errors": [{"code": "x"}]}, error="x", now=1002)
            with self.assertRaises(CommonTaskError):
                store.record_status("k", "REJECTED", receipt={"errors": [{"code": "x"}]}, error="y", now=1003)
            self.assertEqual(store.get_attempt("k")["error"], "x")
            store.close()

    def test_accepted_requires_receipt_identifier(self):
        with tempfile.TemporaryDirectory() as d:
            store = self.store(d)
            for receipt in (None, {}, {"amount": 1}, {"bet_id": ""}):
                with self.subTest(receipt=receipt):
                    with self.assertRaises(CommonTaskError):
                        store.record_status("k", "ACCEPTED", receipt=receipt, now=1002)
            self.assertEqual(store.get_attempt("k")["status"], "SUBMITTING")
            store.close()

    def test_phase_order_is_enforced(self):
        with tempfile.TemporaryDirectory() as d:
            store = DurableAttemptStore(Path(d) / "attempts.sqlite")
            store.claim("k", stake=1.0, currency="USDT", payload=PAYLOAD, now=1000)
            with self.assertRaises(CommonTaskError):  # cannot accept without submitting
                store.record_status("k", "ACCEPTED", receipt={"bet_id": "x"}, now=1001)
            store.record_status("k", "SUBMITTING", now=1002)
            with self.assertRaises(CommonTaskError):  # no way back
                store.record_status("k", "CLAIMED", now=1003)
            with self.assertRaises(CommonTaskError):  # potential submit cannot be 'withdrawn'
                store.record_status("k", "WITHDRAWN", error="cancel", now=1004)
            store.close()

    def test_database_refuses_to_rewrite_a_sealed_row_even_for_other_writers(self):
        with tempfile.TemporaryDirectory() as d:
            store = self.store(d)
            store.record_status("k", "ACCEPTED", receipt={"bet_id": "first"}, now=1002)
            store.close()
            db = sqlite3.connect(str(Path(d) / "attempts.sqlite"))
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("UPDATE attempts SET receipt='{\"bet_id\":\"forged\"}' WHERE key='k'")
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("UPDATE attempts SET stake=99 WHERE key='k'")
            db.close()

    def test_restart_does_not_revive_terminal_attempt(self):
        with tempfile.TemporaryDirectory() as d:
            store = self.store(d)
            store.record_status("k", "INDETERMINATE", error="timeout", now=1002)
            store.close()
            reopened = DurableAttemptStore(Path(d) / "attempts.sqlite")
            self.assertFalse(reopened.claim("k", stake=1.0, currency="USDT", payload=PAYLOAD, now=1003))
            with self.assertRaises(CommonTaskError):
                reopened.record_status("k", "SUBMITTING", now=1004)
            self.assertEqual(reopened.get_attempt("k")["status"], "INDETERMINATE")
            reopened.close()

    def test_audit_revision_never_changes_the_sealed_attempt(self):
        with tempfile.TemporaryDirectory() as d:
            store = self.store(d)
            store.record_status("k", "INDETERMINATE", error="timeout", now=1002)
            def core(attempt):
                return {k: v for k, v in attempt.items() if k != "revisions"}
            sealed = store.get_attempt("k")
            store.add_revision("k", kind="receipt_reconciliation",
                               data={"found_bet_id": "later-123", "source": "history"}, now=1010)
            after = store.get_attempt("k")
            self.assertEqual(core(after), core(sealed))
            self.assertEqual(len(after["revisions"]), 1)
            self.assertEqual(after["revisions"][0]["data"]["found_bet_id"], "later-123")
            self.assertEqual(after["status"], "INDETERMINATE")
            with self.assertRaises(CommonTaskError):
                store.add_revision("missing", kind="x", data={"a": 1}, now=1011)
            store.close()


def drop_all_triggers(db):
    """Simulate an external writer that bypassed the seals (the store must still notice)."""
    for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='trigger'").fetchall():
        db.execute(f'DROP TRIGGER "{name}"')


class PersistedContentValidation(unittest.TestCase):
    def seeded_db(self, d, **override):
        path = Path(d) / "attempts.sqlite"
        store = DurableAttemptStore(path)
        store.claim("k", stake=1.0, currency="USDT", payload=PAYLOAD, now=1000)
        store.close()
        if override:
            db = sqlite3.connect(str(path), isolation_level=None)
            drop_all_triggers(db)
            for column, value in override.items():
                db.execute(f"UPDATE attempts SET {column}=? WHERE key='k'", (value,))
            db.close()
        return path

    def test_corrupt_rows_fail_closed_without_rewrite(self):
        cases = {
            "unknown status": {"status": "MAYBE"},
            "zero stake": {"stake": 0},
            "negative stake": {"stake": -1},
            "bad currency": {"currency": "usd"},
            "payload not json": {"payload": "{not json"},
            "payload not object": {"payload": "[1]"},
            "accepted without receipt": {"status": "ACCEPTED", "receipt": None},
            "receipt not json": {"status": "ACCEPTED", "receipt": "{bad"},
            "receipt without id": {"status": "ACCEPTED", "receipt": "{\"amount\":1}"},
            "clock order": {"updated_at": 1},
            "payload stake mismatch": {"payload": json.dumps({**PAYLOAD, "stake": 2.0})},
        }
        for name, override in cases.items():
            with self.subTest(case=name), tempfile.TemporaryDirectory() as d:
                path = self.seeded_db(d, **override)
                before = path.read_bytes()
                with self.assertRaises(CommonTaskError):
                    DurableAttemptStore(path)
                self.assertEqual(path.read_bytes(), before)

    def test_corrupt_row_is_not_returned_as_attempt(self):
        with tempfile.TemporaryDirectory() as d:
            path = self.seeded_db(d)
            store = DurableAttemptStore(path)
            drop_all_triggers(store._db)
            store._db.execute("UPDATE attempts SET status='MAYBE' WHERE key='k'")
            with self.assertRaises(CommonTaskError):
                store.get_attempt("k")
            with self.assertRaises(CommonTaskError):
                store.claim("k", stake=1.0, currency="USDT", payload=PAYLOAD, now=1001)
            store.close()


class ProcessLevel(unittest.TestCase):
    SCRIPT = textwrap.dedent("""
        import json, os, sys
        sys.path.insert(0, sys.argv[1])
        from onewin_automation.common import DurableAttemptStore, CommonTaskError
        mode, path = sys.argv[2], sys.argv[3]
        payload = {"idempotency_key": "race", "stake": 1.0, "currency": "USDT", "event_id": "1",
                   "market_id": "2", "selection_id": "10:1:0", "expected_odds": 1.87}
        store = DurableAttemptStore(path)
        if mode == "claim":
            print(json.dumps({"claimed": store.claim("race", stake=1.0, currency="USDT", payload=payload, now=1000)}))
        elif mode == "crash":
            store.claim("race", stake=1.0, currency="USDT", payload=payload, now=1000)
            store.record_status("race", "SUBMITTING", now=1001)
            os._exit(9)
        else:
            try:
                store.record_status("race", "ACCEPTED", receipt={"bet_id": mode}, now=1002)
                print(json.dumps({"outcome": "recorded"}))
            except CommonTaskError as exc:
                print(json.dumps({"outcome": str(exc)}))
    """)

    def run_children(self, path, modes):
        procs = [subprocess.Popen([sys.executable, "-c", self.SCRIPT, str(HERE), mode, str(path)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for mode in modes]
        results = []
        for proc in procs:
            out, err = proc.communicate(timeout=60)
            results.append((proc.returncode, out.strip(), err.strip()))
        return results

    def test_concurrent_processes_one_claim(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "attempts.sqlite"
            DurableAttemptStore(path).close()
            results = self.run_children(path, ["claim"] * 6)
            for code, _, err in results:
                self.assertEqual(code, 0, err)
            self.assertEqual(sum(json.loads(out)["claimed"] for _, out, _ in results), 1)

    def test_crash_after_submitting_blocks_repeat_and_withdrawal(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "attempts.sqlite"
            code, _, _ = self.run_children(path, ["crash"])[0]
            self.assertEqual(code, 9)
            store = DurableAttemptStore(path)
            self.assertEqual(store.get_attempt("race")["status"], "SUBMITTING")
            self.assertFalse(store.claim("race", stake=1.0, currency="USDT", payload={**PAYLOAD, "idempotency_key": "race"}, now=1005))
            with self.assertRaises(CommonTaskError):
                store.record_status("race", "WITHDRAWN", error="restart", now=1006)
            store.record_status("race", "INDETERMINATE", error="restart_recovery", now=1007)
            store.close()

    def test_conflicting_terminal_receipts_across_processes(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "attempts.sqlite"
            store = DurableAttemptStore(path)
            store.claim("race", stake=1.0, currency="USDT", payload={**PAYLOAD, "idempotency_key": "race"}, now=1000)
            store.record_status("race", "SUBMITTING", now=1001)
            store.close()
            results = self.run_children(path, ["A", "B"])
            outcomes = [json.loads(out)["outcome"] for _, out, _ in results]
            self.assertEqual(outcomes.count("recorded"), 1, outcomes)
            final = DurableAttemptStore(path).get_attempt("race")
            self.assertIn(final["receipt"]["bet_id"], {"A", "B"})


class RecordFailureAfterAcceptance(unittest.IsolatedAsyncioTestCase):
    async def test_accepted_receipt_is_not_lost_when_recording_fails(self):
        with tempfile.TemporaryDirectory() as d:
            store = DurableAttemptStore(Path(d) / "attempts.sqlite")
            real = store.record_status

            def failing(key, status, **kw):
                if status == "ACCEPTED":
                    raise sqlite3.OperationalError("disk I/O error")
                return real(key, status, **kw)
            store.record_status = failing

            async def transport(payload):
                return {"ok": True, "status": "ACCEPTED", "receipt_id": "rcpt-77", "amount": payload["stake"]}

            gate = PlacementGate(enabled=True, config=OneWinAutomationConfig(live_enabled=True, max_stake=5.0),
                                 transport=transport, attempt_store=store, max_stake=5.0, require_verified_order=False)
            with self.assertRaises(Exception) as ctx:
                await gate.place({"idempotency_key": "gate-record-fail", "stake": 1.0, "currency": "USDT"})
            receipt = getattr(ctx.exception, "receipt", None)
            self.assertIsNotNone(receipt, "the accepted receipt must travel with the failure")
            self.assertEqual(receipt["receipt_id"], "rcpt-77")
            self.assertNotIsInstance(ctx.exception, BasketValidationError)
            # no second bet is possible under the same key
            store.record_status = real
            with self.assertRaises(BasketValidationError):
                await gate.place({"idempotency_key": "gate-record-fail", "stake": 1.0, "currency": "USDT"})
            store.close()


if __name__ == "__main__":
    unittest.main()
