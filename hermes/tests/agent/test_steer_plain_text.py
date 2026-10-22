"""A steer travels as plain text, and its wrapper tells the model to keep working (Ghidorah 10-19).

10-19: a steer left over at a turn's end was queued as the next message still carrying its delivery receipts; the next
context compression deep-copied the messages and crashed (``PendingSteer.__new__() missing ... 'text'``). And a
mid-job "done?" made the model answer and end the job. Run with the bundled Python:
``python -m unittest tests.agent.test_steer_plain_text``.
"""

import copy
import os
import pickle
import tempfile
import unittest

os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp(prefix="hermes-test-"))

from agent.interrupt_control import PendingSteer  # noqa: E402
from agent.prompt_builder import STEER_MARKER_OPEN, steer_user_row  # noqa: E402


class SteerPlainText(unittest.TestCase):
    def test_a_copied_or_saved_steer_is_its_text(self):
        steer = PendingSteer(PendingSteer(None, "first", lambda: None), "second", lambda: None)
        messages = [{"role": "user", "content": steer}]
        for copied in (copy.deepcopy(messages), pickle.loads(pickle.dumps(messages))):
            self.assertIs(type(copied[0]["content"]), str)
            self.assertEqual(copied[0]["content"], "first\nsecond")
        self.assertEqual(len(steer.receipts), 2, "the original keeps its receipts")

    def test_the_wrapper_says_keep_working(self):
        row = steer_user_row("are you done?")
        self.assertTrue(row["content"].startswith("[OUT-OF-BAND USER MESSAGE"), "opening words unchanged")
        self.assertIn("keep working on the task", STEER_MARKER_OPEN)
        self.assertIn("are you done?", row["content"])


if __name__ == "__main__":
    unittest.main()
