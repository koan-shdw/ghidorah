"""Bundled Windows Python, private-pipe owner, real stdio MCP and OS credentials."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import uuid
import pytest

APP = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(APP / 'backend'), str(APP / 'runtime' / 'hermes')]
PYTHON = APP / 'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'

class Worker:
    def __init__(self, root, namespace):
        self.output = queue.Queue(); self.errors = []
        env = {key: value for key,value in os.environ.items() if key.upper() in {'PATH','SYSTEMROOT','SYSTEMDRIVE','PROGRAMDATA','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'}}
        env.update(PYTHONUTF8='1', PYTHONUNBUFFERED='1', HERMES_HOME=str(root), UNASSIGNED_MCP_SECRET='must-not-reach-server')
        self.child = subprocess.Popen([str(PYTHON),str(APP/'backend/claude_worker.py')],cwd=APP,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',env=env,creationflags=subprocess.CREATE_NO_WINDOW)
        def read():
            for line in self.child.stdout:
                try:self.output.put(json.loads(line))
                except ValueError:self.errors.append(line)
        threading.Thread(target=read,daemon=True).start()
        threading.Thread(target=lambda:self.errors.extend(self.child.stderr.readlines()),daemon=True).start()
        self.send({'executable':str(PYTHON),'args':[str(APP/'backend/mcp_worker.py')],'cwd':str(APP)})
        self.send({'root':str(root),'namespace':namespace})
        assert self.next()['event'] == 'ready', self.errors
    def send(self, value):self.child.stdin.write(json.dumps(value)+'\n');self.child.stdin.flush()
    def next(self):
        try:return self.output.get(timeout=45)
        except queue.Empty:raise AssertionError('Worker timed out: '+''.join(self.errors))
    def start(self, operation, **args):
        request=uuid.uuid4().hex;self.send({'request':request,'operation':operation,'args':args});return request
    def finish(self, request, error=False):
        while True:
            message=self.next()
            if message.get('request')==request:
                if error:assert 'error' in message;return message['error']
                assert 'error' not in message,message;return message['result']
    def call(self, operation, **args):return self.finish(self.start(operation,**args))
    def close(self):
        if self.child.poll() is None:
            self.child.stdin.close()
            try:self.child.wait(timeout=15)
            except subprocess.TimeoutExpired:self.child.kill();self.child.wait();raise

def running(pid):
    import ctypes
    api=ctypes.WinDLL('kernel32',use_last_error=True)
    api.OpenProcess.restype=ctypes.c_void_p
    api.WaitForSingleObject.argtypes=[ctypes.c_void_p,ctypes.c_uint32]
    api.CloseHandle.argtypes=[ctypes.c_void_p]
    handle=api.OpenProcess(0x100000,False,pid)
    if not handle:return False
    try:return api.WaitForSingleObject(handle,0)==258
    finally:api.CloseHandle(handle)

@pytest.mark.skipif(os.name != 'nt', reason='Windows vault and job lifetime')
def test_private_mcp_stdio_vault_scoping_cancel_restart_off_remove_and_job(tmp_path):
    import windows_credentials as vault
    from security import install_codec
    from hermes_cli.credential_codec import decode
    namespace='Trismegistus/Test/mcp-owner-'+uuid.uuid4().hex
    vault.put(namespace+'/encryption',os.urandom(32));worker=Worker(tmp_path,namespace);keys=[]
    try:
        key=worker.call('add',name='Local fixture',config={'command':str(PYTHON),'args':[str(APP/'tests/fixtures/mcp_stdio.py')],'env':{'SERVICE_KEY':'synthetic-server-credential'}});keys.append(key)
        tools=worker.call('tools',id=key);assert [t['name'] for t in tools]==['echo','slow','child'];assert 'synthetic-server-credential' not in json.dumps(tools)
        for marker in ['project-a','project-b','project-a']:
            result=worker.call('call',id=key,name='echo',arguments={'marker':marker});text=result['content'][0]['text']
            assert marker in text and 'synthetic-server-credential' not in text and 'must-not-reach-server' not in text
            assert json.loads(text)['unassigned'] is None
        file=tmp_path/'mcp-connections.json';assert 'synthetic-server-credential' not in file.read_text(encoding='utf-8')
        install_codec(namespace+'/encryption');saved=decode(json.loads(file.read_text(encoding='utf-8')))
        placeholder=saved[key]['config']['env']['SERVICE_KEY'];assert placeholder.startswith('${TRISMEGISTUS_MCP_')
        credential=namespace+'/mcp/'+key+'/'+placeholder[len('${TRISMEGISTUS_MCP_'):-1];assert vault.get(credential)==b'synthetic-server-credential'
        request=worker.start('call',id=key,name='slow');time.sleep(.3);worker.send({'operation':'cancel','request':request})
        assert 'Cancelled' in worker.finish(request,error=True)
        assert 'project-a' in worker.call('call',id=key,name='echo',arguments={'marker':'project-a'})['content'][0]['text']
        child=json.loads(worker.call('call',id=key,name='child')['content'][0]['text'])['child'];assert running(child)
        worker.close();assert not running(child)
        worker=Worker(tmp_path,namespace)
        assert key==worker.call('list')[0]['id']
        worker.call('tools',id=key);worker.call('off',id=key)
        assert 'off' in worker.finish(worker.start('call',id=key,name='echo'),error=True)
        worker.call('on',id=key);worker.call('tools',id=key)
        worker.call('remove',id=key);keys.remove(key);assert worker.call('list')==[];assert vault.get(credential) is None
        replacement=worker.call('add',name='Local fixture',config={'command':str(PYTHON),'args':[str(APP/'tests/fixtures/mcp_stdio.py')]});keys.append(replacement);assert replacement!=key
        assert 'synthetic-server-credential' not in ''.join(worker.errors)
        query=worker.call('add',name='Query URL',config={'url':'https://example.invalid/mcp?key=synthetic-url-key'});keys.append(query)
        saved=decode(json.loads(file.read_text(encoding='utf-8')));assert saved[query]['config']['url'].startswith('${TRISMEGISTUS_MCP_')
        assert next(row for row in worker.call('list') if row['id']==query)['address']=='https://example.invalid/mcp'
        reflected=worker.call('call',id=replacement,name='echo',arguments={'marker':'synthetic-url-key'})
        assert 'synthetic-url-key' not in json.dumps(reflected)
    finally:
        for key in keys:
            try:worker.call('remove',id=key)
            except Exception:pass
        worker.close();vault.delete(namespace+'/encryption')

@pytest.mark.skipif(os.name != 'nt', reason='Windows vault and job lifetime')
def test_private_mcp_fresh_oauth_pkce_callbacks_restart_and_revoke(tmp_path):
    import base64
    import hashlib
    import urllib.request
    from urllib.parse import urlsplit, parse_qs, urlencode
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import windows_credentials as vault
    observed={'tokens':[],'authorized':[],'issued':{},'callback':None,'challenge':None}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def reply(self,status,value=None,headers=None):
            data=json.dumps(value).encode() if value is not None else b''
            self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)))
            for key,value in (headers or {}).items():self.send_header(key,value)
            self.end_headers();self.wfile.write(data)
        def do_GET(self):
            parsed=urlsplit(self.path)
            if parsed.path.startswith('/.well-known/oauth-protected-resource'):
                self.reply(200,{'resource':url+'/mcp','authorization_servers':[url],'scopes_supported':['tools']})
            elif parsed.path.startswith('/.well-known/oauth-authorization-server'):
                self.reply(200,{'issuer':url,'authorization_endpoint':url+'/authorize','token_endpoint':url+'/token','registration_endpoint':url+'/register','response_types_supported':['code'],'grant_types_supported':['authorization_code','refresh_token'],'code_challenge_methods_supported':['S256'],'token_endpoint_auth_methods_supported':['none']})
            elif parsed.path=='/authorize':
                params=parse_qs(parsed.query);assert params['code_challenge_method']==['S256']
                code=uuid.uuid4().hex;observed['issued'][code]=params
                callback=params['redirect_uri'][0]+'?'+urlencode({'code':code,'state':params['state'][0],'iss':url})
                observed['callback']=callback;observed['challenge']=params['code_challenge'][0]
                self.reply(200,{'callback':callback})
            else:self.reply(405)
        def do_DELETE(self):self.reply(200)
        def do_POST(self):
            raw=self.rfile.read(int(self.headers.get('Content-Length',0)))
            if self.path=='/register':
                body=json.loads(raw);self.reply(201,{'client_id':'synthetic-client','redirect_uris':body['redirect_uris'],'token_endpoint_auth_method':'none','grant_types':['authorization_code','refresh_token'],'response_types':['code']});return
            if self.path=='/token':
                body=parse_qs(raw.decode());observed['tokens'].append(body)
                if body.get('grant_type')!=['authorization_code'] or body.get('code',[''])[0] not in observed['issued']:
                    self.reply(400,{'error':'invalid_grant'});return
                issued=observed['issued'].pop(body['code'][0]);challenge=base64.urlsafe_b64encode(hashlib.sha256(body['code_verifier'][0].encode()).digest()).decode().rstrip('=')
                if challenge!=issued['code_challenge'][0] or body['redirect_uri']!=issued['redirect_uri']:
                    self.reply(400,{'error':'invalid_grant'});return
                self.reply(200,{'access_token':'synthetic-oauth-access','refresh_token':'synthetic-oauth-refresh','expires_in':3600,'token_type':'Bearer','scope':'tools'});return
            authorization=self.headers.get('Authorization');observed['authorized'].append(authorization)
            if authorization!='Bearer synthetic-oauth-access':
                self.reply(401,headers={'WWW-Authenticate':'Bearer resource_metadata="'+url+'/.well-known/oauth-protected-resource/mcp"'});return
            body=json.loads(raw)
            if 'id' not in body:self.reply(202);return
            if body['method']=='initialize':result={'protocolVersion':body['params']['protocolVersion'],'capabilities':{'tools':{}},'serverInfo':{'name':'oauth-fixture','version':'1'}}
            elif body['method']=='tools/list':result={'tools':[{'name':'echo','inputSchema':{'type':'object','properties':{'marker':{'type':'string'}}}}]}
            else:result={'content':[{'type':'text','text':body['params']['arguments']['marker']+' synthetic-oauth-access'}]}
            self.reply(200,{'jsonrpc':'2.0','id':body['id'],'result':result})
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();url='http://127.0.0.1:'+str(server.server_port)
    namespace='Trismegistus/Test/mcp-oauth-owner-'+uuid.uuid4().hex;vault.put(namespace+'/encryption',os.urandom(32));worker=Worker(tmp_path,namespace);key=None
    try:
        key=worker.call('add',name='OAuth fixture',config={'url':url+'/mcp','auth':'oauth','oauth':{'cimd':False}})
        request=worker.start('login',id=key,redirectUri='http://127.0.0.1:12345/callback')
        while True:
            event=worker.next()
            assert event.get('request')!=request,event
            if event.get('event')=='authorization':break
        assert event['id']==key and urlsplit(event['url']).path=='/authorize'
        response=json.load(urllib.request.urlopen(event['url']));callback=parse_qs(urlsplit(response['callback']).query)
        bad=worker.start('callback',id=key,code=callback['code'][0],state='wrong-state',iss=url)
        assert 'state mismatch' in worker.finish(bad,error=True)
        worker.call('callback',id=key,code=callback['code'][0],state=callback['state'][0],iss=url)
        assert worker.finish(request)[0]['status']=='Connected';assert len(observed['tokens'])==1
        for marker in ['project-a','project-b','project-a']:
            text=worker.call('call',id=key,name='echo',arguments={'marker':marker})['content'][0]['text'];assert marker in text and 'synthetic-oauth-access' not in text
        for file in (tmp_path/'mcp-tokens').glob('*.json'):assert 'synthetic-oauth-' not in file.read_text(encoding='utf-8')
        worker.close();worker=Worker(tmp_path,namespace)
        # Valid saved grants must complete without waiting for a browser URL.
        started=time.monotonic();worker.call('login',id=key,redirectUri='http://127.0.0.1:12345/callback');assert time.monotonic()-started<10
        assert len(observed['tokens'])==1
        worker.call('revoke',id=key);worker.call('on',id=key);before=len(observed['authorized'])
        assert worker.finish(worker.start('tools',id=key),error=True)
        assert all(header is None for header in observed['authorized'][before:]);assert len(observed['tokens'])==1
        # A pending browser callback cannot resurrect a revoked grant.
        request=worker.start('login',id=key,redirectUri='http://127.0.0.1:12345/callback')
        while True:
            event=worker.next()
            assert event.get('request')!=request,event
            if event.get('event')=='authorization':break
        callback=parse_qs(urlsplit(json.load(urllib.request.urlopen(event['url']))['callback']).query)
        worker.call('revoke',id=key)
        assert 'ended' in worker.finish(worker.start('callback',id=key,code=callback['code'][0],state=callback['state'][0],iss=url),error=True)
        assert len(observed['tokens'])==1
    finally:
        if key:
            try:worker.call('remove',id=key)
            except Exception:pass
        worker.close();server.shutdown();server.server_close();vault.delete(namespace+'/encryption')
