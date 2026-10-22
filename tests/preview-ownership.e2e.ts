// Isolated server and synthetic model replies; no account or production files.
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

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work','preview-ownership-')),folder=await fs.mkdtemp(path.join(root,'work','preview-workspace-')),site=path.join(folder,'site');await fs.mkdir(site,{recursive:true});
const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=(listener.address() as net.AddressInfo).port;await new Promise<void>(resolve=>listener.close(()=>resolve()));
const script=path.join(folder,'serve.py');await fs.writeFile(script,`from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler\nfrom functools import partial\nThreadingHTTPServer(('127.0.0.1',${port}),partial(SimpleHTTPRequestHandler,directory=${JSON.stringify(site)})).serve_forever()\n`);
const files=['index.html','style.css','app.js'].map(name=>path.join(site,name));for(const file of files)await fs.writeFile(file,'old');await fs.copyFile('assets/icon.png',path.join(folder,'icon.png'));
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const provider=spawn(PYTHON,['tests/fake_provider.py'],{windowsHide:true,stdio:'pipe'}),lines=createInterface({input:provider.stdout}),[line]=await once(lines,'line');
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath},timeout:30000});
try{
 await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
 const page=await mainWindow(app),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready');await call('wizardFinish');await call('workingFolder',{folder});const chat=await call('addProject'),foreign=await call('addProject');
 let state=await call('state');for(const id of [chat,foreign])await call('mode',{projectId:state.chats.find((c:any)=>c.id===id).projectId,mode:'bypass'});
 const send=async(chatId:string,text:string,models=['deepseek-flash'])=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text,models});const state=await pollState(page,s=>s.turns.some(t=>t.id===id&&['completed','failed'].includes(t.status)),90000);const turn=state.turns.find(t=>t.id===id)!;assert.equal(turn.status,'completed',turn.error||turn.text);return turn.text;};
 const tool=(chatId:string,name:string,args:any)=>send(chatId,'MCP_FIXTURE '+JSON.stringify({name,arguments:args}));
 await send(chat,'BACKGROUND_FIXTURE '+JSON.stringify({script,command:'python -u '+JSON.stringify(script),summary:'Static server observes site assets and owns its loopback port; it makes no file writes.',resources:[{kind:'path',value:site,access:'observe'},{kind:'port',value:'tcp:'+port,access:'write'}]}));
 state=await pollState(page,s=>s.background?.some(row=>row.chatId===chat&&row.status==='running')===true);const job=state.background.find((row:any)=>row.chatId===chat)!;
 assert.equal(await (await fetch('http://127.0.0.1:'+port)).text(),'old');
 const patch='*** Begin Patch\n'+files.map(file=>'*** Update File: '+file+'\n@@\n-old\n+replacement').join('\n')+'\n*** End Patch';
 const edit=await send(chat,'TOOL_SEQUENCE_FIXTURE '+JSON.stringify([...files.map(file=>({name:'read_file',arguments:{path:file}})),{name:'patch',arguments:{mode:'patch',patch}}]));
 assert.doesNotMatch(edit,/Background work owns|error/i);for(const file of files)assert.equal((await fs.readFile(file,'utf8')).trim(),'replacement');
 assert.equal((await (await fetch('http://127.0.0.1:'+port)).text()).trim(),'replacement');
 assert.doesNotMatch(await tool(chat,'create_app',{name:'Vid Drop',description:'Video frame picker for Illustrator.'}),/Background work owns|error/i);assert.ok((await fs.stat(path.join(folder,'Vid-Drop'))).isDirectory());
 await call('savedAppSave',{name:'Preview app'});assert.doesNotMatch(await tool(chat,'create_app',{name:'Preview app',icon_path:path.join(folder,'icon.png'),register_only:true}),/Background work owns|error/i);
 assert.match((await call('state')).savedApps.find((a:any)=>a.name==='Preview app').icon,/^data:image\/png;base64,/);
 // Force a fresh model runtime while the earlier session retains the server.
 const before=(await call('state')).chats.find((c:any)=>c.id===chat).runtimeId;await pollState(page,s=>s.claude?.connected===true);await call('addModel',{chatId:chat,model:'claude-code:haiku'});
 assert.match(await send(chat,JSON.stringify({action:'mcp',server:'ghidorah',tool:'background_process',arguments:{action:'list'}}),['claude-code:haiku']),new RegExp(job.processId));
 const interrupted=crypto.randomUUID();await call('submit',{id:interrupted,chatId:chat,text:'SLOW_FIXTURE',models:['deepseek-flash']});await pollState(page,s=>s.turns.some(t=>t.id===interrupted&&t.text.length>0));await call('stop',{chatId:chat});await pollState(page,s=>s.turns.some(t=>t.id===interrupted&&t.status==='stopped'));
 assert.match(await tool(chat,'background_process',{action:'list'}),new RegExp(job.processId));assert.notEqual((await call('state')).chats.find((c:any)=>c.id===chat).runtimeId,before);
 assert.match(await tool(foreign,'background_process',{action:'stop',id:job.id}),/unavailable in this chat/);assert.equal((await call('state')).background.find((r:any)=>r.id===job.id).status,'running');
 assert.match(await tool(chat,'background_process',{action:'stop',id:job.id}),/stopped/);state=await call('state');assert.equal(state.workReview.length,0,'Stopping an inspected read-only preview creates no global hold');await assert.rejects(fetch('http://127.0.0.1:'+port));
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({multiFilePatch:true,previewLiveEdits:true,iconUpdateWhileServing:true,sessionChanged:true,foreignStopDenied:true,stopOldSession:true,noFalseHold:true,noVisibleWindows:true},null,2));console.log('PASS preview edits, app-icon update, retained-session Stop and chat isolation. '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});provider.stdin.end('\n');lines.close();await host.host('delete_key');}
