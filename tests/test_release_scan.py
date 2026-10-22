import hashlib
import gzip
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

APP = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release_scan', APP / 'scripts/scan_release.py')
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)


class ReleaseScanTest(unittest.TestCase):
    def test_gzip_content_is_scanned_and_invalid_streams_fail(self):
        with tempfile.TemporaryDirectory(prefix='tris-release-gzip-') as directory:
            root = Path(directory)
            (root / 'cmap.json.gz').write_bytes(gzip.compress(b'{"map": [1, 2]}'))
            self.assertEqual(scan.Scanner([], '').scan(root), [])
            (root / 'secret.gz').write_bytes(gzip.compress(('sk-proj-' + 'A' * 40).encode()))
            (root / 'broken.gz').write_bytes(b'\x1f\x8bbroken')
            findings = scan.Scanner([], '').scan(root)
            self.assertTrue(any(row['file'] == 'secret.gz/content' and row['kind'] == 'OpenAI key' for row in findings))
            self.assertTrue(any(row['file'] == 'broken.gz' and 'invalid' in row['kind'] for row in findings))

    def test_built_archives_large_files_and_exact_placeholder_exceptions(self):
        with tempfile.TemporaryDirectory(prefix='tris-release-scan-') as directory:
            root = Path(directory)
            payload, source = root / 'payload', root / 'source'
            payload.mkdir()
            source.mkdir()
            token = 'sk-proj-' + 'A1b2C3d4' * 6
            (payload / 'clean.js').write_text('const ready = true;')
            self.assertEqual(scan.Scanner([], '').scan(payload), [])
            (source / 'auth.json').write_text('{}')
            (source / 'chat.sqlite').write_bytes(b'SQLite format 3\0')
            (source / 'key.js').write_text('const key = "' + token + '";')
            private = '-----BEGIN PRIVATE KEY-----\n' + 'Ab12' * 16 + '\n-----END PRIVATE KEY-----'
            (source / 'key.pem').write_text(private)
            subprocess.run(['node', '-e', "require('@electron/asar').createPackage(process.argv[1],process.argv[2]).catch(e=>{console.error(e.message);process.exitCode=1})", str(source), str(payload / 'app.asar')], cwd=APP, check=True, capture_output=True)
            # Decompression and nested-container inspection, using real stdlib writers.
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode='w:gz') as tar:
                data = token.encode()
                info = tarfile.TarInfo('memories/MEMORY.md')
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
                alias = tarfile.TarInfo('alias.txt')
                alias.type = tarfile.LNKTYPE
                alias.linkname = 'memories/MEMORY.md'
                tar.addfile(alias)
            with zipfile.ZipFile(payload / 'package.whl', 'w', compression=zipfile.ZIP_DEFLATED) as wheel:
                wheel.writestr('nested.tar.gz', archive.getvalue())
                wheel.writestr('config.txt', token.encode('utf-16-le'))
                wheel.comment = token.encode()
            # Large sparse fixture: the old scanner silently skipped the entire file.
            with (payload / 'large.bin').open('wb') as large:
                large.seek(201 * 1024 * 1024)
                large.write(token.encode())
            # The candidate string spans a read boundary and must be compared whole.
            (payload / 'placeholder.txt').write_bytes(b' ' * (scan.CHUNK + 500) + token.encode())
            (payload / 'other-placeholder.txt').write_text(token)
            (payload / '.env.example').write_text('VALUE=')
            allow = [
                {'file': 'placeholder.txt', 'text': token, 'sha256': hashlib.sha256((payload / 'placeholder.txt').read_bytes()).hexdigest(), 'reason': 'Synthetic test value'},
                {'file': '.env.example', 'sha256': hashlib.sha256(b'VALUE=').hexdigest(), 'reason': 'Empty template'},
            ]
            findings = scan.Scanner(allow, '').scan(payload)
            pairs = {(row['file'], row['kind']) for row in findings}
            for file, kind in [
                ('app.asar/auth.json', 'Private runtime file'),
                ('app.asar/chat.sqlite', 'Private runtime file'),
                ('app.asar/key.js', 'OpenAI key'),
                ('app.asar/key.pem', 'Private key'),
                ('package.whl/nested.tar.gz/memories/MEMORY.md', 'OpenAI key'),
                ('package.whl/nested.tar.gz/memories/MEMORY.md', 'Private runtime folder'),
                ('package.whl/nested.tar.gz/alias.txt', 'OpenAI key'),
                ('package.whl/config.txt', 'OpenAI key'),
                ('package.whl', 'OpenAI key'),
                ('large.bin', 'OpenAI key'),
                ('other-placeholder.txt', 'OpenAI key'),
            ]:
                self.assertIn((file, kind), pairs)
            self.assertFalse(any(row['file'] in ('placeholder.txt', '.env.example') for row in findings), findings)
            self.assertNotIn(token, json.dumps(findings), 'diagnostics never disclose credential fragments')
            # A hash exception cannot exempt new contents or matching credentials.
            (payload / '.env.example').write_text(token)
            checker = scan.Scanner(allow, '')
            checker.unpacked = []
            checker.content(io.BytesIO(token.encode()), '.env.example')
            self.assertEqual({row['kind'] for row in checker.findings}, {'Private runtime file', 'OpenAI key'})
            checker.content(io.BytesIO(token.encode()), 'placeholder.txt')
            self.assertTrue(any(row['file'] == 'placeholder.txt' for row in checker.findings), 'changed file bytes revoke a text exception')

    def test_invalid_archives_links_and_missing_unpacked_members_block(self):
        with tempfile.TemporaryDirectory(prefix='tris-release-invalid-') as directory:
            root = Path(directory)
            (root / 'broken.asar').write_bytes(b'not an archive')
            with tarfile.open(root / 'bad.tar', 'w') as archive:
                info = tarfile.TarInfo('link')
                info.type = tarfile.SYMTYPE
                info.linkname = '../outside'
                archive.addfile(info)
            with zipfile.ZipFile(root / 'bad.zip', 'w') as archive:
                archive.writestr('../outside.txt', 'private')
            with zipfile.ZipFile(root / 'links.zip', 'w') as archive:
                info = zipfile.ZipInfo('link')
                info.external_attr = 0o120777 << 16
                archive.writestr(info, 'outside')
            source = root / 'source'
            source.mkdir()
            (source / 'native.node').write_bytes(b'fixture')
            subprocess.run(['node', '-e', "require('@electron/asar').createPackageWithOptions(process.argv[1],process.argv[2],{unpack:'*.node'}).catch(e=>{console.error(e.message);process.exitCode=1})", str(source), str(root / 'unpacked.asar')], cwd=APP, check=True, capture_output=True)
            (root / 'unpacked.asar.unpacked/native.node').unlink()
            findings = scan.Scanner([], '').scan(root)
            self.assertTrue(any(row['file'] == 'broken.asar' and 'invalid' in row['kind'] for row in findings))
            self.assertTrue(any(row['file'] == 'bad.zip' and 'invalid' in row['kind'] for row in findings))
            self.assertTrue(any(row['file'] == 'bad.tar' and 'invalid' in row['kind'] for row in findings))
            self.assertTrue(any(row['file'] == 'links.zip/link' and 'Link' in row['kind'] for row in findings))
            self.assertTrue(any(row['file'] == 'unpacked.asar/native.node' and 'Missing' in row['kind'] for row in findings))
            junction = root / 'junction'
            subprocess.run(['node', '-e', "require('node:fs').symlinkSync(process.argv[1],process.argv[2],'junction')", str(source), str(junction)], check=True, capture_output=True)
            try:
                self.assertTrue(any(row['file'] == 'junction' and 'Link' in row['kind'] for row in scan.Scanner([], '').scan(root)))
                with self.assertRaises(ValueError):
                    scan.Scanner([], '').scan(junction)
            finally:
                junction.rmdir()


if __name__ == '__main__':
    unittest.main()
