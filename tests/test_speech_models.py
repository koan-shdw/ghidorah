"""Speech models (R4): files are taken only when their size and hash match the pinned record."""
import hashlib
from pathlib import Path
import sys
import io
import subprocess
import pytest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'backend'))


def test_pinned_records_and_checks(tmp_path, monkeypatch):
    import speech_models
    assert set(speech_models.MODELS) == {'tiny', 'small', 'large-v3'}
    assert speech_models.MODELS['large-v3']['revision'] == 'edaa852ec7e145841d8ffdb056a99866b5f0a478'
    for model in speech_models.MODELS.values():
        assert all(('sha256' in spec) != ('git' in spec) for spec in model['files'].values())
    content = b'{"fixture": true}'
    blob = hashlib.sha1(b'blob %d\0' % len(content) + content).hexdigest()
    monkeypatch.setitem(speech_models.MODELS, 'fixture', {'repository': 'x/y', 'revision': 'r1', 'files': {
        'config.json': {'size': len(content), 'git': blob},
        'model.bin': {'size': 3, 'sha256': hashlib.sha256(b'abc').hexdigest()}}})
    folder = speech_models.directory(tmp_path, 'fixture')
    folder.mkdir(parents=True)
    (folder / 'config.json').write_bytes(content)
    (folder / 'model.bin').write_bytes(b'abd')
    try:
        speech_models.verified(tmp_path, 'fixture')
        raise AssertionError('a changed file was accepted')
    except ValueError:
        pass
    (folder / 'model.bin').write_bytes(b'abc')
    assert speech_models.verified(tmp_path, 'fixture') == folder
    with pytest.raises(ValueError):
        speech_models.verified(tmp_path, 'nonexistent')


def test_download_is_bounded_and_preserves_existing_files_on_bad_hash(tmp_path, monkeypatch):
    import speech_models as models
    monkeypatch.setitem(models.MODELS, 'fixture-download', {'repository':'fixture/model', 'revision':'r1',
                        'files':{'model.bin':{'size':3,'sha256':hashlib.sha256(b'abc').hexdigest()}}})
    folder=models.directory(tmp_path,'fixture-download');folder.mkdir(parents=True)
    target=folder/'model.bin';target.write_bytes(b'old')
    for body in (b'abd', b'abcTOO-LONG'):
        monkeypatch.setattr(models.urllib.request,'urlopen',lambda *a,**kw:io.BytesIO(body))
        with pytest.raises(ValueError, match='hash|size'):
            models.install(tmp_path,'fixture-download')
        assert target.read_bytes()==b'old'
        assert not list(folder.glob('*.part'))
    monkeypatch.setattr(models.urllib.request,'urlopen',lambda *a,**kw:io.BytesIO(b'abc'))
    assert Path(models.install(tmp_path,'fixture-download'))==folder
    assert target.read_bytes()==b'abc'
    assert not (folder.parent/'progress.json').exists()


def test_progress_reader_cannot_abort_download(tmp_path, monkeypatch):
    import speech_models as models
    monkeypatch.setitem(models.MODELS, 'progress-fixture', {'repository':'fixture/model', 'revision':'r1',
                        'files':{'model.bin':{'size':3,'sha256':hashlib.sha256(b'abc').hexdigest()}}})
    folder=models.directory(tmp_path,'progress-fixture');folder.mkdir(parents=True)
    progress=folder.parent/'progress.json';progress.write_text('{"done":0,"total":3}')
    replace,unlink=Path.replace,Path.unlink
    def replace_with_reader(source, target):
        if Path(target)==progress:
            raise PermissionError('Windows reader holds progress open')
        return replace(source,target)
    def unlink_with_reader(source, *args, **kwargs):
        if source==progress:
            raise PermissionError('Windows reader holds progress open')
        return unlink(source,*args,**kwargs)
    monkeypatch.setattr(Path,'replace',replace_with_reader)
    monkeypatch.setattr(Path,'unlink',unlink_with_reader)
    monkeypatch.setattr(models.urllib.request,'urlopen',lambda *a,**kw:io.BytesIO(b'abc'))
    assert Path(models.install(tmp_path,'progress-fixture'))==folder
    assert (folder/'model.bin').read_bytes()==b'abc'
    assert {f.name for f in folder.parent.iterdir()}=={'r1','progress.json'}


def test_model_folder_junction_cannot_redirect_download(tmp_path, monkeypatch):
    import speech_models as models
    outside=tmp_path/'outside';outside.mkdir()
    root=tmp_path/'profile';root.mkdir()
    link=root/'models'
    subprocess.run(['powershell','-NoProfile','-Command',
                    '& { New-Item -ItemType Junction -Path $args[0] -Target $args[1] | Out-Null }',
                    str(link),str(outside)],check=True,capture_output=True,
                   creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    try:
        with pytest.raises(ValueError,match='links'):
            models.install(root,'tiny')
        assert list(outside.iterdir())==[]
    finally:
        link.rmdir()
