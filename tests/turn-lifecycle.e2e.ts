// Real Electron + Hermes, synthetic provider; no production data or credentials.
import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {Store} from '../app/store';
import {DatabaseSync} from 'node:sqlite';
import {mainWindow,pollState} from './fixtures/poll-state';
import {launchPackaged} from './fixtures/launch-packaged';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/turn-lifecycle-')),folder=path.join(data,'workspace');await fs.mkdir(folder);
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const db=new Store(path.join(data,'chat.sqlite')),project=db.project(folder),history=db.chat(project.id);
db.put('settings',{id:'working-folder',folder});
// Match the reported account's history volume without using its contents.
if(process.env.STRESS_HISTORY==='1')db.transaction(()=>{for(let i=0;i<880;i++){const t=db.accept('old-'+i,history.id,'Previous request');db.update<any>('turn',t.id,{status:'completed',text:'Previous result'});for(let j=0;j<7;j++)db.put('tool',{id:t.id+':'+j,turnId:t.id,name:'read_file',args:{path:'old.txt'},result:'x'.repeat(5500),status:'completed'});}});
db.db.close();
const records=path.join(data,'requests.jsonl'),fake=spawn(PYTHON,['tests/fake_provider.py'],{cwd:root,env:{...process.env,FIXTURE_RECORDS:records},windowsHide:true,stdio:['pipe','pipe','inherit']}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url};
const packaged=process.env.TRISMEGISTUS_EXE?await launchPackaged(env):undefined,app=packaged?undefined:await electron.launch({args:[root,'--hidden'],env,timeout:60000});
const started=Date.now();console.log('Lifecycle evidence: '+data);
try{
 if(app)await app.evaluate(({app,BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.webContents.setBackgroundThrottling(false);app.on('browser-window-created',(_e,w)=>w.webContents.setBackgroundThrottling(false));BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};});
 const page=packaged?.page||await mainWindow(app!),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await page.evaluate(()=>{const metrics={stateMessages:0,streamMessages:0,stateBytes:0,maxStreamBytes:0};(window as any).streamMetrics=metrics;window.desktop.subscribe(state=>{metrics.stateMessages++;if(!metrics.stateBytes)metrics.stateBytes=new TextEncoder().encode(JSON.stringify(state)).length;},updates=>{metrics.streamMessages++;metrics.maxStreamBytes=Math.max(metrics.maxStreamBytes,new TextEncoder().encode(JSON.stringify(updates)).length);});});
 await pollState(page,s=>s.backend==='ready'&&s.connected);await call('wizardFinish');
 const a=await call('newChat'),b=await call('newChat');
 const send=async(chatId:string,text:string)=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text,models:['deepseek-flash']});return id;};
 const first=await send(a,'SLOW_FIXTURE');await pollState(page,s=>s.turns.some(t=>t.id===first&&t.text.length>20));console.log('First chat streaming');
 const second=await send(b,'Second chat must complete during the first reply');
 const queued=await send(a,'Queued follow-up must complete');
 const state=await pollState(page,s=>s.turns.some(t=>t.id===second&&t.status==='completed'),60000);
 assert.ok(['running','completed'].includes(state.turns.find(t=>t.id===first)!.status));console.log('Concurrent chat completed');
 const stopStart=Date.now();await call('stop',{chatId:a});await pollState(page,s=>s.turns.some(t=>t.id===first&&['stopped','completed'].includes(t.status)),10000);
 const stopMs=Date.now()-stopStart;assert.ok(stopMs<10000,'Stop must release the reply');
 await pollState(page,s=>s.turns.some(t=>t.id===queued&&t.status==='completed'),60000);
 const starting=await call('newChat'),cancelled=await send(starting,'CANCEL_BEFORE_PROVIDER');
 const read=new DatabaseSync(path.join(data,'chat.sqlite'),{readOnly:true});let sawSessionSetup=false;
 try{for(const end=Date.now()+15000;Date.now()<end;){const row=read.prepare("SELECT data FROM records WHERE kind='turn' AND id=?").get(cancelled) as {data:string};const turn=JSON.parse(row.data);if(turn.preparation==='Opening model session'&&turn.status==='dispatching'){sawSessionSetup=true;break;}if(turn.status==='running'||turn.status==='completed')break;await new Promise(r=>setTimeout(r,10));}}finally{read.close();}
 assert.ok(sawSessionSetup,'Exercise Stop during actual session setup');const setupStopAt=Date.now();await call('stop',{chatId:starting});
 await pollState(page,s=>s.turns.some(t=>t.id===cancelled&&t.status==='stopped'),5000);const setupStopMs=Date.now()-setupStopAt;assert.ok(setupStopMs<5000);
 assert.doesNotMatch(await fs.readFile(records,'utf8'),/CANCEL_BEFORE_PROVIDER/,'Cancelled setup must not submit a model request');
 const stream=await page.evaluate(()=>(window as any).streamMetrics);assert.ok(stream.streamMessages>0,'The actual app must use incremental stream updates');assert.ok(stream.maxStreamBytes<10000,'Streaming must not copy historical tool results');
 const result={pass:true,stopMs,setupStopMs,totalMs:Date.now()-started,largeHistory:process.env.STRESS_HISTORY==='1',packaged:!!packaged,stream};await fs.writeFile(path.join(data,'verified.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{if(app){await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}await packaged?.close();fake.stdin.end();lines.close();await host.host('delete_key');}
