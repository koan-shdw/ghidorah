"""Package an app-owned staging directory without following links."""
import os
from pathlib import Path
import re
import zipfile


def package(staging, contents='.'):
    staging = Path(staging)
    base = Path(os.environ['HERMES_HOME']).parent / 'exports'
    if not re.fullmatch(r'[a-f0-9-]{36}', staging.name) or staging.parent != base or staging.resolve() != staging or base.resolve() != base:
        raise ValueError('Invalid export staging directory.')
    if contents not in ('.', 'files'):
        raise ValueError('Invalid archive contents.')
    source = staging if contents == '.' else staging / contents
    if not source.is_dir() or source.is_symlink() or source.resolve() != source:
        raise ValueError('Invalid archive contents directory.')
    files = []
    for directory, folders, names in os.walk(source, followlinks=False):
        for name in folders + names:
            file = Path(directory) / name
            if file.is_symlink() or file.resolve() != file:
                raise ValueError('Export staging must not contain links.')
            if file.is_file():
                files.append(file)
    if len(files) > 1004 or sum(file.stat().st_size for file in files) > 1100 * 1024 * 1024:
        raise ValueError('Export archive exceeds the supported size.')
    output = staging / 'export.zip'
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        for file in files:
            archive.write(file, file.relative_to(source).as_posix())
    return {'file': str(output)}
