"""Regression tests for long slash-command pastes split by Telegram clients.

Telegram splits messages above 4096 chars into multiple updates.  A long
``/queue <huge prompt>`` paste arrives as a COMMAND chunk near the limit plus
plain TEXT continuation chunk(s).  Before the fix, `_handle_command`
dispatched the command chunk immediately, orphaning the continuation — which
then landed as a separate plain message and interrupted the running agent.

Near-limit command chunks must route through the text-batching pipeline so
continuations merge in before dispatch; short commands stay immediate.
"""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from gateway.config import Platform, PlatformConfig


def _make_adapter():
    from plugins.platforms.telegram.adapter import TelegramAdapter

    adapter = object.__new__(TelegramAdapter)
    adapter.platform = Platform.TELEGRAM
    adapter.config = PlatformConfig(enabled=True, token="fake-token", extra={})
    adapter._bot = SimpleNamespace(id=999, username="test_bot")
    adapter._message_handler = AsyncMock()
    adapter._pending_text_batches = {}
    adapter._pending_text_batch_tasks = {}
    adapter._text_batch_delay_seconds = 0.01
    adapter._text_batch_split_delay_seconds = 0.05
    adapter._mention_patterns = adapter._compile_mention_patterns()
    adapter._forum_lock = asyncio.Lock()
    adapter._forum_command_registered = set()
    adapter._active_sessions = {}
    adapter._pending_messages = {}
    adapter.handle_message = AsyncMock()
    return adapter


def _make_message(text, *, chat_id=12345):
    return SimpleNamespace(
        message_id=42,
        text=text,
        caption=None,
        entities=[],
        caption_entities=[],
        message_thread_id=None,
        is_topic_message=False,
        chat=SimpleNamespace(id=chat_id, type="private", title=None, is_forum=False),
        from_user=SimpleNamespace(id=111, full_name="Test User", first_name="Test"),
        reply_to_message=None,
        date=None,
        location=None,
        photo=None,
        video=None,
        audio=None,
        voice=None,
        document=None,
        sticker=None,
        media_group_id=None,
    )


def _make_update(text):
    return SimpleNamespace(update_id=1, message=_make_message(text), effective_message=None)


@pytest.mark.asyncio
async def test_message_boundaries_keep_authentication_separate_from_task_text():
    adapter = _make_adapter()
    adapter.config.extra['preserve_message_boundaries'] = True
    adapter._is_user_authorized_from_message = lambda _: True
    try:
        await adapter._handle_text_message(_make_update('123456'), SimpleNamespace())
        await adapter._handle_text_message(_make_update('A different task'), SimpleNamespace())
        await adapter._handle_command(_make_update('/approve ' + 'x' * 4100), SimpleNamespace())
        assert [call.args[0].text for call in adapter.handle_message.await_args_list] == [
            '123456', 'A different task', '/approve ' + 'x' * 4100]
        assert not adapter._pending_text_batches
    finally:
        tasks = list(adapter._pending_text_batch_tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.asyncio
async def test_message_boundaries_reach_handler_while_another_event_is_waiting():
    from gateway.platforms.base import BasePlatformAdapter, SessionSource
    from gateway.platforms.event import MessageEvent

    adapter = _make_adapter()
    adapter.config.extra['preserve_message_boundaries'] = True
    adapter.handle_message = BasePlatformAdapter.handle_message.__get__(adapter)
    entered, release = asyncio.Event(), asyncio.Event()
    seen = []

    async def handler(event):
        seen.append((event.text, event.message_id, event.reply_to_message_id))
        if event.message_id == '1':
            entered.set()
            await release.wait()
        return None

    adapter._message_handler = handler
    source = SessionSource(platform=Platform.TELEGRAM, chat_id='4242', user_id='4242', chat_type='dm')
    first = asyncio.create_task(adapter.handle_message(MessageEvent(text='123456', source=source, message_id='1', reply_to_message_id='100')))
    try:
        await asyncio.wait_for(entered.wait(), timeout=1)
        await adapter.handle_message(MessageEvent(text='Next task', source=source, message_id='2'))
        assert seen == [('123456', '1', '100'), ('Next task', '2', None)]
        assert not adapter._pending_messages
    finally:
        release.set()
        await first


@pytest.mark.asyncio
async def test_short_command_dispatched_immediately():
    adapter = _make_adapter()

    await adapter._handle_command(_make_update("/stop"), SimpleNamespace())

    adapter.handle_message.assert_awaited_once()
    assert not adapter._pending_text_batches


@pytest.mark.asyncio
async def test_near_limit_command_is_batched_not_dispatched():
    adapter = _make_adapter()
    long_cmd = "/queue " + "x" * 4090  # near Telegram's 4096 split point

    await adapter._handle_command(_make_update(long_cmd), SimpleNamespace())

    # Must NOT dispatch immediately — a continuation chunk is almost certain.
    adapter.handle_message.assert_not_awaited()
    assert len(adapter._pending_text_batches) == 1


@pytest.mark.asyncio
async def test_split_queue_command_merges_with_continuation():
    adapter = _make_adapter()
    first = "/queue " + "x" * 4089  # 4096-char first chunk
    continuation = "y" * 500

    await adapter._handle_command(_make_update(first), SimpleNamespace())
    adapter.handle_message.assert_not_awaited()

    # Continuation arrives as a plain text update moments later.
    await adapter._handle_text_message(_make_update(continuation), SimpleNamespace())

    # Wait past the split-delay flush window.
    await asyncio.sleep(0.3)

    adapter.handle_message.assert_awaited_once()
    dispatched = adapter.handle_message.call_args[0][0]
    assert dispatched.text.startswith("/queue ")
    assert "y" * 500 in dispatched.text
    # One merged event — the continuation never dispatched on its own.
    assert not adapter._pending_text_batches
