// Opt-in live API acceptance, isolated credentials and files, no visible windows.
import {_electron as electron,type ElectronApplication,type Page} from 'playwright';
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';
import {Backend} from '../app/backend';import {mainWindow,pollState} from './fixtures/poll-state';
import {isApiProvider} from '../app/api-catalog';
import {modelEfforts,newestFirst} from '../app/models';
if(process.env.TRISMEGISTUS_LIVE_API_CODING!=='1')throw Error('Explicit live API coding opt-in required.');
const provider=process.env.TRISMEGISTUS_LIVE_API_PROVIDER||'gemini';if(!isApiProvider(provider)||provider.endsWith('-oauth')||['vertex','nous'].includes(provider))throw Error('Choose an API-key supplier.');
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/live-api-coding-')),folder=await fs.mkdtemp(path.join(root,'work/live-api-files-'));
const saved=new Backend(root,data,'Trismegistus',()=>{}),temporary=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});
const env={...process.env,TRISMEGISTUS_TEST_DATA:data};for(const key of Object.keys(env))if(key.startsWith('TRISMEGISTUS_TEST_')&&key!=='TRISMEGISTUS_TEST_DATA')delete (env as any)[key];
const launch=async()=>{const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env});await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});return app;};
let app:ElectronApplication|undefined,page:Page,chatId='',model='';const results:any[]=[];
const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
async function task(name:string,text:string,onState?:(state:any,turn:any)=>Promise<void>){
 const id=crypto.randomUUID();await call('submit',{id,chatId,text,models:[model]});let stamp='';
 for(const end=Date.now()+6*60000;Date.now()<end;await page.waitForTimeout(300)){
  const state=await call('state'),turn=state.turns.find((t:any)=>t.id===id),tools=state.tools.filter((t:any)=>t.turnId===id);
  await fs.writeFile(path.join(data,'progress.json'),JSON.stringify({name,turn,tools,approvals:state.approvals,availability:state.availability,workReview:state.workReview},null,2));await onState?.(state,turn);
  if(!onState)assert.equal(state.approvals.some((a:any)=>a.status==='pending'),false,'Unexpected approval; inspect progress.json.');
  const next=JSON.stringify([turn?.status,tools.length]);if(next!==stamp){stamp=next;console.log(name+' '+next);}
  if(turn&&['completed','partial','failed','stopped','interrupted','needs-model'].includes(turn.status)){const result={name,turn,tools};results.push(result);await fs.writeFile(path.join(data,'results.json'),JSON.stringify(results,null,2));return result;}
 }
 throw Error('Live task remains unfinished; inspect the saved evidence before retrying.');
}
const tests="const t=require('node:test'),a=require('node:assert/strict'),{completeTask}=require('./tasks.cjs');t('complete target',()=>a.deepEqual(completeTask([{id:1,title:'A',done:false}],1),[{id:1,title:'A',done:true}]));t('preserve others',()=>a.deepEqual(completeTask([{id:1,done:false},{id:2,done:false}],2),[{id:1,done:false},{id:2,done:true}]));t('preserve fields',()=>a.deepEqual(completeTask([{id:'a',done:false,priority:3}],'a'),[{id:'a',done:true,priority:3}]));t('unknown id',()=>a.throws(()=>completeTask([{id:1}],2),/not found/i));t('immutable',()=>{const row=Object.freeze({id:1,done:false}),list=Object.freeze([row]);a.equal(completeTask(list,1)[0].done,true);a.equal(row.done,false);});t('idempotent',()=>{const result=completeTask([{id:1,done:true}],1);a.equal(result.length,1);a.equal(result[0].done,true);});\n";
const marker='BRIEF-'+crypto.randomUUID(),approvalMarker='approved-'+crypto.randomUUID(),original='Unrelated work stays unchanged.';
console.log('Live '+provider+' evidence: '+data);
try{
 await temporary.host('initialize');const credential=await saved.host('read_key',{provider});try{assert.ok(credential.key,'No connected API key for '+provider);await temporary.host('save_key',{provider,key:credential.key});}finally{credential.key=null;}
 await fs.writeFile(path.join(folder,'tasks.cjs'),"exports.completeTask=(tasks,id)=>tasks;\n");await fs.writeFile(path.join(folder,'tasks.test.cjs'),tests);await fs.writeFile(path.join(folder,'keep.txt'),original);
 app=await launch();page=await mainWindow(app);await pollState(page,s=>s.backend==='ready');await call('wizardFinish');await call('apiCheck',{provider});const state=await call('state'),connection=state.apiProviders.find((row:any)=>row.provider===provider);
 assert.ok(connection?.connected&&connection.source==='live');const models=newestFirst(connection.models.filter((m:any)=>!/(image|video|embedding|tts|audio|vision)/i.test(m.id)).map((m:any)=>({...m,supplier:provider,created:m.created||null})),id=>id);
 model=process.env.TRISMEGISTUS_LIVE_API_MODEL||models.find((m:any)=>/flash$/.test(m.id))?.id||models.find((m:any)=>/flash|fast/i.test(m.id))?.id||models[0]?.id;assert.ok(models.some((m:any)=>m.id===model),'Choose a model from the live catalogue.');
 await fs.writeFile(path.join(data,'catalogue.json'),JSON.stringify({provider,model,connection},null,2));console.log('Model '+model);
 await call('workingFolder',{folder});chatId=await call('addProject');await call('addModel',{chatId,model});await call('effort',{chatId,model,effort:Object.keys(modelEfforts(model))[0]});await call('mode',{projectId:(await call('state')).chats.find((c:any)=>c.id===chatId).projectId,mode:'bypass'});
 await call('attachmentAdd',{chatId,name:'brief.txt',bytes:new Uint8Array(Buffer.from('The verification word for your final reply is '+marker+'. Fix only tasks.cjs and preserve every other existing file.'))});
 const coding=await task('coding',`Fix completeTask in ${folder} so all six tests in tasks.test.cjs pass. Read the attached brief. Read the code and tests, edit only tasks.cjs, run node --test tasks.test.cjs in this folder, and report the actual result and the brief's verification word. Use Node built-ins, no dependencies, network or additional agents.`);
 assert.equal(coding.turn.status,'completed',coding.turn.error||coding.turn.text);assert.ok(coding.turn.text.includes(marker),'Attachment marker missing');assert.ok(coding.tools.some((t:any)=>/write_file|patch|edit_file/.test(t.name)&&t.status==='completed'));assert.ok(coding.turn.usage?.turn_total>0);
 await fs.writeFile(path.join(data,'tests.txt'),execFileSync(process.execPath,['--test','tasks.test.cjs'],{cwd:folder,windowsHide:true,encoding:'utf8'}));assert.equal(await fs.readFile(path.join(folder,'tasks.test.cjs'),'utf8'),tests);assert.equal(await fs.readFile(path.join(folder,'keep.txt'),'utf8'),original);
 await call('mode',{projectId:(await call('state')).chats.find((c:any)=>c.id===chatId).projectId,mode:'manual'});let approved=false;
 const approval=await task('approval',`Use write_file to create approval.txt in ${folder} with exactly ${approvalMarker}. Read it back and report the result. Use file tools only; no commands or other writes.`,async(state,turn)=>{
  const pending=state.approvals.find((a:any)=>a.turnId===turn.id&&a.status==='pending');if(!pending)return;
  const description=pending.params?.description;assert.ok(typeof description==='string'&&description.startsWith('write_file: '));const args=JSON.parse(description.slice(12));assert.equal(path.resolve(folder,args.path).toLowerCase(),path.join(folder,'approval.txt').toLowerCase());assert.equal(args.content.trim(),approvalMarker);await call('approve',{id:pending.id,choice:'once'});approved=true;
 });assert.equal(approval.turn.status,'completed',approval.turn.error);assert.equal(approved,true);const approvedBytes=await fs.readFile(path.join(folder,'approval.txt'),'utf8');assert.equal(approvedBytes.trim(),approvalMarker);
 let requestedStop=false;const stopped=await task('stop','Without using tools, write a long explanation of immutable data structures, with at least 30 numbered examples. Start the answer now.',async(_state,turn)=>{if(!requestedStop&&turn.text?.length>20&&turn.status==='running'){requestedStop=true;await call('stop',{chatId});}});assert.equal(requestedStop,true);assert.equal(stopped.turn.status,'stopped');
 await app.evaluate(({app})=>app.quit());await app.close();app=await launch();page=await mainWindow(app);await pollState(page,s=>s.backend==='ready');await call('apiCheck',{provider});const restored=await call('state');assert.equal(restored.apiProviders.find((row:any)=>row.provider===provider)?.connected,true);for(const result of results){const row=restored.turns.find((t:any)=>t.id===result.turn.id);assert.equal(row.status,result.turn.status);assert.deepEqual(row.usage,result.turn.usage);}assert.equal(await fs.readFile(path.join(folder,'approval.txt'),'utf8'),approvedBytes);assert.equal(restored.workReview.length,0);
 const continued=await task('continuation','Inspect the existing approval.txt file and reply with its content. Use only read_file; do not write, run commands, or repeat the completed task.');assert.equal(continued.turn.status,'completed',continued.turn.error);assert.ok(continued.turn.text.includes(approvalMarker));assert.equal(continued.tools.some((t:any)=>/write_file|patch|edit_file|terminal/.test(t.name)),false);
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({provider,model,chatId,folder,executable:process.env.TRISMEGISTUS_EXE||'source',liveCatalogue:true,apiKey:true,codingTests:6,textAttachment:true,approval:true,streamingCancellation:true,restart:true,usageRetained:true,continuation:true,hidden:true},null,2));console.log('PASS live API coding, attachment, approval, stop, restart and continuation: '+data);
}catch(error){await fs.writeFile(path.join(data,'failure.txt'),String(error));throw error;}finally{
 if(chatId&&app)await call('stop',{chatId}).catch(()=>{});if(app){await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}await temporary.host('delete_key',{provider});
}
