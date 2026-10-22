"""A host's ordered fallback choices stay with their session and can be cleared."""
from types import SimpleNamespace

from tui_gateway import server


def test_session_order_survives_config_sync_without_affecting_another_chat(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    (tmp_path / 'config.yaml').write_text('fallback_providers: []\n', encoding='utf-8')
    sessions = {name: {'agent': SimpleNamespace(_fallback_chain=[], _fallback_activated=False),
                       'profile_home': str(tmp_path / name)} for name in ('a', 'b')}
    for name, session in sessions.items():
        (tmp_path / name).mkdir()
        (tmp_path / name / 'config.yaml').write_text('fallback_providers: []\n', encoding='utf-8')
        monkeypatch.setitem(server._sessions, name, session)
    chain = [{'provider': 'second', 'model': 'm2'}, {'provider': 'first', 'model': 'm1'}]

    def select(name, value):
        return server._methods['config.set'](1, {'session_id': name, 'key': 'fallback_providers', 'value': value})

    assert 'error' not in select('a', chain)
    for name in ('a', 'b', 'a'):
        with server._session_profile_runtime_scope(sessions[name]):
            server._sync_agent_fallback_with_config(name, sessions[name])
        assert sessions[name]['agent']._fallback_chain == (chain if name == 'a' else [])
    assert 'error' in select('a', [dict(chain[0], api_key='never-accept-inline-secrets')])
    assert sessions['a']['fallback_override'] == chain
    sessions['a']['running'] = True
    assert 'error' in select('a', [])
    sessions['a']['running'] = False
    assert 'error' not in select('a', [])
    server._sync_agent_fallback_with_config('a', sessions['a'])
    assert sessions['a']['agent']._fallback_chain == []
    assert 'error' in select('missing', chain)
