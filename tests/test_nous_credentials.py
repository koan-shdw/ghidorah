"""Real Windows-vault codec round-trip for the app-owned Nous mirror."""
import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'backend'), str(ROOT / 'runtime/hermes')]
import windows_credentials as vault
from security import install_codec, migrate
from hermes_cli import auth


class NousCredentials(unittest.TestCase):
    def test_mirror_and_legacy_migration(self):
        namespace = 'Trismegistus/Test/nous-codec-' + uuid.uuid4().hex
        old = {key: os.environ.get(key) for key in ('HERMES_HOME', 'HERMES_SHARED_AUTH_DIR')}
        try:
            with tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                os.environ['HERMES_HOME'] = str(home)
                os.environ['HERMES_SHARED_AUTH_DIR'] = str(home / 'shared')
                vault.put(namespace + '/encryption', os.urandom(32))
                install_codec(namespace + '/encryption')
                state = dict(access_token='synthetic-nous-access', refresh_token='synthetic-nous-refresh', expires_at='2099-01-01T00:00:00+00:00')
                auth._write_shared_nous_state(state)
                mirror = home / 'shared' / 'nous_auth.json'
                stored = mirror.read_text()
                self.assertEqual(json.loads(stored)['credential_envelope'], 1)
                self.assertNotIn(state['access_token'], stored)
                self.assertNotIn(state['refresh_token'], stored)
                self.assertEqual(auth._read_shared_nous_state()['refresh_token'], state['refresh_token'])
                mirror.write_text(json.dumps(state))
                migrate(home)
                self.assertNotIn(state['access_token'], mirror.read_text())
                self.assertEqual(auth._read_shared_nous_state()['access_token'], state['access_token'])
        finally:
            vault.delete(namespace + '/encryption')
            for key, value in old.items():
                if value is None: os.environ.pop(key, None)
                else: os.environ[key] = value


if __name__ == '__main__': unittest.main()
