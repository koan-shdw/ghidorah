"""Shared xAI grants rotate once across concurrently active profiles."""
import base64
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from hermes_cli import auth
from hermes_constants import set_hermes_home_override, reset_hermes_home_override


def jwt(exp):
    return 'header.' + base64.urlsafe_b64encode(json.dumps({'exp': exp}).encode()).decode().rstrip('=') + '.sig'


@pytest.fixture
def shared(tmp_path, monkeypatch):
    root = tmp_path / 'root'
    root.mkdir()
    monkeypatch.setenv('HERMES_HOME', str(root))
    monkeypatch.setenv('HOME', str(tmp_path / 'unrelated'))
    monkeypatch.setattr(auth, '_global_auth_file_path', lambda: root / 'auth.json')
    profiles = [root / 'profiles' / name for name in ('a', 'b')]
    for profile in profiles:
        profile.mkdir(parents=True)
    auth._save_xai_oauth_tokens({'access_token': jwt(1), 'refresh_token': 'single-use'},
                               discovery={'token_endpoint': 'https://auth.x.ai/token'}, set_active=False)
    return root, profiles


def test_concurrent_profiles_refresh_root_once(shared, monkeypatch):
    root, profiles = shared
    entered = threading.Event()
    calls = []
    fresh = jwt(time.time() + 7200)

    def refresh(access, token, **kwargs):
        calls.append(token)
        entered.set()
        time.sleep(.3)
        return {'access_token': fresh, 'refresh_token': 'rotated', 'last_refresh': 'now'}

    monkeypatch.setattr(auth, 'refresh_xai_oauth_pure', refresh)

    def resolve(profile):
        scope = set_hermes_home_override(profile)
        try:
            return auth.resolve_xai_oauth_runtime_credentials()['api_key']
        finally:
            reset_hermes_home_override(scope)

    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(resolve, profiles[0])
        assert entered.wait(5)
        second = pool.submit(resolve, profiles[1])
        assert first.result(10) == second.result(10) == fresh
    assert calls == ['single-use']
    assert resolve(profiles[0]) == fresh
    assert auth._load_auth_store(root / 'auth.json')['providers']['xai-oauth']['tokens']['refresh_token'] == 'rotated'
    assert all('xai-oauth' not in auth._load_auth_store(p / 'auth.json').get('providers', {}) for p in profiles)


def test_failed_refresh_quarantines_source_not_profile(shared, monkeypatch):
    root, profiles = shared

    def rejected(*args, **kwargs):
        raise auth.AuthError('Expired grant', provider='xai-oauth', code='xai_refresh_failed', relogin_required=True)

    monkeypatch.setattr(auth, 'refresh_xai_oauth_pure', rejected)
    scope = set_hermes_home_override(profiles[0])
    try:
        with pytest.raises(auth.AuthError):
            auth.resolve_xai_oauth_runtime_credentials()
    finally:
        reset_hermes_home_override(scope)
    assert not auth._load_auth_store(root / 'auth.json')['providers']['xai-oauth']['tokens'].get('refresh_token')
    assert 'xai-oauth' not in auth._load_auth_store(profiles[0] / 'auth.json').get('providers', {})
