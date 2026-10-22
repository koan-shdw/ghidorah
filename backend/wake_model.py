"""Pinned English wake model; no Hermes fallback download or unchecked archive extraction."""
import hashlib
import json
import tarfile
import tempfile
import urllib.request
from pathlib import Path
from uuid import uuid4

MODEL = json.loads(Path(__file__).with_name('wake-model.json').read_text(encoding='utf-8'))


def directory(root):
    parent = Path(root).resolve() / 'models' / 'wake'
    folder = parent / MODEL['sha256']
    if folder.resolve() != folder:
        raise ValueError('Wake model folders must not be links.')
    return folder


def verified(root):
    folder = directory(root)
    if not folder.is_dir() or {file.name for file in folder.iterdir()} != set(MODEL['files']):
        raise ValueError('The wake model is missing or changed. Install it again on the Voice page.')
    for name, spec in MODEL['files'].items():
        file = folder / name
        if file.resolve() != file or not file.is_file() or file.stat().st_size != spec['size']:
            raise ValueError('The wake model is missing or changed: ' + name)
        with file.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != spec['sha256']:
                raise ValueError('The wake model is missing or changed: ' + name)
    return folder


def install(root):
    try:
        return str(verified(root))
    except ValueError:
        pass
    folder = directory(root)
    folder.parent.mkdir(parents=True, exist_ok=True)
    staged = Path(tempfile.mkdtemp(prefix='.install-', dir=folder.parent))
    archive = None
    # The generated staging folder and any old model are retained if installation
    # fails; no unverified files replace the active model.
    try:
        with tempfile.NamedTemporaryFile(dir=folder.parent, suffix='.tar.bz2', delete=False) as output:
            archive = Path(output.name)
            with urllib.request.urlopen(MODEL['url'], timeout=60) as response:
                received = 0
                while chunk := response.read(min(1024 * 1024, MODEL['size'] - received + 1)):
                    received += len(chunk)
                    if received > MODEL['size']:
                        raise ValueError('The wake model download exceeds its pinned size.')
                    output.write(chunk)
        with archive.open('rb') as stream:
            if archive.stat().st_size != MODEL['size'] or hashlib.file_digest(stream, 'sha256').hexdigest() != MODEL['sha256']:
                raise ValueError('The wake model archive does not match its pinned hash.')
        with tarfile.open(archive, 'r:bz2') as source:
            for name, spec in MODEL['files'].items():
                member = source.getmember(MODEL['folder'] + '/' + name)
                if not member.isfile() or member.size != spec['size']:
                    raise ValueError('Invalid wake model archive member: ' + name)
                payload = source.extractfile(member).read(spec['size'] + 1)
                if len(payload) != spec['size'] or hashlib.sha256(payload).hexdigest() != spec['sha256']:
                    raise ValueError('The wake model file does not match its pinned hash: ' + name)
                (staged / name).write_bytes(payload)
        if directory(root) != folder or staged.resolve() != staged:
            raise ValueError('The wake model location changed.')
        previous = folder.parent / ('.previous-' + str(uuid4()))
        moved = folder.exists()
        if moved:
            folder.rename(previous)
        try:
            staged.rename(folder)
        except OSError:
            if moved:
                previous.rename(folder)
            raise
        return str(verified(root))
    finally:
        if archive:
            archive.unlink(missing_ok=True)
