"""Embedders can keep task scratch outside protected runtime storage."""
import json

from agent import prompt_builder
from agent.secret_scope import set_multiplex_active
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from tools.terminal_scope import install_and_reset_profile_terminal_scope


def test_scratch_guidance_follows_profile_without_changing_runtime_temp(tmp_path, monkeypatch):
    monkeypatch.delenv('HERMES_ENVIRONMENT_HINT', raising=False)
    homes = [tmp_path / 'first', tmp_path / 'second']
    for home in homes:
        home.mkdir()
        (home / 'work').mkdir()
    hint = 'Keep task scripts and probes in the working directory; the profile cache is private.'
    for home, agent in zip(homes, [{'scratch_hint': hint}, {}]):
        (home / 'config.yaml').write_text(json.dumps({'agent': agent, 'terminal': {'cwd': str(home / 'work')}}))
    set_multiplex_active(True)
    try:
        for home in [*homes, homes[0]]:
            token = set_hermes_home_override(str(home))
            try:
                with install_and_reset_profile_terminal_scope(home):
                    result = prompt_builder.build_environment_hints()
                assert str(home / 'work') in result
                if home == homes[0]:
                    assert hint in result
                    assert str(home / 'cache' / 'scratch') not in result
                    assert not (home / 'cache' / 'scratch').exists()
                else:
                    assert hint not in result
                    assert str(home / 'cache' / 'scratch') in result
            finally:
                reset_hermes_home_override(token)
    finally:
        set_multiplex_active(False)


def test_local_scratch_override_stays_out_of_remote_environment(tmp_path, monkeypatch):
    hint = 'Local task scratch belongs in the local workspace.'
    (tmp_path / 'config.yaml').write_text(json.dumps({'agent': {'scratch_hint': hint}, 'terminal': {'backend': 'docker'}}))
    monkeypatch.setattr(prompt_builder, '_probe_remote_backend', lambda backend: '  OS: Linux')
    token = set_hermes_home_override(str(tmp_path))
    try:
        with install_and_reset_profile_terminal_scope(tmp_path):
            result = prompt_builder.build_environment_hints()
        assert 'Terminal backend: docker' in result
        assert hint not in result
        assert str(tmp_path) not in result
    finally:
        reset_hermes_home_override(token)
