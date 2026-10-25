// TRIS-TODO top fix (10-25): a stuck reply never holds ChatGPT sign-in or sign-out again. The handover old chat's
// exit-Plan-mode request gets No without a prompt; a request Claude withdraws puts its reply back to running; the
// sign-out refusal names the chats; messages a restart left paused do not hold it. Claude CLI and DeepSeek fixtures.
import {_electron as electron} from 'playwright';import {spawn} from 'node:child_process';import {once} from 'node:events';import {createInterface} from 'node:readline';import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';import {mainWindow,pollState} from './fixtures/poll-state';
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/stuck-replies-')),folder=await fs.mkdtemp(path.join(root,'work/stuck-replies-files-')),host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','inherit']}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const launch=async()=>{const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env});await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});return app;};let app=await launch();
const haiku='claude-code:haiku';
try{
 let page=await mainWindow(app);page.setDefaultTimeout(15000);const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&s.claude?.models?.some(m=>m.id===haiku)===true);await call('wizardFinish');await call('workingFolder',{folder});
 const chat=async(name:string,model:string,mode:string)=>{const id=await call('addProject');await call('sidebarChat',{action:'rename',chatId:id,name});await call('addModel',{chatId:id,model});await call('mode',{projectId:(await call('state')).chats.find((c:any)=>c.id===id).projectId,mode});return id;};
 const submit=async(chatId:string,model:string,text:string)=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text,models:[model]});return id;};
 const finish=async(id:string)=>{const s=await pollState(page,s=>s.turns.some(t=>t.id===id&&['completed','failed','interrupted','stopped'].includes(t.status)));assert.equal(s.turns.find(t=>t.id===id)!.status,'completed');return s;};

 // 1. The old chat of a running handover: Claude's request to leave Plan mode gets No, no prompt, and the reply ends.
 const old=await chat('Handover old chat','claude-code:haiku','accept-edits');await finish(await submit(old,haiku,'Seed the work.'));
 const handover=await submit(old,haiku,'/handoff');await finish(handover);
 const fresh=await call('handoverStart',{chatId:old,turnId:handover,model:haiku});
 let state=await pollState(page,s=>s.turns.some(t=>t.chatId===fresh&&t.status==='completed')&&s.projects.find(p=>p.id===s.chats.find(c=>c.id===old)!.projectId)!.mode==='plan');
 const exit=await submit(old,haiku,JSON.stringify({action:'exit-plan'}));state=await finish(exit);
 assert.equal(state.approvals.some(a=>a.turnId===exit),false,'no exit-Plan-mode prompt in the handover old chat');
 // Outside a handover the same request still asks him.
 const control=await chat('Plain plan chat','claude-code:haiku','plan'),asked=await submit(control,haiku,JSON.stringify({action:'exit-plan'}));
 state=await pollState(page,s=>s.approvals.some(a=>a.turnId===asked&&a.status==='pending'));
 await call('approve',{id:state.approvals.find(a=>a.turnId===asked&&a.status==='pending')!.id,choice:'deny'});await finish(asked);
 await call('handoverClose',{chatId:old});

 // 2. Claude withdraws its own request: the approval expires and the reply is running again, not left waiting.
 const withdraw=await chat('Withdrawn request','claude-code:haiku','manual'),pending=await submit(withdraw,haiku,JSON.stringify({action:'withdraw-request',after:1500,hold:3000}));
 await pollState(page,s=>s.approvals.some(a=>a.turnId===pending&&a.status==='pending')&&s.turns.find(t=>t.id===pending)?.status==='waiting');
 state=await pollState(page,s=>s.approvals.some(a=>a.turnId===pending&&a.status==='expired'));
 assert.equal(state.turns.find(t=>t.id===pending)!.status,'running','a withdrawn request leaves its reply running');
 await finish(pending);

 // 3. The ChatGPT sign-out refusal names the chat that holds it.
 const slow=await chat('Slow chat','deepseek-flash','manual'),running=await submit(slow,'deepseek-flash','SLOW_FIXTURE');
 await pollState(page,s=>s.turns.find(t=>t.id===running)?.status==='running');
 await assert.rejects(call('codexDisconnect'),/switching ChatGPT accounts: “Slow chat”/);
 const queued=await submit(slow,'deepseek-flash','/compact');await pollState(page,s=>s.turns.find(t=>t.id===queued)?.status==='queued');

 // 4. After a restart the queued message waits paused for Send, and a paused message never holds the switch.
 await app.evaluate(({app})=>app.quit());await app.close();app=await launch();page=await mainWindow(app);
 state=await pollState(page,s=>s.backend==='ready'&&s.turns.find(t=>t.id===queued)?.paused===true);
 const signOut=await call('codexDisconnect').then(()=>'',error=>String(error));
 assert.doesNotMatch(signOut,/Stop or finish current replies/,'a paused message held the sign-out: '+signOut);
 console.log('PASS stuck replies: handover exit request, withdrawn request, named refusal, paused message.');
}catch(error){console.log('Stuck replies evidence: '+data);throw error;}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end();lines.close();await host.host('delete_key');}
