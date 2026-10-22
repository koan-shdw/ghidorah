"""Claude models summarise apps through the background Claude runner (Koan: "why doesnt it show sonnet 5.5 as an
ioption for the summary?"): the backend prepares the prompt and validates Claude's answer without an API call."""
import json
from pathlib import Path
import sys

APP = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(APP / 'backend'), str(APP / 'runtime' / 'hermes')]
import app_summary


def test_native_summary_prepares_and_validates_without_api_calls():
    original = app_summary.summary_completion
    def unexpected(*args, **kwargs):
        raise AssertionError('Native summaries must not call an API provider')
    app_summary.summary_completion = unexpected
    try:
        for context, prompt in [({'previous': [], 'sources': [{'id': 's1', 'text': 'Build the overview.'}]}, app_summary.PROMPT),
                                ({'todos': [{'id': 't1', 'notes': 'Make the dashboard faster'}]}, app_summary.TODO_PROMPT)]:
            prepared = app_summary.summarize({'context': context, 'prepare': True}, 'ns')
            assert prepared['system'] == prompt and json.loads(prepared['prompt']) == context
            items = [{'id': 't1', 'text': 'Faster dashboard'}]
            answer = app_summary.summarize({'context': context, 'response': '```json\n' + json.dumps({'items': items}) + '\n```',
                                            'usage': {'input_tokens': 10, 'output_tokens': 5}}, 'ns')
            assert answer['items'] == items, answer
        for response in [None, '[]', 'not json', 'x' * 60001]:
            try:
                app_summary.summarize({'context': {'todos': []}, 'response': response}, 'ns')
            except (ValueError, TypeError):
                pass
            else:
                raise AssertionError('Invalid native response accepted')
    finally:
        app_summary.summary_completion = original


if __name__ == '__main__':
    test_native_summary_prepares_and_validates_without_api_calls()
    print('ok')
