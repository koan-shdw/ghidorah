"""Heartbeats and watch matches wake the model only when idle and the process still runs (Ghidorah 10-19).

10-19: heartbeats queued while a job ran, then fired one model turn each after it ended, mostly about processes that
had already exited (19 turns in 7 minutes). Run with the bundled Python:
``python -m unittest tests.tui_gateway.test_progress_signals``.
"""

import os
import queue
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp(prefix="hermes-test-"))

from tui_gateway import server  # noqa: E402


def _heartbeat(seq, proc="proc_1"):
    return {"type": "heartbeat", "session_id": proc, "seq": seq, "command": "build", "output": f"line {seq}"}


class ProgressSignals(unittest.TestCase):
    def setUp(self):
        self.turns, self.statuses = [], []
        for name, value in {"_notif_dispatch_event": lambda sid, session, evt, text: self.turns.append(evt["seq"]),
                            "_emit": lambda name, sid, payload=None: self.statuses.append(payload)}.items():
            p = patch.object(server, name, value)
            p.start()
            self.addCleanup(p.stop)

    def _run(self, events, *, running=False, exited=False):
        process = types.SimpleNamespace(exited=exited)
        registry = types.SimpleNamespace(completion_queue=queue.Queue(), get=lambda sid: process,
                                         is_completion_consumed=lambda sid: False)
        session = {"history_lock": threading.RLock(), "running": running}
        server._notif_handle_ready("sid", session, events, set(), registry, lambda evt: "text", None, owned=True)
        return registry.completion_queue

    def test_idle_and_running_wakes_the_model_once_for_the_newest(self):
        left = self._run([_heartbeat(1), _heartbeat(2)])
        self.assertEqual(self.turns, [2])
        self.assertTrue(left.empty())

    def test_busy_shows_a_status_line_and_queues_nothing(self):
        left = self._run([_heartbeat(1)], running=True)
        self.assertEqual(self.turns, [])
        self.assertTrue(left.empty(), "a busy turn never gets it later")
        self.assertTrue(self.statuses, "shown as a status line")

    def test_a_signal_for_an_exited_process_is_dropped(self):
        self._run([_heartbeat(1)], exited=True)
        self._run([{**_heartbeat(2), "type": "watch_match", "pattern": "ERROR"}], exited=True)
        self.assertEqual(self.turns, [])


if __name__ == "__main__":
    unittest.main()
