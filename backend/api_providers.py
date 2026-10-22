"""App-owned API connections using Hermes credentials and provider transports."""
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError

PROVIDERS = ('alibaba', 'openrouter-api', 'minimax', 'minimax-cn', 'mistral', 'openai-api', 'gemini', 'xai', 'kimi-coding', 'zai')
MODEL_ID = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}\Z')
NON_CHAT_MODEL = re.compile(json.loads(Path(__file__).with_name('non-chat-models.json').read_text())['pattern'], re.I)


def model_identity(model):
    match = re.fullmatch(r'api:(nous|alibaba|openrouter-api|minimax|minimax-cn|minimax-oauth|mistral|openai-api|gemini|vertex|xai|xai-oauth|kimi-coding|zai):(.+)', model)
    if match and MODEL_ID.fullmatch(match[2]):
        return match[1], match[2]
    if re.fullmatch(r'deepseek-[a-zA-Z0-9.-]+', model):
        return 'deepseek', model
    if re.fullmatch(r'gpt-[a-zA-Z0-9.-]+', model):
        return 'openai-codex', model
    raise ValueError('Unsupported model identity.')


def test_endpoints(namespace):
    """Private synthetic servers are accepted only in isolated test namespaces."""
    raw = os.environ.get('TRISMEGISTUS_TEST_API_URLS')
    if not raw:
        return
    endpoints = json.loads(raw)
    from hermes_cli.auth import PROVIDER_REGISTRY
    for provider, url in endpoints.items():
        parsed = urlsplit(url)
        if provider not in PROVIDERS or not namespace.startswith('Trismegistus/Test/') or parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.username or parsed.query or parsed.fragment:
            raise ValueError('Invalid isolated API endpoint.')
        config = PROVIDER_REGISTRY[provider]
        if config.base_url_env_var: os.environ[config.base_url_env_var] = url
        else: config.inference_base_url = url


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def json_get(url, headers):
    # Credentials never follow redirects. Setup reads only model metadata.
    with build_opener(NoRedirect()).open(Request(url, headers=headers), timeout=8) as response:
        body = response.read(2_000_001)
        if len(body) > 2_000_000:
            raise ValueError('Model list is too large.')
        return json.loads(body)


def details(row):
    """Release time (ms) and the supplier's own one-line description, when its model list reports them."""
    created = row.get('created') or row.get('created_at') or row.get('createdAt')
    if isinstance(created, bool) or not isinstance(created, (int, float, str)):
        created = None
    elif isinstance(created, str):
        try:
            created = int(datetime.fromisoformat(created.replace('Z', '+00:00')).timestamp() * 1000)
        except ValueError:
            created = None
    elif created > 0:
        created = int(created * 1000 if created < 10**12 else created)
    else:
        created = None
    description = row.get('description')
    description = ' '.join(description.split())[:300] if isinstance(description, str) and description.strip() else None
    return dict(created=created, description=description)


def text_model(provider, row):
    if provider == 'alibaba' and 'model' in row:
        metadata = row.get('inference_metadata') or {}
        if 'function-calling' not in row.get('features', []) or 'Text' not in metadata.get('response_modality', []):
            return None
        model = row['model']
        if not isinstance(model, str) or not MODEL_ID.fullmatch(model):
            return None
        return dict(id='api:alibaba:' + model, label=str(row.get('name') or model)[:128],
                    vision='Image' in metadata.get('request_modality', []), **details(row))
    model = row.get('name', '').removeprefix('models/') if provider == 'gemini' else row.get('id', '')
    if not isinstance(model, str) or not MODEL_ID.fullmatch(model):
        return None
    if provider == 'gemini' and 'generateContent' not in row.get('supportedGenerationMethods', []):
        return None
    capabilities = row.get('capabilities') or {}
    if provider == 'openrouter-api' and 'architecture' in row:
        if 'text' not in row['architecture'].get('output_modalities', []) or 'tools' not in row.get('supported_parameters', []):
            return None
    if provider == 'mistral' and capabilities and (capabilities.get('completion_chat') is not True or capabilities.get('function_calling') is not True):
        return None
    # Generation-only media, embeddings and realtime endpoints cannot run this chat transport.
    if NON_CHAT_MODEL.search(model):
        return None
    if provider == 'openai-api' and not re.match(r'(?:ft:)?(?:gpt-|chatgpt-|o[1-9](?:-|$))', model):
        return None
    if provider in ('xai', 'xai-oauth') and not model.startswith('grok'):
        return None
    from agent.image_routing import _lookup_supports_vision
    return dict(id='api:' + provider + ':' + model, label=str(row.get('displayName') or model)[:128],
                vision=('image' in row['architecture'].get('input_modalities', [])) if provider == 'openrouter-api' and 'architecture' in row else capabilities.get('vision') is True if provider == 'mistral' and capabilities else _lookup_supports_vision(provider, model, {}) is True,
                **details(row))


def status(provider, namespace, check=False):
    if provider not in PROVIDERS:
        raise ValueError('Unsupported API supplier.')
    from provider_credentials import install
    from security import install_codec
    install_codec(namespace + '/encryption')
    install(Path(os.environ['HERMES_HOME']), namespace)
    from hermes_cli.auth import resolve_api_key_provider_credentials
    credentials = resolve_api_key_provider_credentials(provider)
    key, base = credentials['api_key'], credentials['base_url']
    result = dict(provider=provider, connected=bool(key), status='Unverified' if key else 'Not connected',
                  models=[], baseUrl=base, source='unverified', checkedAt=None)
    if provider == 'alibaba':
        import windows_credentials as vault
        from alibaba_connection import read
        config = read(vault.get(namespace + '/alibaba'))[1]
        result.update(region=config['region'], workspaceId=config['workspaceId'])
    if not key or not check:
        return result
    headers = {'x-goog-api-key': key} if provider == 'gemini' else {'Authorization': 'Bearer ' + key}
    rows, token = [], None
    try:
        if provider == 'openrouter-api':
            # OpenRouter's model catalogue is public, so it cannot validate the key.
            account = json_get(base.rstrip('/') + '/key', headers)
            if not isinstance(account.get('data'), dict): raise ValueError('Account check unavailable.')
            remaining = account['data'].get('limit_remaining')
            result['keyBudgetRemaining'] = remaining if isinstance(remaining, (int, float)) and not isinstance(remaining, bool) and remaining >= 0 else None
            reset = account['data'].get('limit_reset')
            result['keyLimitReset'] = reset if reset in ('daily', 'weekly', 'monthly') else None
        for page_number in range(1, 101 if provider == 'alibaba' else 11):
            url = base.rstrip('/') + ('/v1/models' if provider in ('minimax','minimax-cn') else '/models')
            if provider == 'alibaba':
                endpoint = urlsplit(base)
                url = endpoint.scheme + '://' + endpoint.netloc + '/api/v1/models?' + urlencode(dict(page_no=page_number, page_size=100, features='function-calling', language='en-US'))
            if provider == 'gemini':
                url += '?' + urlencode(dict(pageSize=1000, **({'pageToken': token} if token else {})))
            payload = json_get(url, headers)
            page = payload.get('output', {}).get('models') if provider == 'alibaba' else payload.get('models' if provider == 'gemini' else 'data')
            if not isinstance(page, list):
                raise ValueError('Model metadata unavailable.')
            rows.extend(row for row in page if isinstance(row, dict))
            if provider == 'alibaba':
                total = payload['output'].get('total')
                if type(total) is not int or total < 0 or (not page and len(rows) < total):
                    raise ValueError('Model list pagination incomplete.')
                if len(rows) >= total:
                    break
                continue
            token = payload.get('nextPageToken') if provider == 'gemini' else None
            if not token:
                break
        else:
            raise ValueError('Model list pagination incomplete.')
        models = [item for row in rows if (item := text_model(provider, row))]
        result.update(status='Connected', models=list({m['id']: m for m in models}.values()), source='live')
    except HTTPError as error:
        result.update(status='Authentication failed' if error.code == 401 else 'Access denied' if error.code == 403 else 'Model check unavailable',
                      authFailed=error.code == 401)
    except Exception:
        result['status'] = 'Model check unavailable'
    result['checkedAt'] = datetime.now(timezone.utc).isoformat()
    return result


def prices(models, urls):
    """Supplier list prices per million tokens for the model tooltips, from Hermes's pricing sources."""
    from agent.usage_pricing import get_pricing_entry
    rows = {}
    for model in models:
        try:
            provider, wire = model_identity(model)
            entry = get_pricing_entry(wire, provider=provider, base_url=urls.get(provider))
        except Exception:
            continue
        if entry and entry.pricing_version == 'included-route':
            rows[model] = {'included': True}
        elif entry and entry.input_cost_per_million is not None and entry.output_cost_per_million is not None:
            rows[model] = {'input': float(entry.input_cost_per_million), 'output': float(entry.output_cost_per_million)}
    return rows
