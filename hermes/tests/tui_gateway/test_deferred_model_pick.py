"""A composer selection made after lazy resume governs the next physical request."""
from tui_gateway.server import _deferred_build_agent_kwargs


def test_current_model_effort_and_tier_supersede_saved_runtime_without_changing_history(tmp_path):
    saved = {'model_override': {'model': 'gpt-6-astra', 'provider': 'openai-codex'},
             'provider_override': 'openai-codex', 'reasoning_config_override': {'effort': 'low'},
             'service_tier_override': 'priority'}
    current = {'resume_session_id': 'saved-conversation', 'resume_runtime_overrides': saved,
               'cwd': str(tmp_path), 'source': 'desktop'}
    restored = _deferred_build_agent_kwargs(current, None)
    assert restored['model_override'] == saved['model_override']
    pick = {'model': 'deepseek-flash', 'provider': 'deepseek', 'base_url': 'https://api.deepseek.com/v1'}
    current.update(model_override=pick, create_reasoning_override={'effort': 'high'}, create_service_tier_override='')
    changed = _deferred_build_agent_kwargs(current, None)
    assert changed['model_override'] == pick
    assert changed['provider_override'] == pick['provider']
    assert changed['reasoning_config_override'] == current['create_reasoning_override']
    assert changed['service_tier_override'] == ''
    assert changed['session_id'] == restored['session_id'] == 'saved-conversation'
    assert saved['provider_override'] == 'openai-codex'


def test_explicit_pick_during_build_switches_the_finished_agent(monkeypatch):
    import threading
    from tui_gateway import server

    boundary = threading.Event()

    class Ready(threading.Event):
        def wait(self, timeout=None):
            boundary.set()
            return super().wait(timeout)

    ready, built = Ready(), object()
    session = {'agent': None, 'agent_ready': ready, 'agent_build_started': True}
    monkeypatch.setitem(server._sessions, 'building', session)
    calls, results = [], []

    def switch(sid, current, value, **kwargs):
        boundary.set()
        assert current['agent'] is built
        calls.append(value)
        return {'value': 'chosen-model', 'warning': ''}

    monkeypatch.setattr(server, '_apply_model_switch', switch)
    worker = threading.Thread(target=lambda: results.append(server._methods['config.set'](1, {
        'session_id': 'building', 'key': 'model', 'value': 'chosen-model --provider deepseek --session'})))
    worker.start()
    try:
        assert boundary.wait(5)
        session['agent'] = built
    finally:
        ready.set()
        worker.join(5)
    assert not worker.is_alive()
    assert results[0].get('result', {}).get('value') == 'chosen-model', results
    assert calls == ['chosen-model --provider deepseek --session']
