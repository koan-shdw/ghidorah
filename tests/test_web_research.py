import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'backend'), str(ROOT / 'runtime' / 'hermes')]
from web_research import research, public_url
from plugins.web import keyless_mcp
from tools import url_safety


class WebResearchTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.env = patch.dict(os.environ, {'HERMES_HOME': self.folder.name}, clear=False)
        self.env.start(); self.addCleanup(self.env.stop)
        os.environ.pop('TRISMEGISTUS_TEST_WEB_URL', None)
        from hermes_constants import set_hermes_home_override
        set_hermes_home_override(Path(self.folder.name))
        self.replace(url_safety, '_getaddrinfo', lambda host, port=None: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (host if host[0].isdigit() else '93.184.216.34', 443))])

    def replace(self, obj, name, value):
        mock = patch.object(obj, name, value); mock.start(); self.addCleanup(mock.stop)

    def test_adapter_and_large_page(self):
        seen = []
        self.replace(keyless_mcp, 'exa_search_keyless', lambda query, limit: seen.append((query, limit)) or {'success': True, 'data': {'web': [{'url': 'https://example.com', 'title': 'Docs'}]}})
        self.replace(keyless_mcp, 'mcp_call', lambda endpoint, tool, args: seen.append(args) or '# Docs\n' + 'x' * 1_000_010)
        result = research({'name': 'search_web', 'arguments': {'query': 'official docs', 'limit': 2}}, 'Trismegistus/Test/web')
        self.assertEqual(result['results'][0]['title'], 'Docs')
        result = research({'name': 'read_web_page', 'arguments': {'url': 'https://example.com/docs'}}, 'Trismegistus/Test/web')
        self.assertEqual(len(result['text']), 1_000_000); self.assertTrue(result['truncated'])
        self.assertEqual(seen, [('official docs', 2), {'urls': ['https://example.com/docs'], 'maxCharacters': 1_000_000}])

    def test_private_and_credential_urls(self):
        for url in ['file:///C:/test', 'http://127.0.0.1', 'http://10.1.2.3', 'http://169.254.169.254', 'https://user:pass@example.com', 'https://example.com?api_key=private', 'https://example.com/sk-' + 'a' * 30]:
            with self.subTest(url=url), self.assertRaises(ValueError): public_url(url)

    def test_errors_and_invalid_input(self):
        self.replace(keyless_mcp, 'exa_search_keyless', lambda *args: {'success': False, 'error': 'HTTP 429'})
        def failed(*args): raise RuntimeError('Page unavailable')
        self.replace(keyless_mcp, 'mcp_call', failed)
        with self.assertRaisesRegex(RuntimeError, '429'):
            research({'name': 'search_web', 'arguments': {'query': 'docs'}}, 'Trismegistus/Test/web')
        with self.assertRaisesRegex(RuntimeError, 'Page unavailable'):
            research({'name': 'read_web_page', 'arguments': {'url': 'https://example.com/docs'}}, 'Trismegistus/Test/web')
        for args in [{'query': 'docs', 'limit': True}, {'query': 'docs', 'limit': 11}, {'query': ''}, {'query': 'sk-' + 'a' * 30}, {'query': 'docs', 'headers': {}}]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                research({'name': 'search_web', 'arguments': args}, 'Trismegistus/Test/web')

    def test_production_transport(self):
        os.environ['TRISMEGISTUS_TEST_WEB_URL'] = 'http://127.0.0.1:1234'
        with self.assertRaisesRegex(ValueError, 'isolated'):
            research({'name': 'search_web', 'arguments': {'query': 'docs'}}, 'Trismegistus')


if __name__ == '__main__': unittest.main()
