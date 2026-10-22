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


def test_real_staged_unstaged_and_nested_paths_without_running_repository_helpers(tmp_path):
    def git(*args):
        return subprocess.run(['git', '-C', str(tmp_path), *args], check=True, capture_output=True,
                              creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    git('init', '-q')
    git('config', 'core.autocrlf', 'false')
    folder = tmp_path / 'nested'
    folder.mkdir()
    file = folder / 'file with spaces.py'
    file.write_text('original\n')
    (tmp_path / 'other.txt').write_text('outside\n')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base')
    file.write_text('staged\n')
    git('add', '.')
    file.write_text('working\n')
    (tmp_path / 'other.txt').write_text('changed outside\n')
    (folder / 'new.txt').write_text('new\n')
    (tmp_path / '.gitattributes').write_text('*.py filter=trip diff=trip\n')
    marker = tmp_path / 'helper-ran.txt'
    for key in ['filter.trip.clean', 'filter.trip.process', 'diff.trip.textconv', 'diff.external', 'core.fsmonitor']:
        git('config', key, f"echo forbidden > '{marker.as_posix()}'")
    git('config', 'filter.trip.required', 'true')
    rows = module.changes(str(folder))['files']
    assert {'status': 'MM', 'path': file.name} in rows
    assert {'status': '??', 'path': 'new.txt'} in rows
    assert not any('other.txt' in row['path'] for row in rows)
    assert '+working' in module.changes(str(folder), file.name)['text']
    assert '+staged' in module.changes(str(folder), file.name, True)['text']
    assert not marker.exists()
    with pytest.raises(ValueError):
        module.changes(str(folder), '../other.txt')


def test_untracked_files_have_real_added_line_diffs(tmp_path):
    subprocess.run(['git', '-C', str(tmp_path), 'init', '-q'], check=True, capture_output=True,
                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    folder = tmp_path / 'new folder'
    folder.mkdir()
    file = folder / 'new file.txt'
    file.write_text('one\ntwo\n', encoding='utf-8')
    rows = module.changes(str(tmp_path))['files']
    assert any(Path(row['path']) == Path('new folder/new file.txt') for row in rows)
    diff = module.changes(str(tmp_path), 'new folder/new file.txt')['text']
    assert '--- /dev/null' in diff
    assert '@@ -0,0 +1,2 @@' in diff
    assert '+one' in diff and '+two' in diff
    assert module.changes(str(tmp_path), 'new folder/new file.txt', True)['text'] == ''
    (tmp_path / 'binary.bin').write_bytes(b'\0\1\2')
    assert 'Binary files' in module.changes(str(tmp_path), 'binary.bin')['text']
    subprocess.run(['git', '-C', str(tmp_path), 'add', '--', 'new folder/new file.txt'], check=True,
                   capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert '+two' in module.changes(str(tmp_path), 'new folder/new file.txt', True)['text']


def test_repository_status_never_runs_configured_filters(tmp_path):
    def git(*args):
        return subprocess.run(['git', '-C', str(tmp_path), *args], check=True,
                              capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    git('init', '-q')
    assert module.status(tmp_path)['unpushed'] == 0
    git('config', 'core.autocrlf', 'false')
    file = tmp_path / 'tracked.txt'
    file.write_text('before\n')
    (tmp_path / '.gitattributes').write_text('tracked.txt filter=trip\n')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base')
    marker = tmp_path / 'filter-ran.txt'
    git('config', 'filter.trip.clean', f"echo forbidden > '{marker.as_posix()}'; cat")
    git('config', 'filter.trip.required', 'true')
    # Same-size changes force Git to inspect content instead of just stat size.
    file.write_text('after!\n')
    result = module.status(tmp_path)
    assert result['unpushed'] == 1
    assert result['changed'] == 1
    assert result['remote'] is False
    assert not marker.exists()
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    git('remote', 'add', 'origin', 'https://example.invalid/repository.git')
    result = module.status(tmp_path)
    assert result['unpushed'] == 0 and result['remote'] is True
    assert not marker.exists()
    with pytest.raises(OSError):
        module.status(tmp_path / 'missing')
