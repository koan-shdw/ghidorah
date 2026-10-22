import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from agent.interrupt_control import InterruptControlMixin
from agent.agent_runtime_helpers import apply_pending_steer_to_tool_results
from tui_gateway import server


class SteerRead(unittest.TestCase):
    def test_only_read_ids_join_the_reply_and_late_ids_survive_for_the_next_turn(self):
        agent = InterruptControlMixin()
        agent._pending_steer = None
        agent._pending_steer_lock = threading.Lock()
        session = {'history_lock': threading.RLock(), 'running': True}
        events = []
        with patch.object(server, '_emit', side_effect=lambda *args: events.append(args)), patch.object(server, '_ok', side_effect=lambda rid, value: value):
            for cid in ['B', 'C']:
                answer = server._ac_try_correction(cid, session, agent, 'steer', 'same text', 'steered', sid='session', client_ids=[cid])
                self.assertEqual(answer['status'], 'steered')
            self.assertEqual(events, [])
            apply_pending_steer_to_tool_results(agent, [{'role': 'tool', 'content': 'done'}], 1)
            self.assertEqual(events, [('message.read', 'session', {'client_ids': ['B']}), ('message.read', 'session', {'client_ids': ['C']})])
            server._ac_try_correction('D', session, agent, 'steer', 'late', 'steered', sid='session', client_ids=['D'])
            result = SimpleNamespace(result={'pending_steer': agent._drain_pending_steer()})
            self.assertEqual(server._answered_client_ids(session, result, ['A']), ['A', 'B', 'C'])
            self.assertEqual(session['_leftover_steer_client_ids'], ['D'])


if __name__ == '__main__':
    unittest.main()
