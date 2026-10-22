"""Real Google credential constructors and HTTP refresh across app profile scopes."""
import json
import sys
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'backend'), str(ROOT / 'runtime/hermes')]
import vertex_connection as vertex
import windows_credentials as vault
from security import install_codec
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from agent import vertex_adapter
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization


class VertexCredentials(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.namespace = 'Trismegistus/Test/vertex-' + str(uuid.uuid4())
        import os
        vault.put(self.namespace + '/encryption', os.urandom(32))
        install_codec(self.namespace + '/encryption')
        self.calls = []
        self.fail = False
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                owner.calls.append(self.rfile.read(int(self.headers['Content-Length'])).decode())
                owner.entered.set()
                owner.release.wait(5)
                self.send_response(400 if owner.fail else 200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': 'invalid_grant'} if owner.fail else {'access_token': 'test-access-' + str(len(owner.calls)), 'expires_in': 3600, 'token_type': 'Bearer'}).encode())
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.env = patch.dict(os.environ, {'TRISMEGISTUS_TEST_VERTEX_URL': 'http://127.0.0.1:' + str(self.server.server_port)})
        self.env.start()
        self.info = dict(type='authorized_user', client_id='test-client', client_secret='test-secret', refresh_token='test-refresh')
        self.file = self.root / 'import.json'
        self.store(self.info)
        vertex.install(self.root, self.namespace)

    def tearDown(self):
        vertex_adapter.set_host_vertex_config_resolver(None)
        self.env.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        vault.delete(self.namespace + '/encryption')
        self.temp.cleanup()

    def store(self, info):
        self.file.write_text(json.dumps(info), encoding='utf-8')
        vertex.save(self.root, self.file, 'fixture-project', 'global')

    def scoped(self, profile):
        token = set_hermes_home_override(profile)
        try: return vertex_adapter.get_vertex_config()
        finally: reset_hermes_home_override(token)

    def test_shared_refresh_expiry_and_profile_boundary(self):
        profiles = [self.root / 'profiles' / ('p-' + str(uuid.uuid4())) for _ in range(2)]
        for profile in profiles: profile.mkdir(parents=True)
        with ThreadPoolExecutor(2) as pool:
            replies = list(pool.map(self.scoped, profiles))
        self.assertEqual(replies[0], replies[1])
        self.assertEqual(len(self.calls), 1)
        value = vertex.read(self.root)
        value['access']['expires'] = 0
        vertex.write(self.root, value)
        self.assertEqual(self.scoped(profiles[0])[0], 'test-access-2')
        self.assertEqual(self.scoped(profiles[1])[0], 'test-access-2')
        for profile in profiles: self.assertFalse(vertex.storage(profile).exists())
        with self.assertRaisesRegex(ValueError, 'outside this app'):
            self.scoped(self.root / 'outside')

    def test_service_account_and_replacement(self):
        self.scoped(self.root)
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        private = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
        self.store(dict(type='service_account', client_email='fixture@fixture-project.iam.gserviceaccount.com', private_key=private, private_key_id='fixture-id'))
        self.assertEqual(self.scoped(self.root)[0], 'test-access-2')
        self.assertIn('assertion=', self.calls[-1])
        stored = vertex.storage(self.root).read_text()
        self.assertNotIn(private, stored)
        self.assertNotIn('test-access', stored)

    def test_invalid_import_preserves_working_credential(self):
        before = vertex.storage(self.root).read_bytes()
        for info in [dict(self.info, token_uri='https://example.com/token'), {}, dict(self.info, universe_domain='example.com')]:
            with self.assertRaises(ValueError): self.store(info)
            self.assertEqual(vertex.storage(self.root).read_bytes(), before)

    def test_disconnect_waits_for_refresh_and_removes_result(self):
        self.release.clear()
        with ThreadPoolExecutor(2) as pool:
            refresh = pool.submit(self.scoped, self.root)
            self.assertTrue(self.entered.wait(5))
            disconnect = pool.submit(vertex.disconnect, self.root)
            with self.assertRaises(TimeoutError):
                disconnect.result(0.1)
            self.release.set()
            refresh.result(10)
            disconnect.result(10)
        self.assertFalse(vertex.storage(self.root).exists())

    def test_failed_refresh_preserves_and_disconnected_refuses_ambient(self):
        self.fail = True
        before = vertex.storage(self.root).read_bytes()
        from google.auth.exceptions import RefreshError
        with self.assertRaises(RefreshError): self.scoped(self.root)
        self.assertEqual(vertex.storage(self.root).read_bytes(), before)
        vertex.storage(self.root).unlink()
        vertex.install(self.root, self.namespace)
        self.assertFalse(vertex_adapter.has_vertex_credentials())
        with self.assertRaisesRegex(ValueError, 'Connect Google Cloud'):
            self.scoped(self.root)


if __name__ == '__main__': unittest.main()
