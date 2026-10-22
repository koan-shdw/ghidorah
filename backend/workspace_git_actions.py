"""Explicit user Git actions. Read probes reuse Hermes; mutations use ordinary Git configuration."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlsplit, urlunsplit
from workspace_git import git_probe, changes


def command(directory, args, timeout=90):
    # Git must retain the user's identity, credential helper, filters and hooks.
    # UI actions are explicit; never infer stage-all, force-push or discard.
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='Never', GIT_LITERAL_PATHSPECS='1')
    for key in list(env):
        if key.startswith('GIT_CONFIG_') or key in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'):
            env.pop(key)
    process = subprocess.Popen(['git', '--no-pager', '-C', str(directory), *args], env=env,
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    try:
        out, err = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True,
                           creationflags=subprocess.CREATE_NO_WINDOW)
        else:
            process.kill()
        process.communicate()
        raise ValueError('Git timed out. Refresh and inspect its outcome before retrying.')
    text = (out + err).decode('utf-8', errors='replace')
    if process.returncode:
        raise ValueError(text[-12000:].strip() or 'Git did not complete the requested action.')
    return text.strip()


def display_remote(value):
    if '://' not in value:
        return value
    parts = urlsplit(value)
    return urlunsplit((parts.scheme, parts.netloc.rsplit('@', 1)[-1], parts.path, '', ''))


def inspect(root, directory):
    root, directory = Path(root).resolve(strict=True), Path(directory).resolve(strict=True)
    if not directory.is_relative_to(root):
        raise ValueError('Choose a repository inside the working folder.')
    _, probe = git_probe(directory)
    repository = Path(probe('rev-parse', '--show-toplevel').strip()).resolve(strict=True)
    if not repository.is_relative_to(root):
        raise ValueError('The repository root is outside the working folder. Select its root in Settings first.')
    _, probe = git_probe(repository)
    status = probe('status', '--porcelain=v2', '--branch', '--ignore-submodules=all')
    headers = dict(line[2:].split(' ', 1) for line in status.splitlines() if line.startswith('# '))
    files = changes(repository)['files']
    digest = hashlib.sha256((str(repository) + '\0' + status).encode())
    # Include bytes, not only Git's stat cache, so same-size outside edits invalidate a preview.
    for item in files:
        file = repository / item['path']
        digest.update(item['path'].encode())
        if file.is_symlink():
            digest.update(os.readlink(file).encode())
        elif file.is_file():
            with file.open('rb') as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
        else:
            digest.update(b'<not-a-file>')
    index = (repository / probe('rev-parse', '--git-path', 'index').strip()).resolve()
    if index.exists():
        digest.update(index.read_bytes())
    # These built-in configuration queries do not run repository hooks or filters.
    remotes = []
    for name in command(repository, ['remote'], timeout=10).splitlines():
        urls = command(repository, ['remote', 'get-url', '--push', '--all', name], timeout=10).splitlines()
        digest.update(json.dumps([name, urls]).encode())
        remotes.append({'name': name, 'urls': [display_remote(url) for url in urls]})
    return {'repository': str(repository), 'directory': str(repository.relative_to(root)),
            'branch': headers.get('branch.head', '(detached)'), 'head': headers.get('branch.oid'),
            'upstream': headers.get('branch.upstream'), 'files': files, 'remotes': remotes,
            'branches': probe('for-each-ref', '--format=%(refname:short)', 'refs/heads').splitlines(),
            'revision': digest.hexdigest()}


def execute(request):
    snapshot = inspect(request['root'], request['directory'])
    action = request.get('action', 'inspect')
    if action == 'inspect':
        return snapshot
    if request.get('revision') != snapshot['revision']:
        raise ValueError('The repository changed. Refresh changes and review the action again.')
    repository = snapshot['repository']
    if action in ('stage', 'unstage'):
        file = request.get('file')
        if not isinstance(file, str) or '\0' in file or Path(file).is_absolute():
            raise ValueError('Choose one changed file.')
        file = os.path.normpath(os.path.relpath(Path(request['directory']) / file, repository))
        row = next((row for row in snapshot['files'] if row['path'] == file), None)
        if row is None:
            raise ValueError('Choose one of the changed files.')
        if action == 'stage':
            args = ['add', '--', file]
        elif snapshot['head'] == '(initial)':
            args = ['rm', '--cached', '--force', '--', file]
        else:
            args = ['reset', '-q', 'HEAD', '--', file]
    elif action == 'commit':
        message = request.get('message')
        if not isinstance(message, str) or not message.strip() or len(message) > 4000 or '\0' in message:
            raise ValueError('Enter a commit message up to 4,000 characters.')
        if not any(row['status'][0] not in (' ', '?', '!') for row in snapshot['files']):
            raise ValueError('Stage the files you want to commit first.')
        args = ['commit', '-m', message.strip()]
    elif action in ('branch', 'switch'):
        branch = request.get('branch')
        if not isinstance(branch, str) or not branch or branch.startswith('-') or '@{' in branch or len(branch) > 200:
            raise ValueError('Enter a valid branch name.')
        command(repository, ['check-ref-format', '--branch', branch], timeout=10)
        args = ['switch', *(['-c'] if action == 'branch' else []), branch]
    elif action == 'push':
        remote = next((row for row in snapshot['remotes'] if row['name'] == request.get('remote')), None)
        branch = snapshot['branch']
        if not remote or len(remote['urls']) != 1:
            raise ValueError('Choose a remote with one push destination.')
        if branch == '(detached)' or snapshot['head'] == '(initial)':
            raise ValueError('Create a branch and commit before pushing.')
        # Explicit current branch refspec; configured mirror or tag pushes must not widen it.
        args = ['-c', 'remote.' + remote['name'] + '.mirror=false', 'push', '--porcelain',
                '--no-follow-tags', '--recurse-submodules=no', '--set-upstream',
                remote['name'], 'HEAD:refs/heads/' + branch]
    else:
        raise ValueError('Unknown Git action.')
    output = command(repository, args)
    return {'output': output, 'snapshot': inspect(request['root'], repository)}
