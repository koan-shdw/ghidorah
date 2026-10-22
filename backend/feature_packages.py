"""Install app features from the exact wheels recorded in this app build.

Named plugin requirements resolve in the same target with the bundled versions
held fixed. Every transitive dependency of an app feature has a pinned wheel URL
and SHA256; pip verifies those URL fragments before installing their bytes.
"""
import json
import os
from pathlib import Path
import sys

LOCK = Path(__file__).with_name('feature-wheels.json')


def install(target, specs, features):
    from tools.lazy_deps import _core_constraints_file, _spec_is_safe
    from hermes_cli._subprocess_compat import bounded_probe_run
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name
    if any(not _spec_is_safe(spec) for spec in specs):
        raise ValueError('Only named Python package requirements are supported.')
    lock = json.loads(LOCK.read_text(encoding='utf-8'))
    if any(feature not in lock['features'] for feature in features):
        raise ValueError('Unknown app feature.')
    names = sorted({name for feature in features for name in lock['features'][feature]})
    requirements = []
    extras = {}
    for spec in specs:
        requirement = Requirement(spec)
        name = canonicalize_name(requirement.name)
        if name in names:
            if lock['packages'][name]['version'] not in requirement.specifier:
                raise ValueError('This plugin conflicts with the pinned app feature: ' + spec)
            extras.setdefault(name, set()).update(requirement.extras)
        else:
            requirements.append(spec)
    for name in names:
        row = lock['packages'][name]
        suffix = '[' + ','.join(sorted(extras[name])) + ']' if extras.get(name) else ''
        requirements.append(name + suffix + ' @ ' + row['url'] + '#sha256=' + row['sha256'])
    target = Path(target)
    requirement_file = target / 'feature-requirements.txt'
    requirement_file.write_text('\n'.join(requirements) + '\n', encoding='utf-8')
    constraints = _core_constraints_file()
    if constraints is None:
        raise ValueError('The bundled Python versions could not be read safely.')
    # Disable ambient pip configuration; this app build names every feature
    # artifact and uses PyPI for reviewed plugins' additional named packages.
    env = {key:value for key,value in os.environ.items() if not key.upper().startswith(('PIP_', 'UV_'))}
    env.update(PIP_CONFIG_FILE=os.devnull, PYTHONDONTWRITEBYTECODE='1')
    try:
        result = bounded_probe_run([sys.executable, '-m', 'pip', '--disable-pip-version-check',
                                    'install', '--no-input', '--only-binary=:all:', '--no-compile',
                                    '--index-url', 'https://pypi.org/simple', '--retries', '2', '--timeout', '30',
                                    '--target', str(target), '--constraint', str(constraints),
                                    '--requirement', str(requirement_file),
                                    '--report', str(target / 'install-receipt.json')], env=env, timeout=600)
    finally:
        constraints.unlink(missing_ok=True)
    if result is None or result.returncode:
        raise ValueError('Feature dependencies were not activated: ' +
                         ((result.stderr or result.stdout)[-2400:] if result else 'The installer timed out or could not start.'))
