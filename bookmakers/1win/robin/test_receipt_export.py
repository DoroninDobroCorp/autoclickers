import unittest

from onewin_automation.receipt_export import ReceiptExportError, export_attempt_receipt


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
        out = export_attempt_receipt(entry(), transport_environment="local_stand", queue_task_id=7)
        self.assertEqual(out["outcome"], "accepted")
        self.assertTrue(out["synthetic"])
        self.assertEqual(out["settlement"], "pending")
        self.assertEqual(out["financial_result"], "not_recorded")
        self.assertEqual(out["bookmaker_receipt"]["bet_id"], "STAND-1")
        self.assertNotIn("roi", str(out).lower())
        self.assertEqual(out["timestamps"]["created_at_utc"], "2026-09-21T14:13:20.000Z")

    def test_production_receipt_is_synthetic_only_when_the_id_says_so(self):
        real = export_attempt_receipt(entry(receipt={"bet_id": 9876543, "accepted_cf": 1.87, "amount": 1, "currency": "USDT"}),
                                      transport_environment="production")
        self.assertFalse(real["synthetic"])
        self.assertEqual(real["bookmaker_receipt"]["bet_id"], "9876543")
        marked = export_attempt_receipt(entry(), transport_environment="production")
        self.assertTrue(marked["synthetic"], "an id with a synthetic marker stays synthetic even in production")

    def test_unresolved_and_rejected_and_not_sent(self):
        for status, outcome, unresolved in (("INDETERMINATE", "unknown_reconcile_required", True), ("SUBMITTING", "in_flight_or_crashed", True),
                                            ("CLAIMED", "in_flight_or_crashed", True), ("WITHDRAWN", "not_sent", False)):
            out = export_attempt_receipt(entry(status=status, receipt=None), transport_environment="local_stand")
            self.assertEqual((out["outcome"], out["unresolved"], out["bookmaker_receipt"]), (outcome, unresolved, None))
        rejected = export_attempt_receipt(entry(status="REJECTED", error="odd_cf_changed", receipt=None), transport_environment="local_stand")
        self.assertEqual((rejected["outcome"], rejected["rejection_code"], rejected["unresolved"]), ("rejected", "odd_cf_changed", False))

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

    def test_refuses_malformed_entries_and_unstated_environment(self):
        for bad in (None, {}, entry(status="DONE"), entry(key=" "), entry(receipt=None)):
            with self.assertRaises(ReceiptExportError):
                export_attempt_receipt(bad, transport_environment="local_stand")
        with self.assertRaises(ReceiptExportError):
            export_attempt_receipt(entry(), transport_environment="unknown")


if __name__ == "__main__":
    unittest.main()
