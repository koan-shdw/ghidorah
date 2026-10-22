"""Reviewed plugin setup using Hermes declarations, settings and secret-source APIs."""
from pathlib import Path
import hashlib
import json
import os
import re
import tempfile
import uuid


def metadata(source):
    from utils import fast_safe_load
    from hermes_cli.plugins_settings import _field_type, secret_env_name
    from hermes_cli.plugins_state import _plugin_relative_segments
    from hermes_cli.plugin_python_deps import read_declaration, applicable_specs, unsupported_specs
    source = Path(source)
    manifest_file = next((source / name for name in ('plugin.yaml', 'plugin.yml') if (source / name).is_file()), None)
    if not manifest_file:
        return dict(fields=[], python=[], plugins=[], blockers=[])
    raw = fast_safe_load(manifest_file.read_text(encoding='utf8')) or {}
    fields, blockers = [], []
    if not isinstance(raw.get('config_schema') or {}, dict):
        raise ValueError('config_schema must be a settings object.')
    for key, spec in (raw.get('config_schema') or {}).items():
        if not isinstance(spec, dict):
            raise ValueError('Each plugin setting must declare a settings object.')
        _plugin_relative_segments(key)
        kind = _field_type(spec)
        # Credential-shaped fields keep credential storage even on older manifests.
        if re.search(r'(^|_)(api_key|token|secret|password)$', key, re.I):
            kind = 'secret'
        field = dict(key='setting:' + key, setting=key, type=kind, label=str(spec.get('label', key)),
                     description=str(spec.get('description', '')), required=bool(spec.get('required')),
                     schema=spec)
        if kind == 'secret':
            field['env'] = secret_env_name(raw['name'], key, spec)
        elif 'default' in spec:
            field['default'] = spec['default']
        fields.append(field)
    for section in ('requires_env', 'optional_env'):
        if not isinstance(raw.get(section) or [], list):
            raise ValueError(section + ' must be a list of environment fields.')
        for item in raw.get(section) or []:
            spec = dict(name=item) if isinstance(item, str) else item
            name = spec.get('name')
            if not name:
                raise ValueError('An environment requirement has no name.')
            if any(row.get('env') == name for row in fields):
                if section == 'requires_env':
                    next(row for row in fields if row.get('env') == name)['required'] = True
                continue
            fields.append(dict(key='env:' + name, env=name, type='secret' if spec.get('secret', True) else 'string',
                               label=name, description=str(spec.get('description', '')), required=section == 'requires_env', schema={}))
    for field in fields:
        if field.get('env'):
            validate_env(field['env'])
    declaration = read_declaration(source)
    specs = list(declaration.specs)
    if not specs and not (source / 'pyproject.toml').exists() and (source / 'requirements.txt').is_file():
        specs = [line.strip() for line in (source / 'requirements.txt').read_text(encoding='utf8').splitlines() if line.strip() and not line.lstrip().startswith('#')]
    if unsupported_specs(specs):
        blockers.append('Direct URL/path Python dependencies require a separate source review.')
    if declaration.external:
        blockers.append('This plugin manages an external Python runtime; its setup is not supported yet.')
    if (source / 'setup.py').exists() and not specs:
        blockers.append('setup.py has no declarative dependency list. Its installer requires separate review.')
    if raw.get('external_dependencies'):
        blockers.append('External dependencies: ' + str(raw['external_dependencies']))
    from hermes_cli.plugins_manifest import parse_manifest_file
    manifest = parse_manifest_file(manifest_file, source, 'user', '')
    return dict(fields=fields, python=applicable_specs(specs), plugins=manifest.requires_plugins, blockers=blockers)


def validate_env(name):
    from agent.secret_scope import _is_global_env
    if not isinstance(name, str) or not re.fullmatch(r'[A-Z_][A-Z0-9_]{0,119}', name) or _is_global_env(name) or name.startswith(('HERMES_', 'TRISMEGISTUS_', 'PYTHON', 'NODE_', 'ELECTRON_', 'UV_', 'PIP_')):
        raise ValueError('The plugin environment field cannot override app runtime settings: ' + str(name))


def configuration_path(home, revision):
    if not isinstance(revision, str) or not re.fullmatch(r'[a-f0-9]{32}', revision):
        raise ValueError('Invalid plugin configuration revision.')
    file = Path(home) / 'plugin-configurations' / (revision + '.json')
    if file.is_symlink() or file.parent.is_symlink() or file.parent.is_junction():
        raise ValueError('Plugin configuration links are not allowed.')
    return file


def load_configuration(home, revision):
    from hermes_cli.credential_codec import decode
    data = json.loads(configuration_path(home, revision).read_text(encoding='utf8'))
    if data.get('credential_envelope') != 1:
        raise ValueError('The encrypted plugin configuration is unavailable. Save its settings again.')
    return decode(data)


def save_configuration(home, source, values, previous=None):
    from hermes_cli.credential_codec import encode
    from hermes_cli.plugins_state import _plugin_relative_segments
    from utils import atomic_json_write
    if not isinstance(values, dict):
        raise ValueError('Plugin settings must be an object.')
    fields = metadata(source)['fields']
    known = {field['key'] for field in fields}
    if set(values) - known:
        raise ValueError('A setting is not declared by this plugin.')
    old = load_configuration(home, previous) if previous else dict(values={})
    merged = {key: value for key, value in old['values'].items() if key in known}
    merged.update(values)
    environment, settings, public, filled, redact = {}, {}, {}, [], []
    for field in fields:
        key = field['key']
        value = merged.get(key, field.get('default'))
        if value is None or (field['required'] or field['type'] == 'secret') and value == '':
            merged.pop(key, None)
            if field['required']:
                raise ValueError('Enter ' + field['label'] + ' before enabling this plugin.')
            continue
        kind, spec = field['type'], field['schema']
        from hermes_cli.plugins_settings import _VALUE_TYPES
        expected = (str,) if kind == 'secret' else _VALUE_TYPES[kind]
        if not isinstance(value, expected) or isinstance(value, bool) and bool not in expected:
            raise ValueError(field['label'] + ' has the wrong value type.')
        if str(spec.get('type')).lower() in ('int', 'integer') and not isinstance(value, int):
            raise ValueError(field['label'] + ' requires a whole number.')
        choices = spec.get('choices', spec.get('enum'))
        if kind == 'enum' and value not in [str(item) for item in choices]:
            raise ValueError(field['label'] + ' must use one of its listed choices.')
        merged[key] = value
        if kind == 'secret':
            redact.append(value)
        if field.get('env'):
            validate_env(field['env'])
            environment[field['env']] = str(value)
        if field.get('setting'):
            cursor = settings
            segments = _plugin_relative_segments(field['setting'])
            for segment in segments[:-1]:
                cursor = cursor.setdefault(segment, {})
            cursor[segments[-1]] = '${env:' + field['env'] + '}' if kind == 'secret' else value
        if kind != 'secret' and not field.get('env'):
            public[key] = value
        filled.append(key)
    revision = uuid.uuid4().hex
    file = configuration_path(home, revision)
    file.parent.mkdir(parents=True, exist_ok=True)
    atomic_json_write(file, encode(dict(values=merged, env=environment, redact=redact)), mode=0o600)
    return dict(revision=revision, settings=settings, values=public, filled=filled,
                redact=redact)


def configuration_values(home, revisions):
    combined = {}
    for revision in revisions:
        for key, value in load_configuration(home, revision)['env'].items():
            validate_env(key)
            if key in combined and combined[key] != value:
                raise ValueError('Enabled plugins have different values for ' + key + '. Give them matching values or turn one off.')
            combined[key] = value
    return combined


def configuration_redactions(home, revisions):
    return [value for revision in revisions for value in load_configuration(home, revision).get('redact', [])]


def install_secret_source(home, revisions):
    from agent.secret_sources.base import SecretSource, FetchResult, ErrorKind
    from agent.secret_sources.registry import register_source, apply_all
    from agent.redact import register_vault_redaction_value
    root = Path(home).resolve()
    values = configuration_values(home, revisions)
    for value in configuration_redactions(home, revisions):
        register_vault_redaction_value(value)
    class PluginSecrets(SecretSource):
        name = 'trismegistus_plugins'
        label = 'Ghidorah plugin settings'
        override_existing_default = True
        def fetch(self, cfg, home_path):
            current = Path(home_path).resolve()
            if current != root and not (current.parent == root / 'profiles' and re.fullmatch(r'p-[0-9a-f-]{36}', current.name)):
                return FetchResult().fail('Plugin credentials requested outside this app.', ErrorKind.REF_INVALID)
            return FetchResult(secrets=dict(values))
    if not register_source(PluginSecrets(), replace=True):
        raise ValueError('The plugin credential source could not start.')
    # Registration and environment reads during plugin import happen before a turn's scope.
    apply_all(dict(trismegistus_plugins=dict(enabled=True)), root)


def runtime_files(directory):
    root = Path(directory).resolve(strict=True)
    pending = [root]
    while pending:
        current = pending.pop()
        for file in current.iterdir():
            if file.is_symlink() or file.is_junction() or not file.resolve().is_relative_to(root):
                raise ValueError('Plugin dependency links require review.')
            if file.is_dir():
                pending.append(file)
            elif file.is_file():
                yield file


def clear_runtime_bytecode(directory):
    # Python reads caches even with PYTHONDONTWRITEBYTECODE=1. Discard them before
    # verification/import, including caches excluded by older runtime hashes.
    for file in runtime_files(directory):
        if file.suffix in ('.pyc', '.pyo'):
            file.unlink()


def runtime_hash(directory):
    digest = hashlib.sha256()
    for file in sorted(runtime_files(directory)):
        digest.update(file.relative_to(directory).as_posix().encode() + b'\0')
        digest.update(str(file.stat().st_size).encode() + b'\0')
        with file.open('rb') as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
    return digest.hexdigest()


def check_runtime(home, runtime):
    if not runtime:
        return None
    directory = Path(runtime['directory'])
    root = Path(home).parent / 'plugin-runtimes'
    if directory.parent != root or not re.fullmatch(r'runtime-[A-Za-z0-9_-]+', directory.name) or root.is_symlink() or root.is_junction() or directory.is_symlink() or directory.is_junction() or not directory.is_dir():
        raise ValueError('Plugin dependencies changed or are missing. Review their installation again.')
    clear_runtime_bytecode(directory)
    if runtime_hash(directory) != runtime['hash']:
        raise ValueError('Plugin dependencies changed or are missing. Review their installation again.')
    return directory


# Feature versions and their full wheel closure are locked beside this file.
FEATURES = {'telegram': 'telegram-requirements.txt', 'speech': 'speech-requirements.txt'}


def feature_specs(features):
    specs = []
    for feature in features:
        if feature not in FEATURES:
            raise ValueError('Unknown feature.')
        lines = (Path(__file__).parent / FEATURES[feature]).read_text(encoding='utf8').splitlines()
        specs += [line.strip() for line in lines if line.strip() and not line.lstrip().startswith('#')]
    return specs


def prepare_runtime(home, sources, features=()):
    from tools.lazy_deps import install_specs
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from importlib.metadata import distributions
    specs = list(dict.fromkeys([*(spec for source in sources for spec in metadata(source)['python']), *feature_specs(features)]))
    if not specs:
        return None
    root = Path(home).parent / 'plugin-runtimes'
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink() or root.is_junction():
        raise ValueError('Plugin runtime links are not allowed.')
    target = Path(tempfile.mkdtemp(prefix='runtime-', dir=root))
    # A fresh target makes failure/cancellation leave the active environment untouched.
    # Hermes pins every bundled distribution to its installed version in target mode.
    os.environ['HERMES_LAZY_INSTALL_TARGET'] = str(target)
    token = set_hermes_home_override(target / 'installer-home')
    try:
        if features:
            from feature_packages import install
            install(target, specs, features)
        else:
            result = install_specs(specs, timeout=600, policy='plugin')
            if not result.ok:
                raise ValueError('Plugin dependencies were not activated: ' + (result.reason or result.stderr or result.stdout)[-2400:])
    finally:
        reset_hermes_home_override(token)
    clear_runtime_bytecode(target)
    packages = sorted({dist.metadata['Name']: dist.version for dist in distributions(path=[str(target)]) if dist.metadata.get('Name')}.items())
    return dict(directory=str(target), hash=runtime_hash(target), specs=specs, features=list(features), packages=[dict(name=name, version=version) for name, version in packages])


def validate_plugins(plugins):
    from packaging.specifiers import SpecifierSet
    from packaging.version import Version
    for plugin in plugins:
        for dependency in metadata(plugin['directory'])['plugins']:
            match = next((item for item in plugins if dependency['id'] in (item['name'], item['key'])), None)
            if not match:
                raise ValueError(plugin['name'] + ' requires enabled plugin ' + dependency['id'] + '.')
            constraint = dependency.get('version_range')
            if constraint and Version(match['version']) not in SpecifierSet(constraint):
                raise ValueError(plugin['name'] + ' requires ' + dependency['id'] + ' ' + constraint + '.')
