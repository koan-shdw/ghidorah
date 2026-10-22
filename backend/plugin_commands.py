"""One reviewed plugin command in an app-owned Windows job; never general slash dispatch."""
import contextlib
import io
import json
import os
import queue
from pathlib import Path
import re
import sys
import threading
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime' / 'hermes'))


def main():
    request = json.loads(sys.stdin.buffer.readline())
    wire = os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf8', buffering=1)
    # Native writes/subprocess output are diagnostics, not protocol frames.
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    lock = threading.Lock()

    def emit(kind, **data):
        with lock:
            wire.write(json.dumps(dict(type=kind, **data), ensure_ascii=False) + '\n')
            wire.flush()

    def scrub(value):
        from agent.redact import redact_registered_vault_values, redact_sensitive_text
        return redact_sensitive_text(redact_registered_vault_values(str(value)), force=True)

    class Output(io.TextIOBase):
        pending = ''
        def write(self, text):
            self.pending += text
            while '\n' in self.pending:
                line, self.pending = self.pending.split('\n', 1)
                emit('output', text=scrub(line + '\n'))
            return len(text)
        def flush(self):
            if self.pending:
                emit('output', text=scrub(self.pending))
                self.pending = ''

    try:
        root = Path(request['root']).resolve(strict=True)
        profile = request.get('profile')
        if profile and not re.fullmatch(r'p-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', profile):
            raise ValueError('Invalid command project.')
        home = root / 'profiles' / profile if profile else root
        if home.resolve(strict=True) != home or (home / 'config.yaml').resolve() != home / 'config.yaml':
            raise ValueError('Linked plugin configuration is unavailable.')
        from security import install_codec
        install_codec(request['namespace'] + '/encryption')
        from plugin_setup import check_runtime, install_secret_source
        runtime = check_runtime(root, request.get('runtime'))
        if runtime:
            from tools.lazy_deps import _activate_target_on_syspath
            _activate_target_on_syspath(runtime)
        with contextlib.redirect_stdout(sys.stderr):
            install_secret_source(root, request.get('configurations', []))
            from provider_credentials import install
            install(root, request['namespace'])
            if request.get('provider_access'):
                from provider_access import install as install_provider_access
                install_provider_access(request['provider_access'], request['provider_urls'])
            from hermes_constants import set_hermes_home_override
            set_hermes_home_override(home)
            from hermes_cli.env_loader import hydrate_profile_secret_sources
            from agent.secret_scope import build_profile_secret_scope, set_secret_scope
            hydrate_profile_secret_sources(home)
            set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
            from agent.redact import register_vault_redaction_value
            from plugin_setup import configuration_redactions
            for value in configuration_redactions(root, request.get('configurations', [])):
                register_vault_redaction_value(value)
            if request['operation'] == 'run':
                if not profile or not request.get('cwd'):
                    raise ValueError('A command needs a chat and root working folder.')
                policy = json.loads((home / 'trismegistus-policy.json').read_text())
                if policy.get('mode') == 'plan':
                    raise ValueError('Plan mode does not run plugin command code.')
                cwd = Path(request['cwd']).resolve(strict=True)
                if not policy.get('folder') or cwd != Path(policy['folder']).resolve():
                    raise ValueError('The command working folder changed.')
                os.chdir(cwd)
                from gateway.session_context import set_session_vars
                set_session_vars(source='cli', chat_id=request['chat'], session_key=request['turn'],
                                 session_id=request['turn'], profile=profile, cwd=str(cwd), async_delivery=False)
                from tools.registry import discover_builtin_tools
                discover_builtin_tools()
            from hermes_cli.plugins import discover_plugins, get_plugin_commands, get_plugin_manager, require_pre_tool_plugin
            require_pre_tool_plugin('trismegistus-permissions')
            discover_plugins()
            loaded = {plugin['key']: plugin for plugin in get_plugin_manager().list_plugins()}
            if not any(plugin['name'] == 'trismegistus-permissions' and plugin['enabled'] and not plugin['error'] for plugin in loaded.values()):
                raise ValueError('Required permissions plugin did not load.')
            if any(key not in loaded or not loaded[key]['enabled'] or loaded[key]['error'] for key in request['plugins']):
                raise ValueError('A reviewed plugin could not load.')
            registered = {name: entry for name, entry in get_plugin_commands().items()
                          if entry.get('plugin_key') in request['plugins']}
        if request['operation'] == 'catalog':
            emit('result', value=[dict(command=name, pluginKey=entry['plugin_key'], plugin=entry['plugin'],
                                       description=entry.get('description', '')) for name, entry in registered.items()])
            return
        if request['operation'] != 'run':
            raise ValueError('Unsupported command operation.')
        entry = registered.get(request['command'])
        if not entry or entry['plugin_key'] != request['pluginKey']:
            raise ValueError('This reviewed command is no longer available.')
        approval_lock = threading.Lock()
        pending = {}
        disconnected = threading.Event()
        from tools.process_registry import process_registry

        def clean(value):
            if isinstance(value, str): return scrub(value)
            if isinstance(value, list): return [clean(item) for item in value]
            if isinstance(value, dict): return {key: clean(item) for key, item in value.items()}
            return value

        def processes():
            return process_registry.list_sessions(session_key=request['turn'], include_retained=True)

        def receive():
            try:
                for line in sys.stdin.buffer:
                    message = json.loads(line)
                    if message.get('type') == 'process':
                        try:
                            if message['method'] == 'list':
                                value = {'processes': processes()}
                            elif message['method'] == 'kill':
                                process = process_registry.get(message.get('processId'))
                                if process is None or process.session_key != request['turn']:
                                    raise ValueError('Process unavailable in this command.')
                                value = process_registry.kill_process(process.id)
                            else:
                                raise ValueError('Unsupported process operation.')
                            emit('process', id=message['id'], value=clean(value))
                        except Exception as error:
                            emit('process', id=message['id'], error=scrub(error))
                    elif message.get('id') in pending:
                        pending[message['id']].put(message)
            finally:
                disconnected.set()
                for response in list(pending.values()): response.put({'error': 'Command owner disconnected.'})

        threading.Thread(target=receive, daemon=True).start()

        def exchange(kind, **values):
            with approval_lock:
                if disconnected.is_set(): raise RuntimeError('Command owner disconnected.')
                identity = str(uuid4())
                response = pending[identity] = queue.Queue()
                try:
                    emit(kind, id=identity, **values)
                    answer = response.get()
                    if answer.get('error'): raise RuntimeError(answer['error'])
                    return answer
                finally:
                    pending.pop(identity, None)

        def coordinate(operation, **values):
            return exchange('work', operation=operation, **values)

        def approve(command, description, **_):
            response = exchange('approval', description=scrub(description), command=scrub(command))
            return 'once' if response.get('approved') is True else 'deny'

        os.environ['HERMES_INTERACTIVE'] = '1'
        from tools.terminal_tool import record_session_cwd, set_approval_callback
        record_session_cwd(request['turn'], str(cwd))
        set_approval_callback(approve)
        from hermes_cli.plugins import resolve_plugin_command_result
        from hermes_cli.plugins_host import plugin_tool_dispatcher
        from model_tools import get_tool_definitions, handle_function_call
        toolsets = ['file', 'terminal', 'memory', 'session_search', 'todo', 'skills']
        allowed = {tool['function']['name'] for tool in get_tool_definitions(enabled_toolsets=toolsets, quiet_mode=True, skip_tool_search_assembly=True)}
        allowed.add('inspect_action')

        def dispatch(ctx, name, args, kwargs):
            if ctx.plugin_id not in request['plugins'] or ctx._manager.home_path != home or name not in allowed:
                raise PermissionError('This tool is unavailable to the command worker.')
            # The owner supplies identity and grants. Plugin kwargs cannot skip permission hooks.
            coordinated_name, coordinated_args = name, args
            if name == 'tool_call':
                from tools.tool_search import resolve_underlying_call
                coordinated_name, coordinated_args, error = resolve_underlying_call(args)
                if error:
                    return json.dumps({'error': error})
            if coordinated_name == 'inspect_action':
                return json.dumps(coordinate('inspect', arguments=coordinated_args).get('value'))
            lease = coordinate('begin', name=coordinated_name, arguments=coordinated_args).get('lease')
            try:
                result = handle_function_call(name, args, task_id=request['turn'], session_id=request['turn'],
                                              turn_id=request['turn'], enabled_tools=list(allowed), enabled_toolsets=toolsets)
                try:
                    body = json.loads(result) if isinstance(result, str) else result
                except (ValueError, TypeError):
                    body = result
                coordinate('finish', lease=lease, result=result, uncertain=isinstance(body, dict) and bool(body.get('error') or body.get('isError')))
                return result
            except Exception:
                coordinate('finish', lease=lease, result='Command tool did not return a confirmed result.', uncertain=True)
                raise

        output = Output()
        with plugin_tool_dispatcher(dispatch), contextlib.redirect_stdout(output):
            result = resolve_plugin_command_result(entry['handler'](request.get('arguments', '')))
            output.flush()
        emit('processes', value=clean(processes()))
        emit('result', value=scrub(result or ''))
        while process_registry.has_active_for_session(request['turn']) and not disconnected.wait(0.2):
            pass
        emit('processes', value=clean(processes()))
    except Exception as error:
        emit('error', message=scrub(error))


if __name__ == '__main__':
    main()
    # The input reader may still be waiting; the supervisor owns descendant cleanup.
    os._exit(0)
