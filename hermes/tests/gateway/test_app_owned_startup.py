"""An app-owned Telegram transport cannot start independent agent work."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest


def test_app_owned_gateway_does_not_start_schedulers(monkeypatch):
    import gateway.run as run
    import cron.scheduler_provider as providers
    import cron.scheduler_thread as threads

    monkeypatch.setattr('gateway.run_inbound.APP_OWNED_INBOUND', True)
    provider = MagicMock()
    resolve = MagicMock(return_value=provider)
    monkeypatch.setattr(providers, 'resolve_cron_scheduler', resolve)
    monkeypatch.setattr(run, '_cron_tick_profile_homes', lambda config: [])
    monkeypatch.setattr(run.asyncio, 'get_running_loop', lambda: None)
    ticker, housekeeper = MagicMock(), MagicMock()
    monkeypatch.setattr(threads, 'SupervisedTickerThread', ticker)
    monkeypatch.setattr(run.threading, 'Thread', housekeeper)
    stop, scheduler, cron_thread, housekeeping_thread = run._start_gateway_start_cron_and_housekeeping(
        SimpleNamespace(config=None, adapters={}))
    try:
        resolve.assert_not_called()
        ticker.assert_not_called()
        housekeeper.assert_not_called()
        assert scheduler is cron_thread is housekeeping_thread is None
    finally:
        stop.set()


@pytest.mark.parametrize('app_owned', [False, True])
def test_app_owned_gateway_keeps_reconnection_without_agent_watchers(monkeypatch, app_owned):
    from gateway.run_startup import GatewayStartupMixin

    monkeypatch.setattr('gateway.run_inbound.APP_OWNED_INBOUND', app_owned)
    runner = MagicMock()
    runner._PRE_RECONNECT_WATCHERS = GatewayStartupMixin._PRE_RECONNECT_WATCHERS
    runner._POST_RECONNECT_WATCHERS = GatewayStartupMixin._POST_RECONNECT_WATCHERS
    runner._failed_platforms = {}
    runner._scale_to_zero_should_arm.return_value = False
    GatewayStartupMixin._start_spawn_background_watchers(runner)
    runner._spawn_reconnect_watcher.assert_called_once()
    spawned = [call.args[1] for call in runner._spawn_supervised.call_args_list]
    assert ('kanban_dispatcher_watcher' in spawned) is (not app_owned)
    assert ('handoff_watcher' in spawned) is (not app_owned)
    if app_owned:
        assert spawned == []


@pytest.mark.asyncio
async def test_app_owned_startup_releases_messages_without_agent_services(monkeypatch):
    from gateway.run_startup import GatewayStartupMixin
    from gateway.run import _discover_gateway_mcp_tools

    monkeypatch.setattr('gateway.run_inbound.APP_OWNED_INBOUND', True)
    runner = MagicMock()
    runner._run_boot_probe_in_launch_scope = AsyncMock()
    runner._start_post_connect_services = AsyncMock()
    runner._finish_startup_restore = AsyncMock()
    runner._recover_unclean_sessions = AsyncMock()
    runner._recover_secondary_process_checkpoints.return_value = 0
    runner._suspend_stuck_loop_sessions.return_value = 0
    GatewayStartupMixin._start_startup_warmup(runner)
    await GatewayStartupMixin._run_free_tier_bootstrap(runner)
    await GatewayStartupMixin._start_recover_previous_run(runner)
    await GatewayStartupMixin._start_finish_wiring(runner, 1)
    discover = MagicMock(side_effect=AssertionError('MCP must remain owned by the app'))
    monkeypatch.setattr('tools.mcp_tool_discovery.discover_mcp_tools', discover)
    await _discover_gateway_mcp_tools(SimpleNamespace(multiplex_profiles=False))
    assert runner._startup_warmup_task is None
    runner._run_boot_probe_in_launch_scope.assert_not_awaited()
    runner._recover_unclean_sessions.assert_not_awaited()
    runner._start_post_connect_services.assert_not_awaited()
    runner._finish_startup_restore.assert_awaited_once()
    runner._start_loop_heartbeat_task.assert_called_once()
    discover.assert_not_called()
