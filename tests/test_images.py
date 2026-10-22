import base64
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

APP = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(APP / 'backend'), str(APP / 'runtime' / 'hermes')]
import httpx
from PIL import Image
import images


def picture(fmt='PNG'):
    out = io.BytesIO()
    Image.new('RGB', (16, 16), 'blue').save(out, format=fmt)
    return base64.b64encode(out.getvalue()).decode()


class Images(unittest.TestCase):
    def run_request(self, provider='xai', status=200, body=None, **args):
        calls = []
        def serve(request):
            calls.append(request)
            return httpx.Response(status, json=body if body is not None else {'data': [{'b64_json': picture('JPEG')}], 'usage': {'images': 1}})
        client = httpx.Client(transport=httpx.MockTransport(serve))
        with patch.object(images, 'credentials', return_value={'api_key': 'test-private-key'}), patch('httpx.Client', return_value=client):
            result = images.generate({'provider': provider, 'model': images.CATALOG[provider]['models'][0], 'prompt': 'A blue square', **args}, 'Trismegistus/Test/images')
        return result, calls

    def test_generate_and_edit_all_transports(self):
        for provider in images.CATALOG:
            for references in ([], [picture()], [picture(), picture()]):
                body = {'candidates': [{'content': {'parts': [{'inlineData': {'mimeType': 'image/png', 'data': picture()}}]}}]} if provider == 'gemini' else None
                result, calls = self.run_request(provider, body=body, sources=references)
                self.assertNotIn('error', result)
                self.assertEqual(len(calls), 1)
                raw, mime, size = images.image_bytes(result['image'])
                self.assertEqual(mime, 'image/png')
                self.assertEqual(size, [16, 16])
                request = calls[0]
                self.assertNotIn('test-private-key', str(request.url))
                if provider == 'openai-api' and references:
                    self.assertIn('multipart/form-data', request.headers['content-type'])
                    self.assertIn(b'image[]', request.content)
                else:
                    payload = json.loads(request.content)
                    if provider == 'xai' and references:
                        self.assertIn('image' if len(references) == 1 else 'images', payload)

    def test_bad_inputs_never_send(self):
        for args in ({'sources': ['invalid']}, {'sources': [picture()] * 5}, {'aspect': 'giant'}, {'transparent': True}, {'prompt': ''}):
            result, calls = self.run_request(**args)
            self.assertEqual(calls, [])
            self.assertEqual(result['outcome'], 'refused')
            self.assertFalse(result['attempted'])
        for raw in (b'<svg></svg>', b'invalid'):
            with self.assertRaises(ValueError):
                images.image_bytes(base64.b64encode(raw).decode())

    def test_no_retries_redirects_or_error_body_leaks(self):
        for status in (302, 400, 401, 403, 408, 429, 500):
            result, calls = self.run_request(status=status, body={'error': 'test-private-key confidential'})
            self.assertEqual(len(calls), 1)
            self.assertNotIn('test-private-key', json.dumps(result))
            self.assertEqual(result['outcome'], 'refused' if status in (400, 401, 403, 429) else 'unknown')

    def test_invalid_output_keeps_billing_uncertainty(self):
        result, calls = self.run_request(body={'data': [{'b64_json': 'invalid'}]})
        self.assertEqual(result['outcome'], 'unknown')
        self.assertEqual(len(calls), 1)

    def test_no_image_is_completed_request(self):
        result, _ = self.run_request(body={'data': []})
        self.assertEqual(result['outcome'], 'finished')
        result, _ = self.run_request(body={'data': [{'b64_json': picture(), 'respect_moderation': False}]})
        self.assertEqual(result['outcome'], 'finished')

    def test_openai_transparency(self):
        result, calls = self.run_request('openai-api', transparent=True)
        self.assertNotIn('error', result)
        self.assertEqual(json.loads(calls[0].content)['background'], 'transparent')

if __name__ == '__main__':
    unittest.main()
