import base64
import json
import os
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import windows_credentials
from urllib.parse import urlsplit
import hashlib
import io
import re


def migrate_plaintext(root: Path, namespace: str):
    """Move credentials from this app's config/env files into its OS vault."""
    import yaml
    from dotenv.parser import parse_stream
    from utils import atomic_write_text
    secret_name = re.compile(r'(^|_)(api_key|key|token|secret|password)$', re.I)
    def save(origin, name, value):
        target = namespace + '/imported/' + hashlib.sha256((str(origin)+':'+name).encode()).hexdigest()
        windows_credentials.put(target, str(value).encode())
        if name.upper() == 'DEEPSEEK_API_KEY' and windows_credentials.get(namespace+'/deepseek') is None:
            windows_credentials.put(namespace+'/deepseek', str(value).encode())
    for folder in [root, *(root/'profiles').glob('*')]:
        env = folder/'.env'
        if env.is_file():
            bindings = list(parse_stream(io.StringIO(env.read_text(encoding='utf-8-sig'))))
            if any(b.error for b in bindings):raise OSError('Cannot safely migrate malformed app environment file')
            kept=[]
            for binding in bindings:
                if binding.key and binding.value and secret_name.search(binding.key):save(env,binding.key,binding.value)
                else:kept.append(binding.original.string)
            atomic_write_text(env,''.join(kept),mode=0o600)
        config=folder/'config.yaml'
        if config.is_file():
            value=yaml.safe_load(config.read_text(encoding='utf-8-sig'))
            changed=False
            def visit(node, trail=''):
                nonlocal changed
                if isinstance(node,dict):
                    for key, item in list(node.items()):
                        if isinstance(item,str) and item and secret_name.search(str(key)):
                            save(config,trail+str(key),item);del node[key];changed=True
                        else:visit(item,trail+str(key)+'.')
                elif isinstance(node,list):
                    for index,item in enumerate(node):visit(item,trail+str(index)+'.')
            visit(value)
            if changed:atomic_write_text(config,yaml.safe_dump(value,sort_keys=False),mode=0o600)


def provider_guard(allowed_url):
    allowed = [urlsplit(url) for url in (allowed_url if isinstance(allowed_url,list) else [allowed_url])]
    def check(url):
        parsed = urlsplit(url)
        if not any((parsed.scheme, parsed.hostname, parsed.port)==(item.scheme,item.hostname,item.port) for item in allowed) or parsed.username or parsed.password or parsed.fragment:
            raise PermissionError(f'Provider address {parsed.scheme}://{parsed.hostname}:{parsed.port} is not authorized by Ghidorah')
    return check


def install_codec(target: str):
    from hermes_cli.credential_codec import configure
    key = windows_credentials.get(target)
    if key is None:
        raise OSError('The app encryption key is unavailable')
    cipher = AESGCM(key)
    def register(data):
        from agent.redact import register_vault_redaction_value
        if isinstance(data,dict):
            from provider_identity import register as register_identity
            providers = data.get('providers')
            minimax = providers.get('minimax-oauth') if isinstance(providers, dict) else None
            if isinstance(minimax, dict):register_identity('minimax-oauth', minimax.get('access_token'))
            oauth = providers.get('xai-oauth') if isinstance(providers, dict) else None
            if isinstance(oauth, dict):register_identity('xai-oauth', (oauth.get('tokens') or {}).get('access_token'))
            pools = data.get('credential_pool')
            pool = pools.get('xai-oauth') if isinstance(pools, dict) else []
            if isinstance(pool, list):
                for entry in pool:
                    if isinstance(entry, dict):register_identity('xai-oauth', entry.get('access_token'))
            for name,value in data.items():
                if isinstance(value,str) and re.search(r'(token|api_key|private_key|secret)$',name,re.I):register_vault_redaction_value(value)
                elif isinstance(value,(dict,list)):register(value)
        elif isinstance(data,list):
            for value in data:register(value)
    def seal(data):
        register(data)
        nonce = os.urandom(12)
        encrypted = cipher.encrypt(nonce, json.dumps(data, default=str).encode(), b'Trismegistus credentials v1')
        return {'credential_envelope': 1, 'payload': base64.b64encode(nonce + encrypted).decode()}
    def open_envelope(data):
        payload = base64.b64decode(data['payload'], validate=True)
        decoded=json.loads(cipher.decrypt(payload[:12], payload[12:], b'Trismegistus credentials v1'))
        register(decoded)
        return decoded
    configure(seal=seal, open_envelope=open_envelope)
    return seal, open_envelope


def migrate(root: Path):
    """Encrypt existing token stores atomically before the backend is admitted."""
    from hermes_cli.credential_codec import encode
    from utils import atomic_json_write
    for folder in [root, *(root / 'profiles').glob('*')]:
        for path in [folder / 'auth.json', folder / 'shared' / 'nous_auth.json', *(folder / 'mcp-tokens').glob('*.json')]:
            if path.is_file():
                data = json.loads(path.read_text(encoding='utf-8-sig'))
                if data.get('credential_envelope') != 1:
                    atomic_json_write(path, encode(data), mode=0o600)
