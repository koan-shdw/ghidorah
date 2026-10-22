"""Profile configuration must control the executable and every lazy download."""
import json
import sys

import pytest

from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from tools import browser_tool as browser
from tools import browser_tool_install as install


def test_pinned_executable_is_profile_scoped_and_never_falls_back(tmp_path, monkeypatch):
    homes = [tmp_path / name for name in ('a', 'b')]
    pins = [sys.executable, str(tmp_path / 'missing.exe')]
    for home, pin in zip(homes, pins):
        home.mkdir()
        (home / 'config.yaml').write_text(json.dumps({'browser': {'agent_browser_path': pin}}))
    monkeypatch.setattr(browser, '_agent_browser_resolved', True)
    monkeypatch.setattr(browser, '_cached_agent_browser', browser.NPX_AGENT_BROWSER_SENTINEL)
    for index in (0, 1, 0):
        token = set_hermes_home_override(homes[index])
        try:
            for validate in (False, True):
                if index == 0:
                    assert install._find_agent_browser(validate=validate) == pins[index]
                else:
                    with pytest.raises(FileNotFoundError, match='configured agent-browser'):
                        install._find_agent_browser(validate=validate)
        finally:
            reset_hermes_home_override(token)


def test_disabled_lazy_installs_block_npx_and_cache_warming(tmp_path, monkeypatch):
    (tmp_path / 'config.yaml').write_text(json.dumps({'security': {'allow_lazy_installs': False}}))
    token = set_hermes_home_override(tmp_path)
    monkeypatch.setattr(install, '_agent_browser_candidates', lambda _: iter(()))
    # The policy must reject before resolving or launching npx, including a cached fallback.
    monkeypatch.setattr(install, '_resolve_npx_bin', lambda: pytest.fail('npx was resolved despite disabled installs'))
    try:
        for cached in (False, True):
            monkeypatch.setattr(browser, '_agent_browser_resolved', cached)
            monkeypatch.setattr(browser, '_cached_agent_browser', browser.NPX_AGENT_BROWSER_SENTINEL)
            with pytest.raises(FileNotFoundError):
                install._find_agent_browser()
        assert install.warm_agent_browser_npx_cache() is False
    finally:
        reset_hermes_home_override(token)
