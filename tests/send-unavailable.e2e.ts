import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {mainWindow,pollState} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/send-unavailable-'));
await fs.writeFile(path.join(data,'health.json'),JSON.stringify({claude:'exhausted'}));
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath}});
try{
 await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
 const page=await mainWindow(app),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&s.claude?.status==='Signed in');await call('wizardFinish');
 const chatId=await call('newChat'),model='claude-code:haiku',text='Keep this draft until the account is available.';
 await call('addModel',{chatId,model});await call('draft',{chatId,text});
 const before=await call('state');assert.equal(before.availableModels.length,0);assert.ok(before.claude.connected);
 for(const models of [[model],[]]){
  await assert.rejects(call('submit',{id:crypto.randomUUID(),chatId,text,models}),error=>{assert.match(String(error),/Usage limit reached/);assert.match(String(error),/resets/);assert.doesNotMatch(String(error),/Connect an available model/);return true;});
 }
 let state=await call('state');assert.equal(state.chats.find((c:any)=>c.id===chatId).draft,text);assert.equal(state.turns.length,before.turns.length);assert.equal(state.workReview.length,0);
 const requests=()=>fs.readFile(path.join(data,'claude-requests.jsonl'),'utf8').then(text=>text.trim().split('\n').filter(Boolean),()=>[]);
 assert.equal((await requests()).length,0,'A blocked send must not consume a model request');
 await fs.writeFile(path.join(data,'health.json'),JSON.stringify({claude:'ready'}));await call('claudeCheck');
 await pollState(page,s=>s.availableModels?.includes(model)===true);
 const id=crypto.randomUUID();await call('submit',{id,chatId,text,models:[model]});
 state=await pollState(page,s=>s.turns.some(t=>t.id===id&&['completed','failed'].includes(t.status)));
 assert.equal(state.turns.find((t:any)=>t.id===id).status,'completed');assert.equal((await requests()).length,1);
 assert.match((await requests())[0],/Chat goal: not set/,'Native Claude must receive the current goal state');
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({explicitLimitReason:true,automaticLimitReason:true,resetTime:true,draftPreserved:true,noBlockedRequests:true,noBlockedTurns:true,explicitRecovery:true,hidden:true},null,2));
 console.log('PASS connected-but-exhausted sends explain limits, preserve drafts and make no model request. '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
