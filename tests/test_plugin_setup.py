import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from plugin_setup import metadata, save_configuration, load_configuration, configuration_values, install_secret_source, runtime_hash, check_runtime, validate_plugins


def fixture(tmp_path, monkeypatch):
    import windows_credentials
    from security import install_codec
    monkeypatch.setattr(windows_credentials, 'get', lambda name: b'x' * 32)
    install_codec('synthetic-test')
    source = tmp_path / 'source'
    source.mkdir()
    (source / 'plugin.yaml').write_text(json.dumps(dict(name='example', version='1.0', requires_env=['EXAMPLE_PLUGIN_TOKEN'], config_schema={
        'label': dict(type='string', default='first'), 'size': dict(type='integer', required=True),
        'kind': dict(type='str', choices=['brief', 'full'], default='brief'), 'api_key': dict(type='secret', env='EXAMPLE_API_KEY'),
    })), encoding='utf8')
    return source, tmp_path / 'hermes'


def test_settings_use_canonical_encrypted_revisions_and_validate_before_saving(tmp_path, monkeypatch):
    source, home = fixture(tmp_path, monkeypatch)
    first = save_configuration(home, source, {'env:EXAMPLE_PLUGIN_TOKEN': 'synthetic-plugin-credential', 'setting:size': 2, 'setting:api_key': 'synthetic-other-credential'})
    assert first['settings']['api_key'] == '${env:EXAMPLE_API_KEY}'
    assert first['values'] == {'setting:label': 'first', 'setting:size': 2, 'setting:kind': 'brief'}
    raw = (home / 'plugin-configurations' / (first['revision'] + '.json')).read_text()
    assert 'synthetic-plugin-credential' not in raw and 'synthetic-other-credential' not in raw
    second = save_configuration(home, source, {'setting:label': 'second'}, first['revision'])
    assert load_configuration(home, first['revision'])['values']['setting:label'] == 'first'
    assert configuration_values(home, [second['revision']])['EXAMPLE_PLUGIN_TOKEN'] == 'synthetic-plugin-credential'
    for values in ({'setting:size': True}, {'setting:size': 1.2}, {'setting:kind': 'invalid'}, {'setting:unknown': 'invalid'}, {'env:EXAMPLE_PLUGIN_TOKEN': None}):
        with pytest.raises(ValueError):
            save_configuration(home, source, values, first['revision'])
    third = save_configuration(home, source, {'env:EXAMPLE_PLUGIN_TOKEN': 'different-value'}, first['revision'])
    with pytest.raises(ValueError, match='different values'):
        configuration_values(home, [first['revision'], third['revision']])


def test_existing_secret_source_api_supplies_named_profiles_without_plaintext_copies(tmp_path, monkeypatch):
    source, home = fixture(tmp_path, monkeypatch)
    saved = save_configuration(home, source, {'env:EXAMPLE_PLUGIN_TOKEN': 'profile-plugin-credential', 'setting:size': 2})
    # Restore process environment after the app's legitimate startup injection.
    monkeypatch.setenv('EXAMPLE_PLUGIN_TOKEN', '')
    monkeypatch.delenv('EXAMPLE_PLUGIN_TOKEN')
    install_secret_source(home, [saved['revision']])
    from agent.secret_sources.registry import get_source
    resolver = get_source('trismegistus_plugins')
    for folder in [home, home / 'profiles' / ('p-' + 'a' * 36)]:
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'config.yaml').write_text(json.dumps(dict(secrets=dict(trismegistus_plugins=dict(enabled=True)), plugins=dict(entries=dict(example=dict(settings=saved['settings']))))), encoding='utf8')
        from agent.secret_scope import build_profile_secret_scope, set_secret_scope, reset_secret_scope
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        from hermes_cli.env_loader import hydrate_profile_secret_sources
        hydrate_profile_secret_sources(folder)
        scope = build_profile_secret_scope(folder)
        assert scope['EXAMPLE_PLUGIN_TOKEN'] == 'profile-plugin-credential'
        token = set_secret_scope(scope, profile_home=str(folder))
        override = set_hermes_home_override(folder)
        try:
            from hermes_cli.config import load_config_readonly
            assert load_config_readonly()['plugins']['entries']['example']['settings']['size'] == 2
        finally:
            reset_hermes_home_override(override)
            reset_secret_scope(token)
        assert not (folder / '.env').exists()
        assert 'profile-plugin-credential' not in (folder / 'config.yaml').read_text()
    assert not resolver.fetch({}, tmp_path / 'outside').ok


def test_dependency_metadata_reuses_hermes_declarations_and_runtime_checks(tmp_path, monkeypatch):
    source, home = fixture(tmp_path, monkeypatch)
    (source / 'pyproject.toml').write_text('[project]\nname="example"\ndependencies=["packaging>=20; python_version >= \'3.10\'"]\n', encoding='utf8')
    assert metadata(source)['python'] == ['packaging>=20']
    runtime = tmp_path / 'plugin-runtimes/runtime-example'
    runtime.mkdir(parents=True)
    (runtime / 'example.py').write_text('value=1')
    record = dict(directory=str(runtime), hash=runtime_hash(runtime))
    assert check_runtime(home, record) == runtime
    (runtime / 'example.py').write_text('value=2')
    with pytest.raises(ValueError, match='changed'):
        check_runtime(home, record)
    (source / 'plugin.yaml').write_text('name: example\nrequires_plugins:\n  - id: helper\n    version_range: ">=2"\n')
    plugin = dict(directory=str(source), name='example', key='reviewed/example', version='1.0')
    with pytest.raises(ValueError, match='requires enabled'):
        validate_plugins([plugin])
    helper = tmp_path / 'helper'
    helper.mkdir()
    (helper / 'plugin.yaml').write_text('name: helper\n')
    validate_plugins([plugin, dict(directory=str(helper), name='helper', key='reviewed/helper', version='2.0')])
    (source / 'plugin.yaml').write_text('name: example\nrequires_env: [PYTHONPATH]\n')
    with pytest.raises(ValueError, match='runtime'):
        metadata(source)


def test_runtime_discards_unverified_bytecode_before_import(tmp_path):
    import os
    import py_compile
    import subprocess
    runtime = tmp_path / 'plugin-runtimes/runtime-bytecode'
    runtime.mkdir(parents=True)
    source = runtime / 'sample.py'
    source.write_text('value = 1\n', encoding='utf-8')
    stamp = source.stat().st_mtime
    record = dict(directory=str(runtime), hash=runtime_hash(runtime))
    source.write_text('value = 2\n', encoding='utf-8')
    os.utime(source, (stamp, stamp))
    py_compile.compile(str(source), doraise=True)
    source.write_text('value = 1\n', encoding='utf-8')
    os.utime(source, (stamp, stamp))
    # Same source size/mtime makes the poisoned cache valid to Python. It must
    # be discarded by the app even for a legacy source-only runtime hash.
    assert check_runtime(tmp_path / 'hermes', record) == runtime
    result = subprocess.run([sys.executable, '-B', '-c', 'import sample; print(sample.value)'],
                            cwd=runtime, capture_output=True, text=True, check=True,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.stdout.strip() == '1'
    assert not list(runtime.rglob('*.pyc'))


def test_cache_junction_cannot_redirect_runtime_cleanup(tmp_path):
    import subprocess
    runtime = tmp_path / 'plugin-runtimes/runtime-linked'
    runtime.mkdir(parents=True)
    (runtime / 'sample.py').write_text('value = 1\n')
    record = dict(directory=str(runtime), hash=runtime_hash(runtime))
    outside = tmp_path / 'outside'; outside.mkdir()
    protected = outside / 'keep.pyc'; protected.write_bytes(b'kept')
    link = runtime / '__pycache__'
    subprocess.run(['powershell', '-NoProfile', '-Command',
                    '& { New-Item -ItemType Junction -Path $args[0] -Target $args[1] | Out-Null }',
                    str(link), str(outside)], check=True, capture_output=True,
                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    try:
        with pytest.raises(ValueError, match='links'):
            check_runtime(tmp_path / 'hermes', record)
        assert protected.read_bytes() == b'kept'
    finally:
        link.rmdir()
