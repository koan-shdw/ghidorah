"""Explicit fallback and summary endpoints take precedence over profile defaults."""
import base64
import json

from agent.auxiliary_client import resolve_provider_client
from hermes_cli.auth import _save_codex_tokens


def test_explicit_codex_endpoint_for_raw_and_auxiliary_clients(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    claims = base64.urlsafe_b64encode(json.dumps({'exp': 9999999999}).encode()).decode().rstrip('=')
    token = 'fixture.' + claims + '.signature'
    _save_codex_tokens({'access_token': token, 'refresh_token': 'fixture-refresh'}, set_active=False)
    for raw in (True, False):
        client, model = resolve_provider_client('openai-codex', model='gpt-fixture',
                                               raw_codex=raw, explicit_base_url='http://127.0.0.1:12345/codex')
        try:
            assert str(client.base_url).rstrip('/') == 'http://127.0.0.1:12345/codex'
            assert client.api_key == token
            assert model == 'gpt-fixture'
        finally:
            client.close()
