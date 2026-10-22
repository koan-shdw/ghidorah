"""Shared MiniMax grants stay in their owning store across refresh and rejection."""
import threading
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from hermes_cli import auth, auth_minimax
from hermes_constants import set_hermes_home_override, reset_hermes_home_override


@pytest.fixture
def shared(tmp_path, monkeypatch):
    root = tmp_path / 'root'
    root.mkdir()
    monkeypatch.setenv('HERMES_HOME', str(root))
    monkeypatch.setattr(auth, '_global_auth_file_path', lambda: root / 'auth.json')
    profiles = [root / 'profiles' / name for name in ('a', 'b')]
    for profile in profiles: profile.mkdir(parents=True)
    auth._minimax_save_auth_state(dict(access_token='expired', refresh_token='single-use',
        expires_at='2000-01-01T00:00:00+00:00', portal_base_url='https://example.invalid',
        inference_base_url='https://example.invalid/anthropic', client_id='test-client'))
    return root, profiles


def resolve(profile):
    scope = set_hermes_home_override(profile)
    try: return auth.resolve_minimax_oauth_runtime_credentials()['api_key']
    finally: reset_hermes_home_override(scope)


def test_concurrent_profiles_refresh_owner_once(shared, monkeypatch):
    root, profiles = shared
    entered, second = threading.Event(), threading.Event()
    calls = []
    def post(client, url, *, data, headers):
        calls.append(data['refresh_token'])
        entered.set()
        if len(calls) > 1: second.set()
        second.wait(2)
        return httpx.Response(200, json=dict(status='success', access_token='fresh', refresh_token='rotated', expired_in=7200))
    monkeypatch.setattr(auth_minimax, '_minimax_post_form', post)
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(resolve, profiles[0])
        assert entered.wait(5)
        other = pool.submit(resolve, profiles[1])
        assert first.result(10) == other.result(10) == 'fresh'
    assert calls == ['single-use']
    assert resolve(profiles[0]) == 'fresh'
    assert auth._load_auth_store(root / 'auth.json')['providers']['minimax-oauth']['refresh_token'] == 'rotated'
    assert all('minimax-oauth' not in auth._load_auth_store(p / 'auth.json').get('providers', {}) for p in profiles)


def test_terminal_failure_quarantines_owner(shared, monkeypatch):
    root, profiles = shared
    def rejected(*args, **kwargs):
        raise auth.AuthError('Expired grant', provider='minimax-oauth', code='refresh_failed', relogin_required=True)
    monkeypatch.setattr(auth, '_refresh_minimax_oauth_state', rejected)
    with pytest.raises(auth.AuthError): resolve(profiles[0])
    assert not auth._load_auth_store(root / 'auth.json')['providers']['minimax-oauth'].get('refresh_token')
    assert 'minimax-oauth' not in auth._load_auth_store(profiles[0] / 'auth.json').get('providers', {})
