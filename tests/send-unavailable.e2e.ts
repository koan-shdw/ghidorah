import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {mainWindow,pollState} from './fixtures/poll-state';

// Koan 2026-11-14: a full usage meter holds nothing; only Claude's own refusal holds a message. Before a refusal the
// message goes to Claude. After one, a send says why, keeps the draft and makes no request, until a usage check
// finds room again.
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/send-unavailable-')),healthFile=path.join(data,'health.json');
await fs.writeFile(healthFile,JSON.stringify({claude:'exhausted'}));
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath}});
try{
 await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
 const page=await mainWindow(app),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&s.claude?.status==='Signed in');await call('wizardFinish');
 const chatId=await call('newChat'),model='claude-code:haiku',text='Keep this draft until the account is available.';
 await call('addModel',{chatId,model});
 const requests=()=>fs.readFile(path.join(data,'claude-requests.jsonl'),'utf8').then(text=>text.trim().split('\n').filter(Boolean),()=>[]);
 const finished=async(id:string)=>(await pollState(page,s=>s.turns.some(t=>t.id===id&&['completed','failed'].includes(t.status)))).turns.find((t:any)=>t.id===id)!;

 // 1. The meter reads 100% and Claude has refused nothing: the model stays available and the message goes.
 const before=await call('state');assert.ok(before.claude.connected);
 assert.equal(before.claude.windows.find((row:any)=>row.label==='Current session').usedPercent,100);
 assert.ok(before.availableModels.includes(model),'A full meter does not hold a Claude message');
 const first=crypto.randomUUID();await call('submit',{id:first,chatId,text:'Answer while the meter is full.',models:[model]});
 assert.equal((await finished(first)).status,'completed');assert.equal((await requests()).length,1);
 assert.match((await requests())[0],/Chat goal: not set/,'Native Claude must receive the current goal state');

 // 2. Claude refuses, with no reset time: the model is held, and a send says why without spending a request.
 const refused=crypto.randomUUID();await call('submit',{id:refused,chatId,text:JSON.stringify({action:'limit'}),models:[model]});
 assert.equal((await finished(refused)).status,'failed');
 const held=await pollState(page,s=>s.availableModels?.length===0);assert.ok(held.claude.connected);
 const sent=(await requests()).length;await call('draft',{chatId,text});
 for(const models of [[model],[]]){
  await assert.rejects(call('submit',{id:crypto.randomUUID(),chatId,text,models}),error=>{assert.match(String(error),/Usage limit reached/);assert.doesNotMatch(String(error),/Connect an available model/);return true;});
 }
 let state=await call('state');assert.equal(state.chats.find((c:any)=>c.id===chatId).draft,text);assert.equal(state.turns.length,held.turns.length);
 assert.equal((await requests()).length,sent,'A blocked send must not consume a model request');

 // 3. A usage check that finds room lifts the hold, and the message goes.
 await fs.writeFile(healthFile,JSON.stringify({claude:'ready'}));await call('claudeCheck');
 await pollState(page,s=>s.availableModels?.includes(model)===true);
 const id=crypto.randomUUID();await call('submit',{id,chatId,text,models:[model]});
 assert.equal((await finished(id)).status,'completed');assert.equal((await requests()).length,sent+1);
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({fullMeterSends:true,refusalHolds:true,explicitLimitReason:true,draftPreserved:true,noBlockedRequests:true,noBlockedTurns:true,explicitRecovery:true,hidden:true},null,2));
 console.log('PASS a full meter sends, Claude\'s refusal holds with its reason, drafts stay and no request is spent, a usage check with room recovers. '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
