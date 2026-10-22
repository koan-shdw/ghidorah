"""Provider-only access to the app's Windows vault; never a generic secret source."""
from pathlib import Path
import re
import windows_credentials as vault


def install(home: Path, namespace: str):
    import os
    import json
    # The approved GLM connection is prepaid API access. Hermes auto-detection
    # sends paid chat probes; pin the documented endpoint instead.
    os.environ.setdefault('GLM_BASE_URL', 'https://api.z.ai/api/paas/v4')
    from hermes_cli.auth import set_host_provider_key_resolver
    from hermes_constants import get_hermes_home
    from agent.redact import register_vault_redaction_value
    root = home.resolve()
    from alibaba_connection import read as read_alibaba
    alibaba_key, alibaba_config = read_alibaba(vault.get(namespace + '/alibaba'))
    if not (namespace.startswith('Trismegistus/Test/') and 'alibaba' in json.loads(os.environ.get('TRISMEGISTUS_TEST_API_URLS', '{}'))):
        os.environ['DASHSCOPE_BASE_URL'] = alibaba_config['baseUrl']

    def resolve(provider: str):
        if provider not in ('deepseek', 'alibaba', 'openrouter-api', 'minimax', 'minimax-cn', 'mistral', 'openai-api', 'gemini', 'xai', 'kimi-coding', 'zai'):
            return None
        current = get_hermes_home().resolve()
        if current != root and not (current.parent == root / 'profiles' and re.fullmatch(r'p-[0-9a-f-]{36}', current.name)):
            raise RuntimeError('Provider credential requested outside this app')
        value = vault.get(namespace + '/' + provider)
        key = alibaba_key if provider == 'alibaba' else value.decode() if value else ''
        if key:
            register_vault_redaction_value(key)
            from provider_identity import register
            register(provider, key)
        return key

    set_host_provider_key_resolver(resolve)
    from vertex_connection import install as install_vertex
    install_vertex(root, namespace)
