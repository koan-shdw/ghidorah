import {mainWindow} from './fixtures/poll-state';
import {_electron as electron,type Page} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','background-work-')),folder=await fs.mkdtemp(path.join(root,'work','background-workspace-'));
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const records=path.join(data,'requests.jsonl'),fake=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:records},windowsHide:true,stdio:'pipe'}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env,timeout:30000});let app=await launch(),page:Page;
const port=async()=>{const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const number=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return number;};
const specs:{name:string;port:number;script:string;command:string;summary:string;resources:{kind:string;value:string;access:string}[]}[]=[];
for(const name of ['alpha','beta','side']){
 const number=await port(),script=name+'.py';
 await fs.writeFile(path.join(folder,script),`from http.server import HTTPServer, BaseHTTPRequestHandler\nfrom pathlib import Path\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200);self.end_headers();self.wfile.write(b'${name}-alive')\n def log_message(self,*args): pass\nPath('${name}.started').write_text('started once')\nprint('${name}-private-output',flush=True)\nHTTPServer(('127.0.0.1',${number}),Handler).serve_forever()\n`);
 specs.push({name,port:number,script,command:'python -u '+script,summary:'Read the Python server: it writes one startup marker, observes the source tree and owns one localhost listener.',resources:[{kind:'path',value:script,access:'observe'},{kind:'path',value:name+'.started',access:'write'},{kind:'port',value:'tcp:'+number,access:'write'}]});
}
await fs.writeFile(path.join(folder,'bounded.py'),"from pathlib import Path\nPath('bounded.result').write_text('completed once')\nprint('bounded-complete',flush=True)\n");
const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
const approved=new Set<string>();
const wait=async(predicate:(state:any)=>boolean)=>{const until=Date.now()+90000;while(Date.now()<until){const state=await call('state');if(predicate(state))return state;for(const item of state.approvals.filter((a:any)=>a.status==='pending'))if(!approved.has(item.id)){approved.add(item.id);await call('approve',{id:item.id,choice:'once'});}await page.waitForTimeout(100);}throw Error('Timed out: '+JSON.stringify((await call('state')).turns));};
const done=(id:string)=>wait(s=>s.turns.some((t:any)=>t.id===id&&['completed','failed','interrupted'].includes(t.status)));
const send=async(chatId:string,text:string,models=['deepseek-flash'])=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text,models});await done(id);return id;};
const healthy=async(spec:typeof specs[number])=>assert.equal(await (await fetch('http://127.0.0.1:'+spec.port)).text(),spec.name+'-alive');
try{
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));page=await mainWindow(app);await wait(s=>s.backend==='ready'&&s.claude?.connected);await call('workingFolder',{folder});
 const a=await call('addProject'),b=await call('addProject');
 const alpha=await send(a,'BACKGROUND_FIXTURE '+JSON.stringify(specs[0]));let state=await wait(s=>s.background?.some((r:any)=>r.turnId===alpha&&r.status==='running'));
 const alphaRow=state.background.find((r:any)=>r.turnId===alpha);assert.equal(state.turns.find((t:any)=>t.id===alpha).status,'completed');await healthy(specs[0]);
 const beta=await send(b,'BACKGROUND_FIXTURE '+JSON.stringify(specs[1]));state=await wait(s=>s.background?.some((r:any)=>r.turnId===beta&&r.status==='running'));const betaRow=state.background.find((r:any)=>r.turnId===beta);await healthy(specs[1]);
 // A new model can change an observed source file while the server stays live.
 await call('addModel',{chatId:a,model:'claude-code:haiku'});const changedSource=(await fs.readFile(path.join(folder,'alpha.py'),'utf8'))+'\n# Native edit while serving\n';const edit=await send(a,JSON.stringify({action:'write',path:'alpha.py',readFirst:true,content:changedSource}),['claude-code:haiku']);
 assert.equal(await fs.readFile(path.join(folder,'alpha.py'),'utf8'),changedSource);await healthy(specs[0]);
 const bounded=await send(b,'BACKGROUND_FIXTURE '+JSON.stringify({script:'bounded.py',command:'python -u bounded.py',summary:'Read the script: writes one result file, prints completion and exits normally.',resources:[{kind:'path',value:'bounded.result',access:'write'}]}));state=await wait(s=>s.background.some((r:any)=>r.turnId===bounded&&r.status==='exited'&&r.exitCode===0));assert.equal(await fs.readFile(path.join(folder,'bounded.result'),'utf8'),'completed once');
 // Exact duplicate launch and a different command claiming the same port both stop before execution.
 const duplicate=await send(a,'BACKGROUND_FIXTURE '+JSON.stringify(specs[0]));state=await call('state');assert.match(JSON.stringify(state.tools.filter((t:any)=>t.turnId===duplicate)),/Background work owns|already has a running background/);
 const collision=await send(b,'BACKGROUND_FIXTURE '+JSON.stringify({...specs[1],command:specs[1].command+' collision',resources:[{kind:'port',value:'tcp:'+specs[0].port,access:'write'}]}));state=await call('state');assert.match(JSON.stringify(state.tools.filter((t:any)=>t.turnId===collision)),/Background work owns/);await healthy(specs[0]);await healthy(specs[1]);
 assert.equal(state.background.filter((r:any)=>r.status==='running').length,2);assert.equal(state.workReview.length,0,'normal exit and pre-execution refusals are not uncertain effects');
 // Exercise actual process card and Stop, with the other server left running.
 await page.evaluate(id=>localStorage.setItem('chat',id),a);await page.reload();await page.waitForTimeout(300);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());
 // Select the owning chat through its sidebar label when reload keeps a different chat.
 const title=state.chats.find((c:any)=>c.id===a).title;await page.locator('.chat-link').filter({hasText:title}).first().click();
 const card=page.locator(`[data-process-id="${alphaRow.id}"]`);await card.locator('summary').click();await card.getByRole('button',{name:'Stop process '+alphaRow.processId,exact:true}).click();await wait(s=>s.background.find((r:any)=>r.id===alphaRow.id)?.status==='stopped');await healthy(specs[1]);
 await page.screenshot({path:path.join(data,'background-status.png')});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());
 await assert.rejects(fetch('http://127.0.0.1:'+specs[0].port));assert.equal(await fs.readFile(path.join(folder,'alpha.started'),'utf8'),'started once');
 console.log('PASS persistent process cards, independent inspected servers/native file work, collision/duplicate refusal and UI Stop preserving the sibling');
 // A side window owns only its process and closing the view leaves it alive.
 const parent=await call('addProject');await call('addModel',{chatId:parent,model:'claude-code:haiku'});const group=await send(parent,'BACKGROUND_FIXTURE '+JSON.stringify(specs[2]),['deepseek-flash','claude-code:haiku']);
 state=await wait(s=>s.background.some((r:any)=>r.command===specs[2].command&&r.status==='running'));const sideRow=state.background.find((r:any)=>r.command===specs[2].command);
 await call('openJob',{id:sideRow.turnId});let side=app.windows().find(w=>w.url().endsWith('#job='+sideRow.chatId));for(const until=Date.now()+30000;!side&&Date.now()<until;side=app.windows().find(w=>w.url().endsWith('#job='+sideRow.chatId)))await page.waitForTimeout(100);assert.ok(side);await side.waitForFunction(()=>!!window.desktop);const sideState=await side.evaluate(()=>window.desktop.invoke('state'));assert.equal(sideState.background.length,1);
 await assert.rejects(side.evaluate(id=>window.desktop.invoke('backgroundStop',{id}),betaRow.id),/another job/);
 await side.evaluate(()=>window.desktop.invoke('window',{action:'close'})).catch(error=>{if(!String(error).includes('closed'))throw error;});await healthy(specs[2]);await call('openJob',{id:sideRow.turnId});await call('stop',{chatId:sideRow.chatId});await wait(s=>s.background.find((r:any)=>r.id===sideRow.id)?.status==='stopped');await healthy(specs[1]);
 console.log('PASS side-window process isolation, close/reopen without termination, and Stop after the model reply');
 // Crash the real app tree: keep the effect/receipt, lose the old handle, and do not replay.
 const before=(await fs.readFile(records,'utf8')).trim().split('\n').length;
 execFileSync('taskkill',['/PID',String(app.process().pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await app.close().catch(()=>{});app=await launch();page=await mainWindow(app);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));state=await wait(s=>s.backend==='ready');
 assert.equal(state.background.find((r:any)=>r.id===betaRow.id).status,'lost');assert.equal((await fs.readFile(records,'utf8')).trim().split('\n').length,before);await assert.rejects(fetch('http://127.0.0.1:'+specs[1].port));assert.equal(await fs.readFile(path.join(folder,'beta.started'),'utf8'),'started once');
 assert.deepEqual(state.workReview,[],'Work review is never shown; holds settle themselves (Koan 2026-10-06, 7efed60)');
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({backgroundSurvivesReply:true,independentResources:true,nativeIndependentWrite:edit,uiStop:true,sideOwnership:true,crashNoReplay:true,retainedEffect:true,workReviewNeverShown:true,group},null,2));console.log('PASS durable crash recovery, retained completed effects, Work review never shown. Evidence: '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end('\n');lines.close();await host.host('delete_key');}
