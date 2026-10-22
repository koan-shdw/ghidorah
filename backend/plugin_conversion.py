"""Reviewable adapters for Claude packages and Hub skills. No source code executes here."""
import json
from pathlib import Path
import re
import shutil
import tempfile

from plugin_packages import clone_repository, validate_tree

# App-owned adapter. The reviewed package is data; only eligible skills are registered.
ADAPTER = '''from pathlib import Path
import json
def register(ctx):
    root = Path(__file__).parent
    data = json.loads((root / "conversion.json").read_text(encoding="utf-8"))
    for skill in data["skills"]:
        ctx.register_skill(skill["name"], root / skill["path"], description=skill["description"], frontmatter=skill["frontmatter"])
'''
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}')
RUNTIME_FIELDS = {'allowed-tools', 'model', 'effort', 'context', 'agent', 'hooks', 'permissionMode'}


def staging(home):
    root = Path(home).parent / 'plugin-reviews'
    root.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix='converted-', dir=root))


def local_file(root, value):
    if not isinstance(value, str) or not value or '\\' in value or ':' in value:
        raise ValueError('Plugin paths must be relative to its folder.')
    path = Path(value)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('Plugin paths must stay inside its folder.')
    result = root / path
    if not result.resolve().is_relative_to(root.resolve()):
        raise ValueError('Plugin path escapes its folder.')
    return result


def markdown(file):
    from tools.skills_hub_models import _parse_frontmatter
    text = file.read_text(encoding='utf-8')
    metadata = _parse_frontmatter(text)
    body = re.sub(r'\A---\r?\n.*?\r?\n---(?:\r?\n|$)', '', text, count=1, flags=re.S)
    return metadata, body


def eligible(file, root, unsupported, *, skill=False):
    metadata, body = markdown(file)
    fields = sorted(RUNTIME_FIELDS.intersection(metadata))
    dynamic = re.search(r'!`[^`]*`|\$[0-9]|\$ARGUMENTS\[', body)
    placeholders = re.findall(r'\$\{([^}]+)\}', body)
    if fields or dynamic or (placeholders and (skill or any(value != 'CLAUDE_PLUGIN_ROOT' for value in placeholders))):
        reason = ', '.join(fields) if fields else 'dynamic execution, positional arguments or unsupported path expansion'
        unsupported.append(file.relative_to(root).as_posix() + ': ' + reason)
        return None
    return metadata, body


def package_result(destination, repository, commit, manifest, conversion, *, native):
    from tools.plugin_guard import scan_plugin
    from dataclasses import asdict
    name = str(manifest['name'])
    if not NAME.fullmatch(name) or name.lower().startswith('trismegistus'):
        raise ValueError('The plugin needs a valid, unreserved name.')
    description = str(manifest.get('description', ''))
    version = str(manifest.get('version', ''))
    (destination / 'plugin.yaml').write_text(json.dumps(dict(name=name, version=version, description=description)), encoding='utf-8')
    (destination / '__init__.py').write_text(ADAPTER, encoding='utf-8')
    (destination / 'conversion.json').write_text(json.dumps(conversion, ensure_ascii=False), encoding='utf-8')
    validate_tree(destination)
    scan = scan_plugin(destination, source=repository + '@' + commit)
    return dict(source=str(destination), repository=repository, commit=commit, name=name, version=version,
                description=description, hooks=False, prerequisites=[], native=native, nativeSubdir='source' if native else None,
                conversion=conversion, scan=dict(verdict=scan.verdict, findings=[asdict(f) for f in scan.findings]))


def convert_claude(home, source, repository, commit):
    source = Path(source)
    if not re.fullmatch(r'[a-fA-F0-9]{40}', commit or ''):
        raise ValueError('Conversion requires a reported or resolved Git commit. Review the GitHub repository at a pinned commit.')
    validate_tree(source)
    destination = staging(home)
    shutil.copytree(source, destination / 'source', ignore=shutil.ignore_patterns('.git', '__pycache__', '*.pyc', '.in_use'))
    root = destination / 'source'
    manifest = json.loads((root / '.claude-plugin/plugin.json').read_text(encoding='utf-8'))
    unsupported, skills, commands, servers = [], [], [], []
    for field, names in [('hooks', ['hooks']), ('agents', ['agents']), ('lspServers', ['.lsp.json']), ('monitors', ['monitors'])]:
        if manifest.get(field) or any((root / name).exists() for name in names):
            unsupported.append(field + ': remains native to Claude; not converted for GPT/DeepSeek')
    for field in ('settings', 'dependencies', 'userConfig', 'channels', 'outputStyles', 'workflows', 'experimental'):
        if manifest.get(field):
            unsupported.append(field + ': remains native to Claude; not converted for GPT/DeepSeek')
    def locations(field, default, additive=True):
        raw = manifest.get(field)
        values = ([raw] if isinstance(raw, str) else raw if isinstance(raw, list) else [])
        if raw is not None and not isinstance(raw, (str, list)):
            unsupported.append(field + ': unsupported manifest format')
        configured = [local_file(root, value) for value in values]
        for path in configured:
            if not path.exists():
                unsupported.append(path.relative_to(root).as_posix() + ': configured ' + field + ' path was not found')
        candidates = ([root / default] if additive or raw is None else []) + configured
        return list(dict.fromkeys(path for path in candidates if path.exists()))
    skill_files = set()
    for location in locations('skills', 'skills'):
        skill_files.update([location] if location.is_file() and location.name == 'SKILL.md' else [location / 'SKILL.md'] if (location / 'SKILL.md').is_file() else location.glob('*/SKILL.md') if location.is_dir() else [])
    skill_names = set()
    for file in sorted(skill_files):
        parsed = eligible(file, root, unsupported, skill=True)
        if not parsed:
            continue
        metadata, body = parsed
        name = str(metadata.get('name') or file.parent.name)
        if not NAME.fullmatch(name) or name in skill_names:
            unsupported.append(file.relative_to(root).as_posix() + ': invalid or duplicate skill name')
            continue
        skill_names.add(name)
        if metadata.get('disable-model-invocation'):
            unsupported.append(file.relative_to(root).as_posix() + ': model invocation disabled; available through its command only')
        else:
            skills.append(dict(name=name, path=file.relative_to(destination).as_posix(), description=str(metadata.get('description', '')), frontmatter=metadata))
        if metadata.get('user-invocable', True):
            commands.append(dict(name=name, path=file.relative_to(destination).as_posix(), description=str(metadata.get('description', ''))))
    command_files = {}
    if isinstance(manifest.get('commands'), dict):
        for name, spec in manifest['commands'].items():
            if not NAME.fullmatch(name) or not isinstance(spec, dict) or bool(spec.get('source')) == bool(spec.get('content')) or RUNTIME_FIELDS.intersection(spec):
                unsupported.append('Command ' + name + ': unsupported command definition')
                continue
            if spec.get('source'):
                file = local_file(root, spec['source'])
            else:
                file = destination / 'generated-commands' / (name + '.md')
                file.parent.mkdir(exist_ok=True)
                file.write_text(str(spec['content']), encoding='utf-8')
            command_files[file] = (name, str(spec.get('description', '')))
    else:
        for location in locations('commands', 'commands', additive=False):
            if location.is_dir():
                for nested in location.rglob('*.md'):
                    if nested.parent != location:
                        unsupported.append(nested.relative_to(root).as_posix() + ': nested command directories are not converted')
            for file in [location] if location.is_file() and location.suffix == '.md' else location.glob('*.md') if location.is_dir() else []:
                command_files[file] = (file.stem, '')
    for file, (name, description) in sorted(command_files.items()):
        parsed = eligible(file, destination, unsupported)
        if not parsed:
            continue
        metadata, _body = parsed
        if metadata.get('user-invocable') is False:
            unsupported.append(file.relative_to(destination).as_posix() + ': user invocation disabled')
            continue
        if not NAME.fullmatch(name) or any(row['name'] == name for row in commands):
            unsupported.append(file.relative_to(destination).as_posix() + ': invalid or duplicate command name')
            continue
        commands.append(dict(name=name, path=file.relative_to(destination).as_posix(), description=description or str(metadata.get('description', ''))))
    configs = []
    if (root / '.mcp.json').is_file():
        configs.append(json.loads((root / '.mcp.json').read_text(encoding='utf-8')))
    raw = manifest.get('mcpServers')
    if isinstance(raw, dict):
        configs.append(raw)
    elif isinstance(raw, (str, list)):
        for value in [raw] if isinstance(raw, str) else raw:
            if isinstance(value, dict):
                configs.append(value)
            elif str(value).endswith(('.mcpb', '.dxt')):
                unsupported.append(str(value) + ': MCP bundles need a separate installer')
            else:
                configs.append(json.loads(local_file(root, value).read_text(encoding='utf-8')))
    elif raw is not None:
        unsupported.append('mcpServers: unsupported manifest format')
    for config in configs:
        entries = config.get('mcpServers', config)
        if not isinstance(entries, dict):
            raise ValueError('MCP configuration must contain a server object.')
        for name, value in entries.items():
            if not isinstance(value, dict) or not (value.get('command') or value.get('url')):
                unsupported.append('MCP ' + name + ': unsupported server configuration')
            else:
                servers = [server for server in servers if server['name'] != name]
                servers.append(dict(name=name, config=value))
    conversion = dict(kind='claude', skills=skills, commands=commands, servers=servers, unsupported=unsupported)
    return package_result(destination, repository, commit, manifest, conversion, native=True)


def skills_browse(query='', page=1):
    from tools.skills_hub_official import HermesIndexSource
    from tools.skills_hub_github import GitHubAuth
    if not isinstance(query, str) or len(query) > 120 or not isinstance(page, int) or not 1 <= page <= 1000:
        raise ValueError('Invalid Skills Hub search.')
    source = HermesIndexSource(GitHubAuth())
    if not source.is_available:
        raise ValueError('The Skills Hub catalogue is unavailable. Try again when connected.')
    found = source.search(query, limit=page * 20 + 1)
    return dict(page=page, more=len(found) > page * 20, items=[dict(name=row.name, description=row.description,
                identifier=row.identifier, source=row.source, trust=row.trust_level) for row in found[(page-1)*20:page*20]])


def github_skill(home, path):
    """A curated pick can name its GitHub skill folder directly. It still installs at a pinned commit."""
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*', path) or '..' in path.split('/'):
        raise ValueError('Invalid GitHub skill path.')
    parts = path.split('/', 2)
    repository, relative = '/'.join(parts[:2]), parts[2] if len(parts) == 3 else ''
    checkout, commit = clone_repository(home, repository, subdir=relative or None)
    relative = relative or '.'
    if not (local_file(checkout, relative) / 'SKILL.md').is_file():
        raise ValueError('There is no SKILL.md at this GitHub path.')
    return checkout, commit, repository, relative


def catalogue_skill(home, identifier):
    from tools.skills_hub_official import HermesIndexSource
    from tools.skills_hub_github import GitHubAuth
    entry = HermesIndexSource(GitHubAuth())._find_entry(identifier)
    if not entry:
        raise ValueError('This skill is no longer in the Skills Hub catalogue.')
    github = entry.get('resolved_github_id') or '/'.join(filter(None, [entry.get('repo'), entry.get('path')]))
    parts = github.split('/', 2)
    if len(parts) != 3 or not parts[2]:
        raise ValueError('This skill has no GitHub source that can be pinned. It has not been installed.')
    repository, relative = '/'.join(parts[:2]), parts[2]
    checkout, commit = clone_repository(home, repository, subdir=relative)
    if not (local_file(checkout, relative) / 'SKILL.md').is_file():
        # Catalogues can store a short skill alias. Resolve it against this fixed Git tree,
        # then check out the exact path without following a newer branch head.
        from hermes_cli.plugins_cmd import _resolve_git_executable, _run_plugin_git, _restrict_checkout_to_subdir, _git_or_raise
        from tools.skills_hub_skillssh import SkillsShSource
        git = _resolve_git_executable()
        tree = _run_plugin_git(git, checkout, 'ls-tree', '-r', '--name-only', commit, timeout=30)
        if tree.returncode:
            raise ValueError('Could not resolve the skill path at this commit.')
        files = set(tree.stdout.splitlines())
        candidates = [candidate.split('/', 2)[2] for candidate in SkillsShSource._candidate_identifiers(repository + '/' + relative)]
        resolved = next((candidate for candidate in candidates if candidate + '/SKILL.md' in files), None)
        if not resolved:
            matches = [file[:-len('/SKILL.md')] for file in files if file.endswith('/' + relative.rsplit('/', 1)[-1] + '/SKILL.md')]
            if len(matches) != 1:
                raise ValueError('The catalogue path is missing or ambiguous at this commit. Review its repository instead.')
            resolved = matches[0]
        from tools.skills_hub_models import _validate_bundle_rel_path
        relative = _validate_bundle_rel_path(resolved)
        _restrict_checkout_to_subdir(checkout, git, relative)
        _git_or_raise(git, checkout, 'checkout', commit, timeout=60, failure_prefix='Could not check out the pinned skill: ')
    return checkout, commit, repository, relative


def review_skill(home, identifier):
    if not isinstance(identifier, str) or len(identifier) > 500:
        raise ValueError('Invalid skill identifier.')
    checkout, commit, repository, relative = github_skill(home, identifier[7:]) if identifier.startswith('github:') else catalogue_skill(home, identifier)
    source = local_file(checkout, relative)
    validate_tree(source)
    destination = staging(home)
    shutil.copytree(source, destination / 'source', ignore=shutil.ignore_patterns('.git', '__pycache__', '*.pyc'))
    skill = destination / 'source/SKILL.md'
    unsupported = []
    parsed = eligible(skill, destination / 'source', unsupported, skill=True)
    if not parsed:
        raise ValueError('This skill requires unsupported features: ' + '; '.join(unsupported))
    metadata, _body = parsed
    name = str(metadata.get('name') or source.name)
    if not NAME.fullmatch(name):
        # Some packages (Cursor's) give a display name here. Use the skill's folder name and say so in the review.
        folder = repository.split('/')[1] if relative == '.' else Path(relative).name
        if not NAME.fullmatch(folder):
            raise ValueError('This skill has an unsupported name.')
        unsupported.append('Its name "' + name[:80] + '" is not a valid skill name here, so it is installed as ' + folder + '.')
        name = folder
    row = dict(name=name, path='source/SKILL.md', description=str(metadata.get('description', '')), frontmatter=metadata)
    conversion = dict(kind='skill', skills=[] if metadata.get('disable-model-invocation') else [row],
                      commands=[{key: row[key] for key in ('name', 'path', 'description')}] if metadata.get('user-invocable', True) else [],
                      servers=[], unsupported=unsupported, identifier=identifier)
    # Expose the same reviewed skill to native Claude through its existing plugin format.
    native = destination / 'native'
    (native / '.claude-plugin').mkdir(parents=True)
    (native / '.claude-plugin/plugin.json').write_text(json.dumps(dict(name=name, description=row['description'])), encoding='utf-8')
    shutil.copytree(destination / 'source', native / 'skills' / name)
    result = package_result(destination, repository if relative == '.' else repository + '/' + relative, commit, dict(name=name, description=row['description']), conversion, native=True)
    result['nativeSubdir'] = 'native'
    return result
