"""Cancellation may stop execution, never completion accounting."""
import importlib.util
import json
from pathlib import Path
from unittest.mock import Mock
from uuid import uuid4

import pytest

spec = importlib.util.spec_from_file_location('work_receipts', Path(__file__).resolve().parents[1] / 'plugins/trismegistus-permissions/work.py')
work = importlib.util.module_from_spec(spec)
spec.loader.exec_module(work)


def test_cancelled_session_can_report_completion_but_cannot_start(monkeypatch):
    from gateway import session_context
    from tools import interrupt
    from tui_gateway import server_requests
    monkeypatch.setattr(session_context, 'session_context_engaged', lambda: True)
    monkeypatch.setattr(session_context, 'get_session_env', lambda key: 'desktop' if key == 'HERMES_SESSION_SOURCE' else 'old-session')
    monkeypatch.setattr(interrupt, 'is_interrupted', lambda: True)
    send = Mock(return_value={'enabled': True})
    monkeypatch.setattr(server_requests, 'send', send)
    with pytest.raises(RuntimeError, match='stopped'):
        work.exchange('begin')
    assert work.exchange('finish', lease='original', result={'exit_code': 0}) == {'enabled': True}
    assert send.call_count == 1


def test_lost_completion_preserves_original_result_and_disk_receipt(tmp_path, monkeypatch):
    import hermes_constants
    from gateway import session_context
    monkeypatch.setattr(hermes_constants, 'get_hermes_home', lambda: tmp_path)
    monkeypatch.setattr(session_context, 'get_session_env', lambda key: 'original-session')
    lease = str(uuid4())
    exchange = Mock(side_effect=[{'lease': lease}, RuntimeError('desktop closed')])
    monkeypatch.setattr(work, 'exchange', exchange)
    result = json.dumps({'exit_code': 1, 'output': 'test failed', 'error': None})
    run = Mock(return_value=result)
    assert work.execute('terminal', {'command': 'test'}, run, tool_call_id='original-tool-call') == result
    assert exchange.call_args_list[0].kwargs['request_id'] == 'original-tool-call'
    assert run.call_count == 1
    receipt = tmp_path / 'desktop' / 'work-results' / (lease + '.json')
    assert json.loads(receipt.read_text()) == {'lease': lease, 'session_id': 'original-session', 'result': result, 'uncertain': False, 'refused': False}
    assert exchange.call_count == 2, 'Do not replace a real result with a fabricated missing-result report'
    monkeypatch.setattr(work, 'exchange', Mock(return_value={'enabled': True}))
    work._completion(lease, result, False)
    assert not receipt.exists()
    assert list(receipt.parent.glob('*.tmp')) == []


def test_tool_exception_cannot_fall_through_and_execute_again(monkeypatch):
    monkeypatch.setattr(work, 'exchange', Mock(return_value={'lease': str(uuid4())}))
    completion = Mock()
    monkeypatch.setattr(work, '_completion', completion)
    run = Mock(side_effect=RuntimeError('tool failed after starting'))
    assert json.loads(work.execute('terminal', {}, run))['uncertain'] is True
    assert run.call_count == 1
    assert completion.call_args.args[2] is True


def test_trusted_pre_execution_refusal_does_not_create_uncertain_hold(monkeypatch):
    monkeypatch.setattr(work, 'exchange', Mock(return_value={'lease': str(uuid4())}))
    completion = Mock()
    monkeypatch.setattr(work, '_completion', completion)
    def denied(args):
        work.after_tool(status='blocked', error_type='plugin_block')
        return json.dumps({'error':'Approval timed out'})
    work.execute('write_file', {}, denied)
    assert completion.call_args.args[3] is True
    def started(args):
        work.after_tool(status='error', error_type='tool_error')
        return json.dumps({'error':'Approval timed out'})
    work.execute('write_file', {}, started)
    assert completion.call_args.args[3] is False


def test_real_dispatcher_reports_expired_approval_before_entering_writer(monkeypatch):
    from types import SimpleNamespace
    from agent import tool_executor
    from hermes_cli import plugins, lifecycle
    from tools import approval
    hooks = {}
    work.register(SimpleNamespace(register_hook=lambda name, fn: hooks.update({name:fn}), register_tool=lambda **_:None))
    def hook(event, **values):
        if event == 'pre_tool_call':
            return [{'action':'approve','message':'Synthetic file edit','rule_key':'receipt-regression'}]
        if event in hooks:
            hooks[event](**values)
        return []
    monkeypatch.setattr(lifecycle, 'invoke_hook', hook)
    monkeypatch.setattr(lifecycle, 'has_hook', lambda _:True)
    monkeypatch.setattr(plugins, '_required_pre_tool_plugins', set())
    monkeypatch.setattr(approval, '_presence', lambda *a, **k:(lambda *a, **k:'timeout', True, False, False))
    monkeypatch.setattr(approval, '_yolo_active', lambda:False)
    monkeypatch.setattr(approval, 'is_approved', lambda *a, **k:False)
    monkeypatch.setattr(work, 'exchange', Mock(return_value={'lease':str(uuid4())}))
    completion = Mock()
    monkeypatch.setattr(work, '_completion', completion)
    writer = Mock(side_effect=AssertionError('Expired approval reached writer'))
    def dispatch(args):
        ref = tool_executor._ToolCallRef('write_file', args, 'receipt-test', 'receipt-call', [])
        return tool_executor._dispatch_authorized_once(SimpleNamespace(), SimpleNamespace(), ref, execute=writer, scope_block=None, display_index=None, begin_execution=None, authorization_gate=None)
    result = json.loads(work.execute('write_file', {}, dispatch))
    assert 'timed out' in result['error']
    assert writer.call_count == 0 and completion.call_args.args[3] is True
