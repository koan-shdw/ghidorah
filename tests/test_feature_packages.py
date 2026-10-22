from pathlib import Path
import hashlib
import json
import sys
import zipfile

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import feature_packages


def wheel(root, name, requires=''):
    file=root/(name+'-1.0-py3-none-any.whl')
    info=name+'-1.0.dist-info/'
    with zipfile.ZipFile(file,'w') as archive:
        files={name+'/__init__.py':'value=1\n',info+'METADATA':'Metadata-Version: 2.1\nName: '+name+'\nVersion: 1.0\n'+requires,
               info+'WHEEL':'Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n'}
        files[info+'RECORD']='\n'.join(name+',,' for name in [*files,info+'RECORD'])+'\n'
        for name,text in files.items():archive.writestr(name,text)
    return dict(version='1.0',url=file.as_uri(),sha256=hashlib.sha256(file.read_bytes()).hexdigest())


def test_pip_checks_pinned_wheel_bytes_and_keeps_failed_target_inactive(tmp_path, monkeypatch):
    row=wheel(tmp_path,'featurefixture');record=dict(features={'fixture':['featurefixture']},packages={'featurefixture':row})
    lock=tmp_path/'lock.json';monkeypatch.setattr(feature_packages,'LOCK',lock)
    target=tmp_path/'runtime-failed';target.mkdir();(target/'kept.txt').write_text('old')
    row['sha256']='0'*64;lock.write_text(json.dumps(record))
    with pytest.raises(ValueError,match='HASHES|hashes'):
        feature_packages.install(target,['featurefixture==1.0'],['fixture'])
    assert (target/'kept.txt').read_text()=='old'
    assert not (target/'featurefixture').exists()
    row['sha256']=hashlib.sha256((tmp_path/'featurefixture-1.0-py3-none-any.whl').read_bytes()).hexdigest();lock.write_text(json.dumps(record))
    target=tmp_path/'runtime-good';target.mkdir()
    feature_packages.install(target,['featurefixture==1.0'],['fixture'])
    assert (target/'featurefixture/__init__.py').read_text()=='value=1\n'
    assert not list(target.rglob('*.pyc'))
    receipt=json.loads((target/'install-receipt.json').read_text())
    assert receipt['install'][0]['download_info']['archive_info']['hashes']['sha256']==row['sha256']


def test_conflicts_and_unreviewed_install_arguments_are_refused(tmp_path, monkeypatch):
    a=wheel(tmp_path,'featurefixture');b=wheel(tmp_path,'dependentfixture','Requires-Dist: featurefixture>=2\n')
    lock=tmp_path/'lock.json';lock.write_text(json.dumps(dict(features={'fixture':['featurefixture','dependentfixture']},packages={'featurefixture':a,'dependentfixture':b})))
    monkeypatch.setattr(feature_packages,'LOCK',lock)
    target=tmp_path/'runtime-conflict';target.mkdir()
    with pytest.raises(ValueError,match='ResolutionImpossible|conflicting dependencies'):
        feature_packages.install(target,[],['fixture'])
    assert not (target/'dependentfixture').exists()
    for spec in ('--index-url=https://example.invalid','sample @ https://example.invalid/a.whl','../sample'):
        with pytest.raises(ValueError,match='named Python'):
            feature_packages.install(target,[spec],['fixture'])
