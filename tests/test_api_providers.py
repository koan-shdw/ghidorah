import sys
import unittest
from pathlib import Path
from unittest.mock import patch
import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'runtime/hermes'), str(ROOT / 'backend')]
import api_providers
import provider_access
from routing_summary import reported_usage


class ApiTests(unittest.TestCase):
    def test_native_summary_counts_remain_reported_and_missing_counts_unknown(self):
        from agent.gemini_native_adapter import translate_gemini_response
        response = translate_gemini_response({'candidates': [{'content': {'parts': [{'text': 'Summary'}]}}],
                                             'usageMetadata': {'promptTokenCount': 100, 'candidatesTokenCount': 20, 'totalTokenCount': 120}}, 'gemini-3.8-flash')
        self.assertEqual(reported_usage(response.usage), dict(prompt_tokens=100, completion_tokens=20, total_tokens=120))
        self.assertIsNone(reported_usage(None))
        self.assertEqual(reported_usage({'prompt_tokens': 100}), {'prompt_tokens': 100})

    def test_catalogue_filters_generation_and_media_endpoints(self):
        self.assertIsNone(api_providers.text_model('gemini', dict(name='models/embedding', supportedGenerationMethods=['embedContent'])))
        self.assertIsNone(api_providers.text_model('xai', dict(id='grok-image')))
        self.assertIsNone(api_providers.text_model('xai', dict(id='grok-test --provider deepseek')))
        row = api_providers.text_model('gemini', dict(name='models/gemini-3.8-flash', supportedGenerationMethods=['generateContent']))
        self.assertEqual(row['id'], 'api:gemini:gemini-3.8-flash')

    def test_native_gemini_guard_checks_url_identity_before_io(self):
        captured = {}
        def install(guard, **hooks):
            captured.update(guard=guard, **hooks)
        class Result:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, size): return b'{"blocked":false}'
        messages = []
        class Opener:
            def open(self, request, **kwargs):
                import json
                messages.append(json.loads(request.data))
                return Result()
        with patch('agent.process_bootstrap.set_provider_request_guard', install), patch('provider_access.build_opener', return_value=Opener()):
            provider_access.install(dict(url='http://127.0.0.1:1234/', token='x'*64), {'gemini': 'https://generativelanguage.googleapis.com/v1beta'})
            before = captured['before_request']
            before(httpx.Request('POST', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse', json={'contents': []}))
            self.assertEqual(messages[0]['provider'], 'gemini')
            self.assertEqual(messages[0]['model'], 'gemini-3.8-flash')
            for url in ['https://elsewhere.test/v1beta/models/gemini:generateContent', 'https://generativelanguage.googleapis.com/foreign/models/gemini:generateContent', 'https://generativelanguage.googleapis.com/v1beta/models/invalid:otherAction']:
                with self.assertRaises(PermissionError): before(httpx.Request('POST', url, json={}))
            self.assertEqual(len(messages), 1)

    def test_gemini_pagination_and_no_post_setup(self):
        with patch('provider_credentials.install'), patch('security.install_codec'), patch.dict('os.environ', HERMES_HOME=str(ROOT/'work/test-api')), patch('hermes_cli.auth.resolve_api_key_provider_credentials', return_value=dict(api_key='test-key', base_url='https://generativelanguage.googleapis.com/v1beta')), patch('api_providers.json_get', side_effect=[{'models': [{'name': 'models/gemini-3.8-flash', 'supportedGenerationMethods': ['generateContent']}], 'nextPageToken':'page 2'}, {'models': [{'name': 'models/gemini-3.8-pro', 'supportedGenerationMethods':['generateContent']}]}]) as get:
            result = api_providers.status('gemini', 'Trismegistus/Test/catalogue', True)
            self.assertEqual(len(result['models']), 2)
            self.assertIn('pageToken=page+2', get.call_args_list[1].args[0])
            self.assertEqual(result['source'], 'live')


if __name__ == '__main__': unittest.main()
