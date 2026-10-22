import hashlib
import io
from pathlib import Path
import sys
import tarfile
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import wake_model


def test_exact_archive_members_hashes_repair_and_failed_replacement(tmp_path):
    files = {'encoder.onnx': b'fixture weights', 'tokens.txt': b'fixture tokens'}
    payload = io.BytesIO()
    with tarfile.open(fileobj=payload, mode='w:bz2') as archive:
        for name, contents in files.items():
            member = tarfile.TarInfo('model/' + name)
            member.size = len(contents)
            archive.addfile(member, io.BytesIO(contents))
    data = payload.getvalue()
    spec = dict(folder='model', url='https://example.invalid/fixture', size=len(data),
                sha256=hashlib.sha256(data).hexdigest(),
                files={name:dict(size=len(contents), sha256=hashlib.sha256(contents).hexdigest())
                       for name, contents in files.items()})
    with patch.object(wake_model, 'MODEL', spec), patch.object(wake_model.urllib.request, 'urlopen', side_effect=lambda *a, **k: io.BytesIO(data)) as download:
        folder = Path(wake_model.install(tmp_path))
        assert wake_model.verified(tmp_path) == folder
        wake_model.install(tmp_path)
        assert download.call_count == 1
        (folder / 'encoder-unlisted.onnx').write_bytes(b'unknown')
        with pytest.raises(ValueError, match='changed'):
            wake_model.verified(tmp_path)
        assert Path(wake_model.install(tmp_path)) == folder
        backups = list(folder.parent.glob('.previous-*'))
        assert len(backups) == 1 and (backups[0] / 'encoder-unlisted.onnx').read_bytes() == b'unknown'
        (folder / 'tokens.txt').write_bytes(b'changed')
        with pytest.raises(ValueError, match='changed'):
            wake_model.verified(tmp_path)
        for bad in (b'bad archive', data + b'extra'):
            with patch.object(wake_model.urllib.request, 'urlopen', return_value=io.BytesIO(bad)), pytest.raises(ValueError, match='pinned hash|pinned size'):
                wake_model.install(tmp_path)
            assert (folder / 'tokens.txt').read_bytes() == b'changed'
