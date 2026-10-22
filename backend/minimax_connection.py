"""MiniMax's PKCE user-code flow with app-owned encrypted credential storage."""
from datetime import datetime, timezone
from urllib.parse import urlsplit


def test_endpoint(namespace):
    import os
    value = os.environ.get('TRISMEGISTUS_TEST_MINIMAX_URL')
    if not value: return
    parsed = urlsplit(value)
    if not namespace.startswith('Trismegistus/Test/') or parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Invalid isolated MiniMax endpoint.')
    from hermes_cli.auth import PROVIDER_REGISTRY
    config = PROVIDER_REGISTRY['minimax-oauth']
    config.portal_base_url = value
    config.inference_base_url = value + '/anthropic'
    config.extra.update(cn_portal_base_url=value + '/cn', cn_inference_base_url=value + '/cn/anthropic')


def login(emit, region='global'):
    import httpx
    from hermes_cli.auth import PROVIDER_REGISTRY, _minimax_save_auth_state
    from hermes_cli.auth_minimax import _minimax_pkce_pair, _minimax_request_user_code, _minimax_poll_token, _minimax_expiry_fields
    config = PROVIDER_REGISTRY['minimax-oauth']
    if region not in ('global', 'cn'): raise ValueError('Choose Global or China.')
    portal = config.extra['cn_portal_base_url'] if region == 'cn' else config.portal_base_url
    inference = config.extra['cn_inference_base_url'] if region == 'cn' else config.inference_base_url
    verifier, challenge, state = _minimax_pkce_pair()
    with httpx.Client(timeout=20, follow_redirects=False) as client:
        device = _minimax_request_user_code(client, portal_base_url=portal,
            client_id=config.client_id, code_challenge=challenge, state=state)
        url = str(device['verification_uri'])
        parsed = urlsplit(url)
        domain = 'minimaxi.com' if region == 'cn' else 'minimax.io'
        if parsed.scheme != 'https' or not parsed.hostname or not (parsed.hostname == domain or parsed.hostname.endswith('.' + domain)) or parsed.username or parsed.password:
            raise ValueError('MiniMax returned an unsupported sign-in address.')
        emit(dict(type='device', url=url, code=str(device['user_code'])))
        tokens = _minimax_poll_token(client, portal_base_url=portal, client_id=config.client_id,
            user_code=str(device['user_code']), code_verifier=verifier, expired_in=int(device['expired_in']), interval_ms=device.get('interval'))
    _minimax_save_auth_state(dict(provider='minimax-oauth', region=region, portal_base_url=portal,
        inference_base_url=inference, client_id=config.client_id, scope=config.scope,
        access_token=tokens['access_token'], refresh_token=tokens['refresh_token'], token_type=tokens.get('token_type','Bearer'),
        **_minimax_expiry_fields(tokens['expired_in'])))
    emit(dict(type='connected'))


def status(check=False):
    from hermes_cli.auth import get_provider_auth_state, resolve_minimax_oauth_runtime_credentials, AuthError
    from api_providers import json_get, text_model
    from urllib.error import HTTPError
    state = get_provider_auth_state('minimax-oauth') or {}
    result = dict(provider='minimax-oauth', connected=bool(state.get('access_token')), models=[], source='unverified',
        checkedAt=None, status='Unverified' if state.get('access_token') else 'Not connected',
        baseUrl=state.get('inference_base_url', 'https://api.minimax.io/anthropic'), region=state.get('region','global'))
    if not check or not result['connected']: return result
    try:
        credentials = resolve_minimax_oauth_runtime_credentials()
        payload = json_get(credentials['base_url'].rstrip('/') + '/v1/models',
            {'Authorization':'Bearer ' + credentials['api_key'], 'anthropic-version':'2023-06-01'})
        if not isinstance(payload.get('data'), list): raise ValueError('Model list unavailable')
        models = [model for row in payload['data'] if isinstance(row,dict) and (model := text_model('minimax-oauth',row))]
        result.update(models=models, source='live', status='Connected')
    except AuthError as error:
        result.update(status='Sign in again' if error.relogin_required else 'Connection check unavailable', authFailed=error.relogin_required)
    except HTTPError as error:
        result.update(status='Sign in again' if error.code == 401 else 'Access denied' if error.code == 403 else 'Model list unavailable · add a model by ID', authFailed=error.code == 401)
    except Exception:
        result['status'] = 'Connection check unavailable'
    result['checkedAt'] = datetime.now(timezone.utc).isoformat()
    return result


def disconnect():
    from hermes_cli.auth import _auth_store_lock, _load_auth_store, _save_auth_store
    with _auth_store_lock():
        store = _load_auth_store()
        store.get('providers',{}).pop('minimax-oauth',None)
        store.get('credential_pool',{}).pop('minimax-oauth',None)
        if store.get('active_provider') == 'minimax-oauth': store.pop('active_provider')
        _save_auth_store(store)
