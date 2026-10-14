import unittest

from onewin_automation.receipt_export import ReceiptExportError, export_attempt_receipt


def provenance(env="production", synthetic=False, source="first-party-readonly"):
    return {"executor_provenance": {"transport_environment": env, "contract": "automation-executor.v1",
                                    "guard_version": "onewin-transport-guard.v2", "bet_api_origins": ["https://api-gateway.top-parser.com"]},
            "provenance": {"synthetic": synthetic, "evidence_source": source}}


def entry(**kw):
    base = {"key": "k-1", "status": "ACCEPTED", "stake": 1.0, "currency": "USDT", "event_id": "40021999", "market_id": "6271",
            "selection_id": "10:193671744120169820:0", "expected_odds": 1.87, "error": None,
            "created_at": 1790000000000, "updated_at": 1790000001500,
            "receipt": {"bet_id": "STAND-1", "accepted_cf": 1.87, "amount": 1, "currency": "USDT",
                        "possible_profit_amount": 1.87, "rejected_amount": 0, "condition_mismatches": []}}
    base.update(kw)
    return base


class ReceiptExportTest(unittest.TestCase):
    def test_accepted_stand_receipt_is_synthetic_pending_and_valueless(self):
        out = export_attempt_receipt(entry(payload=provenance("local_stand", True)), queue_task_id=7)
        self.assertEqual(out["outcome"], "accepted")
        self.assertTrue(out["synthetic"])
        self.assertEqual(out["transport_environment"], "local_stand")
        self.assertEqual(out["settlement"], "pending")
        self.assertEqual(out["financial_result"], "not_recorded")
        self.assertEqual(out["bookmaker_receipt"]["bet_id"], "STAND-1")
        self.assertNotIn("roi", str(out).lower())
        self.assertEqual(out["timestamps"]["created_at_utc"], "2026-09-21T14:13:20.000Z")

    def test_only_an_attempt_stamped_production_with_real_evidence_exports_as_real(self):
        receipt = {"bet_id": 9876543, "accepted_cf": 1.87, "amount": 1, "currency": "USDT"}
        real = export_attempt_receipt(entry(receipt=receipt, payload=provenance("production", False)), transport_environment="production")
        self.assertFalse(real["synthetic"])
        self.assertTrue(real["provenance"]["verified_from_attempt"])
        self.assertEqual(real["bookmaker_receipt"]["bet_id"], "9876543")
        self.assertEqual(real["provenance"]["synthetic_reasons"], [])

    def test_a_production_label_of_the_caller_never_makes_a_synthetic_result_real(self):
        receipt = {"bet_id": 9876543, "accepted_cf": 1.87, "amount": 1, "currency": "USDT"}   # an ordinary numeric id
        for payload, reason in ((provenance("local_stand", True), "executor_environment_local_stand"),
                                (provenance("production", True), "order_evidence_synthetic"),
                                ({}, "executor_environment_not_recorded_in_attempt"),
                                ({"executor_provenance": {"transport_environment": "production"}}, "order_synthetic_flag_not_recorded")):
            out = export_attempt_receipt(entry(receipt=receipt, payload=payload), transport_environment="production")
            self.assertTrue(out["synthetic"], payload)
            self.assertIn(reason, out["provenance"]["synthetic_reasons"])
        stand = export_attempt_receipt(entry(receipt=receipt, payload=provenance("local_stand", True)), transport_environment="production")
        self.assertTrue(stand["provenance"]["label_conflict"])
        self.assertEqual(stand["transport_environment"], "local_stand")
        legacy = export_attempt_receipt(entry(receipt=receipt), transport_environment="production")
        self.assertEqual((legacy["transport_environment"], legacy["synthetic"]), ("unverified", True))

    def test_a_cautious_caller_label_and_a_marked_bet_id_keep_a_record_synthetic(self):
        receipt = {"bet_id": 9876543, "accepted_cf": 1.87, "amount": 1, "currency": "USDT"}
        out = export_attempt_receipt(entry(receipt=receipt, payload=provenance("production", False)), transport_environment="local_stand")
        self.assertTrue(out["synthetic"])
        marked = export_attempt_receipt(entry(payload=provenance("production", False)))
        self.assertTrue(marked["synthetic"])
        self.assertIn("bet_id_carries_synthetic_marker", marked["provenance"]["synthetic_reasons"])

    def test_native_idempotency_key_is_exported_for_reconciliation_by_identity(self):
        out = export_attempt_receipt(entry(status="INDETERMINATE", receipt=None, payload=provenance("local_stand", True),
                                           native_request={"idempotency_key": "page-uuid-1", "body_sha256": "a" * 64, "recorded_at": 1}))
        self.assertEqual(out["identity"]["native_idempotency_key"], "page-uuid-1")
        self.assertEqual(out["identity"]["native_body_sha256"], "a" * 64)
        self.assertTrue(out["unresolved"])
        none = export_attempt_receipt(entry(status="WITHDRAWN", receipt=None, payload=provenance("local_stand", True)))
        self.assertIsNone(none["identity"]["native_idempotency_key"])

    def test_export_is_repeatable_and_does_not_mutate_the_attempt(self):
        import copy
        source = entry(payload=provenance("local_stand", True))
        before = copy.deepcopy(source)
        self.assertEqual(export_attempt_receipt(source, queue_task_id=1), export_attempt_receipt(source, queue_task_id=1))
        self.assertEqual(source, before)

    def test_unresolved_and_rejected_and_not_sent(self):
        for status, outcome, unresolved in (("INDETERMINATE", "unknown_reconcile_required", True), ("SUBMITTING", "in_flight_or_crashed", True),
                                            ("CLAIMED", "in_flight_or_crashed", True), ("WITHDRAWN", "not_sent", False)):
            out = export_attempt_receipt(entry(status=status, receipt=None), transport_environment="local_stand")
            self.assertEqual((out["outcome"], out["unresolved"], out["bookmaker_receipt"]), (outcome, unresolved, None))
        rejected = export_attempt_receipt(entry(status="REJECTED", error="odd_cf_changed", receipt=None), transport_environment="local_stand")
        self.assertEqual((rejected["outcome"], rejected["rejection_code"], rejected["unresolved"]), ("rejected", "odd_cf_changed", False))

    def test_purpose_correlation_and_source_quotes_come_from_the_attempt_payload(self):
        payload = {"idempotency_key": "k-1", "purpose": "diagnostic_test", "correlation": {"queue_task_id": 42, "task_idempotency_key": "k-1"},
                   "source_quotes": {"donor": {"odds": 1.87, "source_ts": 1790000000.0}, "reference": None, "margins": []}}
        out = export_attempt_receipt(entry(payload=payload), transport_environment="local_stand")
        self.assertEqual((out["purpose"], out["queue_task_id"]), ("diagnostic_test", 42))
        self.assertEqual(out["source_quotes"]["donor"]["odds"], 1.87)
        none = export_attempt_receipt(entry(payload={"purpose": "anything"}), transport_environment="local_stand")
        self.assertIsNone(none["purpose"])

    def test_indeterminate_attempt_reconciled_against_history(self):
        placed = export_attempt_receipt(entry(status="INDETERMINATE", receipt=None, revisions=[
            {"seq": 1, "kind": "receipt_reconciled", "data": {"bet_id": "STAND-3", "source": "history"}, "created_at": 1}]),
            transport_environment="local_stand")
        self.assertEqual((placed["outcome"], placed["unresolved"], placed["bookmaker_receipt"]["bet_id"]), ("accepted_reconciled", False, "STAND-3"))
        self.assertTrue(placed["bookmaker_receipt"]["from_history_reconciliation"])
        not_placed = export_attempt_receipt(entry(status="INDETERMINATE", receipt=None, revisions=[
            {"seq": 1, "kind": "reconciled_not_placed", "data": {"operator": "op", "evidence": "history-2026-10-13"}, "created_at": 1}]),
            transport_environment="local_stand")
        self.assertEqual((not_placed["outcome"], not_placed["unresolved"]), ("not_placed_reconciled", False))
        still = export_attempt_receipt(entry(status="INDETERMINATE", receipt=None, revisions=[]), transport_environment="local_stand")
        self.assertEqual((still["outcome"], still["unresolved"]), ("unknown_reconcile_required", True))

    def test_refuses_malformed_entries_and_unknown_label(self):
        for bad in (None, {}, entry(status="DONE"), entry(key=" "), entry(receipt=None)):
            with self.assertRaises(ReceiptExportError):
                export_attempt_receipt(bad, transport_environment="local_stand")
        with self.assertRaises(ReceiptExportError):
            export_attempt_receipt(entry(), transport_environment="unknown")
        # no label at all is fine: the environment comes from the attempt
        self.assertEqual(export_attempt_receipt(entry())["transport_environment"], "unverified")


if __name__ == "__main__":
    unittest.main()
