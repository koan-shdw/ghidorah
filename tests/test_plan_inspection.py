import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

import pytest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP/'runtime/hermes'))
spec = importlib.util.spec_from_file_location('plan_permissions', APP/'plugins/trismegistus-permissions/__init__.py')
permissions = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = permissions
spec.loader.exec_module(permissions)
from plan_permissions.inspection import prepare, commands, validate, prepared


def test_bounded_grammar_rejects_writes_and_execution_options():
    for command in [
        'git diff; touch changed', 'git diff > changed', 'git diff $(touch changed)',
        'git diff `touch changed`', 'git diff &', 'git diff ||', 'git diff --output=changed',
        'git log --output changed', 'git log --show-signature', 'git log --format=%G?',
        'git -c core.fsmonitor=evil status', 'git checkout main', 'git branch new',
        'git branch -- new', 'git config x y', 'git show --ext-diff', 'git show --textconv',
        'git ls-files --recurse-submodules', 'git rev-parse --local-env-vars',
        'head --help; python x.py', 'find . -exec touch changed ;', 'sed -i x file',
        'git diff | bash', 'cd sub && git diff', 'env git diff', './git diff',
        'powershell Get-Content file', 'git diff\nrm file', 'git diff "unterminated', 'head -n', 'git log -n --output=x',
    ]:
        with pytest.raises(ValueError, match='Plan|quotation'):
            for words, _ in commands(command):
                validate(words)
    for command in ['git diff --stat && git diff HEAD -- file', 'git log -5 --oneline; git status --short',
                    'git -C "folder with spaces" show HEAD:file', 'pwd\nls -lah', 'cat file | head -20',
                    'git log --format="%h %s"', 'git branch --list "feature/*"', 'head -n 20 file', 'git log -n 5']:
        for words, _ in commands(command):
            validate(words)


def test_real_git_and_file_inspection_disable_helpers_and_leave_repo_unchanged(tmp_path, monkeypatch):
    from tools.environments.local import _find_bash
    repo = tmp_path/'repository with spaces'
    repo.mkdir()
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repo), *args], text=True)
    git('init', '-q', '-b', 'main')
    (repo/'calc.py').write_text('def add(a,b): return a+b\n')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base')
    (repo/'calc.py').write_text('def add(a,b): return a-b\n')
    (repo/'.gitattributes').write_text('*.py filter=trip diff=trip\n')
    canary = 'echo forbidden > '+shlex.quote(str(repo/'executed.txt').replace('\\', '/'))
    subprocess.run([_find_bash(), '--noprofile', '--norc', '-c', canary], cwd=repo, check=True)
    assert (repo/'executed.txt').read_text().strip() == 'forbidden'
    (repo/'executed.txt').unlink()
    for key in ['filter.trip.clean', 'filter.trip.process', 'diff.trip.textconv', 'diff.external', 'core.fsmonitor', 'core.pager']:
        git('config', key, canary)
    git('config', 'filter.trip.required', 'true')
    # Cwd executables, inherited helper/config and trace destinations must not run.
    (repo/'git').write_text('#!/bin/sh\n'+canary+'\n')
    monkeypatch.setenv('GIT_EXTERNAL_DIFF', canary)
    monkeypatch.setenv('GIT_TRACE', str(repo/'trace.txt'))
    monkeypatch.setenv('GIT_CONFIG_COUNT', '1')
    monkeypatch.setenv('GIT_CONFIG_KEY_0', 'core.fsmonitor')
    monkeypatch.setenv('GIT_CONFIG_VALUE_0', canary)
    before = {str(p.relative_to(repo)): p.read_bytes() for p in repo.rglob('*') if p.is_file()}
    command = 'pwd; git status --short; git diff; git log -1 --oneline; git show HEAD:calc.py; cat calc.py | head -1'
    safe = prepare({'command': command}, str(repo))
    result = subprocess.run([_find_bash(), '--noprofile', '--norc', '-c', safe['command']],
                            cwd=safe['workdir'], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert '-def add(a,b): return a+b' in result.stdout
    assert '+def add(a,b): return a-b' in result.stdout
    assert 'base' in result.stdout
    assert not (repo/'executed.txt').exists()
    assert not (repo/'trace.txt').exists()
    assert {str(p.relative_to(repo)): p.read_bytes() for p in repo.rglob('*') if p.is_file()} == before
    # Scope helpers to the same -C repository that the actual command inspects.
    safe = prepare({'command': 'git -C "repository with spaces" diff --stat'}, str(tmp_path))
    result = subprocess.run([_find_bash(), '--noprofile', '--norc', '-c', safe['command']],
                            cwd=safe['workdir'], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert 'calc.py' in result.stdout
    assert not (repo/'executed.txt').exists()


def test_middleware_exact_grant_and_fixed_secret_rule(tmp_path, monkeypatch):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    policy = {'mode':'plan', 'folder':str(tmp_path), 'secrets_root':str(tmp_path/'private')}
    (tmp_path/'trismegistus-policy.json').write_text(json.dumps(policy))
    context = set_hermes_home_override(str(tmp_path))
    calls = []
    def dispatch(args):
        calls.append(args)
        assert permissions.before_tool('terminal', args) is None
        assert permissions.before_tool('terminal', {**args, 'command':args['command']+'; touch bad'})['action'] == 'block'
        return 'allowed'
    try:
        assert permissions.execute('terminal', {'command':'pwd'}, dispatch) == 'allowed'
        assert len(calls) == 1 and prepared.get() is None
        result = permissions.execute('terminal', {'command':'git diff > bad'}, dispatch)
        assert 'error' in json.loads(result) and len(calls) == 1
        assert permissions.before_tool('terminal', calls[0])['action'] == 'block'
        result = permissions.execute('terminal', {'command':'cat .claude/auth.json'},
                                     lambda args: permissions.before_tool('terminal', args))
        assert result['action'] == 'approve'
        result = permissions.execute('terminal', {'command':'git -C .claude status'}, dispatch)
        assert 'protected files' in json.loads(result)['error'] and len(calls) == 1
        # Failed tool execution must not be labelled refused (it may have run).
        def fail(args):
            raise RuntimeError('execution failed')
        result = json.loads(permissions.execute('terminal', {'command':'pwd'}, fail))
        assert result == {'error': 'execution failed', 'uncertain': True}
        assert prepared.get() is None
    finally:
        reset_hermes_home_override(context)
