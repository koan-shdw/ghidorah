from pathlib import Path
import sys

import pytest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'backend'))
from plugin_packages import describe_plugin, review_repository


def test_review_reads_manifests_without_running_code_and_reports_prerequisites(tmp_path):
    (tmp_path / 'plugin.yaml').write_text('name: example\nversion: 1\nrequires_env: [EXAMPLE_TOKEN]\n', encoding='utf8')
    (tmp_path / '__init__.py').write_text('raise RuntimeError("must never import at review")', encoding='utf8')
    (tmp_path / 'setup.py').write_text('raise RuntimeError("must never install at review")', encoding='utf8')
    review = describe_plugin(tmp_path, 'owner/repo', 'a' * 40)
    assert review['name'] == 'example'
    assert any(item.get('env') == 'EXAMPLE_TOKEN' for item in review['setup']['fields'])
    assert any('setup.py' in item for item in review['prerequisites'])
    (tmp_path / 'plugin.yaml').write_text('name: trismegistus-permissions\n', encoding='utf8')
    with pytest.raises(ValueError, match='reserved'):
        describe_plugin(tmp_path, 'owner/repo', 'a' * 40)


def test_repository_and_submodule_validation(tmp_path):
    for repository, commit in [('https://evil.test/repo', ''), ('owner/repo', 'main'), ('owner/repo; run', '')]:
        with pytest.raises(ValueError):
            review_repository(tmp_path, repository, commit)
    (tmp_path / '.gitmodules').write_text('[submodule "other"]', encoding='utf8')
    with pytest.raises(ValueError, match='submodules'):
        describe_plugin(tmp_path, 'owner/repo', 'a' * 40)
