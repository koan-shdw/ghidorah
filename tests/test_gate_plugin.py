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
