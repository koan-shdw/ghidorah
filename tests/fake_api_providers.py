"""Four isolated supplier protocols. Contains no real credentials or outside calls."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import base64
import sys
import threading
import time
from pathlib import Path

root = Path(sys.argv[1])
models = {'alibaba': 'qwen-plus', 'openrouter-api': 'test/chat-model', 'mistral': 'devstral-latest', 'openai-api': 'gpt-6-astra', 'gemini': 'gemini-3.8-flash', 'xai': 'grok-4.6', 'kimi-coding': 'kimi-k3', 'zai': 'glm-5.3'}
if os.environ.get('TRISMEGISTUS_TEST_SUPPLIER') == 'nous': models = {'nous': 'hermes-test'}
encode = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
nous_token = encode({'alg':'none'}) + '.' + encode({'exp':int(time.time())+3600,'scope':'inference:invoke','sub':'fixture'}) + '.fixture'
servers = []


def handler(provider):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def authenticated(self):
            if provider == 'nous': return self.headers.get('Authorization') == 'Bearer ' + nous_token
            return self.headers.get('x-goog-api-key' if provider == 'gemini' else 'Authorization') == ('' if provider == 'gemini' else 'Bearer ') + 'synthetic-' + provider + '-test-credential'

        def do_GET(self):
            if not self.authenticated() and not (provider == 'openrouter-api' and '/models' in self.path):
                self.reply(401, {'error': {'code': 'invalid_api_key'}})
                return
            mode = json.loads((root / 'health.json').read_text()).get(provider, 'ready')
            if mode == 'unknown':
                self.reply(503, {})
                return
            if self.path.endswith('/key') and provider == 'openrouter-api':
                self.reply(200, {'data': {'label': 'Fixture', 'limit_remaining': 5}})
                return
            if '/models' in self.path:
                if provider == 'alibaba':
                    from urllib.parse import urlsplit, parse_qs
                    parsed = urlsplit(self.path)
                    if parsed.path != '/api/v1/models':
                        self.reply(404, {})
                        return
                    number = int(parse_qs(parsed.query)['page_no'][0])
                    rows = [dict(model=models[provider], name=models[provider], features=['function-calling'], inference_metadata=dict(request_modality=['Text'], response_modality=['Text']))] if number == 1 else [dict(model='wan-fixture', features=[], inference_metadata=dict(response_modality=['Video']))]
                    self.reply(200, {'output': {'total': 2, 'models': rows}})
                elif provider == 'gemini':
                    rows = [{'name': 'models/' + models[provider], 'supportedGenerationMethods': ['generateContent'], 'displayName': 'Gemini test', 'inputTokenLimit': 1000000}, {'name': 'models/embedding-001', 'supportedGenerationMethods': ['embedContent']}]
                    rows.extend(dict(name='models/' + model, supportedGenerationMethods=['generateContent']) for model in ['nano-banana-pro-preview', 'lyria-3.5'])
                    self.reply(200, {'models': rows})
                else:
                    rows = [{'id': models[provider]}, {'id': 'embedding-fixture'}]
                    if provider == 'xai': rows.append({'id': 'grok-imagine-video-1.5'})
                    self.reply(200, {'data': rows})
                return
            self.reply(404, {})

        def do_POST(self):
            global nous_token
            if provider == 'nous' and self.path == '/api/oauth/device/code':
                self.rfile.read(int(self.headers['Content-Length']))
                self.reply(200, dict(device_code='fixture-device', user_code='NOUS-TEST', verification_uri='https://portal.nousresearch.com/device', verification_uri_complete='https://portal.nousresearch.com/device?code=NOUS-TEST', expires_in=120, interval=1))
                return
            if provider == 'nous' and self.path == '/api/oauth/token':
                from urllib.parse import parse_qs
                form = parse_qs(self.rfile.read(int(self.headers['Content-Length'])).decode())
                if form.get('grant_type') == ['refresh_token']:
                    nous_token = encode({'alg':'none'}) + '.' + encode({'exp':int(time.time())+3600,'scope':'inference:invoke','sub':'rotated'}) + '.fixture'
                    (root / 'health.json').write_text('{}')
                    (root / 'nous-refreshed').write_text('yes')
                if not (root / 'nous-authorized').exists():
                    self.reply(400, {'error':'authorization_pending'})
                else:
                    self.reply(200, dict(access_token=nous_token, refresh_token='synthetic-nous-refresh', expires_in=3600, scope='inference:invoke'))
                return
            if self.path.endswith('/auth/keys') and provider == 'openrouter-api':
                import hashlib, base64
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                expected = json.loads((root / 'openrouter-pkce.json').read_text())
                challenge = base64.urlsafe_b64encode(hashlib.sha256(body['code_verifier'].encode()).digest()).decode().rstrip('=')
                if body.get('code') != expected['code'] or body.get('code_challenge_method') != 'S256' or challenge != expected['challenge']:
                    self.reply(403, {})
                    return
                self.reply(200, {'key': 'synthetic-openrouter-api-test-credential'})
                return
            if not self.authenticated():
                self.reply(401, {'error': {'code': 'invalid_api_key'}})
                return
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if self.path == '/api/show':
                self.reply(404, {})  # Hermes's loopback-only Ollama metadata probe.
                return
            with (root / 'requests.jsonl').open('a', encoding='utf-8') as output:
                output.write(json.dumps(dict(provider=provider, path=self.path, body=body)) + '\n')
            mode = json.loads((root / 'health.json').read_text()).get(provider, 'ready')
            if mode == 'expired' and provider == 'nous':
                self.reply(401, {'error': {'code': 'token_expired', 'message': 'Access token expired'}})
                return
            if provider == 'gemini' and mode in ('model-quota', 'account-quota'):
                violation = {'quotaMetric': 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
                             'quotaId': 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'quotaValue': '5',
                             'quotaDimensions': {'model': models[provider]} if mode == 'model-quota' else {}}
                self.reply(429, {'error': {'code': 429, 'status': 'RESOURCE_EXHAUSTED', 'message': 'Quota exceeded for free_tier_requests.',
                    'details': [{'@type': 'type.googleapis.com/google.rpc.QuotaFailure', 'violations': [violation]},
                                {'@type': 'type.googleapis.com/google.rpc.RetryInfo', 'retryDelay': '2s'}]}})
                return
            if provider == 'alibaba' and mode in ('free-tier', 'unpurchased'):
                self.reply(403, {'error': {'code': 'AllocationQuota.FreeTierOnly' if mode == 'free-tier' else 'AccessDenied.Unpurchased', 'message': 'Model access refused'}})
                return
            if mode == 'exhausted':
                self.reply(402, {'error': {'code': 'insufficient_quota', 'type': 'insufficient_quota', 'message': 'Insufficient quota'}})
                return
            if mode == 'model':
                self.reply(404, {'error': {'code': 'model_not_found', 'message': 'Model not found'}})
                return
            sequence = body.get('contents', body.get('input', body.get('messages', [])))
            user = next((i for i in range(len(sequence)-1, -1, -1) if sequence[i].get('role') == 'user' and 'functionResponse' not in json.dumps(sequence[i])), -1)
            prompt = json.dumps(sequence[user]) if user >= 0 else ''
            spec = None
            if 'API_WRITE ' in prompt:
                import re
                filename = re.search(r'API_WRITE ([a-z.-]+)', prompt)[1]
                spec = {'path': filename, 'content': provider + ' approved write'}
            responded = any(item.get('role') == 'tool' or item.get('type') == 'function_call_output' or 'functionResponse' in json.dumps(item) for item in sequence[user+1:])
            tool = spec is not None and not responded and bool(body.get('tools'))
            reply = provider + ' fixture retained copperfinch.'
            if 'API_SLOW' in prompt:
                reply += ' Streaming.' * 150
            usage = {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}
            native = provider == 'gemini'
            responses = self.path.endswith('/responses')
            if native:
                parts = [{'functionCall': {'name': 'write_file', 'args': spec}}] if tool else [{'text': reply}]
                result = {'candidates': [{'index': 0, 'content': {'role': 'model', 'parts': parts}, 'finishReason': 'STOP'}], 'usageMetadata': {'promptTokenCount': 100, 'candidatesTokenCount': 20, 'totalTokenCount': 120}, 'modelVersion': models[provider]}
            elif responses:
                item = {'id': 'fc_api', 'type': 'function_call', 'call_id': 'call_api', 'name': 'write_file', 'arguments': json.dumps(spec), 'status': 'completed'} if tool else {'id': 'msg_api', 'type': 'message', 'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': reply, 'annotations': []}]}
                result = {'id': 'resp_api', 'object': 'response', 'status': 'completed', 'model': models[provider], 'output': [item], 'usage': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120}}
            else:
                message = {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'call_api', 'type': 'function', 'function': {'name': 'write_file', 'arguments': json.dumps(spec)}}]} if tool else {'role': 'assistant', 'content': reply}
                result = {'id': 'chat_api', 'object': 'chat.completion', 'model': models[provider], 'choices': [{'index': 0, 'message': message, 'finish_reason': 'tool_calls' if tool else 'stop'}], 'usage': usage}
            if not body.get('stream') and 'streamGenerateContent' not in self.path:
                self.reply(200, result)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            def emit(data, event=None):
                self.wfile.write(((('event: ' + event + '\n') if event else '') + 'data: ' + json.dumps(data) + '\n\n').encode())
                self.wfile.flush()
            try:
                if native:
                    if not tool:
                        for piece in reply.split(' '):
                            emit({'candidates': [{'index': 0, 'content': {'role': 'model', 'parts': [{'text': piece + ' '}]}}]})
                            time.sleep(.02)
                        result['candidates'][0]['content']['parts'] = []
                    emit(result)
                elif responses:
                    emit({'type': 'response.created', 'response': {**result, 'status': 'in_progress', 'output': []}}, 'response.created')
                    emit({'type': 'response.output_item.added', 'output_index': 0, 'item': item}, 'response.output_item.added')
                    if not tool:
                        for piece in reply.split(' '):
                            emit({'type': 'response.output_text.delta', 'output_index': 0, 'item_id': item['id'], 'content_index': 0, 'delta': piece + ' '}, 'response.output_text.delta')
                            time.sleep(.02)
                    emit({'type': 'response.output_item.done', 'output_index': 0, 'item': item}, 'response.output_item.done')
                    emit({'type': 'response.completed', 'response': result}, 'response.completed')
                else:
                    base = {'id': 'chat_api', 'object': 'chat.completion.chunk', 'model': models[provider]}
                    if tool:
                        message['tool_calls'][0]['index'] = 0
                        emit({**base, 'choices': [{'index': 0, 'delta': message, 'finish_reason': None}]})
                    else:
                        for piece in reply.split(' '):
                            emit({**base, 'choices': [{'index': 0, 'delta': {'content': piece + ' '}, 'finish_reason': None}]})
                            time.sleep(.02)
                    emit({**base, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls' if tool else 'stop'}], 'usage': usage})
                    self.wfile.write(b'data: [DONE]\n\n')
            except ConnectionError:
                pass
    return Handler


urls = {}
for provider in models:
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler(provider))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    servers.append(server)
    urls[provider] = f'http://127.0.0.1:{server.server_port}/' + ('generativelanguage.googleapis.com/v1beta' if provider == 'gemini' else 'v1')
print(json.dumps(urls), flush=True)
sys.stdin.readline()
for server in servers:
    server.shutdown()
