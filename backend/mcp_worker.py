"""Private-pipe MCP connection owner. The outer Windows job owns all children."""
import asyncio
from contextlib import AsyncExitStack
from collections import defaultdict
import json
import os
from pathlib import Path
import sys
import uuid
from urllib.parse import urlsplit, parse_qsl

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'runtime' / 'hermes'))


def scrub(value):
    from agent.redact import redact_registered_vault_values
    if isinstance(value, str): return redact_registered_vault_values(value)
    if isinstance(value, list): return [scrub(item) for item in value]
    if isinstance(value, dict): return {scrub(name): scrub(item) for name, item in value.items()}
    return value


def emit(value):
    print(json.dumps(scrub(value), ensure_ascii=False), flush=True)


class Connections:
    def __init__(self, root, namespace):
        from security import install_codec
        from tools.mcp_oauth import configure_token_storage_root
        from hermes_cli.credential_codec import decode
        self.root = Path(root)
        self.namespace = namespace
        self.gates = defaultdict(asyncio.Lock)
        self.file = self.root / 'mcp-connections.json'
        install_codec(namespace + '/encryption')
        configure_token_storage_root(self.root)
        self.records = decode(json.loads(self.file.read_text(encoding='utf-8'))) if self.file.exists() else {}
        self.live = {}
        self.flows = {}
        self.lock = asyncio.Lock()
        for key, record in self.records.items():
            try: self.register_secrets(self.resolve_config(key, record['config']))
            except ValueError: pass  # One missing credential must not block unrelated connections.

    @staticmethod
    def register_secrets(config):
        from agent.redact import register_vault_redaction_value
        for field in ('env', 'headers'):
            for value in config.get(field, {}).values():
                register_vault_redaction_value(value)
                if value.startswith('Bearer '): register_vault_redaction_value(value[7:])
        if config.get('url') and urlsplit(config['url']).query:
            register_vault_redaction_value(config['url'])
            for _, value in parse_qsl(urlsplit(config['url']).query): register_vault_redaction_value(value)
        if config.get('oauth', {}).get('client_secret'):
            register_vault_redaction_value(config['oauth']['client_secret'])

    def secret_target(self, key, field):
        return self.namespace + '/mcp/' + key + '/' + field

    def store_secrets(self, key, config):
        import windows_credentials as vault
        saved = json.loads(json.dumps(config))
        fields = [(section, name) for section in ('env', 'headers') for name in saved.get(section, {})]
        if saved.get('url') and urlsplit(saved['url']).query: fields.append((None, 'url'))
        if saved.get('oauth', {}).get('client_secret'): fields.append(('oauth', 'client_secret'))
        written = []
        try:
            for section, name in fields:
                field = uuid.uuid4().hex
                values = saved[section] if section else saved
                vault.put(self.secret_target(key, field), values[name].encode())
                written.append(field)
                values[name] = '${TRISMEGISTUS_MCP_' + field + '}'
        except Exception:
            for field in written: vault.delete(self.secret_target(key, field))
            raise
        return saved

    def resolve_config(self, key, config):
        import windows_credentials as vault
        result = json.loads(json.dumps(config))
        for section in ('env', 'headers', 'oauth', None):
            values = result.get(section, {}) if section else {name: result[name] for name in ('url',) if name in result}
            for name, value in values.items():
                if isinstance(value, str) and value.startswith('${TRISMEGISTUS_MCP_') and value.endswith('}'):
                    field = value[len('${TRISMEGISTUS_MCP_'):-1]
                    secret = vault.get(self.secret_target(key, field))
                    if secret is None: raise ValueError('A connection credential is missing. Reconnect this server.')
                    if section: result[section][name] = secret.decode()
                    else: result[name] = secret.decode()
        return result

    def delete_secrets(self, key, config):
        import windows_credentials as vault
        for section in ('env', 'headers', 'oauth', None):
            values = config.get(section, {}) if section else {name: config[name] for name in ('url',) if name in config}
            for value in values.values():
                if isinstance(value, str) and value.startswith('${TRISMEGISTUS_MCP_') and value.endswith('}'):
                    vault.delete(self.secret_target(key, value[len('${TRISMEGISTUS_MCP_'):-1]))

    def save(self):
        from utils import atomic_json_write
        from hermes_cli.credential_codec import encode
        atomic_json_write(self.file, encode(self.records), mode=0o600)

    def rows(self):
        from agent.redact import redact_registered_vault_values
        return [{'id': key, 'name': record['name'], 'enabled': record['enabled'],
                 'transport': 'http' if record['config'].get('url') else 'stdio',
                 'address': redact_registered_vault_values(record['address']),
                 'auth': record['config'].get('auth', 'configured' if record['config'].get('headers') or record['config'].get('env') else 'none'),
                 'status': self.live.get(key, {}).get('status', 'Not connected' if record['enabled'] else 'Off'),
                 'tools': len(self.live.get(key, {}).get('tools', []))} for key, record in self.records.items()]

    @staticmethod
    def validate(raw):
        if not isinstance(raw, dict): raise ValueError('Enter an MCP server configuration.')
        unknown = set(raw) - {'url', 'command', 'args', 'env', 'headers', 'auth', 'oauth', 'cwd', 'type'}
        if unknown: raise ValueError('Unsupported MCP settings: ' + ', '.join(sorted(unknown)))
        config = dict(raw)
        if bool(config.get('url')) == bool(config.get('command')):
            raise ValueError('Specify either a server URL or a command.')
        if config.get('url'):
            if not isinstance(config['url'], str): raise ValueError('Enter an MCP URL.')
            url = urlsplit(config['url'])
            if url.scheme not in ('https', 'http') or not url.hostname or url.username or url.password or url.fragment:
                raise ValueError('Enter an HTTP or HTTPS MCP URL without embedded credentials.')
        if 'command' in config and (not isinstance(config['command'], str) or not config['command'].strip()):
            raise ValueError('Enter a command.')
        for field in ('env', 'headers'):
            value = config.get(field, {})
            if not isinstance(value, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in value.items()):
                raise ValueError(field + ' must map names to text values.')
        if not isinstance(config.get('args', []), list) or any(not isinstance(arg, str) for arg in config.get('args', [])):
            raise ValueError('Arguments must be a list of strings.')
        if config.get('auth') not in (None, 'oauth'): raise ValueError('Use OAuth or configured headers/environment values.')
        if config.get('auth') == 'oauth' and not config.get('url'): raise ValueError('OAuth requires an HTTP server.')
        if config.get('type') not in (None, 'http', 'stdio', 'sse'): raise ValueError('Unsupported MCP transport.')
        if not isinstance(config.get('oauth', {}), dict): raise ValueError('OAuth settings must be an object.')
        if config.get('cwd') is not None and (not isinstance(config['cwd'], str) or not Path(config['cwd']).is_absolute()): raise ValueError('Working directory must be an absolute path.')
        if config.get('type') == 'stdio' and config.get('url') or config.get('type') in ('http', 'sse') and config.get('command'): raise ValueError('Transport does not match the server configuration.')
        return config

    async def add(self, name, config):
        config = self.validate(config)
        if not isinstance(name, str) or not name.strip(): raise ValueError('Name the connection.')
        async with self.lock:
            # An endpoint is immutable under this ID: remove/add gives a new grant owner.
            key = uuid.uuid4().hex
            self.register_secrets(config)
            stored = self.store_secrets(key, config)
            self.records[key] = {'name': name.strip(), 'enabled': True, 'address': (config.get('url') or config['command']).split('?')[0], 'config': stored}
            try: self.save()
            except Exception:
                self.records.pop(key, None); self.delete_secrets(key, stored)
                raise
        return key

    async def connect(self, key, flow=None):
        async with self.gates[key]:
            record = self.records[key]
            if not record['enabled']: raise ValueError('This connection is off.')
            if key not in self.live:
                live = self.live[key] = {'status': 'Connecting…', 'ready': asyncio.Event(), 'stop': asyncio.Event(), 'tools': [], 'calls': set()}
                live['task'] = asyncio.create_task(self.run_connection(key, live, flow))
            live = self.live[key]
        await asyncio.wait_for(live['ready'].wait(), 310 if flow else 35)
        if live.get('error'): raise RuntimeError(live['error'])
        if self.live.get(key) is not live or not live.get('session'): raise RuntimeError('Connection closed.')
        return live

    async def run_connection(self, key, live, flow):
        from mcp import ClientSession, types
        from mcp.client.stdio import StdioServerParameters, stdio_client
        from mcp.client.streamable_http import streamable_http_client
        from tools.mcp_tool import sdk_httpx
        from tools.mcp_tool_config import _build_safe_env, _resolve_stdio_command
        from tools.mcp_oauth_manager import get_manager
        from tools.mcp_oauth import suppress_interactive_oauth
        from tools.mcp_dashboard_oauth import dashboard_oauth_flow
        from agent.redact import redact_registered_vault_values
        try:
            config = self.resolve_config(key, self.records[key]['config'])
            self.register_secrets(config)
            with dashboard_oauth_flow(flow) if flow else suppress_interactive_oauth():
                async with AsyncExitStack() as stack:
                    if config.get('url'):
                        auth = get_manager().get_or_build_provider(key, config['url'], config.get('oauth')) if config.get('auth') == 'oauth' else None
                        httpx = sdk_httpx()
                        client = await stack.enter_async_context(httpx.AsyncClient(headers=config.get('headers'), auth=auth, timeout=httpx.Timeout(30, read=300), follow_redirects=False))
                        if config.get('type') == 'sse':
                            from mcp.client.sse import sse_client
                            streams = await stack.enter_async_context(sse_client(config['url'], headers=config.get('headers'), auth=auth, httpx_client_factory=lambda **kw: httpx.AsyncClient(**kw, follow_redirects=False)))
                        else:
                            streams = await stack.enter_async_context(streamable_http_client(config['url'], http_client=client))
                    else:
                        env = _build_safe_env(config.get('env'))
                        command, env = _resolve_stdio_command(config['command'], env)
                        params = StdioServerParameters(command=command, args=config.get('args', []), env=env, cwd=config.get('cwd'))
                        # Stderr stays out of logs: untrusted servers may print their credentials.
                        errlog = stack.enter_context(open(os.devnull, 'w'))
                        streams = await stack.enter_async_context(stdio_client(params, errlog=errlog))
                    session = await stack.enter_async_context(ClientSession(streams[0], streams[1], read_timeout_seconds=300 if flow else 30))
                    await session.initialize()
                    tools, cursor, seen = [], None, set()
                    while True:
                        listing = await session.list_tools(params=types.PaginatedRequestParams(cursor=cursor) if cursor else None)
                        tools.extend(tool.model_dump(mode='json', by_alias=True, exclude_none=True) for tool in listing.tools)
                        cursor = listing.next_cursor
                        if not cursor: break
                        if cursor in seen: raise ValueError('Server repeated a tools cursor.')
                        seen.add(cursor)
                    live.update(session=session, tools=tools, status='Connected')
                    if flow: flow.mark_approved()
                    live['ready'].set(); emit({'event': 'changed'})
                    await live['stop'].wait()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # ExceptionGroup's short str often hides the actionable leaf error.
            while isinstance(error, BaseExceptionGroup) and error.exceptions: error = error.exceptions[0]
            live['error'] = redact_registered_vault_values(str(error))[:1000] or 'Connection failed.'
            live['status'] = live['error']
            if flow: flow.mark_error(live['error'])
        finally:
            live['ready'].set()
            live.pop('session', None)
            emit({'event': 'changed'})

    async def close(self, key):
        async with self.gates[key]:
            if flow := self.flows.pop(key, None): flow.mark_error('Sign-in cancelled.', cancelled=True)
            live = self.live.pop(key, None)
            if live:
                tasks = list(live['calls'])
                for task in tasks: task.cancel()
                if tasks: await asyncio.gather(*tasks, return_exceptions=True)
                live['stop'].set()
                if not live['ready'].is_set(): live['task'].cancel()
                try: await asyncio.wait_for(live['task'], 12)
                except (asyncio.CancelledError, asyncio.TimeoutError): pass

    async def dispatch(self, operation, args):
        key = args.get('id')
        if operation == 'list': return self.rows()
        if operation == 'add': return await self.add(args['name'], args['config'])
        if key not in self.records: raise ValueError('Connection not found.')
        if operation == 'test':
            await self.close(key)
            await self.connect(key)
            return self.rows()
        if operation in ('off', 'on', 'remove', 'revoke', 'cancelLogin'):
            async with self.lock:
                if operation != 'cancelLogin': self.records[key]['enabled'] = operation == 'on'
                await self.close(key)
                if operation in ('remove', 'revoke'):
                    from tools.mcp_oauth import HermesTokenStorage
                    from tools.mcp_oauth_manager import get_manager
                    get_manager().evict(key)
                    await HermesTokenStorage(key).revoke()
                if operation == 'remove':
                    self.delete_secrets(key, self.records[key]['config'])
                    del self.records[key]
                self.save()
            return self.rows()
        if operation == 'tools': return (await self.connect(key))['tools']
        if operation == 'call':
            live = await self.connect(key)
            if args['name'] not in {tool['name'] for tool in live['tools']}: raise ValueError('Tool not found.')
            task = asyncio.current_task(); live['calls'].add(task)
            try:
                from agent.redact import redact_registered_vault_values
                result = await live['session'].call_tool(args['name'], args.get('arguments', {}))
                return scrub(result.model_dump(mode='json', by_alias=True, exclude_none=True))
            finally: live['calls'].discard(task)
        if operation == 'login':
            from tools.mcp_dashboard_oauth import DashboardOAuthFlow
            if self.records[key]['config'].get('auth') != 'oauth': raise ValueError('This connection does not use OAuth.')
            await self.close(key)
            redirect = urlsplit(args['redirectUri'])
            if redirect.scheme != 'http' or redirect.hostname != '127.0.0.1' or not redirect.port or redirect.username or redirect.password or redirect.fragment or redirect.query: raise ValueError('A private loopback callback is required.')
            flow = DashboardOAuthFlow(uuid.uuid4().hex, key, None, str(self.root), args['redirectUri'])
            self.flows[key] = flow
            connected = asyncio.create_task(self.connect(key, flow))
            try:
                async with asyncio.timeout(30):
                    while not flow.authorization_url and not connected.done(): await asyncio.sleep(.02)
                if flow.authorization_url: emit({'event': 'authorization', 'id': key, 'url': flow.authorization_url})
                await connected
                return self.rows()
            finally:
                if not connected.done():
                    connected.cancel()
                    await asyncio.gather(connected, return_exceptions=True)
                    await self.close(key)
                if self.flows.get(key) is flow: self.flows.pop(key, None)
        if operation == 'callback':
            flow = self.flows.get(key)
            if not flow: raise ValueError('Sign-in has ended.')
            flow.deliver_callback(code=args.get('code'), state=args.get('state'), error=args.get('error'), iss=args.get('iss'))
            return True
        raise ValueError('Unsupported connection operation.')


async def main():
    settings = json.loads(sys.stdin.readline())
    service = Connections(settings['root'], settings['namespace'])
    pending = {}
    async def handle(message):
        request = message['request']
        try: emit({'request': request, 'result': await service.dispatch(message['operation'], message.get('args', {}))})
        except asyncio.CancelledError: emit({'request': request, 'error': 'Cancelled. Check any uncertain tool outcome before retrying.'})
        except Exception as error:
            from agent.redact import redact_registered_vault_values
            emit({'request': request, 'error': redact_registered_vault_values(str(error))[:1000]})
        finally: pending.pop(request, None)
    try:
        emit({'event': 'ready'})
        while line := await asyncio.to_thread(sys.stdin.readline):
            message = json.loads(line)
            if message.get('operation') == 'cancel':
                if task := pending.get(message.get('request')): task.cancel()
            else: pending[message['request']] = asyncio.create_task(handle(message))
    finally:
        tasks = list(pending.values())
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.gather(*(service.close(key) for key in list(service.live)), return_exceptions=True)


if __name__ == '__main__': asyncio.run(main())
