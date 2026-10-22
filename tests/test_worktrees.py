import importlib.util
from pathlib import Path
import subprocess
import sys

import pytest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'runtime/hermes'))
spec = importlib.util.spec_from_file_location('workspace_git', APP / 'backend/workspace_git.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def git(directory, *args):
    return subprocess.run(['git', '-C', str(directory), *args], check=True, capture_output=True,
                          text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).stdout.strip()


def repo(directory):
    directory.mkdir(exist_ok=True)
    git(directory, 'init', '-q', '-b', 'main')
    git(directory, 'config', 'core.autocrlf', 'false')
    (directory / 'app.txt').write_text('original\n', encoding='utf-8')
    (directory / '.gitattributes').write_text('app.txt filter=trip\n', encoding='utf-8')
    git(directory, 'add', '.')
    git(directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base')


def call(root, action, **args):
    return module.worktree(dict(root=str(root), action=action, **args))


def test_worktree_checkout_and_dirty_removal_never_run_repository_helpers(tmp_path):
    repo(tmp_path)
    marker = tmp_path / 'helper-ran.txt'
    command = f"echo forbidden > '{marker.as_posix()}'; cat"
    for key in ('filter.trip.clean', 'filter.trip.smudge', 'filter.trip.process', 'core.fsmonitor'):
        git(tmp_path, 'config', key, command)
    git(tmp_path, 'config', 'filter.trip.required', 'true')
    hook = tmp_path / '.git/hooks/post-checkout'
    hook.write_text('#!/bin/sh\n' + command + '\n', encoding='utf-8')
    hook.chmod(0o755)
    assert [row['path'] for row in call(tmp_path, 'sources', repositories=[])] == ['.']
    target = Path(call(tmp_path, 'add', repository='.', name='chat-test'))
    assert target.parent == tmp_path / '.trismegistus/worktrees'
    assert git(target, 'branch', '--show-current') == 'trismegistus/chat-test'
    assert (target / 'app.txt').read_text(encoding='utf-8') == 'original\n'
    assert not marker.exists()
    (target / 'app.txt').write_text('changed!\n', encoding='utf-8')
    with pytest.raises(ValueError, match='has changes'):
        call(tmp_path, 'remove', path=str(target))
    assert (target / 'app.txt').read_text(encoding='utf-8') == 'changed!\n'
    assert not marker.exists()
    (target / 'app.txt').write_text('original\n', encoding='utf-8')
    call(tmp_path, 'remove', path=str(target))
    assert not target.exists() and not marker.exists()
    assert module.status(tmp_path)['changed'] == 0


def junction(link, destination):
    # Native PowerShell creates an owned directory junction; no cmd string or shell deletion.
    script = "New-Item -ItemType Junction -Path $args[0] -Target $args[1] | Out-Null"
    subprocess.run(['powershell', '-NoProfile', '-Command', '& { ' + script + ' }',
                    str(link), str(destination)], check=True, capture_output=True,
                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def test_junctions_cannot_redirect_creation_or_removal(tmp_path):
    root, outside = tmp_path / 'root', tmp_path / 'outside'
    repo(root); outside.mkdir()
    junction(root / '.trismegistus', outside)
    with pytest.raises(ValueError, match='outside|link'):
        call(root, 'add', repository='.', name='chat-escape')
    assert not (outside / 'worktrees').exists()
    (root / '.trismegistus').rmdir()  # Remove the junction itself, never its target.
    target = Path(call(root, 'add', repository='.', name='chat-safe'))
    moved = outside / 'moved'
    target.rename(moved)
    junction(target, moved)
    with pytest.raises(ValueError, match='outside|link|not one'):
        call(root, 'remove', path=str(target))
    assert (moved / 'app.txt').exists()
    target.rmdir()


def test_sources_stay_inside_root_and_linked_repository_removal_works(tmp_path):
    main, root = tmp_path / 'main', tmp_path / 'root'
    repo(main); root.mkdir()
    # A root nested in another repository must not expose its outside parent.
    nested = main / 'nested'; nested.mkdir()
    assert call(nested, 'sources') == []
    linked = root / 'linked'
    git(main, 'worktree', 'add', '-b', 'linked', str(linked))
    assert [row['path'] for row in call(root, 'sources', repositories=['linked', '../main'])] == ['linked']
    target = Path(call(root, 'add', repositories=['linked'], repository='linked', name='chat-linked'))
    assert (target / 'app.txt').exists()
    call(root, 'remove', path=str(target))
    assert not target.exists() and (main / 'app.txt').exists() and (linked / 'app.txt').exists()


def test_worktree_links_ignored_dependencies_and_removal_never_touches_them(tmp_path):
    # Koan, 2026-10-08: a Tris-on-Tris worktree must build and test without reinstalling node_modules or runtime.
    main = tmp_path / 'main'
    main.mkdir()
    git(main, 'init', '-q', '-b', 'main')
    (main / '.gitignore').write_text('node_modules/\nruntime/\n', encoding='utf-8')
    (main / 'app.txt').write_text('code\n', encoding='utf-8')
    git(main, 'add', '.')
    git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base')
    (main / 'node_modules/pkg').mkdir(parents=True)
    (main / 'node_modules/pkg/index.js').write_text('module.exports=1\n', encoding='utf-8')
    (main / 'runtime').mkdir()
    (main / 'runtime/python.txt').write_text('py\n', encoding='utf-8')
    target = Path(module.worktree(dict(root=str(tmp_path), action='add', repository='main', name='chat-deps',
                                       repositories=['main'])))
    for folder in ('node_modules', 'runtime'):
        assert module._is_link(target / folder)
        assert (target / folder).resolve() == (main / folder).resolve()
    assert (target / 'node_modules/pkg/index.js').read_text(encoding='utf-8') == 'module.exports=1\n'
    assert git(target, 'status', '--porcelain') == '', 'linked folders stay ignored'
    module.worktree(dict(root=str(tmp_path), action='remove', path=str(target)))
    assert not target.exists()
    assert (main / 'node_modules/pkg/index.js').read_text(encoding='utf-8') == 'module.exports=1\n', 'shared folder intact'
    assert (main / 'runtime/python.txt').exists()


def test_worktree_does_not_link_a_tracked_folder(tmp_path):
    main = tmp_path / 'main'
    (main / 'runtime').mkdir(parents=True)
    git(main, 'init', '-q', '-b', 'main')
    (main / 'runtime/tracked.txt').write_text('tracked\n', encoding='utf-8')
    git(main, 'add', '.')
    git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base')
    target = Path(module.worktree(dict(root=str(tmp_path), action='add', repository='main', name='chat-tracked',
                                       repositories=['main'])))
    assert not module._is_link(target / 'runtime'), 'a tracked folder is checked out, not linked'
