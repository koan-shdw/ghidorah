import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import chat_export


class ChatExport(unittest.TestCase):
    def test_portable_archive_and_link_boundary(self):
        with tempfile.TemporaryDirectory(prefix='tris-export-') as temp:
            root = Path(temp).resolve()
            staging = root / 'exports' / str(uuid4())
            (staging / 'files').mkdir(parents=True)
            (staging / 'conversation.html').write_text('<h1>Conversation</h1>', encoding='utf-8')
            payload = bytes(range(256))
            (staging / 'files' / '日本語.png').write_bytes(payload)
            with patch.dict(os.environ, HERMES_HOME=str(root / 'hermes')):
                result = chat_export.package(str(staging))
                with zipfile.ZipFile(result['file']) as archive:
                    self.assertEqual(set(archive.namelist()), {'conversation.html', 'files/日本語.png'})
                    self.assertEqual(archive.read('files/日本語.png'), payload)
                with self.assertRaises(FileExistsError):
                    chat_export.package(str(staging))
                with self.assertRaisesRegex(ValueError, 'Invalid export'):
                    chat_export.package(str(root))
                # A Windows junction can be created without symlink privileges.
                outside = root / 'outside'
                outside.mkdir()
                link = staging / 'linked'
                if os.name == 'nt':
                    import subprocess
                    subprocess.run(['powershell', '-NoProfile', '-Command',
                                    'New-Item -ItemType Junction -Path $env:TRIS_EXPORT_LINK -Target $env:TRIS_EXPORT_TARGET | Out-Null'],
                                   env={**os.environ, 'TRIS_EXPORT_LINK': str(link), 'TRIS_EXPORT_TARGET': str(outside)},
                                   check=True, capture_output=True, creationflags=0x08000000)
                else:
                    link.symlink_to(outside, target_is_directory=True)
                try:
                    with self.assertRaisesRegex(ValueError, 'must not contain links'):
                        chat_export.package(str(staging))
                finally:
                    if os.name == 'nt':
                        link.rmdir()
                    else:
                        link.unlink()


if __name__ == '__main__':
    unittest.main()
