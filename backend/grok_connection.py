"""Grok subscription sign-in through Hermes's renewable device grant."""
from datetime import datetime, timezone
from urllib.parse import urlsplit


def test_endpoint(namespace):
    import os
    value = os.environ.get('TRISMEGISTUS_TEST_GROK_URL')
    if not value:
        return
    parsed = urlsplit(value)
    if not namespace.startswith('Trismegistus/Test/') or parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Invalid isolated Grok endpoint.')
    from hermes_cli import auth, auth_xai
    for module in (auth, auth_xai):
        module.XAI_OAUTH_DISCOVERY_URL = value + '/discovery'
        module.XAI_OAUTH_DEVICE_CODE_URL = value + '/device'
        module.DEFAULT_XAI_OAUTH_BASE_URL = value + '/v1'
    original = auth_xai._xai_validate_oauth_endpoint
    def validate(url, *, field):
        return url if url == value + '/token' else original(url, field=field)
    auth_xai._xai_validate_oauth_endpoint = validate


def login(emit):
    import httpx
    from hermes_cli.auth_xai import _xai_oauth_request_device_code
    from hermes_cli.auth import _xai_oauth_discovery, _xai_oauth_poll_device_token, _save_xai_oauth_tokens
    discovery = _xai_oauth_discovery()
    with httpx.Client(timeout=20, headers={'Accept': 'application/json'}) as client:
        device = _xai_oauth_request_device_code(client)
        url = str(device.get('verification_uri_complete') or device['verification_uri'])
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or parsed.hostname not in ('auth.x.ai', 'accounts.x.ai') or parsed.username or parsed.password:
            raise ValueError('Grok returned an unsupported sign-in address.')
        emit({'type': 'device', 'url': url, 'code': str(device['user_code'])})
        tokens = _xai_oauth_poll_device_token(client, token_endpoint=discovery['token_endpoint'],
            device_code=str(device['device_code']), expires_in=int(device['expires_in']), poll_interval=int(device['interval']))
    _save_xai_oauth_tokens(tokens, discovery=discovery, set_active=False)
    emit({'type': 'connected'})


def status(check=False):
    from hermes_cli.auth import resolve_xai_oauth_runtime_credentials, AuthError
    from api_providers import json_get, text_model
    from urllib.error import HTTPError
    result = dict(provider='xai-oauth', connected=False, status='Not connected', models=[],
                  baseUrl='https://api.x.ai/v1', source='unverified', checkedAt=None)
    try:
        credential = resolve_xai_oauth_runtime_credentials(refresh_if_expiring=check)
    except AuthError as error:
        if error.code == 'xai_oauth_tier_denied':
            result['status'] = 'Subscription access denied by xAI'
        elif 'missing' not in (error.code or ''):
            result['status'] = 'Sign in again' if error.relogin_required else 'Connection check unavailable'
        return result
    result.update(connected=True, status='Unverified', baseUrl=credential['base_url'])
    if not check:
        return result
    try:
        data = json_get(credential['base_url'].rstrip('/') + '/models', {'Authorization': 'Bearer ' + credential['api_key']})
        if not isinstance(data.get('data'), list):
            raise ValueError('Model list unavailable')
        models = [model for row in data['data'] if isinstance(row, dict) and (model := text_model('xai-oauth', row))]
        result.update(models=models, status='Connected', source='live')
    except HTTPError as error:
        result.update(status='Sign in again' if error.code == 401 else 'Subscription access denied by xAI' if error.code == 403 else 'Model check unavailable', authFailed=error.code == 401)
    except Exception:
        result['status'] = 'Model check unavailable'
    result['checkedAt'] = datetime.now(timezone.utc).isoformat()
    return result


def disconnect():
    from hermes_cli.auth import _auth_store_lock, _load_auth_store, _save_auth_store
    with _auth_store_lock():
        store = _load_auth_store()
        store.get('providers', {}).pop('xai-oauth', None)
        store.get('credential_pool', {}).pop('xai-oauth', None)
        if store.get('active_provider') == 'xai-oauth':
            store.pop('active_provider')
        _save_auth_store(store)
