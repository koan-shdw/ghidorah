import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'runtime/hermes'), str(ROOT / 'backend')]
from gemini_quota import refusal


def quota(model=True):
    return {'error': {'code': 429, 'status': 'RESOURCE_EXHAUSTED', 'details': [
        {'@type': 'type.googleapis.com/google.rpc.QuotaFailure', 'violations': [
            {'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
             'quotaDimensions': {'model': 'gemini-3.8-flash'} if model else {}}]},
        {'@type': 'type.googleapis.com/google.rpc.RetryInfo', 'retryDelay': '2s'}]}}


class QuotaTests(unittest.TestCase):
    def test_model_and_shared_quota_without_inventing_reset(self):
        self.assertEqual(refusal(quota(), 'gemini-flash-latest'), dict(provider='gemini', model='gemini-flash-latest', layer='provider', code='model_quota_exhausted'))
        self.assertEqual(refusal(quota(False), 'gemini-3.8-flash')['code'], 'quota_exhausted')
        both = quota()
        both['error']['details'][0]['violations'].extend(quota(False)['error']['details'][0]['violations'])
        self.assertEqual(refusal(both, 'gemini-3.8-flash')['code'], 'quota_exhausted')

    def test_transient_or_malformed_error_is_not_durable_quota(self):
        for body in (None, [], {'error': 'bad'}, {'error': {'status': 'RESOURCE_EXHAUSTED'}},
                     {'error': {'status': 'RESOURCE_EXHAUSTED', 'details': 'bad'}},
                     {'error': {'status': 'RESOURCE_EXHAUSTED', 'details': [{'@type': 'type.googleapis.com/google.rpc.QuotaFailure', 'violations': [None, {}]}]}}):
            self.assertIsNone(refusal(body, 'gemini-3.8-flash'))
        body = quota();body['error']['status'] = 'UNAVAILABLE'
        self.assertIsNone(refusal(body, 'gemini-3.8-flash'))

    def test_native_classifier_stops_known_quota_but_retains_transient_retry(self):
        import httpx
        from provider_profiles import install
        from agent.error_classifier import classify_api_error
        from agent.gemini_native_adapter import gemini_http_error
        install()
        request = httpx.Request('POST', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent')
        error = gemini_http_error(httpx.Response(429, request=request, json=quota()))
        result = classify_api_error(error, provider='gemini', model='gemini-3.8-flash')
        self.assertEqual(result.reason.value, 'rate_limit')
        self.assertFalse(result.retryable)
        self.assertFalse(result.should_fallback)
        transient = gemini_http_error(httpx.Response(429, request=request, json={'error': {'status': 'RESOURCE_EXHAUSTED', 'message': 'Try again later'}}))
        self.assertTrue(classify_api_error(transient, provider='gemini', model='gemini-3.8-flash').retryable)

    def test_owner_receives_quota_before_any_sdk_retry_and_rejects_without_billing_error(self):
        import json
        import httpx
        import provider_access
        from openai import APIStatusError
        from agent.error_classifier import classify_api_error
        from provider_profiles import install
        install();captured = {};messages = []
        class Reply:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, size): return json.dumps({'blocked': len(messages) > 1, 'reason': 'limit', 'message': 'Usage limit reached'}).encode()
        class Opener:
            def open(self, request, **kwargs): messages.append(json.loads(request.data));return Reply()
        with patch('agent.process_bootstrap.set_provider_request_guard', lambda guard, **hooks: captured.update(hooks)), patch('provider_access.build_opener', return_value=Opener()):
            provider_access.install({'url': 'http://127.0.0.1:1234/', 'token': 'x'*64}, {'gemini': 'https://generativelanguage.googleapis.com/v1beta'})
            request = httpx.Request('POST', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', json={'contents': []})
            captured['after_response'](httpx.Response(429, request=request, json=quota()))
            self.assertEqual(messages[0]['surface']['code'], 'model_quota_exhausted')
            with self.assertRaises(APIStatusError) as caught: captured['before_request'](request)
            result = classify_api_error(caught.exception, provider='gemini', model='gemini-3.8-flash')
            self.assertEqual(result.reason.value, 'rate_limit');self.assertFalse(result.retryable)


if __name__ == '__main__': unittest.main()
