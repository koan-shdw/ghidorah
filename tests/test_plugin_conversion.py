import json
from pathlib import Path
import subprocess
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from plugin_conversion import convert_claude


def put(root, name, value):
    file = root / name
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value) if isinstance(value, dict) else value, encoding='utf8')


def test_conversion_preserves_source_and_only_registers_supported_skills(tmp_path):
    source = tmp_path / 'original'
    put(source, '.claude-plugin/plugin.json', dict(name='example', version='1', commands=['./custom', './missing']))
    put(source, '__init__.py', 'raise RuntimeError("must not execute original code")')
    put(source, 'skills/hello/SKILL.md', '---\nname: hello\ndescription: Greeting\n---\nSay hello.')
    put(source, 'skills/manual/SKILL.md', '---\ndisable-model-invocation: true\n---\nManual only.')
    put(source, 'skills/restricted/SKILL.md', '---\nallowed-tools: Read\n---\nRead only.')
    put(source, 'commands/replaced.md', 'This default directory must not be added.')
    put(source, 'custom/run.md', '---\ndescription: Run command\n---\nUse ${CLAUDE_PLUGIN_ROOT}. $ARGUMENTS')
    put(source, 'custom/dynamic.md', 'Read !`some command`')
    put(source, 'custom/positional.md', 'Use $0 and $1')
    put(source, 'custom/nested/subcommand.md', 'A nested command.')
    put(source, 'custom/hidden.md', '---\nuser-invocable: false\n---\nHidden command.')
    put(source, 'agents/worker.md', 'Native worker.')
    put(source, 'hooks/hooks.json', dict(hooks={}))
    put(source, '.mcp.json', dict(mcpServers={'local': dict(command='python', args=['${CLAUDE_PLUGIN_ROOT}/server.py'])}))
    original = {file.relative_to(source): file.read_bytes() for file in source.rglob('*') if file.is_file()}
    review = convert_claude(tmp_path / 'hermes', source, 'installed:example', 'a' * 40)
    root = Path(review['source'])
    assert original == {file.relative_to(root / 'source'): file.read_bytes() for file in (root / 'source').rglob('*') if file.is_file()}
    conversion = review['conversion']
    assert [row['name'] for row in conversion['skills']] == ['hello']
    assert {row['name'] for row in conversion['commands']} == {'hello', 'manual', 'run'}
    assert all(any(word in row for row in conversion['unsupported']) for word in ['allowed-tools', 'dynamic', 'positional', 'nested', 'agents', 'hooks', 'invocation disabled', 'missing', 'user invocation disabled'])
    assert conversion['servers'][0]['config']['args'] == ['${CLAUDE_PLUGIN_ROOT}/server.py']
    # Execute only the generated adapter with a register_skill receiver. Original Python must stay inert.
    calls = []
    scope = {'__file__': str(root / '__init__.py')}
    exec(compile((root / '__init__.py').read_text(), str(root / '__init__.py'), 'exec'), scope)
    class Context:
        def register_skill(self, name, path, **kwargs):
            calls.append((name, path, kwargs))
    scope['register'](Context())
    assert calls[0][0] == 'hello'
    assert calls[0][1].read_text(encoding='utf8') == (source / 'skills/hello/SKILL.md').read_text(encoding='utf8')


def test_command_maps_and_mcp_overrides_are_preserved(tmp_path):
    source = tmp_path / 'original'
    put(source, '.claude-plugin/plugin.json', dict(name='example', commands={
        'inline': dict(content='Use $ARGUMENTS', description='Inline command'),
        'file': dict(source='./extra.md'),
        'unsupported': dict(content='Use ${OTHER_PATH}'),
        'runtime': {'content': 'Read a file', 'allowed-tools': 'Read'},
    }, mcpServers=[dict(local=dict(command='second')), './extra-mcp.json']))
    put(source, 'extra.md', 'A file command.')
    put(source, 'commands/ignored.md', 'Default command must be replaced.')
    put(source, '.mcp.json', dict(mcpServers=dict(local=dict(command='first'))))
    put(source, 'extra-mcp.json', dict(mcpServers=dict(remote=dict(url='https://example.invalid/mcp'))))
    result = convert_claude(tmp_path / 'hermes', source, 'owner/repo', 'b' * 40)['conversion']
    assert {row['name'] for row in result['commands']} == {'inline', 'file'}
    assert {row['name']: row['config'] for row in result['servers']} == dict(local=dict(command='second'), remote=dict(url='https://example.invalid/mcp'))
    assert any('unsupported' in row for row in result['unsupported'])


def test_conversion_requires_commit_and_rejects_escaping_paths_and_junctions(tmp_path):
    source = tmp_path / 'original'
    put(source, '.claude-plugin/plugin.json', dict(name='example', commands='../outside.md'))
    for commit, error in [('', 'commit'), ('a' * 40, 'inside')]:
        with pytest.raises(ValueError, match=error):
            convert_claude(tmp_path / 'hermes', source, 'owner/repo', commit)
    put(source, '.claude-plugin/plugin.json', dict(name='example'))
    outside = tmp_path / 'outside'
    outside.mkdir()
    if sys.platform == 'win32':
        subprocess.run(['cmd', '/c', 'mklink', '/J', str(source / 'linked'), str(outside)], check=True, capture_output=True)
    else:
        (source / 'linked').symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match='links'):
        convert_claude(tmp_path / 'hermes', source, 'owner/repo', 'a' * 40)
