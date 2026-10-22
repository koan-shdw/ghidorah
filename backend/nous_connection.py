"""Nous Portal sign-in with app-owned credential stores."""
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlsplit


def test_endpoint(namespace):
    import os
    value = os.environ.get('TRISMEGISTUS_TEST_NOUS_URL')
    if not value: return
    parsed = urlsplit(value)
    if not namespace.startswith('Trismegistus/Test/') or parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Invalid isolated Nous endpoint.')
    os.environ['HERMES_PORTAL_BASE_URL'] = value
    os.environ['NOUS_INFERENCE_BASE_URL'] = value + '/v1'
    from hermes_cli import auth, auth_nous
    # Named chat profiles deliberately ignore the root's environment overrides.
    for module in (auth, auth_nous):
        module.DEFAULT_NOUS_PORTAL_URL = value
        module.DEFAULT_NOUS_INFERENCE_URL = value + '/v1'
    auth.PROVIDER_REGISTRY['nous'].portal_base_url = value
    auth.PROVIDER_REGISTRY['nous'].inference_base_url = value + '/v1'


def login(emit):
    import os
    from hermes_cli.auth import PROVIDER_REGISTRY, _request_device_code, _poll_for_token, refresh_nous_oauth_from_state
    from hermes_cli.auth_nous import persist_nous_credentials, _nous_http_client
    config = PROVIDER_REGISTRY['nous']
    portal = os.environ.get('HERMES_PORTAL_BASE_URL', config.portal_base_url)
    inference = os.environ.get('NOUS_INFERENCE_BASE_URL', config.inference_base_url)
    with _nous_http_client(20, True) as client:
        device = _request_device_code(client, portal, config.client_id, config.scope)
        url = str(device['verification_uri_complete'])
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or parsed.hostname != 'portal.nousresearch.com' or parsed.username or parsed.password:
            raise ValueError('Nous returned an unsupported sign-in address.')
        emit(dict(type='device', url=url, code=str(device['user_code'])))
        tokens = _poll_for_token(client, portal, config.client_id, str(device['device_code']), int(device['expires_in']), int(device['interval']))
    now = datetime.now(timezone.utc)
    state = refresh_nous_oauth_from_state(dict(portal_base_url=portal, inference_base_url=inference,
        client_id=config.client_id, scope=tokens.get('scope') or config.scope, access_token=tokens['access_token'],
        refresh_token=tokens.get('refresh_token'), token_type=tokens.get('token_type','Bearer'),
        obtained_at=now.isoformat(), expires_at=(now+timedelta(seconds=int(tokens['expires_in']))).isoformat()))
    persist_nous_credentials(state)
    emit(dict(type='connected'))


def status(check=False):
    from hermes_cli.auth import get_provider_auth_state, resolve_nous_runtime_credentials, AuthError
    from api_providers import json_get, text_model
    from urllib.error import HTTPError
    state = get_provider_auth_state('nous') or {}
    connected = bool(state.get('access_token'))
    result = dict(provider='nous', connected=connected, models=[], source='unverified', checkedAt=None,
        status='Unverified' if connected else 'Not connected', baseUrl=state.get('inference_base_url', 'https://inference-api.nousresearch.com/v1'))
    if not connected or not check: return result
    try:
        credentials = resolve_nous_runtime_credentials()
        payload = json_get(credentials['base_url'].rstrip('/') + '/models', {'Authorization':'Bearer ' + credentials['api_key']})
        if not isinstance(payload.get('data'), list): raise ValueError('Model list unavailable')
        result.update(models=[model for row in payload['data'] if isinstance(row, dict) and (model := text_model('nous', row))],
                      source='live', status='Connected', baseUrl=credentials['base_url'])
    except AuthError as error:
        result.update(status='Sign in again' if error.relogin_required else 'Connection check unavailable', authFailed=error.relogin_required)
    except HTTPError as error:
        result.update(status='Sign in again' if error.code == 401 else 'Access denied' if error.code == 403 else 'Model list unavailable · add a model by ID', authFailed=error.code == 401)
    except Exception:
        result['status'] = 'Connection check unavailable'
    result['checkedAt'] = datetime.now(timezone.utc).isoformat()
    return result


def disconnect():
    import os
    from hermes_cli.auth import _auth_store_lock, _load_auth_store, _save_auth_store
    from hermes_cli.auth_nous import _clear_shared_nous_state
    root = Path(os.environ['HERMES_HOME'])
    # Nous also seeds per-chat pools; remove only this supplier from every app-owned store.
    for file in [root / 'auth.json', *(root / 'profiles').glob('p-*/auth.json')]:
        if not file.is_file(): continue
        with _auth_store_lock(target_path=file):
            store = _load_auth_store(file)
            store.get('providers', {}).pop('nous', None)
            store.get('credential_pool', {}).pop('nous', None)
            if store.get('active_provider') == 'nous': store.pop('active_provider')
            _save_auth_store(store, target_path=file)
    _clear_shared_nous_state('app disconnect')
