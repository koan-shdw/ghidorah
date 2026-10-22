import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';import {once} from 'node:events';import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';import {mainWindow,pollState} from './fixtures/poll-state';
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/gemini-quota-')),folder=await fs.mkdtemp(path.join(root,'work/gemini-quota-files-')),host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});
await fs.writeFile(path.join(data,'health.json'),'{}');const fake=spawn(PYTHON,['tests/fake_api_providers.py',data],{windowsHide:true,stdio:'pipe'}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line'),endpoints=JSON.parse(line);
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_API_URLS:JSON.stringify({gemini:endpoints.gemini})};
const launch=async()=>{const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env});await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});return app;};
let app=await launch(),page=await mainWindow(app);const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
const requests=async()=>(await fs.readFile(path.join(data,'requests.jsonl'),'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
try{
 await pollState(page,s=>s.backend==='ready');await call('apiSave',{provider:'gemini',key:'synthetic-gemini-test-credential'});await pollState(page,s=>s.backend==='ready'&&s.apiProviders?.some(r=>r.provider==='gemini'&&r.source==='live')===true);
 await call('workingFolder',{folder});const chatId=await call('addProject'),model='api:gemini:gemini-3.8-flash';await call('addModel',{chatId,model});
 const send=async()=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text:'Remember copperfinch.',models:[model]});const s=await pollState(page,s=>s.turns.some(t=>t.id===id&&['failed','completed','interrupted','needs-model'].includes(t.status)));return s.turns.find(t=>t.id===id)!;};
 // Complete first-turn title generation before counting the refused reply.
 assert.equal((await send()).status,'completed');
 for(const mode of ['model-quota','account-quota']){
  await fs.writeFile(path.join(data,'health.json'),JSON.stringify({gemini:mode}));const before=(await requests()).length,turn=await send();assert.equal(turn.status,'failed');assert.equal((await requests()).length,before+1,'Known quota must not loop physical requests');
  let s=await call('state'),blocked=s.availability.filter((r:any)=>r.provider==='gemini'&&r.blocked);assert.equal(blocked.length,1);assert.equal(blocked[0].reason,'limit');assert.equal(blocked[0].scope,mode==='model-quota'?model:'account');assert.equal(blocked[0].resetAt,null);
  await fs.writeFile(path.join(data,'health.json'),'{}');await call('apiCheck',{provider:'gemini'});s=await call('state');assert.ok(!s.availableModels.includes(model));assert.equal((await requests()).length,before+1,'Catalogue checks must not send inference');
  await app.evaluate(({app})=>app.quit());await app.close();app=await launch();page=await mainWindow(app);await pollState(page,s=>s.backend==='ready');await call('apiCheck',{provider:'gemini'});s=await call('state');assert.ok(!s.availableModels.includes(model));assert.equal((await requests()).length,before+1);assert.equal(s.turns.find((t:any)=>t.id===turn.id).status,'failed');
  await call('apiRetry',{provider:'gemini'});assert.equal((await send()).status,'completed');console.log('PASS '+mode+': one request, persisted scope, no false reset, explicit recovery');
 }
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({modelQuota:true,accountQuota:true,noRepeatedPhysicalRequest:true,metadataPreservesRefusal:true,restart:true,explicitRetry:true,hidden:true},null,2));console.log('Evidence: '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end();lines.close();await host.host('delete_key',{provider:'gemini'});}
