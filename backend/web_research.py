"""Public research through the pinned Hermes Exa adapter; no browser cookies or account keys."""
import os
from pathlib import Path
from urllib.parse import unquote, urlsplit


def public_url(value):
    from agent.redact import _PREFIX_RE
    from tools.url_safety import normalize_url_for_request, sensitive_query_param_name, is_safe_url
    if not isinstance(value, str) or not 1 <= len(value) <= 4000:
        raise ValueError('Use a public HTTP or HTTPS URL.')
    url = normalize_url_for_request(value)
    parts = urlsplit(url)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
        raise ValueError('Use a public HTTP or HTTPS URL without embedded credentials.')
    if sensitive_query_param_name(url) or _PREFIX_RE.search(unquote(url)):
        raise ValueError('Credentials must not be sent to web research.')
    if not is_safe_url(url):
        raise ValueError('The URL is unavailable or points to a private network. Web research reads public pages.')
    return url


def research(request, namespace):
    from hermes_constants import set_hermes_home_override
    from plugins.web import keyless_mcp as exa
    # No profile-specific plugins, paid-provider autodetection or private-network overrides.
    set_hermes_home_override(Path(os.environ['HERMES_HOME']) / 'web-research')
    endpoint = os.environ.get('TRISMEGISTUS_TEST_WEB_URL')
    if endpoint:
        parts = urlsplit(endpoint)
        if not namespace.startswith('Trismegistus/Test/') or parts.scheme != 'http' or parts.hostname != '127.0.0.1' or parts.username or parts.password:
            raise ValueError('Invalid isolated web test endpoint.')
        exa.EXA_MCP_URL = endpoint
    name, args = request.get('name'), request.get('arguments')
    if not isinstance(args, dict):
        raise ValueError('Invalid web request.')
    if name == 'search_web':
        query, limit = args.get('query'), args.get('limit', 5)
        if set(args) - {'query', 'limit'} or not isinstance(query, str) or not query.strip() or len(query) > 2000 or type(limit) is not int or not 1 <= limit <= 10:
            raise ValueError('Use a search query up to 2,000 characters and 1–10 results.')
        from agent.redact import _PREFIX_RE
        if _PREFIX_RE.search(unquote(query)):
            raise ValueError('Credentials must not be sent to web research.')
        result = exa.exa_search_keyless(query, limit)
        if not result.get('success'):
            raise RuntimeError('Web search unavailable: ' + str(result.get('error', 'No result.')))
        return {'provider': 'Exa', 'results': result.get('data', {}).get('web', [])[:limit]}
    if name == 'read_web_page':
        if set(args) != {'url'}:
            raise ValueError('Choose one public page to read.')
        url = public_url(args['url'])
        # The adapter's convenience extractor accepts Exa's 3,000-character default.
        # Reuse its transport with an explicit budget so long documentation is retrievable.
        text = exa.mcp_call(exa.EXA_MCP_URL, 'web_fetch_exa', {'urls': [url], 'maxCharacters': 1_000_000})
        if not isinstance(text, str) or not text.strip():
            raise RuntimeError('Page reading unavailable: No readable text returned.')
        title = next((line[2:].strip() for line in text.splitlines() if line.startswith('# ')), url)
        return {'provider': 'Exa', 'url': url, 'title': title[:500], 'text': text[:1_000_000], 'truncated': len(text) >= 1_000_000}
    raise ValueError('Unsupported web operation.')
