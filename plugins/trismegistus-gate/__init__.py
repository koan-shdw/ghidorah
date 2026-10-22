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


def _owner_dm(source, owner):
    platform = getattr(getattr(source, 'platform', None), 'value', None)
    return (platform == 'telegram' and getattr(source, 'chat_type', None) == 'dm' and not getattr(source, 'is_bot', False)
            and str(getattr(source, 'user_id', '')) == owner and str(getattr(source, 'chat_id', '')) == owner)


async def gate(event=None, gateway=None, session_store=None, **_):
    try:
        settings = _settings()
        if not settings or not _owner_dm(event.source, settings['owner']):
            return {'action': 'skip', 'reason': 'not the owner'}
        text = (event.text or '').strip()
        if not text or len(text) > 8000:
            await _send({'chat_id': settings['owner'], 'text': 'Send a text message of up to 8,000 characters.'})
            return {'action': 'skip', 'reason': 'invalid text length'}
        command = text[1:].split(maxsplit=1)[0].split('@', 1)[0].lower() if text.startswith('/') and len(text) > 1 else ''
        if command and command not in ALLOWED:
            # /yolo, /update, /debug and every other command stay on the desktop.
            await _send({'chat_id': settings['owner'], 'text': 'That command is not available from Telegram.'})
            return {'action': 'skip', 'reason': 'refused command'}
        reply_to = getattr(event, 'reply_to_message_id', None)
        await asyncio.to_thread(_call, '/inbound', {'message_id': str(event.message_id), 'chat_id': settings['owner'],
                                                   'user_id': settings['owner'], 'text': text,
                                                   **({'reply_to_message_id': str(reply_to)} if reply_to else {})})
    except Exception as error:
        logger.warning('Ghidorah gate could not hand a message to the app: %s', type(error).__name__)
        try:
            await _send({'chat_id': _settings()['owner'], 'text': 'The app did not confirm receipt. Check /status before resending.'})
        except Exception:
            pass
    return {'action': 'skip', 'reason': 'handed to the app'}


async def _send(row):
    adapter = _adapter
    if adapter is None:
        return {'ok': False}
    if row.get('deny'):
        # The button includes the immutable outbox sequence, so a stale Deny cannot target a new approval.
        from telegram import ReplyKeyboardMarkup
        message = await adapter._bot.send_message(chat_id=int(row['chat_id']), text=row['text'],
                                        reply_markup=ReplyKeyboardMarkup([['Deny #' + str(row['seq'])]], resize_keyboard=True, one_time_keyboard=True))
        return {'ok': True, 'message_id': str(message.message_id)}
    result = await adapter.send(str(row['chat_id']), row['text'])
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
                # The app shows Remote as running once Telegram has actually connected.
                await asyncio.to_thread(_call, '/ready', {})
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
