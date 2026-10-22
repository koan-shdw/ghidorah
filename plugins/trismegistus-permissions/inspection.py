"""Bounded Plan terminal inspection, using the normal Hermes terminal lifecycle."""
from contextvars import ContextVar
import os
from pathlib import Path
import re
import shlex

# Invocation-local: a model cannot submit this grant as a tool argument.
prepared = ContextVar('trismegistus_plan_terminal', default=None)
GUIDANCE = ('Plan mode permits read-only Git inspection, pwd, ls, cat, head, tail, wc and echo. '
            'Use workdir or git -C for another directory. Scripts, writes and unsupported '
            'shell syntax require leaving Plan mode.')

GIT_FLAGS = {
    'status': {'--short', '-s', '--branch', '-b', '--porcelain', '--porcelain=v1', '--porcelain=v2', '--untracked-files=all', '--untracked-files=no', '-uno', '-z'},
    'diff': {'--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--check', '--cached', '--staged', '--no-ext-diff', '--no-textconv', '--no-color', '--color=never', '--patch', '-p', '--raw', '--summary', '--find-renames', '--ignore-space-at-eol', '--ignore-all-space', '-w', '--ignore-space-change', '-b', '--exit-code', '--quiet', '-z'},
    'log': {'--oneline', '--stat', '--name-only', '--name-status', '--no-decorate', '--decorate', '--graph', '--all', '--reverse', '--no-merges', '--first-parent', '--no-color', '--color=never', '--patch', '-p', '--no-ext-diff', '--no-textconv'},
    'show': {'--stat', '--name-only', '--name-status', '--no-patch', '-s', '--no-color', '--color=never', '--patch', '-p', '--no-ext-diff', '--no-textconv', '--summary'},
    'ls-files': {'--cached', '-c', '--others', '-o', '--modified', '-m', '--deleted', '-d', '--stage', '-s', '--unmerged', '-u', '--exclude-standard', '-z'},
    'ls-tree': {'-r', '-t', '-d', '-l', '--name-only', '--name-status', '--full-tree', '--full-name', '-z'},
    'rev-parse': {'--verify', '--short', '--show-toplevel', '--show-prefix', '--git-dir', '--absolute-git-dir', '--is-inside-work-tree', '--abbrev-ref', '--end-of-options'},
    'merge-base': {'--all', '-a', '--is-ancestor', '--octopus'},
    'branch': {'--list', '--show-current', '--all', '-a', '--remotes', '-r', '--no-color', '-v', '-vv'},
}
FILE_FLAGS = {
    'pwd': {'-L', '-P'},
    'ls': {'-a', '-l', '-h', '-t', '-r', '-R', '-d', '-F', '-1', '-A', '--all', '--almost-all', '--directory', '--recursive', '--human-readable', '--color=never'},
    'cat': {'-n', '-b', '-s', '-A', '-v', '-E', '-T', '--number'},
    'head': {'-q', '-v', '--quiet', '--verbose'},
    'tail': {'-q', '-v', '--quiet', '--verbose'},
    'wc': {'-l', '-w', '-c', '-m', '-L', '--lines', '--words', '--bytes', '--chars'},
    'echo': set(),
}


def commands(command):
    # ponytail: a bounded grammar, not a general shell analyser. Unknown syntax
    # stays blocked; extend only with an execution test for the new operation.
    if not isinstance(command, str) or len(command) > 16000 or any(c in command for c in '$`<>\\\x00'):
        raise ValueError(GUIDANCE)
    lexer = shlex.shlex(command, posix=True, punctuation_chars=';&|\n')
    lexer.whitespace = ' \t\r'
    lexer.whitespace_split = True
    result, words = [], []
    for token in lexer:
        if token in {';', '&&', '||', '|', '\n'}:
            if not words:
                if token == '\n':
                    continue
                raise ValueError(GUIDANCE)
            result.append((words, token))
            words = []
        else:
            if any(ord(c) < 32 for c in token) or token in {'&', ';;', '(', ')', '{', '}'}:
                raise ValueError(GUIDANCE)
            words.append(token)
    if words:
        result.append((words, ''))
    elif result and result[-1][1] in {';', '\n'}:
        result[-1] = (result[-1][0], '')
    else:
        raise ValueError(GUIDANCE)
    return result


def validate(words):
    name, *args = words
    if name == 'git':
        while args and args[0] in {'-C', '--no-pager'}:
            if args[0] == '-C':
                if len(args) < 2 or not args[1]:
                    raise ValueError(GUIDANCE)
                args = args[2:]
            else:
                args = args[1:]
        if not args or args[0] not in GIT_FLAGS:
            raise ValueError(GUIDANCE)
        subcommand, *args = args
        flags = GIT_FLAGS[subcommand]
    elif name in FILE_FLAGS:
        flags, subcommand = FILE_FLAGS[name], ''
    else:
        raise ValueError(GUIDANCE)
    paths, number = False, False
    for arg in args:
        if name == 'echo':
            continue
        if number:
            if not re.fullmatch(r'\d+', arg):
                raise ValueError(GUIDANCE)
            number = False
        elif not paths and ((name in {'head', 'tail'} and arg in {'-n', '-c', '--lines', '--bytes'}) or
                            (name == 'git' and subcommand == 'log' and arg in {'-n', '--max-count'})):
            number = True
        elif arg == '--':
            paths = True
        elif not paths and arg.startswith('-'):
            numeric = (name in {'head', 'tail'} and re.fullmatch(r'-(?:n|c)?\d+', arg))
            git_value = (name == 'git' and '%G' not in arg and (
                (subcommand in {'log', 'show'} and re.fullmatch(r'--(?:format|pretty)=.*|-\d+|--max-count=\d+', arg)) or
                (subcommand in {'diff', 'log', 'show'} and re.fullmatch(r'-U\d+|--unified=\d+', arg))))
            combined = name in FILE_FLAGS and len(arg) > 2 and arg.startswith('-') and all('-'+c in flags for c in arg[1:])
            if arg not in flags and not numeric and not git_value and not combined:
                raise ValueError(GUIDANCE)
        elif name == 'pwd' or (name == 'git' and subcommand == 'branch' and '--list' not in args):
            raise ValueError(GUIDANCE)
    if number:
        raise ValueError(GUIDANCE)
    return name


def prepare(arguments, folder):
    """Pin executables/options; no repo scripts, pager, diff drivers or shell expansion."""
    if arguments.get('background') or arguments.get('pty'):
        raise ValueError(GUIDANCE)
    parts = commands(arguments.get('command'))
    for words, _ in parts:
        validate(words)
    from tools.environments.local import _find_bash, _msys_to_windows_path
    from hermes_cli._subprocess_compat import git_filter_overrides
    bash = Path(_find_bash()).resolve()
    install = bash.parent.parent
    if install.name.lower() == 'usr':
        install = install.parent
    bins = [install/'mingw64/bin', install/'mingw32/bin', install/'usr/bin', install/'bin', install/'cmd']
    def binary(name):
        match = next((base/(name+'.exe') for base in bins if (base/(name+'.exe')).is_file()), None)
        if match is None:
            raise ValueError('Plan inspection requires the installed Git Bash utilities.')
        return str(match.resolve()).replace('\\', '/')
    env = {key: os.environ[key] for key in ('SystemRoot', 'WINDIR', 'TEMP', 'TMP') if key in os.environ}
    env.update(PATH=os.pathsep.join(str(p) for p in bins), GIT_CONFIG_NOSYSTEM='1',
               GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull,
               GIT_OPTIONAL_LOCKS='0', GIT_NO_LAZY_FETCH='1', GIT_ALLOW_PROTOCOL='',
               GIT_TERMINAL_PROMPT='0', GIT_ATTR_NOSYSTEM='1')
    # env -i also removes inherited shell functions/config injection, credentials,
    # external diff helpers and tracing destinations. Absolute paths avoid cwd/PATH shadows.
    env_prefix = [binary('env'), '-i', *[f'{k}={v}' for k, v in env.items()]]
    cwd = str(Path(_msys_to_windows_path(arguments.get('workdir') or folder)).resolve())
    output = []
    for words, operator in parts:
        name, *args = words
        if name == 'git':
            git = binary('git')
            prefix = [git, '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=NUL',
                      '-c', 'core.untrackedCache=false', '-c', 'maintenance.auto=false',
                      '-c', 'gc.auto=0', '-c', 'log.showSignature=false']
            location = []
            while args[0] in {'-C', '--no-pager'}:
                if args[0] == '-C':
                    location.extend(args[:2]); args = args[2:]
                else:
                    args = args[1:]
            # Read names only. Disable every configured filter before Git touches
            # working-tree bytes (even `diff --no-textconv` can run clean filters).
            filters = git_filter_overrides([*prefix, *location], cwd=cwd, env=env, timeout=5)
            if filters is None:
                raise ValueError('Git configuration could not be checked for Plan inspection.')
            prefix.extend(filters)
            if args[0] in {'diff', 'log', 'show'}:
                args = [args[0], '--no-ext-diff', '--no-textconv', *args[1:]]
            invocation = [*prefix, *location, *args]
        else:
            invocation = [binary(name), *args]
        output.append(shlex.join([*env_prefix, *invocation]))
        if operator:
            output.append(operator)
    return {**arguments, 'command': ' '.join(output), 'workdir': cwd}
