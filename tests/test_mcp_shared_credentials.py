"""Real local MCP transport, encrypted shared grant and two Windows processes.

The initial grant is synthetic and seeded: this does not prove browser sign-in
or Claude/app dispatcher integration.
"""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs
import pytest

APP = Path(__file__).resolve().parents[1]
FORK = APP / 'hermes'
sys.path[:0] = [str(APP / 'backend'), str(FORK)]


async def client_worker(config):
    from security import install_codec
    from tools.mcp_oauth import configure_token_storage_root
    from hermes_constants import set_hermes_home_override
    from tools.mcp_oauth_manager import get_manager
    from tools.mcp_tool import sdk_httpx
    from mcp.client.streamable_http import streamable_http_client
    from mcp import ClientSession
    from agent.redact import redact_registered_vault_values
    install_codec(config['namespace'])
    configure_token_storage_root(config['root'])
    set_hermes_home_override(config['profile'])
    provider = get_manager().get_or_build_provider('shared', config['url'] + '/mcp', {'cimd': False})
    await provider._initialize()
    print('ready', flush=True)
    httpx = sdk_httpx()
    async with httpx.AsyncClient(auth=provider, timeout=8) as client:
        async def call(url, owner):
            async with streamable_http_client(url, http_client=owner) as streams:
                async with ClientSession(streams[0], streams[1], read_timeout_seconds=8) as session:
                    await session.initialize()
                    assert (await session.list_tools()).tools[0].name == 'echo'
                    result = await session.call_tool('echo', {'text': config['marker']})
                    return redact_registered_vault_values(result.content[0].text)
        for line in sys.stdin:
            if line.strip() == 'stop':
                return
            try:
                result = await asyncio.wait_for(call(config['url'] + '/mcp', client), 12)
                async with httpx.AsyncClient(timeout=8) as public:
                    other = await call(config['url'] + '/public', public)
                print(json.dumps({'result': result, 'public': other}), flush=True)
            except Exception:
                print(json.dumps({'blocked': True}), flush=True)


@pytest.mark.windows_only
def test_shared_encrypted_grant_refresh_restart_revocation_and_mcp_calls(tmp_path, monkeypatch):
    import windows_credentials as vault
    from security import install_codec
    from tools import mcp_oauth
    from tools.mcp_oauth_provider import prepare_oauth_config
    from hermes_cli import credential_codec
    from mcp.shared.auth import OAuthToken, OAuthClientInformationFull, OAuthMetadata
    monkeypatch.setattr(credential_codec, '_seal', None)
    monkeypatch.setattr(credential_codec, '_open', None)
    monkeypatch.setattr(mcp_oauth, '_token_storage_root', None)
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    namespace = 'Trismegistus/Test/mcp-' + str(uuid.uuid4())
    vault.put(namespace, os.urandom(32))
    install_codec(namespace)
    mcp_oauth.configure_token_storage_root(tmp_path)
    observed = {'refresh': [], 'authenticated': [], 'public': []}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def reply(self, status, value=None):
            body = json.dumps(value).encode() if value is not None else b''
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def do_GET(self): self.reply(405)
        def do_DELETE(self): self.reply(200)
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            if self.path == '/token':
                refresh = parse_qs(body.decode()).get('refresh_token', [''])[0]
                observed['refresh'].append(refresh)
                if refresh != 'synthetic-refresh-1' or len(observed['refresh']) != 1:
                    self.reply(400, {'error': 'invalid_grant'}); return
                self.reply(200, {'access_token': 'synthetic-access-2', 'refresh_token': 'synthetic-refresh-2', 'expires_in': 3600, 'token_type': 'Bearer'}); return
            authorization = self.headers.get('Authorization')
            public = self.path == '/public'
            observed['public' if public else 'authenticated'].append(authorization)
            if (public and authorization) or (not public and authorization != 'Bearer synthetic-access-2'):
                self.reply(401, {'error': 'unauthorized'}); return
            message = json.loads(body)
            if 'id' not in message:
                self.reply(202); return
            method = message['method']
            if method == 'initialize':
                result = {'protocolVersion': message['params']['protocolVersion'], 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'fixture', 'version': '1'}}
            elif method == 'tools/list':
                result = {'tools': [{'name': 'echo', 'description': 'Echo this call only', 'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'}}}}]}
            else:
                result = {'content': [{'type': 'text', 'text': message['params']['arguments']['text'] + ' ' + (authorization or 'public')}], 'isError': False}
            self.reply(200, {'jsonrpc': '2.0', 'id': message['id'], 'result': result})

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    url = 'http://127.0.0.1:' + str(server.server_port)
    storage = prepare_oauth_config('shared', url + '/mcp', {})[1]
    async def seed():
        storage.bind_issuer(url)
        await storage.set_tokens(OAuthToken(access_token='synthetic-access-1', refresh_token='synthetic-refresh-1', token_type='Bearer', expires_in=0))
        await storage.set_client_info(OAuthClientInformationFull(client_id='fixture-client', redirect_uris=['http://127.0.0.1:12345/callback']))
        storage.save_oauth_metadata(OAuthMetadata(issuer=url, authorization_endpoint=url + '/authorize', token_endpoint=url + '/token'))
    asyncio.run(seed())
    children = []
    def start(marker):
        profile = tmp_path / 'profiles' / marker; profile.mkdir(parents=True, exist_ok=True)
        env = {key: value for key, value in os.environ.items() if key.upper() in {'PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'}}
        env['HERMES_HOME'] = str(tmp_path)
        child = subprocess.Popen([sys.executable, '-u', str(Path(__file__).resolve()), '--worker'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, creationflags=subprocess.CREATE_NO_WINDOW)
        children.append(child)
        child.stdin.write(json.dumps({'namespace': namespace, 'root': str(tmp_path), 'profile': str(profile), 'url': url, 'marker': marker}) + '\n'); child.stdin.flush()
        assert child.stdout.readline().strip() == 'ready'
        return child
    def command(child, text): child.stdin.write(text + '\n'); child.stdin.flush()
    def result(child): return json.loads(child.stdout.readline())
    try:
        a, b = start('alpha'), start('beta')
        command(a, 'call'); command(b, 'call')
        for marker, child in [('alpha', a), ('beta', b)]:
            reply = result(child)
            assert marker in reply['result'] and 'synthetic-' not in reply['result']
            assert reply['public'] == marker + ' public'
        assert observed['refresh'] == ['synthetic-refresh-1']
        assert all(value is None for value in observed['public'])
        for file in (tmp_path / 'mcp-tokens').glob('*.json'):
            assert 'synthetic-' not in file.read_text(encoding='utf-8')
        assert not list((tmp_path / 'profiles').rglob('mcp-tokens'))
        command(a, 'stop'); assert a.wait(timeout=15) == 0
        restarted = start('alpha'); command(restarted, 'call')
        assert 'alpha' in result(restarted)['result']
        assert observed['refresh'] == ['synthetic-refresh-1']
        asyncio.run(storage.revoke())
        before = len(observed['authenticated'])
        for child in [b, restarted]: command(child, 'call')
        for child in [b, restarted]: assert result(child) == {'blocked': True}
        assert all(value is None for value in observed['authenticated'][before:])
        assert len(observed['refresh']) == 1
    finally:
        for child in children:
            if child.poll() is None:
                command(child, 'stop')
                try: child.wait(timeout=15)
                except subprocess.TimeoutExpired: child.kill(); child.wait()
        server.shutdown(); server.server_close(); vault.delete(namespace)


if __name__ == '__main__' and '--worker' in sys.argv:
    asyncio.run(client_worker(json.loads(sys.stdin.readline())))
