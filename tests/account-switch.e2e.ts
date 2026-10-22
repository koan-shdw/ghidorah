// Synthetic accounts and loopback servers only. Production credentials stay untouched.
import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work','account-switch-')),folder=await fs.mkdtemp(path.join(root,'work','account-switch-workspace-'));
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const gpt=spawn(PYTHON,['tests/fake_codex.py',host.namespace,path.join(data,'requests.jsonl')],{env:host.environment(),windowsHide:true,stdio:'pipe'}),gptLines=createInterface({input:gpt.stdout});gpt.stderr.on('data',b=>process.stderr.write(b));
const [gptLine]=await once(gptLines,'line'),gptUrl=JSON.parse(gptLine).url;
const ds=spawn(PYTHON,['tests/fake_provider.py'],{windowsHide:true,stdio:'pipe'}),dsLines=createInterface({input:ds.stdout});const [dsLine]=await once(dsLines,'line');
const control=(value:any)=>fs.writeFile(path.join(data,'health.json'),JSON.stringify(value));
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CODEX_URL:gptUrl,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(dsLine).url},timeout:30000});
try{
 await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};for(const w of BrowserWindow.getAllWindows())w.webContents.setBackgroundThrottling(false);});
 const page=await mainWindow(app);page.setDefaultTimeout(10000);const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&!!s.codex?.models.includes('gpt-6-astra'));await call('wizardFinish');await call('workingFolder',{folder});const chatId=await call('addProject');
 await call('mode',{projectId:(await call('state')).chats.find((c:any)=>c.id===chatId).projectId,mode:'bypass'});await call('addModel',{chatId,model:'gpt-6-astra'});
 const send=async(text:string,model='gpt-6-astra')=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text,models:[model]});const s=await pollState(page,s=>s.turns.some(t=>t.id===id&&['completed','failed'].includes(t.status)));assert.equal(s.turns.find(t=>t.id===id)?.status,'completed');return id;};
 await send('Remember copperfinch.');const oldSession=(await call('state')).chats.find((c:any)=>c.id===chatId).runtimeId;
 const slow=crypto.randomUUID();await call('submit',{id:slow,chatId,text:'SLOW_GPT_FIXTURE',models:['gpt-6-astra']});await pollState(page,s=>s.turns.some(t=>t.id===slow&&!!t.text));
 await assert.rejects(call('codexDisconnect'),/Stop or finish current replies/);await assert.rejects(call('codexLogin'),/Stop or finish current replies/);
 await call('stop',{chatId});await pollState(page,s=>s.turns.some(t=>t.id===slow&&t.status==='stopped'));
 const listener=net.createServer().listen(0,'127.0.0.1');await once(listener,'listening');const port=(listener.address() as net.AddressInfo).port;await new Promise<void>(r=>listener.close(()=>r()));
 const script=path.join(folder,'serve.py');await fs.writeFile(script,`from http.server import HTTPServer, BaseHTTPRequestHandler\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write(b'preview stays alive')\nHTTPServer(('127.0.0.1',${port}),Handler).serve_forever()\n`);
 await send('BACKGROUND_FIXTURE '+JSON.stringify({script,command:'python -u '+JSON.stringify(script),summary:'Preview observes workspace and writes only its listening port.',resources:[{kind:'path',value:folder,access:'observe'},{kind:'port',value:'tcp:'+port,access:'write'}]}),'deepseek-flash');
 const before=await pollState(page,s=>s.background?.some(p=>p.status==='running')===true),job=before.background!.find(p=>p.status==='running')!;
 await call('openConnections');await page.getByLabel('Connection supplier',{exact:true}).first().click();await page.locator('.choice-options label').filter({hasText:/^OpenAI$/}).click();
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await pollState(page,s=>!s.codex?.connected&&s.codex?.status==='Not connected');
 let state=await call('state');assert.ok(!state.availableModels.includes('gpt-6-astra'));assert.equal(state.backend,'ready');assert.ok(state.turns.length>=3);assert.equal(await (await fetch('http://127.0.0.1:'+port)).text(),'preview stays alive');
 await control({account:'account-b',login:'pending'});await page.getByRole('button',{name:'Sign in with ChatGPT',exact:true}).click();await pollState(page,s=>!!s.codex?.login);
 await page.getByRole('button',{name:'Cancel sign-in',exact:true}).click();await pollState(page,s=>s.codex?.status==='Sign-in cancelled');assert.equal((await call('state')).codex.connected,false);
 await control({account:'account-b'});await page.getByRole('button',{name:'Sign in with ChatGPT',exact:true}).click();await pollState(page,s=>s.codex?.status==='Connected'&&!!s.codex.models.length);
 await page.keyboard.press('Escape');const reply=await send('What word did I ask you to remember?');state=await call('state');assert.match(state.turns.find((t:any)=>t.id===reply).text,/copperfinch/);assert.notEqual(state.chats.find((c:any)=>c.id===chatId).runtimeId,oldSession);
 assert.equal(JSON.parse((await fs.readFile(path.join(data,'requests.jsonl'),'utf8')).trim().split('\n').at(-1)!)._fixture_account,'account-b');
 assert.equal(state.background.find((p:any)=>p.id===job.id).status,'running');assert.equal(await (await fetch('http://127.0.0.1:'+port)).text(),'preview stays alive');
 await call('openConnections');await page.getByLabel('Connection supplier',{exact:true}).first().click();await page.locator('.choice-options label').filter({hasText:/^OpenAI$/}).click();
 await control({account:'account-c'});await page.getByRole('button',{name:'Switch account',exact:true}).click();await pollState(page,s=>s.codex?.status==='Connected');await page.keyboard.press('Escape');await send('Check the switched account.');
 assert.equal(JSON.parse((await fs.readFile(path.join(data,'requests.jsonl'),'utf8')).trim().split('\n').at(-1)!)._fixture_account,'account-c');
 await call('backgroundStop',{id:job.id});assert.equal((await call('state')).workReview.length,0);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({signOut:true,cancel:true,accountAtoBtoC:true,historyPreserved:true,activeReplyProtected:true,previewPreserved:true,noUncertainHolds:true},null,2));console.log('PASS account switch '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});gpt.stdin.end('\n');ds.stdin.end('\n');gptLines.close();dsLines.close();await host.host('delete_key');}

