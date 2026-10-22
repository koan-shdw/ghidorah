"""The Nous shared mirror must honor the same host codec as auth.json."""
import base64
import json
import os

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from hermes_cli import auth, credential_codec


@pytest.fixture
def shared(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'home'))
    monkeypatch.setenv('HERMES_SHARED_AUTH_DIR', str(tmp_path / 'shared'))
    cipher = AESGCM(AESGCM.generate_key(bit_length=256))
    def seal(value):
        nonce = os.urandom(12)
        payload = nonce + cipher.encrypt(nonce, json.dumps(value).encode(), None)
        return dict(credential_envelope=1, payload=base64.b64encode(payload).decode())
    def decrypt(value):
        payload = base64.b64decode(value['payload'])
        return json.loads(cipher.decrypt(payload[:12], payload[12:], None))
    monkeypatch.setattr(credential_codec, '_seal', seal)
    monkeypatch.setattr(credential_codec, '_open', decrypt)
    return tmp_path


def state(token='test-access'):
    return dict(access_token=token, refresh_token='test-refresh',
                expires_at='2099-01-01T00:00:00+00:00')


def test_shared_mirror_encrypted_and_isolated(shared, monkeypatch):
    auth._write_shared_nous_state(state())
    path = auth._nous_shared_store_path()
    content = path.read_text()
    assert 'test-access' not in content and 'test-refresh' not in content
    assert json.loads(content)['credential_envelope'] == 1
    assert auth._read_shared_nous_state()['access_token'] == 'test-access'
    monkeypatch.setenv('HERMES_SHARED_AUTH_DIR', str(shared / 'second'))
    assert auth._read_shared_nous_state() is None
    auth._write_shared_nous_state(state('second-access'))
    assert auth._read_shared_nous_state()['access_token'] == 'second-access'
    monkeypatch.setenv('HERMES_SHARED_AUTH_DIR', str(shared / 'shared'))
    assert auth._read_shared_nous_state()['access_token'] == 'test-access'


def test_encrypted_mirror_requires_codec(shared, monkeypatch):
    auth._write_shared_nous_state(state())
    monkeypatch.setattr(credential_codec, '_open', None)
    with pytest.raises(credential_codec.CredentialDecryptionError):
        auth._read_shared_nous_state()


def test_corrupt_envelope_is_not_an_empty_store(shared):
    auth._write_shared_nous_state(state())
    path = auth._nous_shared_store_path()
    path.write_text(json.dumps(dict(credential_envelope=1, payload='broken')))
    before = path.read_bytes()
    with pytest.raises(credential_codec.CredentialDecryptionError):
        auth._read_shared_nous_state()
    assert path.read_bytes() == before


def test_plain_cli_store_still_works(shared, monkeypatch):
    monkeypatch.setattr(credential_codec, '_seal', None)
    auth._write_shared_nous_state(state())
    assert auth._read_shared_nous_state()['access_token'] == 'test-access'
