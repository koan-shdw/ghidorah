import {_electron as electron,type Page} from 'playwright';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','plugin-background-')),folder=await fs.mkdtemp(path.join(root,'work','plugin-workspace-')),source=path.join(data,'fixture-plugin');await fs.mkdir(source);
await fs.writeFile(path.join(source,'plugin.yaml'),JSON.stringify({name:'background-example',version:'1'}));
await fs.writeFile(path.join(source,'__init__.py'),`import json, time
from pathlib import Path
def register(ctx):
    def serve(arg):
        if arg=='ping': return 'COMMAND-READY'
        spec=json.loads(arg)
        args={'command':'python -u '+spec['script'], 'background':True}
        if not spec.get('unscoped'):
            read=ctx.dispatch_tool('read_file', {'path':spec['script']})
            inspected=ctx.dispatch_tool('inspect_action', {'tool':'terminal','arguments':args,'summary':'Read server: observes its source, appends its own startup marker and owns one local listener.','evidence':[spec['script']],'resources':[{'kind':'path','value':spec['script'],'access':'observe'},{'kind':'path','value':spec['name']+'.started','access':'write'},{'kind':'port','value':'tcp:'+str(spec['port']),'access':'write'}]})
            if 'error' in json.loads(inspected): raise RuntimeError(inspected)
        result=ctx.dispatch_tool('terminal',args)
        if spec.get('wait'):
            print('HANDLER-WAITING',flush=True)
            while True: time.sleep(0.1)
        return result
    ctx.register_command('serve',serve,description='Start a reviewed local server.')
`);
const port=async()=>{const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const number=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return number;};
const specs:{name:string;port:number;script:string}[]=[];
for(const name of ['alpha','beta','normal','waiting','quit']){
 const number=await port(),script=name+'.py';
 await fs.writeFile(path.join(folder,script),`from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
import os, threading
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(b'${name}-alive')
  if self.path=='/exit': threading.Thread(target=server.shutdown,daemon=True).start()
 def log_message(self,*args): pass
with Path('${name}.started').open('a') as file: file.write(str(os.getpid())+'\\n')
print('${name}-output',flush=True)
server=HTTPServer(('127.0.0.1',${number}),Handler)
server.serve_forever()
print('${name}-completed',flush=True)
`);
 specs.push({name,port:number,script});
}
const env={...process.env,TRISMEGISTUS_TEST_DATA:data},launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env,timeout:30000});let app=await launch(),page:Page;
const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
const approved=new Set<string>();
const wait=async(predicate:(s:any)=>boolean)=>{const until=Date.now()+90000;while(Date.now()<until){const s=await call('state');if(predicate(s))return s;for(const a of s.approvals.filter((a:any)=>a.status==='pending'))if(!approved.has(a.id)){approved.add(a.id);await call('approve',{id:a.id,choice:'once'});}await page.waitForTimeout(100);}throw Error('Timeout: '+JSON.stringify(await call('state')));};
const send=async(chatId:string,arg:unknown)=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text:'/background-example:serve '+(typeof arg==='string'?arg:JSON.stringify(arg))});return id;};
const done=async(id:string,status='completed')=>{const state=await wait(s=>s.turns.some((t:any)=>t.id===id&&['completed','interrupted','stopped'].includes(t.status)));const turn=state.turns.find((t:any)=>t.id===id);assert.equal(turn.status,status,turn.error);return turn;};
const healthy=async(spec:typeof specs[number])=>{let error;for(let i=0;i<100;i++){try{assert.equal(await (await fetch('http://127.0.0.1:'+spec.port)).text(),spec.name+'-alive');return;}catch(value){error=value;}await new Promise(resolve=>setTimeout(resolve,100));}throw error;};
const stopped=async(spec:typeof specs[number])=>{const pid=Number((await fs.readFile(path.join(folder,spec.name+'.started'),'utf8')).trim());for(let i=0;i<100;i++){try{process.kill(pid,0);}catch{await assert.rejects(fetch('http://127.0.0.1:'+spec.port));return;}await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Server survived owner shutdown: '+spec.name);};
try{
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));page=await app.firstWindow();await wait(s=>s.backend==='ready');await call('workingFolder',{folder});
 const a=await call('addProject'),b=await call('addProject'),review=await call('pluginRepositoryReview',{repository:'fixture/plugin'});await call('nativePluginInstall',{token:review.token});
 const alpha=await send(a,specs[0]);await done(alpha);let state=await wait(s=>s.background.some((r:any)=>r.turnId===alpha&&r.status==='running'));const alphaRow=state.background.find((r:any)=>r.turnId===alpha);assert.equal(alphaRow.engine,'plugin');assert.equal(state.approvals.filter((x:any)=>x.turnId===alpha&&x.status==='approved').length,2);await healthy(specs[0]);
 const beta=await send(b,specs[1]);await done(beta);state=await wait(s=>s.background.some((r:any)=>r.turnId===beta&&r.status==='running'));const betaRow=state.background.find((r:any)=>r.turnId===beta);assert.notEqual(alphaRow.generation,betaRow.generation);await healthy(specs[1]);
 assert.match((await done(await send(a,'ping'))).text,/COMMAND-READY/);await healthy(specs[0]);
 const blocked=await done(await send(a,{...specs[0],unscoped:true}),'interrupted');assert.match(blocked.error,/Background work owns|already has a running background/);
 await assert.rejects(call('restart'),/Stop active work/);
 await page.evaluate(id=>localStorage.setItem('chat',id),a);await page.reload();await page.waitForTimeout(300);if(await page.getByRole('button',{name:'Close settings',exact:true}).count())await page.getByRole('button',{name:'Close settings',exact:true}).click();state=await call('state');await page.locator('.chat-link').filter({hasText:state.chats.find((c:any)=>c.id===a).title}).first().click();
 const card=page.locator(`[data-process-id="${alphaRow.id}"]`);await card.locator('summary').click();await card.getByRole('button',{name:'Stop process '+alphaRow.processId,exact:true}).click();await wait(s=>s.background.find((r:any)=>r.id===alphaRow.id)?.status==='stopped');await stopped(specs[0]);await healthy(specs[1]);
 await page.screenshot({path:path.join(data,'plugin-background.png')});await call('inspectWork',{id:alphaRow.actionId,note:'Checked local server stopped and startup marker retained.'});
 console.log('PASS real plugin registry survives return, two owners, fresh command, approvals, conflicts and UI Stop preserving sibling');
 const normal=await send(a,specs[2]);await done(normal);await healthy(specs[2]);await fetch('http://127.0.0.1:'+specs[2].port+'/exit');state=await wait(s=>s.background.some((r:any)=>r.turnId===normal&&r.status==='exited'&&r.exitCode===0));await stopped(specs[2]);assert.equal(state.workReview.some((r:any)=>r.job===normal),false);
 const waiting=await send(a,{...specs[3],wait:true});await wait(s=>s.turns.find((t:any)=>t.id===waiting)?.text.includes('HANDLER-WAITING'));await healthy(specs[3]);await call('stop',{chatId:a});await done(waiting,'stopped');state=await wait(s=>s.background.some((r:any)=>r.turnId===waiting&&r.status==='stopped'));await stopped(specs[3]);await healthy(specs[1]);const waitingRow=state.background.find((r:any)=>r.turnId===waiting);await call('inspectWork',{id:waitingRow.actionId,note:'Checked local server stopped and marker retained.'});
 const main=await app.evaluate(()=>process.pid);execFileSync('taskkill',['/PID',String(main),'/F'],{windowsHide:true,stdio:'pipe'});await stopped(specs[1]);await app.close().catch(()=>{});app=await launch();page=await app.firstWindow();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));state=await wait(s=>s.backend==='ready'&&s.commands.filter((c:any)=>c.plugin!=='Ghidorah').length===1);
 assert.equal(state.background.find((r:any)=>r.id===betaRow.id).status,'lost');assert.equal(state.turns.find((t:any)=>t.id===beta).status,'completed');assert.equal((await fs.readFile(path.join(folder,'beta.started'),'utf8')).trim().split('\n').length,1);await call('inspectWork',{id:betaRow.actionId,note:'Checked dead server and retained marker after crash; do not replay.'});
 const quit=await send(a,specs[4]);await done(quit);await healthy(specs[4]);await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});await stopped(specs[4]);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({realHermesPlugin:true,backgroundAfterReturn:true,independentOwners:true,approvalAndConflict:true,uiStop:true,naturalExit:true,foregroundStop:true,mainCrashCleanup:true,restartNoReplay:true,gracefulQuitCleanup:true,folder},null,2));console.log('PASS natural exit, foreground Stop, main-process crash/no replay and graceful quit. '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
