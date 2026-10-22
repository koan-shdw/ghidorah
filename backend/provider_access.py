"""Mandatory account checks against Electron main before physical provider requests."""
import json
import hashlib
import re
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def install(connection, destinations):
    from security import provider_guard
    from agent.process_bootstrap import set_provider_request_guard
    import httpx
    from openai import APIStatusError
    from agent.error_surface import build_error_surface_from_exception

    parsed = urlsplit(connection['url'])
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.path != '/' or parsed.query or parsed.fragment or parsed.username:
        raise ValueError('Invalid availability owner address.')
    token = connection['token']
    if not isinstance(token, str) or len(token) != 64:
        raise ValueError('Invalid availability owner token.')
    allowed = {provider: urlsplit(url) for provider, url in destinations.items()}

    def identity(request):
        if request.method != 'POST':
            return None
        url = urlsplit(str(request.url))
        candidates = [name for name, base in allowed.items()
                      if (url.scheme, url.hostname, url.port) == (base.scheme, base.hostname, base.port) and url.path.startswith(base.path.rstrip('/') + '/')]
        if not candidates:
            raise PermissionError('Provider address is unavailable.')
        from provider_identity import identify
        authorization = request.headers.get('Authorization') or ('Bearer ' + request.headers.get('x-api-key', ''))
        provider = candidates[0] if len(candidates) == 1 else identify(authorization, candidates)
        payload = json.loads(request.content)
        model = payload.get('model')
        if provider == 'gemini':
            match = re.search(r'/models/([a-zA-Z0-9._-]+):(generateContent|streamGenerateContent)$', url.path)
            model = match[1] if match else None
        if not isinstance(model, str) or not model or len(model) > 200:
            raise PermissionError('Provider request is missing its model identity.')
        return dict(provider=provider, model=model, credential=hashlib.sha256(authorization.encode()).hexdigest())

    def exchange(message):
        # No proxy/redirect: the owner credential goes only to this local process.
        opener = build_opener(ProxyHandler({}), NoRedirect())
        with opener.open(Request(connection['url'], data=json.dumps(message).encode(),
                                 headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}), timeout=10) as response:
            result = json.loads(response.read(8193))
        if not isinstance(result.get('blocked'), bool):
            raise RuntimeError('The availability owner returned no decision.')
        return result

    def before(request):
        who = identity(request)
        if who is None:
            return
        result = exchange(dict(phase='request', **who))
        if result['blocked']:
            reason = result['reason']
            status = {'auth': 401, 'model': 404, 'credit': 402, 'limit': 402}[reason]
            code = {'auth': 'invalid_api_key', 'model': 'model_not_found', 'credit': 'insufficient_quota', 'limit': 'insufficient_quota'}[reason]
            if who['provider'] == 'gemini' and reason == 'limit':
                status, code = 429, 'trismegistus_quota_exhausted'
            error = dict(error=dict(code=code, message=result['message'], type=code))
            if result.get('resetAt'):
                error['error']['resets_at'] = result['resetAt'] / 1000
            # SDK/agent exception chaining retains this structured refusal; no provider I/O occurs.
            raise APIStatusError(result['message'], response=httpx.Response(status, request=request, json=error), body=error)

    def after(response):
        who = identity(response.request)
        if who is None:
            return
        try:
            body = response.json()
        except ValueError:
            body = None
        error = APIStatusError('Provider request refused', response=response, body=body)
        surface = build_error_surface_from_exception(error, provider=who['provider'], model=who['model'])
        if who['provider'] == 'alibaba':
            from alibaba_connection import refusal
            surface = refusal(body, who['model']) or surface
        elif who['provider'] == 'gemini' and response.status_code == 429:
            from gemini_quota import refusal
            surface = refusal(body, who['model']) or surface
        if surface:
            # Persistence acknowledgement precedes the SDK's retry/fallback decision.
            exchange(dict(phase='response', surface=surface, **who))

    set_provider_request_guard(provider_guard(list(destinations.values())), before_request=before, after_response=after)
