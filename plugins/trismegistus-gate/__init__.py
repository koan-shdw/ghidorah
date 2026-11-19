"""Ghidorah gate (6a, 6b; SPEC 5.21 H6, 5.22): the app's Telegram front door.

It runs only inside the app's own gateway process. The owner's direct messages are handed to the app over the
private loopback channel; everything else is dropped. The fork's APP_OWNED_INBOUND switch then drops every event
after this hook, so this process never starts a model or a tool, whatever happens here. Replies, approvals and
notices come back from the app and go out through the gateway's own Telegram adapter.
"""
import asyncio
import json
import logging
import urllib.request

logger = logging.getLogger(__name__)
ALLOWED = {'start', 'help', 'whoami', 'new', 'stop', 'status', 'approve', 'deny', 'pause', 'project'}
_adapter = None
_delivery = None


def _settings():
    # Set in memory by backend/host.py's gateway operation: the loopback address, its per-spawn token, the owner.
    import gate_channel
    return gate_channel.settings()


def _call(path, payload=None, timeout=10):
    settings = _settings()
    request = urllib.request.Request(
        settings['url'] + path, method='POST' if payload is not None else 'GET',
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'Authorization': 'Bearer ' + settings['token'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read() or b'null')


def _topic(source):
    thread = str(getattr(source, 'thread_id', None) or '')
    return thread if thread.isdigit() and len(thread) <= 20 else None


def _keys(rows):
    """Buttons under a message: a link, or a press that comes back to the app as `data`. A colour goes in as the
    Bot API's `style` field, which this python-telegram-bot does not know by name."""
    if not rows:
        return None
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    return InlineKeyboardMarkup([[InlineKeyboardButton(
        str(key['text'])[:64], **({'url': key['url']} if key.get('url') else {'callback_data': str(key.get('data', ''))[:64]}),
        **({'api_kwargs': {'style': key['style']}} if key.get('style') in ('danger', 'success', 'primary') else {}))
        for key in row] for row in rows])


def _owner_dm(source, owner):
    platform = getattr(getattr(source, 'platform', None), 'value', None)
    return (platform == 'telegram' and getattr(source, 'chat_type', None) == 'dm' and not getattr(source, 'is_bot', False)
            and str(getattr(source, 'user_id', '')) == owner and str(getattr(source, 'chat_id', '')) == owner)


async def gate(event=None, gateway=None, session_store=None, **_):
    try:
        settings = _settings()
        if not settings or not _owner_dm(event.source, settings['owner']):
            return {'action': 'skip', 'reason': 'not the owner'}
        # A topic of the owner's bot chat: one per app chat. Answers go back into the same topic.
        topic = _topic(event.source)
        text = (event.text or '').strip()
        if not text or len(text) > 8000:
            await _send({'chat_id': settings['owner'], 'text': 'Send a text message of up to 8,000 characters.', 'thread_id': topic})
            return {'action': 'skip', 'reason': 'invalid text length'}
        command = text[1:].split(maxsplit=1)[0].split('@', 1)[0].lower() if text.startswith('/') and len(text) > 1 else ''
        if command and command not in ALLOWED:
            # /yolo, /update, /debug and every other command stay on the desktop.
            await _send({'chat_id': settings['owner'], 'text': 'That command is not available from Telegram.', 'thread_id': topic})
            return {'action': 'skip', 'reason': 'refused command'}
        reply_to = getattr(event, 'reply_to_message_id', None)
        await asyncio.to_thread(_call, '/inbound', {'message_id': str(event.message_id), 'chat_id': settings['owner'],
                                                   'user_id': settings['owner'], 'text': text,
                                                   **({'reply_to_message_id': str(reply_to)} if reply_to else {}),
                                                   **({'thread_id': topic} if topic else {})})
    except Exception as error:
        logger.warning('Ghidorah gate could not hand a message to the app: %s', type(error).__name__)
        try:
            await _send({'chat_id': _settings()['owner'], 'text': 'The app did not confirm receipt. Check /status before resending.'})
        except Exception:
            pass
    return {'action': 'skip', 'reason': 'handed to the app'}


def _gone(error):
    # Telegram's answer when a thread was deleted, or the bot's chat was cleared: nothing was sent.
    text = str(error).lower()
    return 'thread not found' in text or 'topic_id_invalid' in text or 'topic not found' in text or 'topic_deleted' in text


async def _send(row):
    """One row to Telegram. A refusal that asks to wait is waited out and tried again: nothing was sent, so a
    second try cannot double anything. A thread that no longer exists is reported as gone."""
    for attempt in range(3):
        try:
            return await _send_once(row)
        except Exception as error:
            wait = getattr(error, 'retry_after', None)
            if wait is not None and attempt < 2:
                seconds = wait.total_seconds() if hasattr(wait, 'total_seconds') else float(wait)
                await asyncio.sleep(min(max(seconds, 1), 60))
                continue
            if _gone(error):
                return {'ok': False, 'gone': True}
            raise
    return {'ok': False}


async def _send_once(row):
    adapter = _adapter
    if adapter is None:
        return {'ok': False}
    thread = row.get('thread_id')
    if row.get('op') == 'topic':
        # A new app chat: its topic in the owner's bot chat. The receipt carries the topic's id.
        topic = await adapter._bot.create_forum_topic(chat_id=int(row['chat_id']), name=row['text'])
        return {'ok': True, 'message_id': str(topic.message_thread_id)}
    if row.get('op') == 'rename':
        await adapter._bot.edit_forum_topic(chat_id=int(row['chat_id']), message_thread_id=int(thread), name=row['text'])
        return {'ok': True}
    if row.get('op') == 'delete':
        # The chat was deleted or archived in the app: its thread goes, with its messages.
        await adapter._bot.delete_forum_topic(chat_id=int(row['chat_id']), message_thread_id=int(thread))
        return {'ok': True}
    if row.get('op') == 'react':
        # The mark on his own message: the app has it, it is answered, it failed. No text takes the mark away.
        await adapter._bot.set_message_reaction(chat_id=int(row['chat_id']), message_id=int(row['message_id']), reaction=row['text'] or None)
        return {'ok': True}
    if row.get('keys'):
        # A message with buttons under it. Without `notify` it arrives without sound, as the adapter's own sends do.
        message = await adapter._bot.send_message(chat_id=int(row['chat_id']), text=row['text'], reply_markup=_keys(row.get('keys')),
                                                  disable_notification=not row.get('notify'),
                                                  **({'message_thread_id': int(thread)} if thread else {}))
        return {'ok': True, 'message_id': str(message.message_id)}
    if row.get('deny'):
        # The button includes the immutable outbox sequence, so a stale Deny cannot target a new approval.
        from telegram import ReplyKeyboardMarkup
        message = await adapter._bot.send_message(chat_id=int(row['chat_id']), text=row['text'],
                                        reply_markup=ReplyKeyboardMarkup([['Deny #' + str(row['seq'])]], resize_keyboard=True, one_time_keyboard=True),
                                        **({'message_thread_id': int(thread)} if thread else {}))
        return {'ok': True, 'message_id': str(message.message_id)}
    # The adapter sends without sound unless `notify` is set (its "important" mode, the default).
    metadata = {**({'thread_id': str(thread)} if thread else {}), **({'notify': True} if row.get('notify') else {})}
    result = await adapter.send(str(row['chat_id']), row['text'], None, metadata) if metadata else await adapter.send(str(row['chat_id']), row['text'])
    if not getattr(result, 'success', False) and thread and _gone(getattr(result, 'error', '') or ''):
        return {'ok': False, 'gone': True}
    return {'ok': bool(getattr(result, 'success', False)),
            **({'message_id': str(result.message_id)} if getattr(result, 'message_id', None) else {})}


async def _deliver():
    reported, after = None, 0
    while True:
        adapter = _adapter
        if adapter is None or not adapter.is_connected:
            await asyncio.sleep(0.5)
            continue
        try:
            if reported is not adapter:
                # The app shows Remote as running once Telegram has actually connected. The bot's own name goes
                # with it, for links to a thread.
                name = getattr(getattr(adapter, '_bot', None), 'username', None)
                await asyncio.to_thread(_call, '/ready', {'username': name} if isinstance(name, str) and name else {})
                reported = adapter
            rows = await asyncio.to_thread(_call, '/outbox?after=' + str(after), None, 35)
        except Exception:
            await asyncio.sleep(2)
            continue
        for row in rows or []:
            try:
                sent = await _send(row)
            except Exception:
                sent = {'ok': False}
            # Retry only the receipt. Sending again after a lost acknowledgement could duplicate an action prompt.
            while True:
                try:
                    await asyncio.to_thread(_call, '/sent', {'seq': row['seq'], **sent})
                    break
                except Exception:
                    await asyncio.sleep(2)
            after = max(after, int(row['seq']))


def attach(native, adapter):
    """Runs inside the Telegram adapter's connect(), on the gateway loop; a reconnect runs it again."""
    global _adapter, _delivery
    _adapter = adapter
    if _delivery is None or _delivery.done():
        _delivery = asyncio.get_running_loop().create_task(_deliver())


def register(ctx):
    ctx.register_hook('pre_gateway_dispatch', gate)
    ctx.register_platform_handler('telegram', attach)
