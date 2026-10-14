"""Synthetic review cases: legacy store identity and missing queue acknowledgements."""
import tempfile
import unittest
from unittest.mock import Mock

import test_consumer_units as consumer_units
from onewin_automation.consumer.core import Decision
from onewin_automation.consumer.queue_client import QueueError
from onewin_automation.consumer.core import PreflightError
from onewin_automation.consumer.journal import open_exposures


class CoordinatorRecoveryReview(unittest.TestCase):
    def helper(self):
        return consumer_units.LostAnswerTest(methodName='runTest')

    def test_legacy_handoff_without_store_identity_does_not_certify_a_foreign_fence(self):
        helper = self.helper()
        with tempfile.TemporaryDirectory() as directory:
            executor = helper._executor(fence=helper._fenced_answer('new-store'))
            consumer = helper._consumer(executor, directory)
            try:
                view = consumer._await_attempt_after_restart('legacy-key', {'id': 1.5}, handed=True, store=None)
                decision = consumer._decision_from_attempt('legacy-key', view)
                self.assertEqual(decision.status, 'unresolved')
                self.assertFalse(executor.fences)
            finally:
                consumer.close()

    def unresolved(self, consumer):
        for row in [
            dict(phase='claimed', key='key', snapshot={'id': 1.5}, mode='real'),
            dict(phase='built', key='key', synthetic=False),
            dict(phase='handed_off', key='key', mode='real', executor_store='aaaa'),
        ]:
            consumer.journal.append(row)
        return consumer.journal.items()['key']

    def test_unacknowledged_fence_resolution_remains_retryable(self):
        helper = self.helper()
        with tempfile.TemporaryDirectory() as directory:
            consumer = helper._consumer(helper._executor(fence=helper._fenced_answer('aaaa')), directory)
            try:
                entry = self.unresolved(consumer)
                decision = Decision('unresolved', ['lost response'], 'executor')
                consumer.queue.request = Mock(return_value={'resolved': False, 'reason': 'missing_history'})
                consumer._late_resolution('key', {'id': 1.5}, decision, None, entry)
                current = consumer.journal.items()['key']
                self.assertFalse((current['phases'].get('exported') or {}).get('late_resolution'))
                consumer.queue.request = Mock(return_value={'resolved': True})
                result = consumer._late_resolution('key', {'id': 1.5}, decision, None, current)
                self.assertTrue(result['queue'])
                self.assertEqual(consumer.journal.items()['key']['phases']['exported']['late_resolution'], 'not_placed')
            finally:
                consumer.close()

    def test_unacknowledged_accepted_resolution_does_not_export_a_completed_queue(self):
        helper = self.helper()
        with tempfile.TemporaryDirectory() as directory:
            consumer = helper._consumer(helper._executor(fence=None), directory)
            try:
                entry = self.unresolved(consumer)
                consumer.queue.request = Mock(return_value={'resolved': False, 'reason': 'missing_history'})
                consumer._export = Mock(return_value=None)
                attempt = {'status': 'ACCEPTED', 'stake': 1.0,
                           'receipt': {'bet_id': 'synthetic-ticket', 'accepted_cf': 1.9}}
                consumer._late_resolution('key', {'id': 1.5}, Decision('unresolved', [], 'executor'), attempt, entry)
                consumer._export.assert_not_called()
                self.assertFalse((consumer.journal.items()['key']['phases'].get('exported') or {}).get('late_resolution'))
            finally:
                consumer.close()

    def test_queue_written_phase_requires_positive_acknowledgement(self):
        helper = self.helper()
        with tempfile.TemporaryDirectory() as directory:
            consumer = helper._consumer(helper._executor(fence=None), directory)
            try:
                self.unresolved(consumer)
                consumer.queue.request = Mock(return_value={'recorded': False, 'already': False})
                with self.assertRaises(QueueError):
                    consumer._write_queue('key', {'id': 1.5}, Decision('unresolved', [], 'executor'), None)
                self.assertNotIn('queue_written', consumer.journal.items()['key']['phases'])
            finally:
                consumer.close()

    def test_legacy_late_marker_without_queue_ack_remains_exposure(self):
        helper = self.helper()
        with tempfile.TemporaryDirectory() as directory:
            consumer = helper._consumer(helper._executor(fence=None), directory)
            try:
                self.unresolved(consumer)
                consumer.journal.append({'phase': 'decided', 'key': 'key', 'decision': {'status': 'unresolved'}})
                consumer.journal.append({'phase': 'exported', 'key': 'key', 'late_resolution': 'accepted'})
                self.assertEqual(len(open_exposures(consumer.journal.items())), 1)
                consumer.journal.append({'phase': 'exported', 'key': 'key', 'late_resolution': 'accepted',
                                         'queue_acknowledged': True})
                self.assertEqual(open_exposures(consumer.journal.items()), [])
            finally:
                consumer.close()

    def test_new_real_handoff_requires_store_identity_in_preflight(self):
        helper = self.helper()
        with tempfile.TemporaryDirectory() as directory:
            executor = helper._executor(fence=None)
            executor.health = Mock(return_value={'mode': 'real', 'live_gate_open': True,
                'transport_environment': 'local_stand', 'store': {'durable': True}})
            consumer = helper._consumer(executor, directory)
            try:
                with self.assertRaises(PreflightError):
                    consumer.preflight()
                executor.health.return_value['store']['path_sha256'] = 'known-store'
                consumer.preflight()
                self.assertEqual(consumer._store_id, 'known-store')
            finally:
                consumer.close()

    def test_positive_idempotent_queue_ack_is_preserved(self):
        helper = self.helper()
        with tempfile.TemporaryDirectory() as directory:
            consumer = helper._consumer(helper._executor(fence=None), directory)
            try:
                self.unresolved(consumer)
                consumer.queue.request = Mock(return_value={'already': True})
                consumer._write_queue('key', {'id': 1.5}, Decision('unresolved', [], 'executor'), None)
                self.assertTrue(consumer.journal.items()['key']['phases']['queue_written']['already'])
            finally:
                consumer.close()


if __name__ == '__main__':
    unittest.main()
