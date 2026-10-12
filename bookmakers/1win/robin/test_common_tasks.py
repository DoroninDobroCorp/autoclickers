import tempfile
import unittest
from onewin_automation.common import CommonTaskError,DurableDryRunStore,task_from_value
class CommonTaskTests(unittest.TestCase):
 def task(self):
  q={'source':'1win','source_event_key':'d','source_market':'T> 2.5','odds':2.2,'source_ts':1000}
  r={**q,'source':'BIA','source_event_key':'r','odds':2}
  return task_from_value({'event_id':'canonical','isLive':True,'first':{'bookmaker':'BIA','matchId':'r'},'second':{'bookmaker':'1win','matchId':'d'}},{'outcome':'T> 2.5','score1':{'value':2},'score2':{'value':2.2},'reference_quote':r,'donor_quote':q,'margin_quotes':[r]},stake=10,idempotency_key='key',now=1001)
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
