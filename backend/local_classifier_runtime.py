"""Pinned optional local classifier runtime, separate from Hermes and its dependencies."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import sys
import urllib.request
from parent_lifetime import parent_guard

SOURCE = Path(__file__).resolve().parent
MANIFEST = None
LOCK = None
IDENTITY = None
NAME = None


def configure(name, lock, manifest):
    """Select the pinned worker's name, dependency lock and model record."""
    global NAME, LOCK, MANIFEST, IDENTITY
    NAME, LOCK, MANIFEST = name, lock, json.loads(manifest.read_text(encoding='utf-8'))
    IDENTITY = hashlib.sha256((lock.read_text(encoding='utf-8') + manifest.read_text(encoding='utf-8')).encode()).hexdigest()


def fingerprint(file):
    with file.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def git_blob(file):
    digest = hashlib.sha1(b'blob %d\0' % file.stat().st_size)
    with file.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def valid(file, spec):
    if not (file.is_file() and file.stat().st_size == spec['size']):
        return False
    return fingerprint(file) == spec['sha256'] if 'sha256' in spec else git_blob(file) == spec['gitSha1']



def emit(value):
    print(json.dumps(value), flush=True)


def install(root):
    if not all((NAME, LOCK, MANIFEST, IDENTITY)):
        raise ValueError('Configure the local classifier before installing.')
    parent_guard()
    root.mkdir(parents=True, exist_ok=True)
    environment = root / IDENTITY[:16]
    python = environment / 'Scripts/python.exe'
    marker = environment / 'ready.json'
    marker.unlink(missing_ok=True)
    emit(dict(type='progress', status='Installing pinned ' + NAME + ' dependencies…'))
    # Install subprocesses do not consume the private parent-liveness pipe.
    subprocess.run([sys.executable, '-I', '-m', 'venv', str(environment)], check=True,
                   timeout=180, stdin=subprocess.DEVNULL, stdout=sys.stderr, stderr=sys.stderr,
                   creationflags=subprocess.CREATE_NO_WINDOW)
    subprocess.run([str(python), '-I', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check',
                    '--require-hashes', '--only-binary=:all:', '-r', str(LOCK)], check=True,
                   timeout=1200, stdin=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW,
                   stdout=sys.stderr, stderr=sys.stderr)
    model = root / 'models' / MANIFEST['revision']
    for name, spec in MANIFEST['files'].items():
        destination = model / name
        if valid(destination, spec):
            continue
        emit(dict(type='progress', status='Downloading ' + NAME + ' · ' + name))
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + '.part')
        url = 'https://huggingface.co/' + MANIFEST['repository'] + '/resolve/' + MANIFEST['revision'] + '/' + name
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open('wb') as output:
            count = 0
            while chunk := response.read(1024 * 1024):
                count += len(chunk)
                if count > spec['size']:
                    raise ValueError(NAME + ' download exceeded its pinned size.')
                output.write(chunk)
        if not valid(temporary, spec):
            raise ValueError(NAME + ' download did not match its pinned hash.')
        temporary.replace(destination)
    marker.write_text(json.dumps(dict(identity=IDENTITY, revision=MANIFEST['revision'])), encoding='utf-8')
    emit(dict(type='installed', identity=IDENTITY))


def run():
    try:
        install(Path(sys.argv[1]).resolve())
    except Exception as error:
        emit(dict(type='error', error=str(error)[-1500:]))
        sys.exit(1)


if __name__ == '__main__':
    run()
