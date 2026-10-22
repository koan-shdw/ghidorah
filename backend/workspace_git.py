"""Read-only workspace diff using the fork's bounded, helper-free Git probes."""
import os
import re
from pathlib import Path
from hermes_cli._subprocess_compat import (
    bounded_probe_run, git_filter_overrides, noninteractive_git_env, NO_LAZY_FETCH_ENV,
)


def git_probe(directory, timeout=10):
    directory = str(Path(directory).resolve(strict=True))
    env = {**noninteractive_git_env(), **NO_LAZY_FETCH_ENV, 'GIT_OPTIONAL_LOCKS': '0',
           'GIT_LITERAL_PATHSPECS': '1'}
    prefix = ['git', '-C', directory]
    overrides = git_filter_overrides(prefix, env=env, timeout=8)
    if overrides is None:
        raise ValueError('Git configuration could not be inspected safely.')
    prefix += overrides

    def run(*args, allow_difference=False):
        result = bounded_probe_run([*prefix, *args], env=env, timeout=timeout)
        if result is None or result.returncode not in ((0, 1) if allow_difference else (0,)):
            if args[0] == 'worktree':
                if result and ('modified' in result.stderr or 'untracked' in result.stderr):
                    raise ValueError('This worktree has changes. Commit or discard them first, then remove it.')
                raise ValueError('Git could not finish the worktree operation. Any existing files are kept; inspect the repository before retrying.')
            if result and 'not a git repository' in result.stderr.lower():
                raise ValueError("This folder isn't a Git repository. Open a chat in a repository folder to see its changes.")
            raise ValueError('Choose a Git repository to view changes. Git inspection failed.')
        if len(result.stdout) > 2 * 1024 * 1024:
            raise ValueError('This diff is too large to display. Choose an individual file.')
        return result.stdout

    return directory, run


# Git-ignored dependency folders a checkout needs to build and test (Tris itself: node_modules, the Python
# runtime). A worktree links them from the main checkout instead of reinstalling (Koan, 2026-10-08). Never run
# an install inside a worktree: it would change the shared folder.
DEPENDENCIES = ('node_modules', 'runtime')


def _link_folder(source, link):
    if os.name == 'nt':
        import _winapi
        _winapi.CreateJunction(str(source), str(link))
    else:
        os.symlink(source, link, target_is_directory=True)


def _is_link(path):
    return path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction())


def worktree(request):
    root = Path(request['root']).resolve(strict=True)

    def inside(candidate, strict=True):
        resolved = Path(candidate).resolve(strict=strict)
        if not resolved.is_relative_to(root):
            raise ValueError('The worktree location points outside the working folder.')
        return resolved

    def sources():
        rows = []
        for relative in ['.', *request.get('repositories', [])]:
            if not isinstance(relative, str):
                continue
            try:
                directory = inside(root / relative)
                _, run = git_probe(directory)
                top = inside(run('rev-parse', '--show-toplevel').strip())
                if not any(row['top'] == str(top) for row in rows):
                    rows.append(dict(path=relative, label='Working folder' if relative == '.' else relative, top=str(top)))
            except (OSError, ValueError):
                continue
        return rows

    action = request['action']
    if action == 'sources':
        return sources()
    parent = root / '.trismegistus' / 'worktrees'
    # Resolve before and after creating each parent. An existing junction cannot
    # redirect creation or removal, including to another folder within the root.
    for directory in (parent.parent, parent):
        if inside(directory, strict=False) != directory:
            raise ValueError('The worktree folder must not be a link.')
        if action == 'add':
            directory.mkdir(exist_ok=True)
        if inside(directory) != directory:
            raise ValueError('The worktree folder must not be a link.')
    if action == 'add':
        name = request['name']
        if not isinstance(name, str) or not re.fullmatch(r'chat-[a-z0-9-]{3,60}', name):
            raise ValueError('Invalid worktree name.')
        source = next((row for row in sources() if row['path'] == request['repository']), None)
        if source is None:
            raise ValueError('Choose a repository from the list.')
        target = parent / name
        if target.exists() or target.is_symlink() or inside(target, strict=False) != target:
            raise ValueError('The worktree folder already exists or is a link.')
        top = Path(source['top'])
        _, run = git_probe(top, timeout=60)
        run('rev-parse', '--verify', 'HEAD^{commit}')
        if top == root:
            common = (top / run('rev-parse', '--git-common-dir').strip()).resolve(strict=True)
            exclude = common / 'info' / 'exclude'
            if exclude.resolve() != exclude:
                raise ValueError('The repository exclude file must not be a link.')
            current = exclude.read_text(encoding='utf-8') if exclude.exists() else ''
            if '/.trismegistus/' not in current.splitlines():
                exclude.parent.mkdir(exist_ok=True)
                with exclude.open('a', encoding='utf-8') as stream:
                    stream.write(('\n' if current and not current.endswith('\n') else '') + '/.trismegistus/\n')
        run('worktree', 'add', '-b', 'trismegistus/' + name, str(target))
        for folder in DEPENDENCIES:
            source, link = top / folder, target / folder
            ignored = run('ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--', folder)
            if source.is_dir() and not _is_link(source) and not link.exists() and ignored.strip():
                _link_folder(source, link)
        return str(inside(target))
    if action == 'remove':
        target = Path(request['path'])
        if target.parent != parent or inside(target) != target:
            raise ValueError('That is not one of the app\'s worktrees.')
        _, inspect = git_probe(target)
        if Path(inspect('rev-parse', '--show-toplevel').strip()).resolve() != target:
            raise ValueError('That folder is not a worktree root.')
        common = (target / inspect('rev-parse', '--git-common-dir').strip()).resolve(strict=True)
        _, run = git_probe(common, timeout=60)
        # Unlink the shared dependency folders first, so removing the worktree can never reach into them.
        for folder in DEPENDENCIES:
            link = target / folder
            if _is_link(link):
                os.unlink(link) if link.is_symlink() else os.rmdir(link)
        run('worktree', 'remove', str(target))
        return None
    raise ValueError('Unknown worktree operation.')


def status(directory):
    _, run = git_probe(directory)
    lines = run('status', '--porcelain=v2', '--branch', '--ignore-submodules=all').splitlines()
    branch = next((line[14:] for line in lines if line.startswith('# branch.head ')), None)
    ab = next((re.fullmatch(r'# branch.ab \+(\d+) -(\d+)', line) for line in lines
               if line.startswith('# branch.ab ')), None)
    # An unborn repository has no commits. Other probe failures remain errors.
    unborn = '# branch.oid (initial)' in lines
    unpushed = 0 if unborn else int(run('rev-list', '--count', 'HEAD', '--not', '--remotes').strip())
    return {'branch': branch, 'changed': sum(bool(line) and not line.startswith('#') for line in lines),
            'ahead': int(ab[1]) if ab else None, 'behind': int(ab[2]) if ab else None,
            'unpushed': unpushed, 'remote': bool(run('remote').strip())}


def changes(directory, selected=None, staged=False):
    directory, run = git_probe(directory)
    repository = run('rev-parse', '--show-toplevel').strip()
    if selected is not None:
        if not isinstance(selected, str) or '\0' in selected or os.path.isabs(selected) or '..' in Path(selected).parts:
            raise ValueError('Invalid changed-file path.')
        options = ('--no-ext-diff', '--no-textconv', '--no-color', '--no-renames')
        status = run('status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--', selected)
        if not staged and status.startswith('?? '):
            target = (Path(directory) / selected).resolve(strict=True)
            if not target.is_relative_to(Path(directory)) or not target.is_file():
                raise ValueError('Choose a file inside the selected folder.')
            text = run('diff', '--no-index', *options, '--', '/dev/null', selected, allow_difference=True)
        else:
            text = run('diff', '--relative', *options, *(('--cached',) if staged else ()), '--', selected)
        return {'text': text, 'staged': staged, 'path': selected}
    status = run('status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-renames', '--', '.')
    files = [{'status': row[:2], 'path': os.path.relpath(Path(repository) / row[3:], directory)} for row in status.split('\0') if row]
    return {'repository': repository, 'files': files}
