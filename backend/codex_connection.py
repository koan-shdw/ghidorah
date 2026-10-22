"""ChatGPT sign-in uses Hermes's own encrypted root grant; no Codex CLI adoption."""
import contextlib
import json
import sys
import math
import os
from pathlib import Path


def disconnect():
    from hermes_cli.auth import clear_provider_auth
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    root = Path(os.environ['HERMES_HOME'])
    # Old app profiles can shadow the shared grant. Leave other suppliers and
    # external Codex/ChatGPT sign-ins alone.
    for folder in [root, *(root / 'profiles').glob('p-*')]:
        if not (folder / 'auth.json').is_file():
            continue
        context = set_hermes_home_override(str(folder))
        try:
            clear_provider_auth('openai-codex')
        finally:
            reset_hermes_home_override(context)


def usage_fields(usage):
    from agent.account_usage import _codex_window_labels
    limits=(usage.raw or {}).get('rate_limit') or {}
    raw_windows=[limits[key] for key,_ in _codex_window_labels(limits)
        if isinstance(limits.get(key),dict) and limits[key].get('used_percent') is not None]
    windows=[]
    for index,window in enumerate(usage.windows):
        seconds=raw_windows[index].get('limit_window_seconds') if index<len(raw_windows) else None
        percent=window.used_percent
        windows.append({'label':window.label,
            'usedPercent':percent if isinstance(percent,(int,float)) and math.isfinite(percent) and percent>=0 else None,
            'resetAt':window.reset_at.isoformat() if window.reset_at else None,
            'durationSeconds':seconds if isinstance(seconds,(int,float)) and math.isfinite(seconds) and seconds>0 else None})
    return {'plan':usage.plan,'windows':windows,'checkedAt':usage.fetched_at.isoformat()}


def login(emit, issuer='https://auth.openai.com'):
    from hermes_cli.auth import CODEX_OAUTH_CLIENT_ID, _save_codex_tokens
    from hermes_cli.auth_codex import (
        _codex_request_device_code, _codex_poll_authorization_code,
        _codex_exchange_authorization_code,
    )
    # Upstream progress copy goes to stderr; stdout is our private event protocol.
    with contextlib.redirect_stdout(sys.stderr):
        device = _codex_request_device_code(issuer, CODEX_OAUTH_CLIENT_ID)
    emit({'type':'device','url':'https://auth.openai.com/codex/device','code':device['user_code']})
    with contextlib.redirect_stdout(sys.stderr):
        authorization = _codex_poll_authorization_code(issuer,
            device_auth_id=device['device_auth_id'], user_code=device['user_code'],
            poll_interval=device['interval'])
        tokens = _codex_exchange_authorization_code(issuer, CODEX_OAUTH_CLIENT_ID, authorization)
    if not tokens.get('access_token') or not tokens.get('refresh_token'):
        raise RuntimeError('OpenAI did not return a renewable sign-in. Please try signing in again.')
    _save_codex_tokens({name:tokens[name] for name in ('access_token','refresh_token')},set_active=False)
    emit({'type':'connected'})


def status(check=False):
    from hermes_cli.auth import resolve_codex_runtime_credentials, AuthError, CODEX_RATE_LIMITED_CODE
    try:
        credentials=resolve_codex_runtime_credentials(read_only=not check)
    except AuthError as error:
        if error.code==CODEX_RATE_LIMITED_CODE:
            return {'connected':True,'status':'Usage limit reached','models':[],'windows':[]}
        return {'connected':False,'status':'Not connected' if 'missing' in (error.code or '') else 'Sign in again','models':[]}
    result={'connected':True,'status':'Unverified','models':[],'windows':[]}
    if not check:
        return result
    token=credentials['api_key']
    from agent.redact import register_vault_redaction_value
    register_vault_redaction_value(token)
    import httpx
    from agent.codex_headers import codex_account_headers
    from agent.model_metadata import fetch_codex_catalog_entries
    from hermes_cli.codex_models import _ranked_slugs
    try:
        entries, code=fetch_codex_catalog_entries(lambda url:httpx.get(url,
            headers={'Authorization':'Bearer '+token,**codex_account_headers(token)},timeout=10))
        # Only live account-scoped models, without synthesized entitlement hints.
        result['models']=[model for model in _ranked_slugs(entries) if model.startswith('gpt-')]
        result['details']={item['slug']:{'description':' '.join(item['description'].split())[:300]} for item in entries if isinstance(item,dict) and item.get('slug') in result['models'] and isinstance(item.get('description'),str) and item['description'].strip()}
        if code in (401,403):
            return {'connected':False,'status':'Sign in again','models':[],'windows':[]}
        if result['models']:result['status']='Connected'
    except Exception:
        pass
    try:
        from agent.account_usage import _fetch_codex_account_usage
        usage=_fetch_codex_account_usage(api_key=token,base_url=credentials['base_url'])
        if usage:
            result.update(usage_fields(usage))
            if any(window.used_percent is not None and window.used_percent>=100 for window in usage.windows):
                result['status']='Usage limit reached'
    except Exception:
        pass
    return result
