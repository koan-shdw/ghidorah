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

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/api-catalog-')),namespace='Trismegistus/Test/'+path.basename(data);
const media={gemini:['nano-banana-pro-preview','lyria-3.5'],xai:['grok-imagine-video-1.5']},coding={gemini:'gemini-3.8-flash',xai:'grok-4.6'};
const outage={gemini:'unknown',xai:'unknown'},host=new Backend(root,data,namespace,()=>{});
await fs.writeFile(path.join(data,'health.json'),JSON.stringify(outage));await host.host('initialize');
const server=spawn(PYTHON,['tests/fake_api_providers.py',data],{windowsHide:true,stdio:'pipe'}),lines=createInterface({input:server.stdout});server.stderr.on('data',b=>process.stderr.write(b));
const [line]=await once(lines,'line'),env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_API_URLS:line};
const store=new Store(path.join(data,'chat.sqlite'));
for(const provider of ['gemini','xai'] as const){
 await host.host('save_key',{provider,key:'synthetic-'+provider+'-test-credential'});
 store.put('api-connection',{id:provider,provider,connected:true,status:'Connected',source:'live',models:[coding[provider],...media[provider]].map(model=>({id:'api:'+provider+':'+model,label:model,vision:true,manual:model!==coding[provider],description:'Saved description'}))});
}
store.db.close();
const launch=async()=>{const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env,timeout:30000});await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});return app;};
let app=await launch();
try{
 let page=await mainWindow(app);
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const ready=()=>pollState(page,s=>s.backend==='ready'&&s.apiProviders?.filter(r=>r.connected).length===2,30000);
 const assertClean=(state:any)=>{for(const provider of ['gemini','xai'] as const){const row=state.apiProviders.find((r:any)=>r.provider===provider);assert.ok(row.models.some((m:any)=>m.id==='api:'+provider+':'+coding[provider]));for(const model of media[provider]){assert.ok(!row.models.some((m:any)=>m.id==='api:'+provider+':'+model));assert.ok(!state.availableModels.includes('api:'+provider+':'+model));}}};
 let state:any=await ready();assertClean(state);
 for(const provider of ['gemini','xai'] as const){
  await call('apiCheck',{provider});state=await call('state');const cached=state.apiProviders.find((r:any)=>r.provider===provider);
  assert.equal(cached.source,'cached');assert.equal(cached.models[0].description,'Saved description');assert.equal(cached.models[0].vision,true);
  for(const model of media[provider])await assert.rejects(()=>call('apiModel',{provider,model}),/supported chat model ID/);
 }
 await call('apiModel',{provider:'gemini',model:'gemini-future-chat'});
 await fs.writeFile(path.join(data,'health.json'),'{}');
 for(const provider of ['gemini','xai'])await call('apiCheck',{provider});
 state=await call('state');assertClean(state);assert.equal(state.apiProviders.find((r:any)=>r.provider==='gemini').source,'live');
 assert.ok(state.apiProviders.find((r:any)=>r.provider==='gemini').models.some((m:any)=>m.id==='api:gemini:gemini-future-chat'&&m.manual));
 // Save valid manual choices across restart while the supplier catalogue is unavailable.
 await fs.writeFile(path.join(data,'health.json'),JSON.stringify(outage));
 await app.evaluate(({app})=>app.quit());await app.close();app=await launch();page=await mainWindow(app);state=await ready();assertClean(state);
 assert.ok(state.availableModels.includes('api:gemini:gemini-future-chat'));
 assert.equal(await fs.readFile(path.join(data,'requests.jsonl'),'utf8').catch(()=>''),'','Model discovery must not send prompts');
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({checks:['cached-media-filter','cached-metadata-preserved','manual-media-rejected','live-media-filter','valid-manual-retained','offline-restart','zero-generation-requests','hidden'],packaged:!!process.env.TRISMEGISTUS_EXE},null,2));console.log('PASS '+data);
}finally{
 await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});server.stdin.end();lines.close();
 for(const provider of ['gemini','xai'])await host.host('delete_key',{provider});
 const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');
}
