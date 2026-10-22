"""Every turn is named on its start and on every end, a crash included (Ghidorah 10-20).

On 10-19 a turn crashed and its end named no message IDs; the client never closed the messages steered into it and
showed them running until a restart. Run with the bundled Python: ``python -m unittest tests.tui_gateway.test_turn_ids``.
"""

import os
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

# Never touch a real Hermes home: this runner has no conftest to sandbox it.
os.environ["HERMES_HOME"] = tempfile.mkdtemp(prefix="hermes-test-")

from agent.interrupt_control import PendingSteer
from tui_gateway import server


class _InlineThread:
    def __init__(self, target=None, daemon=None, args=(), kwargs=None, name=None):
        self._target, self._args, self._kwargs = target, args, kwargs or {}

    def start(self):
        if self._target is not None:
            self._target(*self._args, **self._kwargs)

    def is_alive(self):
        return False

    def join(self, timeout=None):
        return None


def _session(agent, **extra):
    return {"agent": agent, "session_key": "key", "history": [], "history_lock": threading.Lock(), "history_version": 0,
            "running": True, "attached_images": [], "image_counter": 0, "cols": 80, "slash_worker": None,
            "show_reasoning": False, "tool_progress_mode": "all", "inflight_turn": None, **extra}


class TurnIds(unittest.TestCase):
    def setUp(self):
        self.events, self.enqueued = [], []
        stubs = {"_emit": lambda *a, **k: self.events.append(a), "_wire_callbacks": lambda sid: None,
                 "_sync_agent_model_with_config": lambda sid, session: None, "_session_cwd": lambda session: ".",
                 "_register_session_cwd": lambda session: None, "_tts_stream_begin": lambda: None,
                 "_sync_session_key_after_compress": lambda *a, **k: None, "_get_usage": lambda agent: {},
                 "_drain_queued_prompt": lambda *a, **k: False,
                 "_enqueue_prompt": lambda session, text, transport, **k: self.enqueued.append((text, k.get("client_ids")))}
        patches = [patch.object(server.threading, "Thread", _InlineThread)]
        patches += [patch.object(server, name, value) for name, value in stubs.items()]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _frames(self, kind):
        return [payload for name, _sid, *rest in self.events if name == kind for payload in rest or [None]]

    def test_start_and_complete_carry_the_same_turn_id(self):
        agent = types.SimpleNamespace(session_id="a", clear_interrupt=lambda: None,
                                      run_conversation=lambda *a, **k: {"final_response": "done"})
        server._run_prompt_submit("rid", "sid", _session(agent), "go", client_ids=["A"])
        start, complete = self._frames("message.start")[-1], self._frames("message.complete")[-1]
        self.assertTrue(start["turn_id"])
        self.assertEqual(start["client_ids"], ["A"])
        self.assertEqual(complete["turn_id"], start["turn_id"])
        self.assertEqual(complete["client_ids"], ["A"])

    def test_a_crash_names_its_turn_and_the_messages_it_read_and_passes_an_unread_steer_on_as_text(self):
        def boom(*a, **k):
            raise TypeError("crash mid-turn")
        unread = PendingSteer(None, "late", lambda: None)
        agent = types.SimpleNamespace(session_id="a", clear_interrupt=lambda: None, run_conversation=boom)
        agent._drain_pending_steer = lambda: unread
        session = _session(agent, _read_steer_client_ids=["B"], _steer_client_ids=["C"])
        server._run_prompt_submit("rid", "sid", session, "go", client_ids=["A"])
        start, complete = self._frames("message.start")[-1], self._frames("message.complete")[-1]
        self.assertEqual(complete["status"], "error")
        self.assertEqual(complete["turn_id"], start["turn_id"])
        self.assertEqual(complete["client_ids"], ["A", "B"], "read steers end with the turn")
        self.assertEqual(len(self.enqueued), 1)
        text, _ids = self.enqueued[0]
        self.assertIs(type(text), str, "an unread steer goes on as plain text, never the receipt object")
        self.assertEqual(text, "late")
        self.assertEqual(_ids, ["C"], "its IDs go with it")


if __name__ == "__main__":
    unittest.main()
