// Real approval queues and wall clock; synthetic provider, isolated files and test credentials.
import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {Store} from '../app/store';
import {mainWindow,pollState} from './fixtures/poll-state';
import {launchPackaged} from './fixtures/launch-packaged';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/approval-wait-')),workspace=await fs.mkdtemp(path.join(root,'work/approval-workspace-'));
const seed=new Store(path.join(data,'chat.sqlite'));
seed.put('settings',{id:'working-folder',folder:workspace});
const projects=await Promise.all(['files','commands'].map(async name=>{const folder=path.join(workspace,name);await fs.mkdir(folder);return seed.project(folder);}));
const chats=projects.map(project=>{const chat=seed.chat(project.id);seed.update<any>('chat',chat.id,{pool:['deepseek-flash']});return chat;});seed.db.close();
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','inherit']}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url};
const packaged=process.env.TRISMEGISTUS_EXE?await launchPackaged(env):undefined,app=packaged?undefined:await electron.launch({args:[root,'--hidden'],env,timeout:60000});
console.log('Approval evidence: '+data);
try{
 if(app)await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};});
 const page=packaged?.page||await mainWindow(app!),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&s.connected);await call('wizardFinish');
 for(const project of projects)await call('mode',{projectId:project.id,mode:'manual'});
 for(const home of [path.join(data,'hermes'),...projects.map(project=>path.join(data,'hermes/profiles',project.profile))]){
  const config=JSON.parse(await fs.readFile(path.join(home,'config.yaml'),'utf8'));assert.equal(config.approvals.timeout,86400);assert.equal(config.approvals.mode,'manual');assert.equal(config.approvals.unattended_mode,'deny');
 }
 const send=async(chatId:string,name:string,args:any)=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text:'MCP_FIXTURE '+JSON.stringify({name,arguments:args}),models:['deepseek-flash']});return id;};
 const target=path.join(projects[0].folder!,'approved.txt');
 const fileTurn=await send(chats[0].id,'write_file',{path:target,content:'Approved after five minutes.'});
 const command={command:'echo approval-wait-command',workdir:projects[1].folder},commandTurn=crypto.randomUUID();
 await call('submit',{id:commandTurn,chatId:chats[1].id,text:'TOOL_SEQUENCE_FIXTURE '+JSON.stringify([
  {name:'tool_call',arguments:{calls:[{name:'inspect_action',arguments:{tool:'terminal',arguments:command,summary:'Echo prints a fixed literal; no files, subprocess services or external effects.',evidence:[],resources:[]}}]}},
  {name:'terminal',arguments:command}]),models:['deepseek-flash']});
 const waiting=await pollState(page,s=>[fileTurn,commandTurn].every(id=>s.approvals.some(a=>a.turnId===id&&a.status==='pending')));
 const approvals=[fileTurn,commandTurn].map(id=>waiting.approvals.find(a=>a.turnId===id&&a.status==='pending')!);
 const started=Date.now();
 for(let elapsed=0;elapsed<320000;elapsed=Date.now()-started){
  const state=await call('state');
  for(const approval of approvals)assert.equal(state.approvals.find((a:any)=>a.id===approval.id)?.status,'pending');
  for(const id of [fileTurn,commandTurn])assert.equal(state.turns.find((t:any)=>t.id===id)?.status,'waiting');
  assert.equal(await fs.stat(target).catch(()=>null),null,'File must not be written before approval');
  await page.waitForTimeout(Math.min(10000,320000-elapsed));
  console.log('Both approvals still pending at '+Math.round((Date.now()-started)/1000)+' seconds');
 }
 const waitedBeforeApprovalMs=Date.now()-started;
 for(const approval of approvals)await call('approve',{id:approval.id,choice:'once'});
 const completed=await pollState(page,s=>[fileTurn,commandTurn].every(id=>s.turns.some(t=>t.id===id&&t.status==='completed')));
 assert.equal(await fs.readFile(target,'utf8'),'Approved after five minutes.');
 assert.ok(completed.tools.some(t=>t.turnId===commandTurn&&t.status==='completed'&&JSON.stringify(t.result).includes('approval-wait-command')));
 for(const id of [fileTurn,commandTurn])assert.equal(completed.tools.filter(t=>t.turnId===id&&['terminal','write_file'].includes(t.name)).length,1,'Approved action executes once');
 for(const choice of ['deny','stop']){
  const blocked=path.join(projects[0].folder!,choice+'.txt'),id=await send(chats[0].id,'write_file',{path:blocked,content:'Must not be written.'});
  const state=await pollState(page,s=>s.approvals.some(a=>a.turnId===id&&a.status==='pending')),approval=state.approvals.find(a=>a.turnId===id&&a.status==='pending')!;
  if(choice==='deny')await call('approve',{id:approval.id,choice:'deny'});else await call('stop',{chatId:chats[0].id});
  const done=await pollState(page,s=>s.turns.some(t=>t.id===id&&['completed','stopped'].includes(t.status)));
  assert.equal(await fs.stat(blocked).catch(()=>null),null);assert.notEqual(done.approvals.find(a=>a.id===approval.id)?.status,'pending');
  await call('approve',{id:approval.id,choice:'once'});
  assert.equal((await call('state')).approvals.find((a:any)=>a.id===approval.id)?.status,done.approvals.find(a=>a.id===approval.id)?.status,'A stale click cannot revive the approval');
  assert.equal(await fs.stat(blocked).catch(()=>null),null);
 }
 const result={packaged:!!packaged,approvalTimeoutSeconds:86400,waitedBeforeApprovalMs,commandAndFileApproved:true,executedOnce:true,denialAndStopPreventedWrites:true,defaultAndTwoProjectProfilesVerified:true};
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify(result,null,2));console.log('PASS '+JSON.stringify(result));
}finally{if(app){await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}await packaged?.close();fake.stdin.end();lines.close();await host.host('delete_key');}
