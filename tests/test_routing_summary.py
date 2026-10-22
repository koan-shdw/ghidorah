"""Claude subscription models write the routing summary through the background Claude runner (Koan: "why cant we see
anthrpic models as summary models for the deicison model?"): the backend prepares the prompt and validates the answer."""
import json
from pathlib import Path
import sys

APP = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(APP / 'backend'), str(APP / 'runtime' / 'hermes')]
import routing_summary


def test_native_routing_summary_prepares_and_validates_without_api_calls():
    original = routing_summary.summary_completion
    def unexpected(*args, **kwargs):
        raise AssertionError('Native routing summaries must not call an API provider')
    routing_summary.summary_completion = unexpected
    try:
        context = {'previousSummary': '', 'recent': [], 'message': 'Fix the login bug'}
        prepared = routing_summary.summarize({'context': context, 'model': 'claude-code:haiku', 'prepare': True}, 'ns')
        assert 'model selection' in prepared['system'] and json.loads(prepared['prompt']) == context
        answer = routing_summary.summarize({'context': context, 'model': 'claude-code:haiku',
                                            'response': ' Fix a login bug.\nTask kind: coding\nPrevious reply: neutral ',
                                            'usage': {'total_tokens': 42}}, 'ns')
        assert answer == {'summary': 'Fix a login bug.\nTask kind: coding\nPrevious reply: neutral',
                          'model': 'claude-code:haiku', 'usage': {'total_tokens': 42}}, answer
        for response in [None, '', '```x```', 'x' * 3001]:
            try:
                routing_summary.summarize({'context': context, 'model': 'claude-code:haiku', 'response': response}, 'ns')
            except ValueError:
                pass
            else:
                raise AssertionError('Invalid native response accepted')
    finally:
        routing_summary.summary_completion = original


if __name__ == '__main__':
    test_native_routing_summary_prepares_and_validates_without_api_calls()
    print('ok')
