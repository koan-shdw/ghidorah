import asyncio
from unittest.mock import patch

import pytest

from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
from hermes_cli.plugins_host import get_host_tool_dispatcher, plugin_tool_dispatcher


def test_host_dispatch_is_activity_scoped_and_never_falls_through_after_denial():
    context = PluginContext(PluginManifest(name='fixture', source='user'), PluginManager())
    seen = []

    async def activity(owner):
        def dispatch(ctx, name, args, kwargs):
            assert ctx is context
            seen.append((owner, name, args, kwargs))
            return owner
        with plugin_tool_dispatcher(dispatch):
            await asyncio.sleep(0)
            assert context.dispatch_tool('write_file', {'path': owner}, task_id=owner) == owner
            with plugin_tool_dispatcher(lambda *_: (_ for _ in ()).throw(PermissionError('denied'))):
                with pytest.raises(PermissionError, match='denied'):
                    context.dispatch_tool('write_file', {})
            assert context.dispatch_tool('read_file', {}) == owner

    async def both():
        await asyncio.gather(activity('A'), activity('B'))
    with patch('tools.registry.registry.dispatch') as raw:
        asyncio.run(both())
        raw.assert_not_called()
        assert get_host_tool_dispatcher() is None
        context.dispatch_tool('read_file', {})
        raw.assert_called_once()
    assert sorted(row[0] for row in seen) == ['A', 'A', 'B', 'B']
