"""App-owned encrypted Google Cloud credentials for the Hermes Vertex transport."""
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.error import HTTPError

SCOPES = ['https://www.googleapis.com/auth/cloud-platform']


def storage(root):
    return Path(root) / 'vertex-auth.json'


def read(root):
    from hermes_cli.credential_codec import decode
    file = storage(root)
    return decode(json.loads(file.read_text(encoding='utf-8'))) if file.exists() else None


def write(root, value):
    from hermes_cli.credential_codec import encode
    from utils import atomic_json_write
    atomic_json_write(storage(root), encode(value), mode=0o600)


def validate(info, project, region):
    if not isinstance(info, dict) or info.get('type') not in ('service_account', 'authorized_user'):
        raise ValueError('Import a service-account key or authorized-user ADC JSON file.')
    if not isinstance(project, str) or not re.fullmatch(r'(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,20})', project):
        raise ValueError('Enter a Google Cloud project ID or project number.')
    if not isinstance(region, str) or not re.fullmatch(r'(?:global|[a-z]+-[a-z]+[0-9])', region):
        raise ValueError('Enter a Google Cloud region, such as global or us-central1.')
    if info.get('universe_domain', 'googleapis.com') != 'googleapis.com':
        raise ValueError('This connection supports the googleapis.com Cloud domain.')
    if info.get('token_uri', 'https://oauth2.googleapis.com/token') != 'https://oauth2.googleapis.com/token':
        raise ValueError('The credential token endpoint must be Google OAuth.')
    kind = info['type']
    names = ('client_email', 'private_key', 'private_key_id', 'project_id') if kind == 'service_account' else ('client_id', 'client_secret', 'refresh_token')
    clean = {key: info[key] for key in names if isinstance(info.get(key), str)}
    clean.update(type=kind, token_uri='https://oauth2.googleapis.com/token')
    if kind == 'service_account' and not re.fullmatch(r'[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com', clean.get('client_email', '')):
        raise ValueError('Enter a Google service-account credential.')
    # Validate key material and required fields locally; no network or ambient ADC fallback.
    credentials(clean, project)
    return dict(projectId=project, region=region, info=clean)


def credentials(info, project):
    from google.oauth2 import credentials as user, service_account
    try:
        cls = service_account.Credentials if info['type'] == 'service_account' else user.Credentials
        create = cls.from_service_account_info if info['type'] == 'service_account' else cls.from_authorized_user_info
        return create(info, scopes=SCOPES).with_quota_project(project)
    except Exception:
        raise ValueError('The Cloud credential file is incomplete or invalid.') from None


def save(root, file, project, region):
    with Path(file).open('rb') as source:
        raw = source.read(65537)
    if len(raw) > 65536:
        raise ValueError('The Cloud credential file exceeds 64 KiB.')
    try:
        info = json.loads(raw.decode('utf-8-sig'))
    except (ValueError, UnicodeError):
        raise ValueError('Choose a Google Cloud credential JSON file.') from None
    value = validate(info, project, region)
    from hermes_cli.auth import _auth_store_lock
    with _auth_store_lock(target_path=storage(root)):
        write(root, value)


def disconnect(root):
    from hermes_cli.auth import _auth_store_lock
    with _auth_store_lock(target_path=storage(root)):
        storage(root).unlink(missing_ok=True)


def test_base(namespace):
    value = os.environ.get('TRISMEGISTUS_TEST_VERTEX_URL')
    if not value:
        return None
    url = urlsplit(value)
    if not namespace.startswith('Trismegistus/Test/') or url.scheme != 'http' or url.hostname != '127.0.0.1' or url.username or url.password or url.query or url.fragment:
        raise ValueError('Invalid isolated Vertex endpoint.')
    return value.rstrip('/')


def base_url(value, namespace):
    from agent.vertex_adapter import build_vertex_base_url
    return (test_base(namespace) + '/v1') if test_base(namespace) else build_vertex_base_url(value['projectId'], value['region'])


def resolve(root, namespace):
    from hermes_cli.auth import _auth_store_lock
    from agent.redact import register_vault_redaction_value
    from google.auth.transport.requests import Request
    import requests
    class Session(requests.Session):
        def request(self, method, url, **kwargs):
            if url != 'https://oauth2.googleapis.com/token':
                raise ValueError('Unexpected Cloud authentication endpoint.')
            fixture = test_base(namespace)
            kwargs.update(allow_redirects=False, timeout=12)
            return super().request(method, fixture + '/token' if fixture else url, **kwargs)
    with _auth_store_lock(target_path=storage(root)):
        value = read(root)
        if not value:
            raise ValueError('Connect Google Cloud in Settings first.')
        creds = credentials(value['info'], value['projectId'])
        cached = value.get('access') or {}
        if cached.get('token') and isinstance(cached.get('expires'), (int, float)) and cached['expires'] > datetime.now(timezone.utc).timestamp() + 300:
            token = cached['token']
        else:
            with Session() as session:
                session.trust_env = False
                creds.refresh(Request(session=session))
            token = creds.token
            if not token or not creds.expiry:
                raise ValueError('Google did not return an expiring access token.')
            if value['info']['type'] == 'authorized_user':
                value['info']['refresh_token'] = creds.refresh_token
            value['access'] = dict(token=token, expires=creds.expiry.replace(tzinfo=timezone.utc).timestamp())
            write(root, value)
        register_vault_redaction_value(token)
        return token, base_url(value, namespace)


def install(root, namespace):
    from agent.vertex_adapter import set_host_vertex_config_resolver
    from hermes_constants import get_hermes_home
    root = Path(root).resolve()
    def resolver():
        current = get_hermes_home().resolve()
        if current != root and not (current.parent == root / 'profiles' and re.fullmatch(r'p-[0-9a-f-]{36}', current.name)):
            raise ValueError('Cloud credentials requested outside this app.')
        return resolve(root, namespace)
    # An embedding owns the negative decision too: never fall back to ambient machine ADC.
    set_host_vertex_config_resolver(resolver, available=storage(root).exists())


def status(root, namespace, check=False):
    from api_providers import json_get, text_model
    from google.auth.exceptions import RefreshError
    value = read(root)
    result = dict(provider='vertex', connected=bool(value), status='Unverified' if value else 'Not connected', models=[],
                  baseUrl=base_url(value, namespace) if value else '', source='unverified', checkedAt=None)
    if not value:
        return result
    result.update(projectId=value['projectId'], region=value['region'], credentialType=value['info']['type'])
    if not check:
        return result
    try:
        token, _ = resolve(root, namespace)
        fixture = test_base(namespace)
        host = 'aiplatform.googleapis.com' if value['region'] == 'global' else value['region'] + '-aiplatform.googleapis.com'
        url = (fixture + '/models') if fixture else 'https://' + host + '/v1beta1/publishers/google/models'
        models, page = [], None
        for _ in range(10):
            payload = json_get(url + '?' + urlencode(dict(pageSize=100, **({'pageToken': page} if page else {}))), {'Authorization': 'Bearer ' + token, 'x-goog-user-project': value['projectId']})
            if not isinstance(payload.get('publisherModels'), list):
                raise ValueError('Model catalog unavailable.')
            for row in payload['publisherModels']:
                name = row.get('name', '') if isinstance(row, dict) else ''
                if not name.startswith('publishers/google/models/gemini-'):
                    continue
                model = text_model('vertex', {'id': 'google/' + name.rsplit('/', 1)[-1]})
                if model:models.append(model)
            page = payload.get('nextPageToken')
            if not page:break
        else:
            raise ValueError('Model catalog pagination incomplete.')
        result.update(models=list({m['id']: m for m in models}.values()), source='live', status='Credentials checked · model access unverified')
    except RefreshError:
        result.update(status='Cloud credential refresh failed', authFailed=True)
    except HTTPError as error:
        result.update(status='Cloud access denied' if error.code in (401, 403) else 'Model catalog unavailable', authFailed=error.code == 401)
    except Exception:
        result['status'] = 'Cloud connection check unavailable'
    result['checkedAt'] = datetime.now(timezone.utc).isoformat()
    return result
