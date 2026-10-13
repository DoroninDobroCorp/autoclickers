import tempfile
import unittest
from onewin_automation.common import (
    CommonTaskError,
    DurableAttemptStore,
    DurableDryRunStore,
    assess_live_readiness,
    task_from_value,
    verify_executor_quote,
    verify_live_execution_conditions,
)
from onewin_automation.config import OneWinAutomationConfig
from onewin_automation.placement import (
    BasketValidationError,
    LegacyPlacementGateAdapter,
    LivePlacementDisabled,
    PlacementGate,
    PlacementIndeterminate,
    PlacementRejected,
)

class CommonTaskTests(unittest.TestCase):
 def task(self,**basis):
  q={'source':'1win','source_event_key':'d','source_market':'T> 2.5','odds':2.2,'source_ts':1000}
  r={**q,'source':'BIA','source_event_key':'r','odds':2}
  return task_from_value({'event_id':'canonical','isLive':True,'first':{'bookmaker':'BIA','matchId':'r'},'second':{'bookmaker':'1win','matchId':'d'}},{**basis,'outcome':'T> 2.5','score1':{'value':2},'score2':{'value':2.2},'reference_quote':r,'donor_quote':q,'margin_quotes':[r]},stake=10,idempotency_key='key',now=1001)

 def test_bia_identity_and_expiration_preserved(self):
  task=self.task()
  self.assertEqual(task['expires_at'],1005)
  self.assertFalse(task['pinnacle_attributed'])
  self.assertFalse(task['execution_ready'])

 def test_duplicate_and_withdrawal_survive_process_restart(self):
  with tempfile.TemporaryDirectory() as d:
   task=self.task()
   a=DurableDryRunStore(d+'/attempts.sqlite')
   self.assertFalse(a.prepare(task,now=1001)['duplicate'])
   a.close()
   a=DurableDryRunStore(d+'/attempts.sqlite')
   self.assertTrue(a.prepare(task,now=1001)['duplicate'])
   a.reconcile('key',status='WITHDRAWN',revision=1)
   self.assertEqual(a.prepare(task,now=1001)['status'],'WITHDRAWN')
   with self.assertRaises(CommonTaskError):
    a.reconcile('key',status='DRY_RUN_VERIFIED',revision=2)
   changed={**task,'stake':11}
   with self.assertRaises(CommonTaskError):
    a.prepare(changed,now=1001)
   with self.assertRaises(CommonTaskError):
    a.prepare(task,now=1005)
   a.close()

 def test_refund_roi_basis_reaches_durable_task_without_recalculation(self):
  task=self.task(roi_basis='non_void_stake.v1',margin_basis='non_void_exposure')
  self.assertEqual(task['valuation_basis'],{'roi_basis':'non_void_stake.v1','margin_basis':'non_void_exposure'})
  self.assertFalse(task['execution_ready'])

 def test_conflicting_or_unknown_roi_basis_cannot_be_relabelled(self):
  for basis in [dict(margin_basis='non_void_exposure'),dict(roi_basis='placed_stake',margin_basis='non_void_exposure'),dict(margin_basis='unknown_basis')]:
   with self.assertRaises(CommonTaskError):
    self.task(**basis)


class JevBridgeTests(unittest.IsolatedAsyncioTestCase):
 async def test_model_pass_cannot_verify_execution_or_revive_expired_task(self):
  from types import SimpleNamespace
  from onewin_automation.common import review_with_jev
  class Client:
   async def system_one(self,state,questions):
    return SimpleNamespace(choices={'decision':SimpleNamespace(choice='PASS',confidence=.9)},model='test-model')
  task=CommonTaskTests().task()
  result=await review_with_jev(task,Client(),lambda **kw:kw,clock=lambda:1001)
  self.assertEqual(result['status'],'PASS')
  self.assertFalse(result['execution_ready'])
  instants=iter([1001,1006])
  result=await review_with_jev(task,Client(),lambda **kw:kw,clock=lambda:next(instants))
  self.assertEqual(result['status'],'INVESTIGATE')
  self.assertFalse(result['execution_ready'])


class LiveExecutionGuardTests(unittest.TestCase):
 def task(self, stake=1.0):
  q={'source':'1win','source_event_key':'40021999','source_market':'T< 60.5','odds':1.87,'source_ts':1000,
     'axes':{'period':'full_time','scope':'REG','unit':'goals','market':'total','line':60.5,'side':'under'}}
  r={**q,'source':'BIA','source_event_key':'r','odds':1.80}
  return task_from_value(
   {'event_id':'canonical','isLive':True,'first':{'bookmaker':'BIA','matchId':'r'},'second':{'bookmaker':'1win','matchId':'40021999'}},
   {'outcome':'T< 60.5','score1':{'value':1.80},'score2':{'value':1.87},'reference_quote':r,'donor_quote':q,'margin_quotes':[r]},
   stake=stake,idempotency_key='live-attempt-1',now=1001
  )

 def test_durable_attempt_store_claim_validation_and_restart(self):
  with tempfile.TemporaryDirectory() as d:
   db_path = d + '/live_attempts.sqlite'
   store = DurableAttemptStore(db_path, max_stake=10.0)

   payload = {'idempotency_key': 'live-attempt-1', 'event_id': '40021999', 'stake': 1.0, 'currency': 'USDT'}
   # Rejects boolean stake (True == 1 in Python), negative, NaN, bad currency, empty payload, mismatched payload
   with self.assertRaises(CommonTaskError):
    store.claim('live-attempt-1', stake=True, currency='USDT', payload=payload)
   with self.assertRaises(CommonTaskError):
    store.claim('live-attempt-1', stake=0, currency='USDT', payload=payload)
   with self.assertRaises(CommonTaskError):
    store.claim('live-attempt-1', stake=float('nan'), currency='USDT', payload=payload)
   with self.assertRaises(CommonTaskError):
    store.claim('live-attempt-1', stake=1.0, currency='123', payload=payload)
   with self.assertRaises(CommonTaskError):
    store.claim('live-attempt-1', stake=1.0, currency='USDT', payload={})
   with self.assertRaises(CommonTaskError):
    store.claim('live-attempt-1', stake=1.0, currency='USDT', payload={**payload, 'stake': 2.0})

   # Claim succeeds with valid metadata
   self.assertTrue(store.claim('live-attempt-1', stake=1.0, currency='USDT', payload=payload, now=1001))
   self.assertFalse(store.claim('live-attempt-1', stake=1.0, currency='USDT', payload=payload, now=1002))
   store.record_status('live-attempt-1', 'SUBMITTING', now=1003)
   store.close()

   # Reopen to verify durability across restart
   store2 = DurableAttemptStore(db_path, max_stake=10.0)
   att = store2.get_attempt('live-attempt-1')
   self.assertEqual(att['status'], 'SUBMITTING')
   self.assertEqual(att['stake'], 1.0)
   self.assertEqual(att['event_id'], '40021999')
   self.assertFalse(store2.claim('live-attempt-1', stake=1.0, currency='USDT', payload=payload, now=1004))
   store2.record_status('live-attempt-1', 'INDETERMINATE', error='timeout', now=1005)
   with self.assertRaises(CommonTaskError):
    store2.record_status('live-attempt-1', 'SUBMITTING', now=1006)
   store2.close()

 def test_verify_live_execution_conditions_enforces_all_guards(self):
  task = self.task(stake=1.0)
  exec_quote = {
   'identity_verified_by': 'onewin-executor',
   'verified': True,
   'provider_id_namespace': 'top-parser:1win',
   'provider_event_key': '40021999',
   'native_event_id': '40021999',
   'native_market_id': '6271',
   'native_selection_id': '10:193671744120169820:0',
   'source_market': 'T< 60.5',
   'odds': 1.87,
   'source_ts': 1001,
   'commission': 0.0,
   'max_stake': 8.45,
   'currency': 'USDT',
   'axes': {'period':'full_time','scope':'REG','unit':'goals','market':'total','line':60.5,'side':'under'},
   # Positive proofs now travel with their provenance (2026-10-13 review).
   'live_submit_contract_verified': True,
   'live_submit_contract_source': 'unit-test-fixture',
  }
  acct = {'logged_in': True, 'account_identity_verified': True, 'account_identity_source': 'unit-test-fixture',
          'currency': 'USDT', 'available_balance': 8.45, 'observed_at': 1001}
  order = verify_live_execution_conditions(task, exec_quote, acct, now=1002, diagnostic_only=True)
  self.assertEqual(order['stake'], 1.0)
  self.assertEqual(order['currency'], 'USDT')

  # Diagnostic budget strictly 1.0 USDT
  with self.assertRaises(CommonTaskError):
   verify_live_execution_conditions(self.task(stake=2.0), exec_quote, acct, now=1002, diagnostic_only=True)

  # Product budget (e.g. max_stake=10.0) allows 5.0 and rejects 15.0
  prod_task = self.task(stake=5.0)
  prod_quote = {**exec_quote, 'max_stake': 20.0}
  prod_acct = {**acct, 'available_balance': 50.0}
  prod_order = verify_live_execution_conditions(prod_task, prod_quote, prod_acct, now=1002, max_stake=10.0)
  self.assertEqual(prod_order['stake'], 5.0)
  with self.assertRaises(CommonTaskError):
   verify_live_execution_conditions(self.task(stake=15.0), prod_quote, prod_acct, now=1002, max_stake=10.0)

  # Unauthenticated account, unverified identity, or insufficient balance rejected
  with self.assertRaises(CommonTaskError):
   verify_live_execution_conditions(task, exec_quote, {**acct, 'logged_in': False}, now=1002)
  with self.assertRaises(CommonTaskError):
   verify_live_execution_conditions(task, exec_quote, {**acct, 'account_identity_verified': False}, now=1002)
  with self.assertRaises(CommonTaskError):
   verify_live_execution_conditions(task, exec_quote, {**acct, 'currency': 'RUB'}, now=1002)
  with self.assertRaises(CommonTaskError):
   verify_live_execution_conditions(task, exec_quote, {**acct, 'available_balance': 0.5}, now=1002)

  # Price drift and expiry rejected
  with self.assertRaises(CommonTaskError):
   verify_live_execution_conditions(task, {**exec_quote, 'odds': 1.82}, acct, now=1002)
  with self.assertRaises(CommonTaskError):
   verify_live_execution_conditions(task, exec_quote, acct, now=1006)

  # Missing commission or missing available_balance rejected
  with self.assertRaises(CommonTaskError):
   verify_live_execution_conditions(task, {**exec_quote, "commission": None}, acct, now=1002)
  with self.assertRaises(CommonTaskError):
   verify_live_execution_conditions(task, exec_quote, {**acct, "available_balance": None}, now=1002)

 def test_axes_preserved_and_mismatches_rejected(self):
  task = self.task(stake=1.0)
  self.assertEqual(task['axes']['period'], 'full_time')
  self.assertEqual(task['axes']['unit'], 'goals')
  self.assertEqual(task['axes']['side'], 'under')

  valid_exec = {
   'identity_verified_by': 'onewin-executor', 'verified': True,
   'provider_id_namespace': 'top-parser:1win', 'provider_event_key': '40021999',
   'native_event_id': '40021999', 'native_market_id': '6271',
   'native_selection_id': '10:193671744120169820:0', 'source_market': 'T< 60.5',
   'odds': 1.87, 'source_ts': 1001, 'max_stake': 8.45, 'currency': 'USDT',
   'commission': 0.0,
   'axes': {'period':'full_time','scope':'REG','unit':'goals','market':'total','line':60.5,'side':'under'}
  }
  self.assertTrue(verify_executor_quote(task, valid_exec, now=1002)['dry_run'])

  # Rejects guessed/placeholder units
  guessed_axes = {**valid_exec['axes'], 'unit': 'match_base_unit'}
  with self.assertRaises(CommonTaskError):
   verify_executor_quote(task, {**valid_exec, 'axes': guessed_axes}, now=1002)

  # Rejects period, side, or unit mismatch
  with self.assertRaises(CommonTaskError):
   verify_executor_quote(task, {**valid_exec, 'axes': {**valid_exec['axes'], 'period': '1st_half'}}, now=1002)
  with self.assertRaises(CommonTaskError):
   verify_executor_quote(task, {**valid_exec, 'axes': {**valid_exec['axes'], 'side': 'over'}}, now=1002)
  with self.assertRaises(CommonTaskError):
   verify_executor_quote(task, {**valid_exec, 'axes': {**valid_exec['axes'], 'unit': 'points'}}, now=1002)

 def test_assess_live_readiness_keeps_readiness_false_with_blockers(self):
  task = self.task(stake=1.0)
  raw_quote = {
   'source': '1win', 'odds': 1.87,
   'commission': None, 'max_stake': None,
   'verified': False,
  }
  acct = {'logged_in': True, 'currency': 'USDT', 'available_balance': 8.45}
  readiness = assess_live_readiness(task, raw_quote, acct, now=1002)
  self.assertFalse(readiness['execution_ready'])
  self.assertIn('executor_identity_unverified', readiness['execution_blockers'])

  # Even when executor identity is verified, unverified commission and unverified submit wire contract block readiness
  exec_quote = {
   'identity_verified_by': 'onewin-executor',
   'verified': True,
   'commission': None,
   'max_stake': 8.45,
   'axes': task['axes'],
  }
  readiness2 = assess_live_readiness(task, exec_quote, {**acct, 'account_identity_verified': True}, now=1002)
  self.assertFalse(readiness2['execution_ready'])
  self.assertIn('unverified_commission', readiness2['execution_blockers'])
  self.assertIn('unverified_live_submit_wire_contract', readiness2['execution_blockers'])


class PlacementGateIntegrationTests(unittest.IsolatedAsyncioTestCase):
 async def test_placement_gate_enforces_stake_contract_and_records_lifecycle(self):
  with tempfile.TemporaryDirectory() as d:
   store = DurableAttemptStore(d + "/attempts.sqlite", max_stake=50.0)
   cfg = OneWinAutomationConfig(live_enabled=True, max_stake=50.0)
   calls = []
   async def transport(payload):
    calls.append(payload)
    return {"ok": True, "status": "ACCEPTED", "receipt_id": "rcpt-101", "amount": payload["stake"]}

   gate = PlacementGate(enabled=True, config=cfg, transport=transport, attempt_store=store, max_stake=50.0,
                        require_verified_order=False)  # explicit legacy mode (2026-10-13)

   # Missing stake rejected without calling transport
   with self.assertRaises(BasketValidationError):
    await gate.place({"idempotency_key": "gate-no-stake"})
   self.assertEqual(calls, [])

   # Conflicting amount and stake rejected
   with self.assertRaises(BasketValidationError):
    await gate.place({"idempotency_key": "gate-conflict", "stake": 1.0, "amount": 2.0})

   # Valid 1.0 USDT diagnostic stake accepted and recorded
   res = await gate.place({"idempotency_key": "gate-diag-1", "stake": 1.0, "currency": "USDT", "event_id": "40021999"})
   self.assertEqual(res["receipt_id"], "rcpt-101")
   att = store.get_attempt("gate-diag-1")
   self.assertEqual(att["status"], "ACCEPTED")
   self.assertEqual(att["stake"], 1.0)
   self.assertEqual(att["payload"].get("event_id"), "40021999")

   # Duplicate attempt rejected without calling transport
   with self.assertRaises(BasketValidationError):
    await gate.place({"idempotency_key": "gate-diag-1", "stake": 1.0})
   self.assertEqual(len(calls), 1)

   # Product stake 5.0 USDT accepted when <= max_stake
   res5 = await gate.place({"idempotency_key": "gate-prod-5", "stake": 5.0, "currency": "USDT"})
   self.assertEqual(res5["receipt_id"], "rcpt-101")
   self.assertEqual(store.get_attempt("gate-prod-5")["stake"], 5.0)

   # Stake > max_stake rejected
   with self.assertRaises(BasketValidationError):
    await gate.place({"idempotency_key": "gate-over-budget", "stake": 55.0})

   # Compatibility adapter injects default_stake into transport and attempt store
   compat_gate = LegacyPlacementGateAdapter(
    enabled=True, config=cfg, transport=transport, attempt_store=store, default_stake=1.0,
    require_verified_order=False
   )
   compat_res = await compat_gate.place({"idempotency_key": "gate-compat-1"})
   self.assertEqual(compat_res["receipt_id"], "rcpt-101")
   self.assertEqual(store.get_attempt("gate-compat-1")["stake"], 1.0)
   self.assertEqual(calls[-1]["stake"], 1.0)

   # Diagnostic factory strictly caps at 1.0 USDT
   diag_gate = PlacementGate.for_diagnostic_test(transport=transport, attempt_store=store,
                                                 config=OneWinAutomationConfig(live_enabled=True, max_stake=1.0))
   with self.assertRaises(BasketValidationError):
    await diag_gate.place({"idempotency_key": "diag-over", "stake": 2.0})

   store.close()

 async def test_placement_gate_indeterminate_response_locks_attempt_forever(self):
  with tempfile.TemporaryDirectory() as d:
   store = DurableAttemptStore(d + "/attempts.sqlite")
   cfg = OneWinAutomationConfig(live_enabled=True, max_stake=10.0)
   calls = []
   async def timeout_transport(payload):
    calls.append(payload)
    raise TimeoutError("connection dropped after send")

   gate = PlacementGate(enabled=True, config=cfg, transport=timeout_transport, attempt_store=store,
                        require_verified_order=False)
   with self.assertRaises(PlacementIndeterminate):
    await gate.place({"idempotency_key": "gate-timeout-1", "stake": 1.0})

   att = store.get_attempt("gate-timeout-1")
   self.assertEqual(att["status"], "INDETERMINATE")

   # Subsequent call with same key is rejected by claim without calling transport
   with self.assertRaises(BasketValidationError):
    await gate.place({"idempotency_key": "gate-timeout-1", "stake": 1.0})
   self.assertEqual(len(calls), 1)
   store.close()
