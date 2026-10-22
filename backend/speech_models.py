"""Whisper models for dictation (R4) and the local voice fallback (8).

Each model is pinned to a Hugging Face revision; every file is checked by size and SHA-256, or by its git blob SHA-1
for the small text files Hugging Face keeps outside LFS (FINISH-PLAN rule 12, 5.21 M10). Nothing downloads except on
the Voice page's Install click, and a file that does not match is deleted, never used.
"""
import hashlib
import json
import tempfile
import urllib.request
from pathlib import Path

SOURCE = Path(__file__).resolve().parent
MODELS = json.loads((SOURCE / 'whisper-models.json').read_text(encoding='utf-8'))


def _git_sha1(file):
    data = file.read_bytes()
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def _valid(file, spec):
    if file.is_symlink() or file.resolve() != file or not file.is_file() or file.stat().st_size != spec['size']:
        return False
    if 'sha256' in spec:
        with file.open('rb') as stream:
            return hashlib.file_digest(stream, 'sha256').hexdigest() == spec['sha256']
    return _git_sha1(file) == spec['git']


def _spec(name):
    if name not in MODELS:
        raise ValueError('Unknown speech model.')
    return MODELS[name]


def directory(root, name):
    folder = Path(root).resolve() / 'models' / 'whisper' / name / _spec(name)['revision']
    if folder.resolve() != folder:
        raise ValueError('Speech model folders must not be links.')
    return folder


def verified(root, name):
    folder = directory(root, name)
    for file, spec in _spec(name)['files'].items():
        if not _valid(folder / file, spec):
            raise ValueError('The speech model is missing or changed. Install it again on the Voice page.')
    return folder


def install(root, name):
    model = _spec(name)
    folder = directory(root, name)
    folder.mkdir(parents=True, exist_ok=True)
    progress = folder.parent / 'progress.json'
    try:
        progress.unlink(missing_ok=True)
    except PermissionError:
        pass  # The UI may hold this advisory progress file open on Windows.
    total = sum(spec['size'] for spec in model['files'].values())
    done = sum(spec['size'] for file, spec in model['files'].items() if _valid(folder / file, spec))
    for file, spec in model['files'].items():
        target = folder / file
        if _valid(target, spec):
            continue
        url = 'https://huggingface.co/' + model['repository'] + '/resolve/' + model['revision'] + '/' + file
        temporary = None
        try:
            with urllib.request.urlopen(url, timeout=60) as response, tempfile.NamedTemporaryFile(dir=folder, suffix='.part', delete=False) as output:
                temporary = Path(output.name)
                received = 0
                while chunk := response.read(min(1024 * 1024, spec['size'] - received + 1)):
                    received += len(chunk)
                    if received > spec['size']:
                        raise ValueError('The speech download exceeds its pinned size: ' + file)
                    output.write(chunk)
                    done += len(chunk)
                    with tempfile.NamedTemporaryFile(dir=progress.parent, mode='w', encoding='utf-8', delete=False) as update:
                        json.dump({'done': done, 'total': total}, update)
                    try:
                        Path(update.name).replace(progress)
                    except PermissionError:
                        pass  # A progress reader must not abort the model download.
                    finally:
                        Path(update.name).unlink(missing_ok=True)
            if not _valid(temporary, spec):
                raise ValueError('A downloaded file did not match its pinned hash: ' + file)
            if directory(root, name) != folder:
                raise ValueError('The speech model location changed.')
            temporary.replace(target)
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
    try:
        progress.unlink(missing_ok=True)
    except PermissionError:
        pass
    return str(verified(root, name))
