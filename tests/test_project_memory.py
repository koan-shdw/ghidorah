import json
from pathlib import Path
import sys
import uuid
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from project_memory import project_memory


def test_shared_hermes_store_caps_batch_and_profile_binding(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    profiles = ['p-' + str(uuid.uuid4()) for _ in range(2)]
    for profile in profiles:
        home = tmp_path / 'profiles' / profile
        home.mkdir(parents=True)
        (home / 'config.yaml').write_text(json.dumps({'memory': {'memory_char_limit': 150}}))
    def call(profile, name='read_project_memory', **args):
        return project_memory(tmp_path, profile, name, args)
    for profile, text in zip(profiles, ('alpha-only', 'beta-only')):
        assert call(profile, 'update_project_memory', action='add', content=text)['success']
        assert text in call(profile)['memory']
    assert 'beta-only' not in call(profiles[0])['memory']
    assert 'alpha-only' not in call(profiles[1])['memory']
    assert not call(profiles[0], 'update_project_memory', action='add', content='x' * 151)['success']
    assert call(profiles[0], 'update_project_memory', operations=[{'action':'replace','old_text':'alpha-only','content':'changed-alpha'}, {'action':'add','content':'second-fact'}])['success']
    assert 'changed-alpha' in call(profiles[0])['memory']
    assert call(profiles[0], 'update_project_memory', action='remove', old_text='second-fact')['success']
    assert 'second-fact' not in call(profiles[0])['memory']
    review = call(profiles[0], 'prepare_project_memory', action='replace', old_text='changed-alpha', content='reviewed-replacement')['payload']
    assert call(profiles[0], 'update_project_memory', action='replace', old_text='changed-alpha', content='changed-alpha-with-new-fact')['success']
    stale = project_memory(tmp_path, profiles[0], 'update_project_memory', {}, review)
    assert not stale['success']
    assert 'changed-alpha-with-new-fact' in call(profiles[0])['memory']
    assert call(profiles[0], 'update_project_memory', target='user', action='add', content='Prefers concise replies')['success']
    assert 'concise' in call(profiles[0])['user']
    assert not call(profiles[1])['user']
    for invalid in ('../other', 'default', profiles[0] + '/..'):
        with pytest.raises(ValueError): call(invalid)
    with pytest.raises(ValueError): project_memory(tmp_path, profiles[0], 'read_project_memory', {'profile':profiles[1]})
    assert not (tmp_path / 'memories').exists()


def test_linked_memory_refused(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    profile = 'p-' + str(uuid.uuid4())
    home = tmp_path / 'profiles' / profile
    home.mkdir(parents=True)
    outside = tmp_path / 'other-memory'
    outside.mkdir()
    try:
        if sys.platform == 'win32':
            import _winapi
            _winapi.CreateJunction(str(outside), str(home / 'memories'))
        else: (home / 'memories').symlink_to(outside, target_is_directory=True)
    except OSError: pytest.skip('Symlinks are unavailable')
    with pytest.raises(ValueError, match='Linked'):
        project_memory(tmp_path, profile, 'read_project_memory', {})
