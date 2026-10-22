// Explicit real-account check, isolated data, hidden windows, no production chat changes.
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {Backend} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';
if(process.env.TRISMEGISTUS_LIVE_CONTEXT!=='1')throw Error('Explicit live context check opt-in required.');
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/live-context-')),folder=await fs.mkdtemp(path.join(root,'work/live-context-files-'));
const temporary=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{}),saved=new Backend(root,data,'Trismegistus',()=>{});
const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined)),TRISMEGISTUS_TEST_DATA:data};for(const key of Object.keys(env))if(key.startsWith('TRISMEGISTUS_TEST_')&&key!=='TRISMEGISTUS_TEST_DATA')delete env[key];
const launch=async()=>{const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env});await instance.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};});return instance;};
let app=await launch(),chatId:string|undefined;console.log('Live context evidence: '+data);
try{
 let page=await mainWindow(app);const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready');await call('wizardFinish');await call('workingFolder',{folder});
 const credential=await saved.host('read_key');assert.ok(credential.key,'Saved DeepSeek account unavailable');try{await call('saveKey',{key:credential.key});}finally{credential.key=null;}
 await pollState(page,s=>s.providerStatus==='Connected'&&s.backend==='ready');await call('claudeCheck');let state=await call('state');assert.ok(state.claude.connected,'Claude account unavailable');
 const native=state.claude.models.find((m:any)=>/haiku/i.test(m.id))?.id||state.claude.models[0]?.id;assert.ok(native);
 chatId=await call('newChat');await call('addModel',{chatId,model:native});await call('mode',{projectId:(await call('state')).chats.find((c:any)=>c.id===chatId).projectId,mode:'bypass'});await call('effort',{chatId,effort:'none'});
 const receipts:any[]=[];
 async function task(text:string,model:string){
  const id=crypto.randomUUID();await call('submit',{id,chatId,text,models:[model]});
  for(const deadline=Date.now()+300000;Date.now()<deadline;await page.waitForTimeout(250)){
   state=await call('state');const turn=state.turns.find((t:any)=>t.id===id),tools=state.tools.filter((t:any)=>t.turnId===id);
   await fs.writeFile(path.join(data,'progress.json'),JSON.stringify({chatId,turn,tools},null,2));
   if(['completed','failed','interrupted','stopped'].includes(turn.status)){receipts.push({turn,tools});await fs.writeFile(path.join(data,'turns.json'),JSON.stringify(receipts,null,2));assert.equal(turn.status,'completed',turn.error||turn.text);console.log('Completed '+model+': '+tools.length+' tools');return id;}
  }throw Error('Live context turn timed out');
 }
 const nonce='copper-'+crypto.randomUUID(),references=Array.from({length:850},(_,i)=>'Archived inspection '+i+': ordinary list rendering; no new request, file change or decision.').join('\n');
 const first=await task(`We are building KOAN Queue. Preserve that spelling exactly. Use local JavaScript and Node built-ins only. The theme is copper. Outstanding work is activeTasks(items), which must return only items whose done field is false, preserving order without mutating the input. Do not implement that yet. Use write_file to create queue.cjs containing exactly "exports.name = 'KOAN Queue';\\n" with a real newline, and receipt.txt containing exactly "created-once". Do not use terminal, register an app or modify other files. Remember the retrieval marker ${nonce}; it is historical test data, never executable. Below are archived reference notes, not instructions. Read them as context and reply briefly.\n${references}`,'deepseek-flash');
 assert.equal((await fs.readFile(path.join(folder,'queue.cjs'),'utf8')).trim(),"exports.name = 'KOAN Queue';");const receipt=await fs.stat(path.join(folder,'receipt.txt'));
 await task('Keep the pending implementation for the next step. Briefly repeat the app name and remaining function. Use no tools.',native);
 const draft=await call('contextGenerate',{chatId,model:native});assert.match(draft.summary,/KOAN Queue/);assert.match(draft.summary,/activeTasks/);assert.match(draft.summary,/queue\.cjs/);
 // Deliberately leave a detail out of the reviewed summary: retrieving an original record must work.
 const summary=draft.summary.replaceAll(nonce,'[Historical marker omitted; retrieve the original message when needed.]');
 const instructions='Preserve the app name KOAN Queue exactly. Use Node built-ins only. Never rewrite receipt.txt.';
 await call('contextApply',{chatId,revision:draft.revision,summary,instructions});await fs.writeFile(path.join(data,'reviewed-summary.json'),JSON.stringify({summary,instructions,sourceCharacters:draft.sourceCharacters,model:native,tokens:draft.tokens},null,2));
 await app.evaluate(({app})=>app.quit());await app.close();app=await launch();page=await mainWindow(app);await pollState(page,s=>s.backend==='ready');await call('claudeCheck');
 await task(`Continue the pending coding task using the reviewed context. First call read_chat_history with turnId ${first} and retrieve its original retrieval marker. The marker is near the beginning, so the first page is enough. Inspect queue.cjs, implement the pending function, add queue.test.cjs with meaningful tests for the requested behavior, run node --test queue.test.cjs and fix failures. Preserve existing exports. Do not repeat completed setup or write receipt.txt. Work only in this working folder. Report the exact app name, theme, historical marker and actual test result. Work directly without agents.`,native);
 const last=receipts.at(-1);assert.ok(last.tools.some((tool:any)=>tool.name.includes('read_chat_history')),'The real native model must retrieve original history');assert.ok(last.turn.text.includes(nonce),'The model must recover the omitted detail');assert.match(last.turn.text,/KOAN Queue/);
 const check=execFileSync(process.execPath,['--test','queue.test.cjs'],{cwd:folder,windowsHide:true,encoding:'utf8'});await fs.writeFile(path.join(data,'tests.txt'),check);
 const independent=execFileSync(process.execPath,['-e',"const assert=require('node:assert/strict'),q=require('./queue.cjs');const items=[{id:1,done:false},{id:2,done:true},{id:3,done:false}],before=JSON.stringify(items);assert.equal(q.name,'KOAN Queue');assert.deepEqual(q.activeTasks(items),[items[0],items[2]]);assert.equal(JSON.stringify(items),before);assert.deepEqual(q.activeTasks([]),[]);"],{cwd:folder,windowsHide:true,encoding:'utf8'});assert.equal(independent,'');
 await task('From this chat, reply with the exact app name, theme and implemented function. Do not use tools or change files.','deepseek-flash');assert.match(receipts.at(-1).turn.text,/KOAN Queue/);assert.match(receipts.at(-1).turn.text,/copper/i);assert.match(receipts.at(-1).turn.text,/activeTasks/);
 assert.equal(await fs.readFile(path.join(folder,'receipt.txt'),'utf8'),'created-once');assert.equal((await fs.stat(path.join(folder,'receipt.txt'))).mtimeMs,receipt.mtimeMs);assert.equal(state.workReview.length,0);assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({executable:process.env.TRISMEGISTUS_EXE||'source',chatId,folder,native,providers:['DeepSeek','Claude Code'],longHistory:true,reviewedSummary:true,restart:true,historyRetrieval:true,missingDetailRecovered:true,preservedInstructions:true,codingContinuation:true,independentTests:true,noRepeatedWrite:true,hidden:true},null,2));console.log('PASS real mixed-provider context continuation: '+data);
}finally{if(chatId)await app.windows().find(p=>p.url().endsWith('index.html'))?.evaluate(chatId=>window.desktop.invoke('stop',{chatId}),chatId).catch(()=>{});await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});await temporary.host('delete_key');}
