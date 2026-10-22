// A fresh session never waits for the first summary (RUN-PLAN 7b; 5b: a message waited ~2 min on 2026-10-08).
// A long Hermes chat switches to Claude: the Claude reply comes back while the summary is still being written.
import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/background-summary-')),folder=await fs.mkdtemp(path.join(root,'work/background-summary-files-'));
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','inherit']}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const app=await electron.launch({args:[root,'--hidden'],env,timeout:60000});
try{
 await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};});
 const page=await mainWindow(app);page.setDefaultTimeout(20000);const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&s.connected&&s.claude?.models?.some((m:any)=>m.id==='claude-code:haiku')===true);await call('wizardFinish');await call('workingFolder',{folder});
 const chatId=await call('newChat');await call('addModel',{chatId,model:'claude-code:haiku'});await call('mode',{projectId:(await call('state')).chats.find((c:any)=>c.id===chatId).projectId,mode:'bypass'});
 const send=async(text:string,model:string)=>{const id=crypto.randomUUID();await call('submit',{chatId,id,text,models:[model]});const state=await pollState(page,s=>s.turns.some(t=>t.id===id&&['completed','failed','interrupted','stopped'].includes(t.status)),90000);assert.equal(state!.turns.find(t=>t.id===id)!.status,'completed');return {id,state:state!};};
 // Long Hermes history; SLOW_FIXTURE makes the fake model stream slowly, so the summary of it takes several seconds.
 for(let n=0;n<3;n++)await send('SLOW_FIXTURE ANCHOR_BG_'+n+' '+'earlier context '.repeat(12000),'deepseek-flash');
 // Switching to Claude needs a fresh session: the reply must not wait for the summary.
 const {id,state}=await send('Newest task after the switch.','claude-code:haiku');
 assert.ok(state.chats.find((c:any)=>c.id===chatId)?.compacting,'the summary is still being written when the Claude reply is done');
 const requests=(await fs.readFile(path.join(data,'claude-requests.jsonl'),'utf8')).trim().split('\n').map(row=>JSON.parse(row));
 assert.doesNotMatch(JSON.stringify(requests.at(-1).content),/reviewed_summary/,'this reply went with recent history, not a summary');
 await pollState(page,s=>!s.chats.find((c:any)=>c.id===chatId)?.compacting,120000);
 assert.ok(id);console.log('PASS a fresh Claude session after a long Hermes chat answered while the summary was still being written: '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end();lines.close();await host.host('delete_key');}
