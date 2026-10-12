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
