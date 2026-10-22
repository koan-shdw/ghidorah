"""Metadata-only review of a pinned repository; importing code requires app consent."""
from dataclasses import asdict
from pathlib import Path
import re
import tempfile


def clone_repository(home, repository, commit='', subdir=None):
    if not isinstance(repository, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Enter a GitHub repository as owner/repository.')
    if commit and not re.fullmatch(r'[a-fA-F0-9]{40}', commit):
        raise ValueError('Use a complete 40-character Git commit, or leave it blank to review the current version.')
    from hermes_cli.plugins_cmd import _clone_plugin_repo
    root = Path(home).parent / 'plugin-reviews'
    root.mkdir(parents=True, exist_ok=True)
    destination = Path(tempfile.mkdtemp(prefix='review-', dir=root)) / 'source'
    if subdir:
        from tools.skills_hub_models import _validate_bundle_rel_path
        subdir = _validate_bundle_rel_path(subdir)
    resolved = _clone_plugin_repo(destination, 'https://github.com/' + repository + '.git', commit or None, subdir=subdir)
    return destination, resolved


def review_repository(home, repository, commit=''):
    destination, resolved = clone_repository(home, repository, commit)
    if not any((destination / name).is_file() for name in ('plugin.yaml', 'plugin.yml')) and (destination / '.claude-plugin/plugin.json').is_file():
        from plugin_conversion import convert_claude
        return convert_claude(home, destination, repository, resolved)
    return describe_plugin(destination, repository, resolved)


def validate_tree(destination):
    if destination.is_symlink() or destination.is_junction():
        raise ValueError('Plugin links need review before import.')
    if not destination.is_dir():
        raise ValueError('The selected plugin or skill folder was not found at this commit.')
    # Node performs a second bounded tree/hash check before displaying this review.
    # Never read through repository links or initialize submodules.
    count = size = 0
    for item in destination.rglob('*'):
        if '.git' in item.relative_to(destination).parts:
            continue
        if item.is_symlink() or item.is_junction() or not item.resolve().is_relative_to(destination.resolve()):
            raise ValueError('Plugin links need review before import.')
        if item.is_file():
            count += 1
            size += item.stat().st_size
            if count > 10000 or size > 100 * 1024 * 1024:
                raise ValueError('This plugin is too large to import.')
    if (destination / '.gitmodules').exists():
        raise ValueError('This repository uses submodules. Their separate revisions need review before import.')


def describe_plugin(destination, repository, resolved):
    validate_tree(destination)
    manifest_file = next((destination / name for name in ('plugin.yaml', 'plugin.yml') if (destination / name).is_file()), None)
    if not manifest_file:
        raise ValueError('This repository has no Hermes plugin.yaml or Claude .claude-plugin/plugin.json at its root. Skills can be reviewed through Skills Hub.')
    from hermes_cli.plugins_manifest import parse_manifest_file
    from utils import fast_safe_load
    manifest = parse_manifest_file(manifest_file, destination, 'user', '')
    if not manifest or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', manifest.name):
        raise ValueError('The plugin manifest needs a valid name.')
    if manifest.name.lower().startswith('trismegistus'):
        raise ValueError('This name is reserved for the app permissions bridge.')
    if manifest.kind != 'standalone':
        raise ValueError('This installer currently supports standalone Hermes plugins.')
    raw = fast_safe_load(manifest_file.read_text(encoding='utf-8')) or {}
    from plugin_setup import metadata
    setup = metadata(destination)
    prerequisites = list(setup['blockers'])
    if manifest.requires_hermes:
        from hermes_cli.plugins_manifest import requires_hermes_error
        if error := requires_hermes_error(manifest):
            prerequisites.append(error)
    from tools.plugin_guard import scan_plugin
    scan = scan_plugin(destination, source=repository + '@' + resolved)
    return dict(source=str(destination), commit=resolved, repository=repository,
                name=manifest.name, version=manifest.version, description=manifest.description,
                hooks=bool(manifest.provides_hooks), prerequisites=prerequisites, setup=setup,
                scan=dict(verdict=scan.verdict, findings=[asdict(f) for f in scan.findings]))
