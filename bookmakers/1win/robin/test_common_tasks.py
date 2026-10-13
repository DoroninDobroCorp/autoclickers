import tempfile
import unittest
from onewin_automation.common import CommonTaskError,DurableDryRunStore,task_from_value
class CommonTaskTests(unittest.TestCase):
 def task(self,**basis):
  q={'source':'1win','source_event_key':'d','source_market':'T> 2.5','odds':2.2,'source_ts':1000}
  r={**q,'source':'BIA','source_event_key':'r','odds':2}
  return task_from_value({'event_id':'canonical','isLive':True,'first':{'bookmaker':'BIA','matchId':'r'},'second':{'bookmaker':'1win','matchId':'d'}},{**basis,'outcome':'T> 2.5','score1':{'value':2},'score2':{'value':2.2},'reference_quote':r,'donor_quote':q,'margin_quotes':[r]},stake=10,idempotency_key='key',now=1001)
 def test_bia_identity_and_expiration_preserved(self):
  task=self.task();self.assertEqual(task['expires_at'],1005);self.assertFalse(task['pinnacle_attributed']);self.assertFalse(task['execution_ready'])
 def test_duplicate_and_withdrawal_survive_process_restart(self):
  with tempfile.TemporaryDirectory() as d:
   task=self.task();a=DurableDryRunStore(d+'/attempts.sqlite')
   self.assertFalse(a.prepare(task,now=1001)['duplicate']);a.close();a=DurableDryRunStore(d+'/attempts.sqlite')
   self.assertTrue(a.prepare(task,now=1001)['duplicate'])
   a.reconcile('key',status='WITHDRAWN',revision=1)
   self.assertEqual(a.prepare(task,now=1001)['status'],'WITHDRAWN')
   with self.assertRaises(CommonTaskError):a.reconcile('key',status='DRY_RUN_VERIFIED',revision=2)
   changed={**task,'stake':11}
   with self.assertRaises(CommonTaskError):a.prepare(changed,now=1001)
   with self.assertRaises(CommonTaskError):a.prepare(task,now=1005)
   a.close()

 def test_refund_roi_basis_reaches_durable_task_without_recalculation(self):
  task=self.task(roi_basis='non_void_stake.v1',margin_basis='non_void_exposure')
  self.assertEqual(task['valuation_basis'],{'roi_basis':'non_void_stake.v1','margin_basis':'non_void_exposure'})
  self.assertFalse(task['execution_ready'])
 def test_conflicting_or_unknown_roi_basis_cannot_be_relabelled(self):
  for basis in [dict(margin_basis='non_void_exposure'),dict(roi_basis='placed_stake',margin_basis='non_void_exposure'),dict(margin_basis='unknown_basis')]:
   with self.assertRaises(CommonTaskError):self.task(**basis)

class JevBridgeTests(unittest.IsolatedAsyncioTestCase):
 async def test_model_pass_cannot_verify_execution_or_revive_expired_task(self):
  from types import SimpleNamespace
  from onewin_automation.common import review_with_jev
  class Client:
   async def system_one(self,state,questions):
    return SimpleNamespace(choices={'decision':SimpleNamespace(choice='PASS',confidence=.9)},model='test-model')
  task=CommonTaskTests().task()
  result=await review_with_jev(task,Client(),lambda **kw:kw,clock=lambda:1001)
  self.assertEqual(result['status'],'PASS');self.assertFalse(result['execution_ready'])
  instants=iter([1001,1006])
  result=await review_with_jev(task,Client(),lambda **kw:kw,clock=lambda:next(instants))
  self.assertEqual(result['status'],'INVESTIGATE');self.assertFalse(result['execution_ready'])


class LiveExecutionGuardTests(unittest.TestCase):
 def task(self, stake=1.0):
  q={'source':'1win','source_event_key':'40021999','source_market':'T< 60.5','odds':1.87,'source_ts':1000}
  r={**q,'source':'BIA','source_event_key':'r','odds':1.80}
  return task_from_value(
   {'event_id':'canonical','isLive':True,'first':{'bookmaker':'BIA','matchId':'r'},'second':{'bookmaker':'1win','matchId':'40021999'}},
   {'outcome':'T< 60.5','score1':{'value':1.80},'score2':{'value':1.87},'reference_quote':r,'donor_quote':q,'margin_quotes':[r]},
   stake=stake,idempotency_key='live-attempt-1',now=1001
  )

 def test_durable_attempt_store_claim_and_terminal_lock(self):
  from onewin_automation.common import DurableAttemptStore
  with tempfile.TemporaryDirectory() as d:
   db_path = d + '/live_attempts.sqlite'
   store = DurableAttemptStore(db_path)
   self.assertTrue(store.claim('live-attempt-1', stake=1.0, currency='USDT', payload={'event_id':'40021999'}, now=1001))
   self.assertFalse(store.claim('live-attempt-1', stake=1.0, currency='USDT', now=1002))
   store.close()
   # Reopen to verify durability across restart
   store = DurableAttemptStore(db_path)
   self.assertFalse(store.claim('live-attempt-1', stake=1.0, currency='USDT', now=1003))
   store.record_status('live-attempt-1', 'INDETERMINATE', error='timeout', now=1004)
   with self.assertRaises(CommonTaskError):
    store.record_status('live-attempt-1', 'SUBMITTING', now=1005)
   with self.assertRaises(CommonTaskError):
    store.claim('budget-exceeded', stake=2.0, currency='USDT', now=1005)
   store.close()

 def test_verify_live_execution_conditions_enforces_all_guards(self):
  from onewin_automation.common import verify_live_execution_conditions
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
  }
  acct = {'logged_in': True, 'currency': 'USDT', 'available_balance': 8.45}
  order = verify_live_execution_conditions(task, exec_quote, acct, now=1002)
  self.assertEqual(order['stake'], 1.0)
  self.assertEqual(order['currency'], 'USDT')

  # Budget > 1.0 USDT rejected
  big_task = self.task(stake=5.0)
  with self.assertRaises(CommonTaskError):
   verify_live_execution_conditions(big_task, exec_quote, acct, now=1002)

  # Unauthenticated account rejected
  with self.assertRaises(CommonTaskError):
   verify_live_execution_conditions(task, exec_quote, {**acct, 'logged_in': False}, now=1002)

  # Wrong currency rejected
  with self.assertRaises(CommonTaskError):
   verify_live_execution_conditions(task, exec_quote, {**acct, 'currency': 'RUB'}, now=1002)

  # Price drift rejected
  with self.assertRaises(CommonTaskError):
   verify_live_execution_conditions(task, {**exec_quote, 'odds': 1.82}, acct, now=1002)

  # Expired quote rejected
  with self.assertRaises(CommonTaskError):
   verify_live_execution_conditions(task, exec_quote, acct, now=1006)

  # Missing commission or missing available_balance rejected
  with self.assertRaises(CommonTaskError):
   verify_live_execution_conditions(task, {**exec_quote, "commission": None}, acct, now=1002)
  with self.assertRaises(CommonTaskError):
   verify_live_execution_conditions(task, exec_quote, {**acct, "available_balance": None}, now=1002)

 def test_axes_preserved_and_mismatches_rejected(self):
  from onewin_automation.common import verify_executor_quote
  q={'source':'1win','source_event_key':'40021999','source_market':'T< 60.5','odds':1.87,'source_ts':1000,
     'axes':{'period':'full_time','scope':'REG','unit':'goals','market':'total','line':60.5,'side':'under'}}
  r={**q,'source':'BIA','source_event_key':'r','odds':1.80}
  task=task_from_value(
   {'event_id':'canonical','isLive':True,'first':{'bookmaker':'BIA','matchId':'r'},'second':{'bookmaker':'1win','matchId':'40021999'}},
   {'outcome':'T< 60.5','score1':{'value':1.80},'score2':{'value':1.87},'reference_quote':r,'donor_quote':q,'margin_quotes':[r]},
   stake=1.0,idempotency_key='axes-test-key',now=1001
  )
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

  # Different period rejected
  with self.assertRaises(CommonTaskError):
   verify_executor_quote(task, {**valid_exec, 'axes': {**valid_exec['axes'], 'period': '1st_half'}}, now=1002)

  # Different side (over instead of under) rejected
  with self.assertRaises(CommonTaskError):
   verify_executor_quote(task, {**valid_exec, 'axes': {**valid_exec['axes'], 'side': 'over'}}, now=1002)

  # Different unit rejected
  with self.assertRaises(CommonTaskError):
   verify_executor_quote(task, {**valid_exec, 'axes': {**valid_exec['axes'], 'unit': 'points'}}, now=1002)


class PlacementGateIntegrationTests(unittest.IsolatedAsyncioTestCase):
 async def test_placement_gate_works_with_durable_attempt_store(self):
  from onewin_automation.common import DurableAttemptStore
  from onewin_automation.config import OneWinAutomationConfig
  from onewin_automation.placement import PlacementGate, BasketValidationError
  with tempfile.TemporaryDirectory() as d:
   store = DurableAttemptStore(d + "/attempts.sqlite")
   cfg = OneWinAutomationConfig(live_enabled=True, max_stake=1.0)
   async def transport(payload):
    return {"ok": True, "status": "ACCEPTED", "receipt_id": "rcpt-101"}
   gate = PlacementGate(enabled=True, config=cfg, transport=transport, attempt_store=store)
   res = await gate.place({"idempotency_key": "gate-1", "stake": 1.0})
   self.assertEqual(res["receipt_id"], "rcpt-101")
   with self.assertRaises(BasketValidationError):
    await gate.place({"idempotency_key": "gate-1", "stake": 1.0})
   with self.assertRaises(BasketValidationError):
    await gate.place({"idempotency_key": "gate-over-budget", "stake": 2.0})
   store.close()
