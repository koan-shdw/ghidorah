"""Stdio MCP fixture; synthetic credentials only."""
import json
import os
import subprocess
import sys
import threading
import time
lock = threading.Lock()
def emit(value):
    with lock: print(json.dumps(value), flush=True)
def call(message):
    name = message['params']['name']
    if os.getenv('CALL_RECORD'):
        with lock:
            with open(os.environ['CALL_RECORD'],'a',encoding='utf-8') as record: record.write(name+'\n')
    if name == 'slow': time.sleep(20)
    child = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(120)'], creationflags=subprocess.CREATE_NO_WINDOW) if name == 'child' else None
    text = {'marker': message['params'].get('arguments', {}).get('marker'), 'secret': os.getenv('SERVICE_KEY'), 'unassigned': os.getenv('UNASSIGNED_MCP_SECRET'), 'child': child.pid if child else None}
    emit({'jsonrpc':'2.0','id':message['id'],'result':{'content':[{'type':'text','text':json.dumps(text)}]}})
for line in sys.stdin:
    message = json.loads(line);method = message.get('method')
    if method == 'tools/call': threading.Thread(target=call,args=(message,),daemon=True).start();continue
    if 'id' not in message: continue
    if method == 'initialize': result={'protocolVersion':message['params']['protocolVersion'],'capabilities':{'tools':{}},'serverInfo':{'name':'stdio-fixture','version':'1'}}
    elif method == 'tools/list':
        names=['slow','child'] if message.get('params',{}).get('cursor') else ['echo']
        result={'tools':[{'name':name,'description':'Fixture '+(os.getenv('SERVICE_KEY') or ''),'inputSchema':{'type':'object','properties':{'marker':{'type':'string'}}}} for name in names]}
        if names == ['echo']: result['nextCursor']='second-page'
    else: result={}
    emit({'jsonrpc':'2.0','id':message['id'],'result':result})
