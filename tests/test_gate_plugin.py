"""The Remote gate plugin (6b): only the owner's direct messages reach the app; refused commands stay on Telegram;
a lost app drops the message. The gateway itself drops every event after this hook (fork, APP_OWNED_INBOUND)."""
import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'backend'))
TOKEN = 'a' * 64


def load_gate():
    spec = importlib.util.spec_from_file_location('trismegistus_gate_under_test', APP / 'plugins' / 'trismegistus-gate' / '__init__.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def app_server():
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers['Content-Length'] or 0))
            seen.append((self.path, self.headers['Authorization'], json.loads(body or b'null')))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"ok":true}')

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, seen


def event(user, text, chat_type='dm', chat=None):
    source = SimpleNamespace(platform=SimpleNamespace(value='telegram'), chat_type=chat_type, user_id=user,
                             chat_id=chat if chat is not None else user, is_bot=False)
    return SimpleNamespace(source=source, text=text, message_id=77)


def test_only_the_owners_direct_messages_reach_the_app():
    import gate_channel
    gate = load_gate()
    server, seen = app_server()
    try:
        gate_channel.configure('http://127.0.0.1:%d/' % server.server_address[1], TOKEN, '4242')
        assert asyncio.run(gate.gate(event=event('99', 'hello')))['action'] == 'skip'
        assert asyncio.run(gate.gate(event=event('4242', 'hello', 'group', '-100')))['action'] == 'skip'
        assert seen == []
        assert asyncio.run(gate.gate(event=event('4242', ' fix the build ')))['action'] == 'skip'
        assert seen == [('/inbound', 'Bearer ' + TOKEN, {'message_id': '77', 'chat_id': '4242', 'user_id': '4242', 'text': 'fix the build'})]
        for command in ('/start', '/start@SHDWbot connection-proof'):
            asyncio.run(gate.gate(event=event('4242', command)))
            assert seen[-1][2]['text'] == command
        asyncio.run(gate.gate(event=event('99', '/start connection-proof')))
        assert len(seen) == 3
    finally:
        server.shutdown()
        server.server_close()


def test_refused_commands_never_reach_the_app_and_a_lost_app_drops_the_message():
    import gate_channel
    gate = load_gate()
    server, seen = app_server()
    sent = []

    async def send(chat_id, text, reply_to=None, metadata=None):
        sent.append((chat_id, text))
        return SimpleNamespace(success=True)

    gate._adapter = SimpleNamespace(send=send)
    try:
        gate_channel.configure('http://127.0.0.1:%d/' % server.server_address[1], TOKEN, '4242')
        for command in ('/yolo', '/update', '/debug now', '/model gpt'):
            assert asyncio.run(gate.gate(event=event('4242', command)))['action'] == 'skip'
        assert seen == []
        assert sent == [('4242', 'That command is not available from Telegram.')] * 4
        asyncio.run(gate.gate(event=event('4242', '/project 2')))
        assert seen[-1][2]['text'] == '/project 2'
    finally:
        server.shutdown()
        server.server_close()
    # The app is gone: never claim acceptance; tell the owner to inspect status before resending.
    gate_channel.configure('http://127.0.0.1:%d/' % server.server_address[1], TOKEN, '4242')
    assert asyncio.run(gate.gate(event=event('4242', 'still there?')))['action'] == 'skip'
    assert sent[-1] == ('4242', 'The app did not confirm receipt. Check /status before resending.')


def test_reply_identity_survives_the_gateway():
    import gate_channel
    gate = load_gate()
    server, seen = app_server()
    try:
        gate_channel.configure('http://127.0.0.1:%d/' % server.server_address[1], TOKEN, '4242')
        reply = event('4242', '123456')
        reply.reply_to_message_id = '123'
        asyncio.run(gate.gate(event=reply))
        assert seen[-1][2]['reply_to_message_id'] == '123'
    finally:
        server.shutdown()
        server.server_close()


def test_lost_delivery_receipt_retries_the_receipt_without_sending_twice():
    from unittest.mock import patch
    gate = load_gate()
    gate._adapter = SimpleNamespace(is_connected=True)
    sent, receipts, polls = [], [], []

    async def send(row):
        sent.append(row)
        return {'ok': True, 'message_id': '123'}

    async def no_delay(_):
        pass

    def call(route, payload=None, timeout=10):
        if route.startswith('/outbox'):
            polls.append(route)
            if len(polls) > 1:
                raise asyncio.CancelledError()
            return [{'seq': 1, 'chat_id': '4242', 'text': 'Approval'}]
        if route == '/sent':
            receipts.append(payload)
            if len(receipts) == 1:
                raise OSError('fixture lost receipt')
        return {'ok': True}

    with patch.object(gate, '_call', call), patch.object(gate, '_send', send), patch.object(asyncio, 'sleep', no_delay):
        try:
            asyncio.run(gate._deliver())
        except asyncio.CancelledError:
            pass
    assert len(sent) == 1
    assert receipts == [{'seq': 1, 'ok': True, 'message_id': '123'}] * 2


def test_the_channel_settings_are_checked():
    import gate_channel
    for url, token, owner in (('http://example.org:1/', TOKEN, '1'), ('http://127.0.0.1:1/', 'short', '1'), ('http://127.0.0.1:1/', TOKEN, '01')):
        try:
            gate_channel.configure(url, token, owner)
        except ValueError:
            continue
        raise AssertionError('accepted ' + url)


def test_topics_are_made_renamed_and_carried_both_ways():
    import gate_channel
    gate = load_gate()
    server, seen = app_server()
    calls = []

    class Bot:
        async def create_forum_topic(self, **kwargs):
            calls.append(('create', kwargs))
            return SimpleNamespace(message_thread_id=55)

        async def edit_forum_topic(self, **kwargs):
            calls.append(('rename', kwargs))

    async def send(chat_id, text, reply_to=None, metadata=None):
        calls.append(('send', chat_id, text, metadata))
        return SimpleNamespace(success=True, message_id=9)

    gate._adapter = SimpleNamespace(_bot=Bot(), send=send)
    try:
        gate_channel.configure('http://127.0.0.1:%d/' % server.server_address[1], TOKEN, '4242')
        topic = event('4242', 'in a topic')
        topic.source.thread_id = 55
        asyncio.run(gate.gate(event=topic))
        assert seen[-1][2]['thread_id'] == '55'
        topic.source.thread_id = 'x'
        asyncio.run(gate.gate(event=topic))
        assert 'thread_id' not in seen[-1][2]
    finally:
        server.shutdown()
        server.server_close()
    assert asyncio.run(gate._send({'seq': 1, 'chat_id': '4242', 'text': 'Plan', 'op': 'topic'})) == {'ok': True, 'message_id': '55'}
    assert asyncio.run(gate._send({'seq': 2, 'chat_id': '4242', 'text': '📌 Plan', 'op': 'rename', 'thread_id': '55'})) == {'ok': True}
    assert asyncio.run(gate._send({'seq': 3, 'chat_id': '4242', 'text': 'reply', 'thread_id': '55'}))['ok']
    assert calls == [('create', {'chat_id': 4242, 'name': 'Plan'}), ('rename', {'chat_id': 4242, 'message_thread_id': 55, 'name': '📌 Plan'}),
                     ('send', '4242', 'reply', {'thread_id': '55'})]


def telegram_stub():
    """Stand-ins for the python-telegram-bot names the gate uses, so these tests need no Telegram package."""
    import types

    class Button:
        def __init__(self, text, **kwargs):
            self.text, self.kwargs = text, kwargs

    class Markup:
        def __init__(self, rows):
            self.rows = rows

    class Stop(Exception):
        pass

    telegram, ext = types.ModuleType('telegram'), types.ModuleType('telegram.ext')
    telegram.InlineKeyboardButton, telegram.InlineKeyboardMarkup = Button, Markup
    telegram.Update = type('Update', (), {'ALL_TYPES': ['message', 'callback_query']})
    ext.ApplicationHandlerStop = Stop
    ext.CallbackQueryHandler = lambda callback, pattern=None: ('callback', callback, pattern)
    ext.TypeHandler = lambda kind, callback: ('type', callback)
    telegram.ext = ext
    sys.modules['telegram'], sys.modules['telegram.ext'] = telegram, ext
    return telegram, ext


class RecordingBot:
    """Records every Bot API call; a method named in `refuse` raises that error once per listed entry."""
    def __init__(self, refuse=None):
        self.calls, self.refuse, self.next_id = [], dict(refuse or {}), 900

    def __getattr__(self, name):
        async def call(**kwargs):
            errors = self.refuse.get(name)
            if errors:
                raise errors.pop(0)
            self.calls.append((name, kwargs))
            if name == 'send_message':
                self.next_id += 1
                return SimpleNamespace(message_id=self.next_id)
            return SimpleNamespace(message_thread_id=55) if name == 'create_forum_topic' else True
        return call


# Koan 2026-11-19, version 3 of the Telegram mockup.
def test_a_thread_is_deleted_a_text_is_marked_and_buttons_and_sound_travel():
    telegram_stub()
    gate = load_gate()
    bot, sends = RecordingBot(), []

    async def send(chat_id, text, reply_to=None, metadata=None):
        sends.append((chat_id, text, metadata))
        return SimpleNamespace(success=True, message_id=9)

    gate._adapter = SimpleNamespace(_bot=bot, send=send)
    assert asyncio.run(gate._send({'seq': 1, 'chat_id': '4242', 'text': '', 'op': 'delete', 'thread_id': '55'})) == {'ok': True}
    assert asyncio.run(gate._send({'seq': 2, 'chat_id': '4242', 'text': '👀', 'op': 'react', 'message_id': '1017'})) == {'ok': True}
    assert asyncio.run(gate._send({'seq': 3, 'chat_id': '4242', 'text': '', 'op': 'react', 'message_id': '1017'})) == {'ok': True}
    assert bot.calls == [('delete_forum_topic', {'chat_id': 4242, 'message_thread_id': 55}),
                         ('set_message_reaction', {'chat_id': 4242, 'message_id': 1017, 'reaction': '👀'}),
                         ('set_message_reaction', {'chat_id': 4242, 'message_id': 1017, 'reaction': None})]
    # A card kept current: an edit that changes nothing is fine, a message that is gone is said to be gone.
    assert asyncio.run(gate._send({'seq': 7, 'chat_id': '4242', 'text': 'Resets at 22:30.', 'op': 'edit', 'message_id': '901'})) == {'ok': True}
    assert bot.calls[-1] == ('edit_message_text', {'chat_id': 4242, 'message_id': 901, 'text': 'Resets at 22:30.', 'reply_markup': None})
    bot.refuse['edit_message_text'] = [Exception('Bad Request: message is not modified'), Exception('Bad Request: message to edit not found')]
    assert asyncio.run(gate._send({'seq': 8, 'chat_id': '4242', 'text': 'Resets at 22:30.', 'op': 'edit', 'message_id': '901'})) == {'ok': True}
    assert asyncio.run(gate._send({'seq': 9, 'chat_id': '4242', 'text': 'Resets at 22:30.', 'op': 'edit', 'message_id': '901'})) == {'ok': False, 'gone': True}
    assert asyncio.run(gate._send({'seq': 10, 'chat_id': '4242', 'text': '', 'op': 'pin', 'message_id': '901'})) == {'ok': True}
    assert bot.calls[-1] == ('pin_chat_message', {'chat_id': 4242, 'message_id': 901, 'disable_notification': True})
    del bot.calls[3:]
    # A plain reply goes through the adapter, without sound unless the row asks for it.
    asyncio.run(gate._send({'seq': 4, 'chat_id': '4242', 'text': 'copy', 'thread_id': '55'}))
    asyncio.run(gate._send({'seq': 5, 'chat_id': '4242', 'text': 'done', 'thread_id': '55', 'notify': True}))
    assert sends == [('4242', 'copy', {'thread_id': '55'}), ('4242', 'done', {'thread_id': '55', 'notify': True})]
    # A message with buttons: a link, and a press that comes back to the app, coloured by the Bot API's own field.
    row = {'seq': 6, 'chat_id': '4242', 'text': 'New chat: Plan', 'keys': [[{'text': 'Open Plan', 'url': 'https://t.me/bot/55'}, {'text': 'Stop', 'data': 'gh:stop:c1', 'style': 'danger'}]]}
    assert asyncio.run(gate._send(row)) == {'ok': True, 'message_id': '901'}
    name, sent = bot.calls[-1]
    assert name == 'send_message' and sent['disable_notification'] is True and 'message_thread_id' not in sent
    link, stop = sent['reply_markup'].rows[0]
    assert (link.text, link.kwargs) == ('Open Plan', {'url': 'https://t.me/bot/55'})
    assert (stop.text, stop.kwargs) == ('Stop', {'callback_data': 'gh:stop:c1', 'api_kwargs': {'style': 'danger'}})


def test_a_refusal_that_asks_to_wait_is_tried_again_and_a_gone_thread_is_reported():
    from unittest.mock import patch
    telegram_stub()
    gate = load_gate()
    wait = type('RetryAfter', (Exception,), {'retry_after': 3})()
    bot = RecordingBot({'create_forum_topic': [wait], 'edit_forum_topic': [Exception('Bad Request: message thread not found')], 'delete_forum_topic': [Exception('Forbidden')]})
    slept = []

    async def sleep(seconds):
        slept.append(seconds)

    async def send(chat_id, text, reply_to=None, metadata=None):
        return SimpleNamespace(success=False, error='Bad Request: message thread not found', message_id=None)

    gate._adapter = SimpleNamespace(_bot=bot, send=send)
    with patch.object(asyncio, 'sleep', sleep):
        assert asyncio.run(gate._send({'seq': 1, 'chat_id': '4242', 'text': 'Plan', 'op': 'topic'})) == {'ok': True, 'message_id': '55'}
        assert slept == [3], 'nothing was sent, so the second try cannot double anything'
        assert asyncio.run(gate._send({'seq': 2, 'chat_id': '4242', 'text': 'Plan', 'op': 'rename', 'thread_id': '55'})) == {'ok': False, 'gone': True}
        assert asyncio.run(gate._send({'seq': 3, 'chat_id': '4242', 'text': 'reply', 'thread_id': '55'})) == {'ok': False, 'gone': True}
        try:
            asyncio.run(gate._send({'seq': 4, 'chat_id': '4242', 'text': '', 'op': 'delete', 'thread_id': '55'}))
        except Exception as error:
            assert str(error) == 'Forbidden'
        else:
            raise AssertionError('any other refusal is an uncertain outcome for the app to record')


def test_a_reply_shows_while_it_is_written_as_a_draft_or_as_a_message_edited_in_place():
    telegram_stub()
    gate = load_gate()
    bot = RecordingBot()
    gate._adapter = SimpleNamespace(_bot=bot)
    frame = {'n': 1, 'chat_id': '4242', 'thread_id': '55', 'draft_id': 7, 'text': '', 'stop': 'gh:stop:c1'}
    asyncio.run(gate._draft(frame))
    asyncio.run(gate._draft({**frame, 'n': 2, 'text': 'Yes, agents'}))
    assert bot.calls == [('send_message_draft', {'chat_id': 4242, 'draft_id': 7, 'text': '', 'api_kwargs': {'can_stop': True}, 'message_thread_id': 55}),
                         ('send_message_draft', {'chat_id': 4242, 'draft_id': 7, 'text': 'Yes, agents', 'api_kwargs': {'can_stop': True}, 'message_thread_id': 55})]
    asyncio.run(gate._draft({**frame, 'n': 3, 'done': True}))
    assert len(bot.calls) == 2, 'a draft goes by itself when the reply is sent'
    # A bot chat that refuses drafts: one silent message with a Stop button, edited as the reply grows, removed at the end.
    gate = load_gate()
    bot = RecordingBot({'send_message_draft': [Exception('Bad Request: TEXTDRAFT_PEER_INVALID')]})
    gate._adapter = SimpleNamespace(_bot=bot)
    asyncio.run(gate._draft(frame))
    asyncio.run(gate._draft({**frame, 'n': 2, 'text': 'Yes, agents'}))
    asyncio.run(gate._draft({**frame, 'n': 3, 'text': 'Yes, agents'}))
    asyncio.run(gate._draft({**frame, 'n': 4, 'draft_id': 8, 'text': 'A second answer'}))
    asyncio.run(gate._draft({**frame, 'n': 5, 'draft_id': 8, 'done': True}))
    names = [name for name, _ in bot.calls]
    assert names == ['send_message', 'edit_message_text', 'delete_message', 'send_message', 'delete_message'], names
    first = bot.calls[0][1]
    assert first['text'] == '…' and first['disable_notification'] is True and first['message_thread_id'] == 55
    assert first['reply_markup'].rows[0][0].kwargs == {'callback_data': 'gh:stop:c1', 'api_kwargs': {'style': 'danger'}}
    assert bot.calls[1][1]['message_id'] == 901 and bot.calls[1][1]['text'] == 'Yes, agents'
    assert bot.calls[2][1] == {'chat_id': 4242, 'message_id': 901} and bot.calls[4][1] == {'chat_id': 4242, 'message_id': 902}


def test_only_the_owners_press_and_stop_reach_the_app_and_stop_on_a_draft_is_asked_for():
    import gate_channel
    telegram, ext = telegram_stub()
    gate = load_gate()
    server, seen = app_server()
    answers = []

    def query(user, chat=4242, data='gh:stop:c1'):
        async def answer(text=None):
            answers.append(text)
        return SimpleNamespace(callback_query=SimpleNamespace(data=data, from_user=SimpleNamespace(id=user), answer=answer,
                                                              message=SimpleNamespace(chat=SimpleNamespace(id=chat), message_id=901, message_thread_id=55)))

    def run(coroutine):
        try:
            asyncio.run(coroutine)
        except ext.ApplicationHandlerStop:
            return 'stopped'

    try:
        gate_channel.configure('http://127.0.0.1:%d/' % server.server_address[1], TOKEN, '4242')
        assert run(gate._pressed(query(99), None)) == 'stopped' and run(gate._pressed(query(4242, chat=-100), None)) == 'stopped'
        assert seen == [] and answers == [None, None]
        assert run(gate._pressed(query(4242), None)) == 'stopped', "the adapter's own button handler never sees the app's buttons"
        assert seen[-1][2] == {'type': 'button', 'data': 'gh:stop:c1', 'message_id': '901', 'thread_id': '55'}
        # Telegram's own Stop on a draft arrives as an update this python-telegram-bot keeps under api_kwargs.
        stopped = {'chat': {'id': 4242, 'type': 'private'}, 'message_thread_id': 55, 'draft_id': 7}
        asyncio.run(gate._stopped(SimpleNamespace(api_kwargs={'stopped_message_generation': stopped}), None))
        assert seen[-1][2] == {'type': 'stopped', 'draft_id': 7, 'thread_id': '55'}
        count = len(seen)
        asyncio.run(gate._stopped(SimpleNamespace(api_kwargs={'stopped_message_generation': {**stopped, 'chat': {'id': 99}}}), None))
        asyncio.run(gate._stopped(SimpleNamespace(api_kwargs={}), None))
        assert len(seen) == count
    finally:
        server.shutdown()
        server.server_close()
    hooks = []
    gate.register(SimpleNamespace(register_hook=lambda name, hook: hooks.append(name), register_platform_handler=lambda name, factory: hooks.append(name)))
    assert telegram.Update.ALL_TYPES == ['message', 'callback_query', 'stopped_message_generation'] and hooks == ['pre_gateway_dispatch', 'telegram']
