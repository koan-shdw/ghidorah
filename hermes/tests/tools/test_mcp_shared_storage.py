"""Embedding-host credential ownership; ordinary profile isolation stays intact."""
import asyncio
import pytest
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from tools import mcp_oauth
from tools.mcp_oauth_provider import prepare_oauth_config
from tools.mcp_oauth_manager import get_manager, reset_manager_for_tests


@pytest.fixture(autouse=True)
def isolated_owner(monkeypatch):
    monkeypatch.setattr(mcp_oauth, '_token_storage_root', None)
    reset_manager_for_tests()
    yield
    reset_manager_for_tests()


def test_owner_opt_in_uses_one_factory_path_without_changing_profile_scope(tmp_path):
    profiles = [tmp_path / 'profiles' / name for name in ('a', 'b')]
    paths = []
    for profile in profiles:
        token = set_hermes_home_override(profile)
        try:
            paths.append(prepare_oauth_config('connection', 'https://example.test/mcp', {})[1]._tokens_path())
        finally:
            reset_hermes_home_override(token)
    assert paths[0] != paths[1]
    mcp_oauth.configure_token_storage_root(tmp_path)
    from hermes_constants import get_hermes_home
    for profile in [*profiles, profiles[0]]:
        token = set_hermes_home_override(profile)
        try:
            storage = prepare_oauth_config('connection', 'https://example.test/mcp', {})[1]
            assert storage._tokens_path() == tmp_path / 'mcp-tokens' / 'connection.json'
            assert get_hermes_home() == profile
            assert get_manager()._key('connection')[0] == str(tmp_path.resolve())
        finally:
            reset_hermes_home_override(token)


@pytest.mark.asyncio
async def test_revocation_waits_for_refresh_and_removes_its_replacement(tmp_path):
    from mcp.shared.auth import OAuthToken
    mcp_oauth.configure_token_storage_root(tmp_path)
    storage = mcp_oauth.HermesTokenStorage('connection')
    await storage.set_tokens(OAuthToken(access_token='synthetic-old', token_type='Bearer'))
    fence = await mcp_oauth.acquire_refresh_fence(storage._tokens_path())
    revoke = asyncio.create_task(storage.revoke())
    await asyncio.sleep(0)
    try:
        assert not revoke.done()
        await storage.set_tokens(OAuthToken(access_token='synthetic-replacement', token_type='Bearer'))
    finally:
        mcp_oauth.release_refresh_fence(fence)
    await asyncio.wait_for(revoke, 5)
    assert await storage.get_tokens() is None
    assert mcp_oauth._refresh_lock_path(storage._tokens_path()).exists()


@pytest.mark.asyncio
async def test_removed_grant_invalidates_live_provider_before_another_request(tmp_path):
    from mcp.shared.auth import OAuthToken, OAuthClientInformationFull, OAuthMetadata
    mcp_oauth.configure_token_storage_root(tmp_path)
    storage = mcp_oauth.HermesTokenStorage('connection')
    await storage.set_tokens(OAuthToken(access_token='synthetic-old', refresh_token='synthetic-refresh', token_type='Bearer', expires_in=3600))
    await storage.set_client_info(OAuthClientInformationFull(client_id='synthetic-client', redirect_uris=['http://127.0.0.1:12345/callback']))
    storage.save_oauth_metadata(OAuthMetadata(issuer='https://example.test', authorization_endpoint='https://example.test/authorize', token_endpoint='https://example.test/token'))
    manager = get_manager()
    provider = manager.get_or_build_provider('connection', 'https://example.test/mcp', {'cimd': False})
    await provider._initialize()
    await manager.invalidate_if_disk_changed('connection')
    await storage.revoke()
    assert await manager.invalidate_if_disk_changed('connection')
    assert provider.context.current_tokens is None
    assert provider._initialized is False
    await provider._initialize()
    assert provider.context.current_tokens is None


@pytest.mark.asyncio
async def test_revocation_between_cache_check_and_refresh_cannot_recreate_grant(tmp_path):
    from mcp.shared.auth import OAuthToken, OAuthClientInformationFull, OAuthMetadata
    mcp_oauth.configure_token_storage_root(tmp_path)
    storage = mcp_oauth.HermesTokenStorage('connection')
    await storage.set_tokens(OAuthToken(access_token='synthetic-expired', refresh_token='synthetic-refresh', token_type='Bearer', expires_in=0))
    await storage.set_client_info(OAuthClientInformationFull(client_id='synthetic-client', redirect_uris=['http://127.0.0.1:12345/callback']))
    storage.save_oauth_metadata(OAuthMetadata(issuer='https://example.test', authorization_endpoint='https://example.test/authorize', token_endpoint='https://example.test/token'))
    provider = get_manager().get_or_build_provider('connection', 'https://example.test/mcp', {'cimd': False})
    await provider._initialize()
    assert provider.context.current_tokens.refresh_token == 'synthetic-refresh'
    await storage.revoke()
    with pytest.raises(mcp_oauth.OAuthNonInteractiveError, match='removed'):
        await provider._refresh_token()
    assert provider.context.current_tokens is None
    assert provider._hermes_fence is None
    assert not storage._tokens_path().exists()
