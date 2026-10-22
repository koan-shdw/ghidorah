"""Desktop bridge deadlines respect action-bound human waits."""
import importlib.util
import json
from pathlib import Path


def test_only_cross_chat_human_waits_outlive_the_execution_deadline(monkeypatch):
    from gateway import session_context
    from tools import interrupt
    from tui_gateway import server_requests

    path = Path(__file__).resolve().parents[1] / 'plugins/trismegistus-permissions/mcp.py'
    spec = importlib.util.spec_from_file_location('desktop_stall_bridge', path)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    monkeypatch.setattr(session_context, 'session_context_engaged', lambda: True)
    monkeypatch.setattr(session_context, 'get_session_env', lambda key: 'desktop' if key == 'HERMES_SESSION_SOURCE' else 'own-session')
    monkeypatch.setattr(interrupt, 'is_interrupted', lambda: False)
    calls = []

    def send(method, sid, params, *, timeout):
        calls.append((method, sid, params, timeout))
        return {'value': {'done': True}}

    monkeypatch.setattr(server_requests, 'send', send)
    for operation in ['chat-coordinate', 'call', 'chat-history', 'output', 'web']:
        assert json.loads(bridge.exchange(operation)) == {'done': True}
        assert calls[-1][1] == 'own-session'
        assert calls[-1][-1] == (None if operation == 'chat-coordinate' else 310)
    monkeypatch.setattr(interrupt, 'is_interrupted', lambda: True)
    assert 'no longer active' in bridge.exchange('chat-coordinate')
    assert len(calls) == 5


def test_day_long_approval_window_is_safe_for_windows_waits(monkeypatch):
    import threading
    from tools import approval_context
    from tools.approval_human_wait import human_wait_ceiling
    from agent.tool_executor import _authorization_gate_lock_timeout

    monkeypatch.setattr(approval_context, '_get_approval_config', lambda: {'timeout': 86400})
    assert approval_context._get_approval_timeout() == 86400
    for timeout in [approval_context._get_approval_timeout(), human_wait_ceiling(), _authorization_gate_lock_timeout()]:
        lock = threading.Lock()
        assert lock.acquire(timeout=timeout)
        lock.release()
