"""Inspect release payloads without extracting or executing their contents.

Allow entries require an exact relative member path, SHA-256 and a reason.
An optional `text` permits only that identified synthetic match in those exact
bytes. Without `text`, the exception permits only a private-looking filename.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import posixpath
import re
import stat
import struct
import sys
import tarfile
import tempfile
import zipfile

PATTERNS = [(name, re.compile(pattern)) for name, pattern in [
    ('OpenAI key', r'\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}'),
    ('Anthropic key', r'\bsk-ant-[A-Za-z0-9_-]{32,}'),
    ('Google API key', r'\bAIza[0-9A-Za-z_-]{35}\b'),
    ('xAI key', r'\bxai-[A-Za-z0-9]{40,}'),
    ('GitHub token', r'\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b'),
    ('AWS access key', r'\b(?:AKIA|ASIA)[0-9A-Z]{16}\b'),
    ('Slack token', r'\bxox[abposr]-[A-Za-z0-9-]{10,}'),
    ('Telegram bot token', r'\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b'),
    ('Private key', r'-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----(?:\s|\\[rn])+[A-Za-z0-9+/=]{32,}'),
    ('Bearer token', r'\bBearer [A-Za-z0-9._~+/-]{40,}=*'),
]]
PRIVATE_NAMES = re.compile(r'^(?:auth\.(?:json|lock)|.*\.sqlite(?:-(?:wal|shm))?|(?:state|shared-state|projects)\.db|\.env(?:\..*)?|credentials(?:\..*)?|mcp-tokens|trismegistus-policy\.json)$', re.I)
PRIVATE_FOLDERS = {'.claude', '.codex', 'memories', 'sessions', 'state-snapshots', 'browser-profile'}
CHUNK = 1024 * 1024
OVERLAP = 8192
MARKERS = {
    'OpenAI key': ('sk-',), 'Anthropic key': ('sk-ant-',),
    'Google API key': ('AIza',), 'xAI key': ('xai-',),
    'GitHub token': ('gh',), 'AWS access key': ('AKIA', 'ASIA'),
    'Slack token': ('xox',), 'Telegram bot token': (':AA',),
    'Private key': ('-----BEGIN ',), 'Bearer token': ('Bearer ',),
}


def valid_path(name):
    return isinstance(name, str) and bool(name) and all(
        part not in ('', '.', '..') and not re.search(r'[\\:\x00-\x1f]', part)
        for part in name.split('/'))


class Slice:
    """Read one ASAR member without consuming its neighbour."""
    def __init__(self, source, size):
        self.source, self.left = source, size

    def read(self, size=-1):
        data = self.source.read(self.left if size < 0 else min(size, self.left))
        self.left -= len(data)
        if not data and self.left:
            raise ValueError('truncated member')
        return data


class Scanner:
    def __init__(self, allow, home):
        self.allow, self.findings, self.seen, self.pending = allow, [], set(), {}
        self.home = str(home).replace('\\', '/').lower() if home else ''
        self.bytes, self.entries = 0, 0
        for item in allow:
            if not isinstance(item, dict) or not valid_path(item.get('file')) or not item.get('reason'):
                raise ValueError('allow entries need an exact relative file and reason')
            if 'text' in item and (not isinstance(item['text'], str) or not 0 < len(item['text']) < OVERLAP // 4):
                raise ValueError('invalid allowed placeholder')
            if not isinstance(item.get('sha256'), str) or not re.fullmatch('[a-f0-9]{64}', item['sha256']):
                raise ValueError('invalid allowed file hash')

    def add(self, file, kind):
        if (file, kind) not in self.seen:
            self.seen.add((file, kind))
            self.findings.append({'file': file, 'kind': kind})

    def allowed(self, file, key, value):
        return any(row['file'] == file and row.get(key) == value and 'text' not in row for row in self.allow)

    def match(self, file, kind, value):
        hashes = {row['sha256'] for row in self.allow if row['file'] == file and row.get('text') == value}
        if hashes:
            self.pending.setdefault(file, []).append((kind, hashes))
        else:
            self.add(file, kind)

    def text(self, data, file, final):
        # Both UTF-16 alignments catch Windows strings embedded in binary files.
        texts = [data.decode('latin1')]
        if b'\0' in data:
            texts += [data[offset:].decode(encoding, errors='ignore')
                      for encoding in ('utf-16-le', 'utf-16-be') for offset in (0, 1)]
        for text in texts:
            boundary = len(text) if final else len(text) - OVERLAP // 2
            for kind, pattern in PATTERNS:
                if not any(marker in text for marker in MARKERS[kind]):
                    continue
                for match in pattern.finditer(text):
                    # Defer the trailing overlap so a placeholder crossing chunks
                    # is compared in full. Long unbounded token matches still fail.
                    if match.start() < boundary:
                        self.match(file, kind, match[0])
            normalized = text.replace('\\\\', '\\').replace('\\', '/').lower()
            if self.home and self.home in normalized:
                self.match(file, "This machine's user folder", '<home>')

    def chunks(self, source, first=b''):
        data = first
        while data or (data := source.read(CHUNK)):
            self.bytes += len(data)
            if self.bytes > 16 * 1024**3:
                raise ValueError('expanded payload exceeds 16 GiB inspection limit')
            yield data
            data = b''

    def private_name(self, file, digest):
        for kind, hashes in self.pending.pop(file, []):
            if digest not in hashes:
                self.add(file, kind)
        if self.allowed(file, 'sha256', digest):
            return
        parts = file.split('/')
        if PRIVATE_NAMES.fullmatch(parts[-1]):
            self.add(file, 'Private runtime file')
        if any(part.lower() in PRIVATE_FOLDERS for part in parts[:-1]):
            self.add(file, 'Private runtime folder')

    def content(self, source, file, depth=0, seekable=False):
        self.entries += 1
        if depth > 12 or self.entries > 500000:
            raise ValueError('archive depth or entry inspection limit exceeded')
        first = source.read(512)
        kind = ('tar' if file.lower().endswith(('.tar.gz', '.tgz')) else
                'gzip' if first.startswith(b'\x1f\x8b') else
                'asar' if file.lower().endswith('.asar') else
                'zip' if first[:4] in (b'PK\x03\x04', b'PK\x05\x06', b'PK\x07\x08') or file.lower().endswith(('.zip', '.whl', '.egg', '.jar')) else
                'tar' if first[257:262] == b'ustar' or file.lower().endswith(('.tar', '.tar.gz', '.tgz')) else '')
        if kind:
            if seekable:
                source.seek(0)
                self.archive(source, file, kind, depth)
            else:
                with tempfile.SpooledTemporaryFile(max_size=8 * CHUNK) as copy:
                    for chunk in self.chunks(source, first):
                        copy.write(chunk)
                    copy.seek(0)
                    self.archive(copy, file, kind, depth)
            return
        if first.startswith((b'7z\xbc\xaf\x27\x1c', b'Rar!', b'BZh', b'\xfd7zXZ')):
            self.add(file, 'Unsupported archive; inspection required')
        digest, tail = hashlib.sha256(), b''
        for chunk in self.chunks(source, first):
            digest.update(chunk)
            data = tail + chunk
            self.text(data, file, False)
            tail = data[-OVERLAP:]
        self.text(tail, file, True)
        self.private_name(file, digest.hexdigest())

    def member(self, name, seen):
        if not valid_path(name) or name.casefold() in seen:
            raise ValueError('unsafe or duplicate archive member name')
        seen.add(name.casefold())

    def archive(self, source, file, kind, depth):
        # Check every physical archive byte too: ZIP comments and unreferenced
        # ASAR bytes can carry data. Member checks separately attribute findings.
        digest, tail = hashlib.sha256(), b''
        for chunk in self.chunks(source):
            digest.update(chunk)
            data = tail + chunk
            self.text(data, file, False)
            tail = data[-OVERLAP:]
        self.text(tail, file, True)
        self.private_name(file, digest.hexdigest())
        source.seek(0)
        seen = set()
        if kind == 'gzip':
            with gzip.GzipFile(fileobj=source, mode='rb') as member:
                self.content(member, file + '/content', depth + 1)
        elif kind == 'zip':
            with zipfile.ZipFile(source) as archive:
                for info in archive.infolist():
                    name = info.filename.rstrip('/')
                    self.member(name, seen)
                    mode = stat.S_IFMT(info.external_attr >> 16)
                    if mode not in (0, stat.S_IFREG, stat.S_IFDIR) or info.flag_bits & 1:
                        self.add(file + '/' + name, 'Link, special or encrypted archive member')
                    elif not info.is_dir():
                        with archive.open(info) as member:
                            self.content(member, file + '/' + name, depth + 1)
        elif kind == 'tar':
            with tarfile.open(fileobj=source, mode='r:*') as archive:
                for info in archive:
                    name = info.name.removeprefix('./').rstrip('/')
                    if not name and info.isdir():
                        continue
                    self.member(name, seen)
                    target, links = info, set()
                    while target.issym() or target.islnk():
                        linked = posixpath.normpath(posixpath.join(posixpath.dirname(target.name) if target.issym() else '', target.linkname))
                        if not valid_path(linked) or linked in links:
                            raise ValueError('unsafe or cyclic tar link')
                        links.add(linked)
                        try:
                            target = archive.getmember(linked)
                        except KeyError as error:
                            raise ValueError('missing tar link target') from error
                    if target.isfile():
                        with archive.extractfile(target) as member:
                            self.content(member, file + '/' + name, depth + 1)
                    elif not target.isdir():
                        self.add(file + '/' + name, 'Link or special archive member')
        else:
            self.asar(source, file, depth)

    def asar(self, source, file, depth):
        source.seek(0, 2)
        size = source.tell()
        source.seek(0)
        prefix = source.read(16)
        if len(prefix) != 16:
            raise ValueError('truncated ASAR header')
        pickle_size, header_size, payload_size, text_size = struct.unpack('<IIII', prefix)
        if pickle_size != 4 or not 8 <= header_size <= min(16 * CHUNK, size - 8) or payload_size != header_size - 4 or text_size > header_size - 8:
            raise ValueError('invalid ASAR header')
        header = json.loads(source.read(text_size))
        if not isinstance(header, dict) or not isinstance(header.get('files'), dict):
            raise ValueError('invalid ASAR directory')
        ranges, seen = [], set()

        def walk(entries, parent='', level=0):
            if level > 64:
                raise ValueError('ASAR directory depth limit exceeded')
            for name, info in entries.items():
                if not valid_path(name) or '/' in name or not isinstance(info, dict):
                    raise ValueError('unsafe ASAR member')
                relative = parent + name
                self.member(relative, seen)
                target = file + '/' + relative
                if 'link' in info:
                    self.add(target, 'Link in ASAR')
                elif 'files' in info:
                    if not isinstance(info['files'], dict):
                        raise ValueError('invalid ASAR directory')
                    walk(info['files'], relative + '/', level + 1)
                elif info.get('unpacked'):
                    # The adjacent .asar.unpacked tree is inspected by the disk
                    # walker. Nested/unavailable companions cannot be cleared.
                    self.unpacked.append((file, relative, info.get('size')))
                else:
                    offset, length = info.get('offset'), info.get('size')
                    if not isinstance(offset, str) or not re.fullmatch(r'\d+', offset) or type(length) is not int or length < 0:
                        raise ValueError('invalid ASAR member range')
                    start = 8 + header_size + int(offset)
                    if start + length > size:
                        raise ValueError('ASAR member outside archive')
                    ranges.append((start, length, target))
        walk(header['files'])
        end = 8 + header_size
        for start, length, target in sorted(ranges):
            if start < end:
                raise ValueError('overlapping ASAR members')
            source.seek(start)
            self.content(Slice(source, length), target, depth + 1)
            end = start + length

    def scan(self, root):
        root = Path(root).absolute()
        self.unpacked, disk_files = [], {}
        if root.is_symlink() or root.is_junction() or not root.is_dir():
            raise ValueError('scan root must be a real payload directory')
        def walk_error(error):
            raise error
        for folder, directories, files in os.walk(root, followlinks=False, onerror=walk_error):
            for name in list(directories):
                full = Path(folder) / name
                if full.is_symlink() or full.is_junction():
                    self.add(full.relative_to(root).as_posix(), 'Link in build')
                    directories.remove(name)
            for name in files:
                full = Path(folder) / name
                relative = full.relative_to(root).as_posix()
                if full.is_symlink() or not full.is_file():
                    self.add(relative, 'Link or special file in build')
                    continue
                disk_files[relative] = full.stat().st_size
                try:
                    with full.open('rb') as stream:
                        self.content(stream, relative, seekable=True)
                except (OSError, ValueError, EOFError, RuntimeError, zipfile.BadZipFile, tarfile.TarError):
                    self.add(relative, 'Unreadable or invalid payload; inspection required')
        for archive, member, size in self.unpacked:
            if type(size) is not int or disk_files.get(archive + '.unpacked/' + member) != size:
                self.add(archive + '/' + member, 'Missing or invalid unpacked ASAR member')
        return self.findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder')
    parser.add_argument('--allow', type=Path, default=Path(__file__).with_name('scan-allow.json'))
    parser.add_argument('--home', default=str(Path.home()))
    args = parser.parse_args()
    try:
        scanner = Scanner(json.loads(args.allow.read_text(encoding='utf-8')), args.home)
        findings = scanner.scan(args.folder)
    except (OSError, ValueError, TypeError):
        print('Release scan failed: invalid input or allowlist.', file=sys.stderr)
        return 2
    print(json.dumps({'findings': findings, 'entries': scanner.entries, 'bytesInspected': scanner.bytes}, indent=2))
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
