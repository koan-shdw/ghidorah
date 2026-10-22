"""An embedding host's availability decision applies to cached sync/async transports."""
import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from agent import process_bootstrap as bootstrap


def test_request_refusal_and_response_acknowledgement_guard_cached_clients(monkeypatch):
    calls, acknowledgements = [], []
    blocked = False

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            body = b'{"error":{"code":"insufficient_quota"}}'
            self.send_response(402)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f'http://127.0.0.1:{server.server_port}'

    def before(request):
        if blocked:
            raise PermissionError('Account unavailable')

    def after(response):
        nonlocal blocked
        acknowledgements.append(response.json())
        blocked = True

    for key in ('_provider_request_guard', '_provider_before_request', '_provider_after_response'):
        monkeypatch.setattr(bootstrap, key, None)
    bootstrap.set_provider_request_guard(lambda value: None, before_request=before, after_response=after)
    try:
        with bootstrap.build_keepalive_http_client(url) as client:
            assert client.post(url, json={'model': 'first'}).status_code == 402
            assert acknowledgements and blocked
            with pytest.raises(PermissionError, match='Account unavailable'):
                client.post(url, json={'model': 'second'})
            assert len(calls) == 1

        async def check():
            nonlocal blocked
            async with bootstrap.build_keepalive_http_client(url, async_mode=True) as client:
                with pytest.raises(PermissionError):
                    await client.post(url, json={'model': 'async-blocked'})
                assert len(calls) == 1
                blocked = False
                assert (await client.post(url, json={'model': 'restored'})).status_code == 402
                assert len(acknowledgements) == 2 and blocked
                with pytest.raises(PermissionError):
                    await client.post(url, json={'model': 'async-retry'})
                assert len(calls) == 2
        asyncio.run(check())
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_sdk_wrapping_keeps_the_refused_accounts_reset_time():
    import httpx
    from openai import APIConnectionError, APIStatusError
    from agent.agent_runtime_helpers import extract_api_error_context
    from agent.error_surface import build_error_surface_from_exception

    request = httpx.Request('POST', 'https://provider.invalid/v1/chat/completions')
    body = {'error': {'code': 'insufficient_quota', 'resets_at': 4102444800}}
    refused = APIStatusError('Account unavailable', response=httpx.Response(402, request=request, json=body), body=body)
    wrapped = APIConnectionError(request=request)
    wrapped.__cause__ = refused
    assert extract_api_error_context(wrapped)['reset_at'] == body['error']['resets_at']
    surface = build_error_surface_from_exception(wrapped, provider='openai-codex', model='gpt-example')
    assert surface['resets_at'] == body['error']['resets_at']
