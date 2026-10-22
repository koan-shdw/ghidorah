"""Session-start status/diff probes must not execute repository clean filters."""
import os
import shlex
import subprocess

from hermes_cli._subprocess_compat import bounded_git_probe, noninteractive_git_env


def test_status_and_diff_read_modified_files_without_running_filters(tmp_path):
    env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}
    def git(*args):
        return subprocess.check_output(['git', '-C', str(tmp_path), *args], env=env, text=True)
    git('init', '-q', '-b', 'main')
    (tmp_path/'source.txt').write_text('before\n')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base')
    (tmp_path/'source.txt').write_text('after!\n')
    (tmp_path/'.gitattributes').write_text('*.txt filter=untrusted\n')
    marker = tmp_path/'filter-ran'
    git('config', 'filter.untrusted.clean', 'echo ran > '+shlex.quote(marker.as_posix())+'; cat')
    git('config', 'filter.untrusted.required', 'true')
    # Reproduce the original path: the existing noninteractive environment alone
    # disables fsmonitor but still executes clean filters during status.
    subprocess.run(['git', '-C', str(tmp_path), 'diff', '--no-ext-diff', '--no-textconv'],
                   env={**noninteractive_git_env(env), 'GIT_OPTIONAL_LOCKS':'0'},
                   capture_output=True, timeout=10, check=True)
    assert marker.read_text().strip() == 'ran'
    marker.unlink()
    index = (tmp_path/'.git/index').read_bytes()
    assert 'source.txt' in bounded_git_probe(['git', '-C', str(tmp_path), 'status', '--porcelain'], timeout=10)
    diff = bounded_git_probe(['git', '-C', str(tmp_path), 'diff', '--no-ext-diff', '--no-textconv'], timeout=10)
    assert '-before' in diff and '+after' in diff
    assert not marker.exists()
    assert (tmp_path/'.git/index').read_bytes() == index
    assert (tmp_path/'source.txt').read_text() == 'after!\n'
