"""OpenRouter PKCE through Hermes callback helpers and the app's OS vault."""
import secrets
from urllib.parse import urlencode


def login(emit, namespace):
    from hermes_cli.auth_device_flow import (
        _bind_loopback_callback_server, _make_loopback_callback_handler,
        _serve_loopback_callback, _pkce_code_verifier, _pkce_code_challenge)
    from hermes_cli.auth_constants import _openrouter_err, OPENROUTER_AUTH_URL
    from hermes_cli.auth_openrouter import _openrouter_exchange_code
    import windows_credentials as vault
    verifier = _pkce_code_verifier()
    path = '/callback/' + secrets.token_urlsafe(24)
    handler, result = _make_loopback_callback_handler(path, display_name='Ghidorah')
    server = _bind_loopback_callback_server('127.0.0.1', 0, handler,
        err=_openrouter_err, bind_failed_code='openrouter_callback_bind_failed')
    callback = f'http://127.0.0.1:{server.server_address[1]}{path}'
    url = OPENROUTER_AUTH_URL + '?' + urlencode(dict(callback_url=callback,
        code_challenge=_pkce_code_challenge(verifier), code_challenge_method='S256', key_label='Ghidorah'))
    emit(dict(type='device', url=url, code=''))
    result = _serve_loopback_callback(server, result, timeout_seconds=300,
        err=_openrouter_err, timeout_code='openrouter_callback_timeout')
    if result.get('error') or not result.get('code'):
        raise ValueError('OpenRouter sign-in was not authorized. Start sign-in again.')
    # The synthetic exchange is restricted to this test namespace and its configured loopback API.
    import os, json
    endpoint = json.loads(os.environ.get('TRISMEGISTUS_TEST_API_URLS', '{}')).get('openrouter-api')
    if endpoint and namespace.startswith('Trismegistus/Test/'):
        from hermes_cli import auth_openrouter
        auth_openrouter.OPENROUTER_AUTH_KEYS_URL = endpoint.rstrip('/') + '/auth/keys'
    key = _openrouter_exchange_code(str(result['code']), verifier)
    vault.put(namespace + '/openrouter-api', key.encode())
    emit(dict(type='connected'))
