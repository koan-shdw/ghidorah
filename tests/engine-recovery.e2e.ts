import {_electron as electron,type ElectronApplication,type Page} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {Store} from '../app/store';
import {mainWindow,pollState} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/engine-recovery-'));
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'requests.jsonl')},windowsHide:true,stdio:'pipe'});
const lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
let app!:ElectronApplication,page!:Page;
const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
async function launch(){
 app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:[...(process.env.TRISMEGISTUS_EXE?[]:[root]),'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url}});
 await app.evaluate(({app,BrowserWindow})=>{
  for(const w of BrowserWindow.getAllWindows())w.webContents.setBackgroundThrottling(false);
  app.on('browser-window-created',(_e,w)=>w.webContents.setBackgroundThrottling(false));
  BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};
 });
 page=await mainWindow(app);page.setDefaultTimeout(10000);
 await pollState(page,s=>s.backend==='ready'&&s.availableModels?.includes('deepseek-flash')===true);
}
try{
 await launch();await call('wizardFinish');
 const original=await call('newChat');
 await page.getByRole('button',{name:'Settings',exact:true}).first().click();
 await page.getByLabel('Default permission mode',{exact:true}).selectOption('bypass');
 await pollState(page,s=>s.defaultMode==='bypass');
 await page.getByLabel('Close settings',{exact:true}).click();
 const chatId=await call('newChat');
 const mode=(s:any,id:string)=>s.projects.find((p:any)=>p.id===s.chats.find((c:any)=>c.id===id).projectId).mode;
 let state=await call('state');assert.equal(mode(state,original),'manual');assert.equal(mode(state,chatId),'bypass');
 await assert.rejects(call('defaultPermissionMode',{mode:'invalid'}),/permission mode/);
 // Cancel a fresh Hermes turn before prompt submission; its replacement must drain by itself.
 const first=crypto.randomUUID(),second=crypto.randomUUID();
 await call('submit',{id:first,chatId,text:'Discard this initial request.',models:['deepseek-flash']});
 state=await call('state');assert.equal(state.turns.find((t:any)=>t.id===first).status,'dispatching');
 await call('correctGroup',{id:second,chatId,text:'Reply with the corrected result.'});
 state=await pollState(page,s=>s.turns.some(t=>t.id===second&&['completed','interrupted','failed'].includes(t.status)));
 assert.equal(state.turns.find((t:any)=>t.id===first).status,'stopped');assert.equal(state.turns.find((t:any)=>t.id===second).status,'completed');
 const requests=()=>fs.readFile(path.join(data,'requests.jsonl'),'utf8').then(text=>text.trim().split('\n').filter(Boolean));
 assert.equal((await requests()).length,1,'The cancelled preparation must not submit a provider request');
 console.log('PASS permission defaults and correction during preparation');
 const backendPid=JSON.parse(await fs.readFile(path.join(data,'locks/host-serve.json'),'utf8')).pid;
 const tree=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],{windowsHide:true,encoding:'utf8'}));
 const ancestors=new Set<number>();let pid=backendPid;
 while(pid&&!ancestors.has(pid)){ancestors.add(pid);pid=tree.find((p:any)=>p.ProcessId===pid)?.ParentProcessId;}
 assert.ok(ancestors.has(app.process().pid!),'Only stop this hidden test app backend');
 execFileSync('taskkill',['/PID',String(backendPid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
 await pollState(page,s=>s.backend==='failed');
 const count=(await call('state')).turns.length,before=await requests();
 await page.locator('[data-chat-id="'+chatId+'"] .chat-link').click();
 const draft='Keep this offline draft.';
 await page.getByRole('combobox',{name:'Message',exact:true}).fill(draft);
 assert.equal(await page.getByRole('button',{name:'Send',exact:true}).isDisabled(),true);
 await page.getByRole('combobox',{name:'Message',exact:true}).press('Enter');
 await assert.rejects(call('submit',{id:crypto.randomUUID(),chatId,text:draft,models:['deepseek-flash']}),/offline/);
 state=await call('state');assert.equal(state.turns.length,count);assert.equal(state.chats.find((c:any)=>c.id===chatId).draft,draft);assert.deepEqual(await requests(),before);
 const opened=app.waitForEvent('window');await call('openChatWindow',{chatId});
 const chatPage=await opened;
 await chatPage.getByRole('button',{name:'Restore connection',exact:true}).click();
 await pollState(page,s=>s.backend==='ready');
 assert.equal((await call('state')).chats.find((c:any)=>c.id===chatId).draft,draft);
 await chatPage.getByRole('button',{name:'Send',exact:true}).click();
 state=await pollState(page,s=>s.turns.length===count+1&&s.turns.at(-1)?.status==='completed');
 assert.equal((await requests()).length,before.length+1);
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 const settled=await requests();await app.close();
 const saved=new Store(path.join(data,'chat.sqlite'));
 saved.put('tool',{id:'oversized-old-result',turnId:second,name:'read_file',args:{path:'large-source.txt'},result:'LONG_SAVED_OUTPUT '.repeat(100000),status:'completed'});
 saved.update<any>('turn',second,{reasoning:'OLD_INTERNAL_REASONING '.repeat(30000)});
 // A lost session (a plugin or sign-in change drops it) needs a new one: the history it gets stays bounded. An uncertain
 // turn alone keeps its stored session (session-after-stop.e2e.ts).
 saved.put('engine',{...saved.enginePosition(chatId,'hermes'),sessionId:null,uncertain:true});saved.db.close();
 await launch();state=await call('state');assert.equal(state.defaultMode,'bypass');assert.equal(mode(state,original),'manual');
 assert.deepEqual(await requests(),settled,'Restart does not replay completed messages');
 await call('openMainChat',{chatId});
 await call('contextSettings',{chatId,autoCompact:false}); // Exercise the bounded fallback independently of automatic summaries.
 const continuation=crypto.randomUUID();await call('submit',{id:continuation,chatId,text:'Update the icon using the saved findings.',models:['deepseek-flash']});
 state=await pollState(page,s=>s.turns.some(t=>t.id===continuation&&['completed','failed','interrupted'].includes(t.status)));
 assert.equal(state.turns.find((t:any)=>t.id===continuation).status,'completed');
 const resumed=await requests();assert.equal(resumed.length,settled.length+1);
 const sent=JSON.parse(resumed.at(-1)!).messages.filter((m:any)=>m.role==='user').map((m:any)=>m.content).join('\n');
 assert.ok(sent.length<60000,'The restarted chat must not send the original megabytes');assert.match(sent,/oversized-old-result/);assert.match(sent,/read_chat_history/);assert.doesNotMatch(sent,/OLD_INTERNAL_REASONING/);
 assert.equal(state.tools.find((t:any)=>t.id==='oversized-old-result').result.length,'LONG_SAVED_OUTPUT '.repeat(100000).length);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({permissionSetting:true,newChatDefault:true,existingChatPreserved:true,invalidModeRejected:true,preparationCorrection:true,noCancelledRequest:true,offlineDraft:true,noOfflineRequest:true,detachedRestore:true,recoverySend:true,restart:true,hidden:true},null,2));
 console.log('PASS offline draft, blocked send, detached recovery and restart. '+data);
}finally{await app?.evaluate(({app})=>app.quit()).catch(()=>{});await app?.close().catch(()=>{});fake.stdin.end();lines.close();await host.host('delete_key');}
