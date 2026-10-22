import threading
import unittest

from agent.interrupt_control import InterruptControlMixin
from agent.agent_runtime_helpers import apply_pending_steer_to_tool_results
from agent.turn_iteration_prep import _inject_steer_after_newest_tool_result


class SteerReceipts(unittest.TestCase):
    def test_receipts_follow_consumed_batches_through_requeue_and_late_arrivals(self):
        agent = InterruptControlMixin()
        agent._pending_steer = None
        agent._pending_steer_lock = threading.Lock()
        seen = []
        agent.steer('first', on_read=lambda: seen.append('first'))
        drained = agent._drain_pending_steer()
        agent.steer('second', on_read=lambda: seen.append('second'))
        _inject_steer_after_newest_tool_result(agent, [], drained)
        self.assertEqual(seen, [], 'no tool boundary: nothing was read')
        tool = {'role': 'tool', 'content': 'keep tool result', 'tool_call_id': 't'}
        messages = [tool.copy()]
        apply_pending_steer_to_tool_results(agent, messages, 1)
        self.assertEqual(seen, ['second', 'first'])
        self.assertEqual(messages[0], tool)
        self.assertIn('second\nfirst', messages[1]['content'])
        agent.steer('third', on_read=lambda: seen.append('third'))
        _inject_steer_after_newest_tool_result(agent, messages, agent._drain_pending_steer())
        self.assertEqual(seen, ['second', 'first', 'third'])
        agent.steer('late', on_read=lambda: seen.append('late'))
        self.assertEqual(agent._drain_pending_steer(), 'late')
        self.assertNotIn('late', seen, 'finalizer drain is a next-turn handoff, not a read')


if __name__ == '__main__':
    unittest.main()
