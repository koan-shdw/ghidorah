"""Local authenticated Responses wire fixture; never calls an outside service."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import base64
import json
import os
import sys
import threading
import time
from pathlib import Path

APP=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(APP/'runtime'/'hermes'),str(APP/'backend')]
import windows_credentials as vault
from security import install_codec
from hermes_cli.auth import _save_codex_tokens
def account_token(account='fixture-account'):
    payload=base64.urlsafe_b64encode(json.dumps({'exp':4102444800,'sub':account,'https://api.openai.com/auth':{'chatgpt_account_id':account}}).encode()).decode().rstrip('=')
    return 'eyJhbGciOiJub25lIn0.'+payload+'.fixture'
token=account_token()
health_file=Path(sys.argv[2]).parent/'health.json'
def health(value=None):
    if not health_file.exists():return 'ready'
    data=json.loads(health_file.read_text())
    if value is not None:
        data['codex']=value;health_file.write_text(json.dumps(data))
    return data.get('codex','ready')
install_codec(sys.argv[1]+'/encryption')
_save_codex_tokens({'access_token':token,'refresh_token':'fixture-refresh-never-real'},set_active=False)

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def controls(self):
        return json.loads(health_file.read_text()) if health_file.exists() else {}
    def send_json(self,body,status=200):
        data=json.dumps(body).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_GET(self):
        if self.headers.get('Authorization')!='Bearer '+account_token(self.controls().get('account','fixture-account')):
            self.send_error(401);return
        state=health()
        if state=='auth':self.send_error(401);return
        if state=='unknown' and '/models' not in self.path:self.send_error(503);return
        body={'models':[{'slug':'gpt-6-astra','priority':0,'visibility':'list','context_window':272000}]} if '/models' in self.path else {'plan_type':'pro','rate_limit':{'primary_window':{'used_percent':100 if state=='exhausted' else 12,'reset_at':4102444800,'limit_window_seconds':18000}}}
        if '/models' in self.path and os.environ.get('FIXTURE_TEXT_MODEL'):body['models'].append({'slug':'gpt-fixture-text','priority':99,'visibility':'list','context_window':32000})
        data=json.dumps(body).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_POST(self):
        controls=self.controls()
        if self.path in ('/api/accounts/deviceauth/usercode','/api/accounts/deviceauth/token','/oauth/token'):
            self.rfile.read(int(self.headers.get('Content-Length',0)))
            if controls.get('login')=='error':self.send_json({'error':'synthetic login failure'},500)
            elif self.path.endswith('/usercode'):self.send_json({'user_code':'TEST-ONLY','device_auth_id':'synthetic-device','interval':3})
            elif self.path.startswith('/api/'):
                self.send_json({'authorization_code':'synthetic-authorization','code_verifier':'synthetic-verifier'},403 if controls.get('login')=='pending' else 200)
            else:self.send_json({'access_token':account_token(controls.get('account','fixture-account')),'refresh_token':'fixture-refresh-never-real'})
            return
        if self.headers.get('Authorization')!='Bearer '+account_token(controls.get('account','fixture-account')):
            self.send_error(401);return
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with open(sys.argv[2],'a',encoding='utf8') as log:log.write(json.dumps({**body,'_fixture_account':controls.get('account','fixture-account')})+'\n')
        items=body.get('input',[])
        text=json.dumps(items)
        called=any(item.get('type')=='function_call_output' for item in items if isinstance(item,dict))
        user_index=next((i for i in range(len(items)-1,-1,-1) if items[i].get('role')=='user'),-1)
        content=items[user_index].get('content','') if user_index>=0 else ''
        last=(content if isinstance(content,str) else ''.join(part.get('text','') for part in content)).rsplit('Current user message:',1)[-1].strip()
        if 'EXHAUST_GPT_FIXTURE' in last:
            health('exhausted');data=json.dumps({'error':{'message':'Insufficient quota for this account','type':'insufficient_quota','code':'insufficient_quota'}}).encode()
            self.send_response(402);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);return
        current_outputs=[item for item in items[user_index+1:] if item.get('type')=='function_call_output']
        if 'PARALLEL_BOARD_FIXTURE' in last:
            if current_outputs:
                output=[{'id':'msg_fixture','type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':str(current_outputs[-1].get('output','')),'annotations':[]}]}]
            else:
                name,args='parallel_work',{'operation':'note','text':'GPT board finding'}
                if name not in {item.get('name') for item in body.get('tools',[])}:name,args='tool_call',{'calls':[{'name':name,'arguments':args}]}
                output=[{'id':'fc_fixture','type':'function_call','call_id':'call_fixture','name':name,'arguments':json.dumps(args),'status':'completed'}]
        elif 'MCP_FIXTURE ' in last:
            spec=json.JSONDecoder().raw_decode(last.rsplit('MCP_FIXTURE ',1)[-1])[0]
            if current_outputs:
                output=[{'id':'msg_fixture','type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':str(current_outputs[-1].get('output','')),'annotations':[]}]}]
            else:
                name,args=spec['name'],spec['arguments']
                if name not in {item.get('name') for item in body.get('tools',[])}:
                    assert name in json.dumps(body.get('tools',[]))
                    name,args='tool_call',{'calls':[{'name':name,'arguments':args}]}
                output=[{'id':'fc_fixture','type':'function_call','call_id':'call_fixture','name':name,'arguments':json.dumps(args),'status':'completed'}]
        elif 'COORDINATION_WRITE_SHARED' in last and not current_outputs:
            output=[{'id':'fc_fixture','type':'function_call','call_id':'call_fixture','name':'write_file','arguments':json.dumps({'path':'shared-result.txt','content':'GPT shared write.'}),'status':'completed'}]
        elif 'WRITE_GPT_FIXTURE' in last and not current_outputs:
            output=[{'id':'fc_fixture','type':'function_call','call_id':'call_fixture','name':'write_file','arguments':json.dumps({'path':'gpt-result.txt','content':'GPT tool approved.'}),'status':'completed'}]
        else:
            reply='GPT fixture retained copperfinch.' if 'copperfinch' in text else 'GPT fixture reply.'
            if 'SLOW_GPT_FIXTURE' in last:reply+=' Streaming.'*100
            output=[{'id':'msg_fixture','type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':reply,'annotations':[]}]}]
        response={'id':'resp_fixture','object':'response','created_at':int(time.time()),'status':'completed','model':body.get('model'),'output':output,'usage':{'input_tokens':100,'output_tokens':20,'total_tokens':120,'input_tokens_details':{'cached_tokens':0},'output_tokens_details':{'reasoning_tokens':0}}}
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
        def emit(kind,**fields):
            event={'type':kind,**fields};self.wfile.write(('event: '+kind+'\ndata: '+json.dumps(event)+'\n\n').encode());self.wfile.flush()
        try:
            emit('response.created',response={**response,'status':'in_progress','output':[]})
            for index,item in enumerate(output):
                emit('response.output_item.added',output_index=index,item=item)
                if item['type']=='message':
                    for chunk in item['content'][0]['text'].split(' '):
                        emit('response.output_text.delta',output_index=index,item_id=item['id'],content_index=0,delta=chunk+' ')
                        time.sleep(.03)
                emit('response.output_item.done',output_index=index,item=item)
            emit('response.completed',response=response)
        except ConnectionError:pass

server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
print(json.dumps({'url':f'http://127.0.0.1:{server.server_port}/backend-api/codex'}),flush=True)
sys.stdin.readline();server.shutdown()
