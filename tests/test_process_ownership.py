"""Desktop permission middleware guards live and retained process handles."""
import importlib.util
import contextvars
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

APP = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('trismegistus_work', APP / 'plugins/trismegistus-permissions/work.py')
work = importlib.util.module_from_spec(spec)
spec.loader.exec_module(work)


@pytest.fixture
def scope(monkeypatch):
    from gateway.session_context import set_session_vars, clear_session_vars
    from tools.approval_context import set_current_session_key, reset_current_session_key
    from tools.process_registry import process_registry
    tokens = set_session_vars(source='desktop', session_key='chat-a', ui_session_id='ui-a')
    approval = set_current_session_key('chat-a')
    own = SimpleNamespace(id='proc_aaaa0000', session_key='chat-a')
    foreign = SimpleNamespace(id='proc_bbbb0000', session_key='chat-b')
    records = {own.id: own, 'aaaa': own, foreign.id: foreign, 'bbbb': foreign}
    monkeypatch.setattr(process_registry, 'get', lambda value: records.get(value))
    exchange = Mock(return_value={'enabled': True, 'lease': 'lease'})
    monkeypatch.setattr(work, 'exchange', exchange)
    monkeypatch.setattr(work, '_completion', lambda lease, result, uncertain, refused=False:
                        exchange('finish', lease=lease, result=result, uncertain=uncertain, refused=refused))
    try:
        yield records, exchange
    finally:
        reset_current_session_key(approval)
        clear_session_vars(tokens)


@pytest.mark.parametrize('action', ['poll', 'log', 'wait', 'kill', 'write', 'submit', 'close', 'handoff'])
@pytest.mark.parametrize('handle', ['proc_bbbb0000', 'bbbb', 'proc_missing'])
def test_foreign_or_missing_handle_never_dispatches(scope, action, handle):
    run = Mock(return_value='{}')
    answer = json.loads(work.execute('process_manage', {'action': action, 'session_id': handle}, run))
    assert answer == {'error': "Process unavailable in this chat. List this chat's processes first."}
    run.assert_not_called()
    scope[1].assert_not_called()


def test_nested_dispatch_keeps_ownership_check_and_canonical_handle(scope):
    token = work._checked.set(True)
    run = Mock(return_value='{}')
    try:
        assert 'error' in json.loads(work.execute('process_manage', {'action': 'kill', 'session_id': 'bbbb'}, run))
        run.assert_not_called()
        assert json.loads(work.execute('process_manage', {'action': 'poll', 'session_id': 'aaaa'}, run)) == {}
        run.assert_called_once_with({'action': 'poll', 'session_id': 'proc_aaaa0000'})
        scope[1].assert_not_called()
    finally:
        work._checked.reset(token)


def test_list_excludes_foreign_and_retained_unowned_results(scope):
    result = {'processes': [{'session_id': handle, 'output': handle} for handle in ['proc_aaaa0000', 'proc_bbbb0000', 'old-result']]}
    answer = json.loads(work.execute('process_manage', {'action': 'list'}, lambda args: json.dumps(result)))
    assert answer == {'processes': [{'session_id': 'proc_aaaa0000', 'output': 'proc_aaaa0000'}]}
    assert scope[1].call_args.kwargs['result'] == json.dumps(answer)


def test_missing_owner_fails_closed_before_even_listing(scope, monkeypatch):
    from tools import approval_context
    monkeypatch.setattr(approval_context, 'get_current_session_key', lambda **_: '')
    run = Mock(return_value='{}')
    assert json.loads(work.execute('process_manage', {'action': 'list'}, run)) == {'error': 'This chat has no process owner.'}
    run.assert_not_called()
    scope[1].assert_not_called()


@pytest.mark.parametrize('result', ['not json', {'processes': ['invalid row']}, {'unknown': 'private output'}])
def test_invalid_listing_returns_error_without_middleware_fallthrough(scope, result):
    answer = json.loads(work.execute('process_manage', {'action': 'list'}, lambda args: result))
    assert answer == {'error': "This chat's process list could not be verified."}


def test_failed_ownership_lookup_never_exposes_a_listing(scope, monkeypatch):
    from tools.process_registry import process_registry
    def failed(_):
        raise RuntimeError('registry unavailable')
    monkeypatch.setattr(process_registry, 'get', failed)
    answer = json.loads(work.execute('process_manage', {'action': 'list'}, lambda args: {'processes': [{'session_id': 'private'}]}))
    assert answer == {'error': "This chat's process list could not be verified."}


def test_deferred_call_is_checked_before_acquiring_a_lease(scope, monkeypatch):
    from tools import tool_search
    monkeypatch.setattr(tool_search, 'resolve_underlying_call', lambda _: ('process_manage', {'action': 'kill', 'session_id': 'bbbb'}, None))
    run = Mock(return_value='{}')
    assert 'error' in json.loads(work.execute('tool_call', {'name': 'process_manage'}, run))
    run.assert_not_called()
    scope[1].assert_not_called()


def test_plan_permits_owned_process_inspection_but_not_input_or_termination(tmp_path):
    source = importlib.util.spec_from_file_location('process_permissions', APP / 'plugins/trismegistus-permissions/__init__.py')
    permissions = importlib.util.module_from_spec(source)
    source.loader.exec_module(permissions)
    for folder in [str(tmp_path), None]:
        policy = {'folder': folder, 'mode': 'plan', 'secrets_root': str(tmp_path / 'private')}
        for action in ['list', 'poll', 'log', 'wait']:
            assert permissions.decide('process_manage', {'action': action, 'session_id': 'proc_owned'}, policy) is None
        for action in ['kill', 'write', 'submit', 'close']:
            assert permissions.decide('process_manage', {'action': action, 'session_id': 'proc_owned'}, policy)['action'] == 'block'


def test_mandatory_refusal_is_reported_once_and_does_not_leak_to_next_call(scope):
    def denied(args):
        # Match Hermes's bounded pre-tool hooks, which use copied contexts.
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(contextvars.copy_context().run, work.refused).result()
        return json.dumps({'error': 'Plan mode'})
    work.execute('process_manage', {'action': 'kill', 'session_id': 'aaaa'}, denied)
    assert scope[1].call_args.kwargs['refused'] is True
    work.execute('process_manage', {'action': 'poll', 'session_id': 'aaaa'}, lambda args: '{}')
    assert scope[1].call_args.kwargs['refused'] is False
