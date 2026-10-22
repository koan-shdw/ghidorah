"""A ChatGPT plan limit reads as a usage limit, not billing (Ghidorah 10-19).

10-19 19:12: the Codex backend answered 402 then 429 for a ChatGPT sign-in and the chat showed "Billing or credits
exhausted: Connection error ... Add credits". Run: ``python -m unittest tests.agent.test_plan_limit_wording``.
"""

import os
import tempfile
import types
import unittest

os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp(prefix="hermes-test-"))

from agent import conversation_loop as loop  # noqa: E402


class PlanLimitWording(unittest.TestCase):
    def _final(self, provider):
        classified = types.SimpleNamespace(billing_unverified=False, reason=types.SimpleNamespace(value="billing"),
                                           retryable=False)
        return loop._billing_failure_result(classified=classified, summary="Connection error.", messages=[],
                                            api_call_count=1, provider=provider,
                                            base_url="https://chatgpt.com/backend-api/codex", model="gpt-6-astra")["final_response"]

    def test_chatgpt_plan(self):
        final = self._final("openai-codex")
        self.assertTrue(final.startswith("Usage limit reached (ChatGPT plan)"))
        self.assertIn("Usage limit reached for gpt-6-astra on your ChatGPT plan.", final)
        self.assertNotIn("Add credits", final)

    def test_api_key_billing_unchanged(self):
        self.assertTrue(self._final("openai").startswith("Billing or credits exhausted"))


if __name__ == "__main__":
    unittest.main()
