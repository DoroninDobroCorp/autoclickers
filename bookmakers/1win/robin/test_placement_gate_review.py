"""The Python placement gate must not be a second, weaker permission path."""
from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path

from onewin_automation.common import DurableAttemptStore
from onewin_automation.config import OneWinAutomationConfig
from onewin_automation.placement import (
    BasketValidationError,
    PlacementGate,
)

ORDER = {
    "schema_version": "automation-live-order.v1", "live": True, "execution_ready": True, "execution_blockers": [],
    "idempotency_key": "gate-order-1", "event_id": "40021999", "market_id": "6271",
    "selection_id": "10:193671744120169820:0", "odds": 1.87, "stake": 1.0, "currency": "USDT",
    "expires_at": 1005.0,
}


class Clock:
    def __init__(self, value):
        self.value = value

    def __call__(self):
        return self.value


class DiagnosticGateNeedsAVerifiedOrder(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = DurableAttemptStore(Path(self.tmp.name) / "attempts.sqlite", max_stake=1.0)
        self.calls = []

        async def transport(payload):
            self.calls.append(payload)
            return {"ok": True, "status": "ACCEPTED", "receipt_id": "synthetic-1", "amount": payload["stake"],
                    "currency": payload["currency"], "accepted_odds": payload.get("expected_odds") or payload.get("odds")}
        self.transport = transport

    async def asyncTearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def gate(self, clock=None):
        kwargs = {"clock": clock} if clock is not None else {}
        return PlacementGate.for_diagnostic_test(transport=self.transport, attempt_store=self.store,
                                                 config=OneWinAutomationConfig(live_enabled=True, max_stake=1.0), **kwargs)

    def payload(self, **over):
        value = {"idempotency_key": "gate-order-1", "stake": 1.0, "currency": "USDT", "event_id": "40021999",
                 "market_id": "6271", "selection_id": "10:193671744120169820:0", "expected_odds": 1.87,
                 "order": copy.deepcopy(ORDER)}
        value.update(over)
        return value

    async def test_payload_without_order_is_refused_and_nothing_is_sent(self):
        payload = self.payload()
        del payload["order"]
        with self.assertRaises(BasketValidationError):
            await self.gate().place(payload)   # the reviewed bypass: no order at all
        self.assertEqual(self.calls, [], "diagnostic gate sent a bet without a verified order")
        self.assertIsNone(self.store.get_attempt("gate-order-1"))

    async def test_verified_order_is_accepted_once(self):
        result = await self.gate(Clock(1001.0)).place(self.payload())
        self.assertEqual(result["receipt_id"], "synthetic-1")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.store.get_attempt("gate-order-1")["status"], "ACCEPTED")

    async def test_order_that_disagrees_with_the_payload_is_refused(self):
        cases = [
            ("stake", {"order": {**ORDER, "stake": 0.5}}),
            ("key", {"order": {**ORDER, "idempotency_key": "other"}}),
            ("selection", {"order": {**ORDER, "selection_id": "10:1:0"}}),
            ("event", {"order": {**ORDER, "event_id": "1"}}),
            ("odds", {"order": {**ORDER, "odds": 2.0}}),
            ("currency", {"order": {**ORDER, "currency": "EUR"}}),
            ("not ready", {"order": {**ORDER, "execution_ready": False}}),
            ("blockers", {"order": {**ORDER, "execution_blockers": ["unverified_commission"]}}),
            ("schema", {"order": {**ORDER, "schema_version": "automation-task.v1"}}),
            ("expired", {"order": {**ORDER, "expires_at": 1000.5}}),
            ("not an object", {"order": "yes"}),
        ]
        for name, over in cases:
            with self.subTest(case=name):
                with self.assertRaises(BasketValidationError):
                    await self.gate(Clock(1001.0)).place(self.payload(**over))
        self.assertEqual(self.calls, [])

    async def test_expiry_after_the_submitting_record_sends_nothing(self):
        clock = Clock(1001.0)
        real = self.store.record_status

        def hook(key, status, **kw):
            result = real(key, status, **kw)
            if status == "SUBMITTING":
                clock.value = 1006.0  # evidence expires between the record and the transport
            return result
        self.store.record_status = hook
        with self.assertRaises(BasketValidationError):
            await self.gate(clock).place(self.payload())
        self.store.record_status = real
        self.assertEqual(self.calls, [])
        attempt = self.store.get_attempt("gate-order-1")
        self.assertEqual(attempt["status"], "WITHDRAWN")
        self.assertIn("EXPIRED", attempt["error"].upper())

    async def test_legacy_gate_without_the_option_keeps_its_behaviour(self):
        legacy = PlacementGate(enabled=True, config=OneWinAutomationConfig(live_enabled=True, max_stake=5.0),
                               transport=self.transport, attempt_store=self.store, max_stake=5.0)
        payload = self.payload()
        del payload["order"]
        result = await legacy.place(payload)
        self.assertEqual(result["receipt_id"], "synthetic-1")


if __name__ == "__main__":
    unittest.main()
