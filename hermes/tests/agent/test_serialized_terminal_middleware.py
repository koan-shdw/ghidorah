"""Terminal consent preparation must not deadlock an execution middleware lease."""
import contextvars
import json
import queue
import threading
from types import SimpleNamespace

from tests.agent.test_terminal_approval_batch import _agent, _call
from tools import approval
from tools.thread_context import propagate_context_to_thread


def test_terminal_middleware_keeps_context_and_releases_each_action_before_next(tmp_path, monkeypatch):
    from gateway.session_context import clear_session_vars
    from tools.terminal_scope import reset_terminal_scope, set_terminal_scope
    from tools.terminal_tool_lifecycle import cleanup_vm
    from tui_gateway import server
    monkeypatch.setenv('HERMES_EXEC_ASK', '1')
    monkeypatch.setattr('tools.approval_context._get_approval_mode', lambda:'manual')
    monkeypatch.setattr('tools.approval._tirith_scan', lambda command:{'action':'allow'})
    monkeypatch.setattr('agent.title_generator.maybe_auto_title', lambda *a, **kw:None)
    agent = _agent()
    key = 'serialized-terminal-'+tmp_path.name
    notices, errors, messages, completed = queue.Queue(), [], [], []
    approval.register_gateway_notify(key, notices.put)
    monkeypatch.setattr(server, '_sessions', {key:{'session_key':key,'source':'desktop','agent':agent,'cwd':str(tmp_path)}})
    scope = server._set_session_context(key)
    terminal = set_terminal_scope({'TERMINAL_ENV':'local','TERMINAL_CWD':str(tmp_path)})
    lease = threading.Lock()
    owned = contextvars.ContextVar('action_owned', default=False)
    def middleware(name, args, next_call, **kwargs):
        with lease:
            token = owned.set(True)
            try:
                result = next_call(args)
                completed.append(args['command'])
                return result
            finally:
                owned.reset(token)
    monkeypatch.setattr('hermes_cli.middleware.run_tool_execution_middleware', middleware)
    monkeypatch.setattr('hermes_cli.plugins.has_middleware', lambda kind:kind=='tool_execution')
    def pre_tool(name, args, **kwargs):
        assert owned.get(), 'Middleware context was lost before the policy gate'
        return None, args
    monkeypatch.setattr('hermes_cli.plugins._dispatch_pre_tool_call_hooks', pre_tool)
    commands = ['rm -rf absent-one; echo first', 'rm -rf absent-two; echo second']
    calls = [_call(str(i), command) for i,command in enumerate(commands)]
    agent._flush_messages_to_session_db = lambda *a, **kw:True
    def run():
        try:
            agent._execute_tool_calls(SimpleNamespace(tool_calls=calls), messages, key)
        except BaseException as error:
            errors.append(error)
    worker = threading.Thread(target=propagate_context_to_thread(run), daemon=True)
    worker.start()
    try:
        first = notices.get(timeout=15)
        assert completed == [] and notices.empty()
        approval.resolve_gateway_approval(key, 'once', request_id=first['request_id'])
        second = notices.get(timeout=15)
        assert completed == [commands[0]]
        approval.resolve_gateway_approval(key, 'once', request_id=second['request_id'])
        worker.join(15)
        assert not worker.is_alive() and errors == []
        assert completed == commands
        assert [json.loads(m['content'])['output'].strip() for m in messages] == ['first','second']
    finally:
        agent.interrupt('test cleanup')
        approval.unregister_gateway_notify(key)
        worker.join(5)
        cleanup_vm(key)
        reset_terminal_scope(terminal)
        clear_session_vars(scope)
