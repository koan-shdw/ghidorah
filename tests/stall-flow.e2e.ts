// Isolated desktop, synthetic provider and files; never opens the user's chat database.
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

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/stall-flow-')),folder=path.join(data,'workspace');await fs.mkdir(folder);
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const store=new Store(path.join(data,'chat.sqlite')),project=store.project(folder),history=store.chat(project.id);store.put('settings',{id:'working-folder',folder});store.update<any>('project',project.id,{mode:'bypass'});store.update<any>('chat',history.id,{autoCompact:false,pool:['deepseek-flash']});
const body=Array.from({length:180},(_,i)=>`${i} ${'Source evidence: alpha beta gamma delta epsilon zeta eta theta. '.repeat(4)}`).join('\n');
store.transaction(()=>{for(let i=0;i<250;i++){const turn=store.accept('history-'+i,history.id,'Saved request '+i);store.update<any>('turn',turn.id,{status:'completed',text:'Saved answer '+i});for(let j=0;j<3;j++)store.put('tool',{id:turn.id+':'+j,turnId:turn.id,name:'read_file',args:{path:'evidence.txt'},result:body,status:'completed'});}});store.db.close();
const steps=[];for(let i=0;i<32;i++){const file=path.join(folder,`source-${i}.txt`);await fs.writeFile(file,body);steps.push({name:'read_file',arguments:{path:file}});}
const records=path.join(data,'requests.jsonl'),fake=spawn(PYTHON,['tests/fake_provider.py'],{cwd:root,env:{...process.env,FIXTURE_RECORDS:records,FIXTURE_MEASURE_CONTEXT:'1'},windowsHide:true,stdio:['pipe','pipe','inherit']}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url};
const packaged=process.env.TRISMEGISTUS_EXE?await launchPackaged(env):undefined,app=packaged?undefined:await electron.launch({args:[root,'--hidden'],env,timeout:60000});
console.log('Stall flow evidence: '+data);
try{
 if(app)await app.evaluate(({app,BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.webContents.setBackgroundThrottling(false);app.on('browser-window-created',(_e,w)=>w.webContents.setBackgroundThrottling(false));BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};});
 const page=packaged?.page||await mainWindow(app!),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});page.setDefaultTimeout(60000);
 await pollState(page,s=>s.backend==='ready'&&s.connected);await call('wizardFinish');
 const opened=Date.now();await call('openMainChat',{chatId:history.id});await page.locator('[data-turn-id="history-249"]').waitFor();
 const openMs=Date.now()-opened,render=await page.evaluate(async()=>{const samples:number[]=[];let previous=performance.now();for(let i=0;i<30;i++){await new Promise(resolve=>setTimeout(resolve,0));const now=performance.now();samples.push(now-previous);previous=now;}return {nodes:document.querySelectorAll('*').length,textCharacters:document.body.textContent!.length,maxTimerMs:Math.max(...samples),p95TimerMs:samples.sort((a,b)=>a-b)[28]};});
 console.log(JSON.stringify({openMs,render}));assert.ok(render.textCharacters<250000,'Closed tools must not mount megabytes of output');
 const disclosure=page.locator('[data-turn-id="history-249"] .activity-group');await disclosure.locator(':scope > summary').click();await disclosure.locator('.activity-body').first().waitFor({state:'attached'});assert.match(await disclosure.textContent()||'',/Source evidence/);await disclosure.locator(':scope > summary').click();if(process.env.STALL_RENDER_ONLY==='1'){await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({openMs,render}));}
 else{
  const config=JSON.parse(await fs.readFile(path.join(data,'hermes','profiles',project.profile,'config.yaml'),'utf8'));assert.deepEqual(config.compression,{threshold:.85,codex_gpt55_autoraise:false,proactive_prune_tokens:48000,proactive_prune_min_result_chars:8000,proactive_prune_min_reclaim_tokens:4096});
  const chatId=history.id;await call('mode',{projectId:(await call('state')).chats.find((c:any)=>c.id===chatId).projectId,mode:'bypass'});
  const id=crypto.randomUUID(),started=Date.now();await call('submit',{id,chatId,text:'Keep approved wording ANCHOR_EXACT. TOOL_SEQUENCE_FIXTURE '+JSON.stringify(steps),models:['deepseek-flash']});
  const queued=crypto.randomUUID();await pollState(page,s=>s.tools.some(t=>t.turnId===id));await call('submit',{id:queued,chatId,text:'Continue after the file inspection.',models:['deepseek-flash']});
  const state=await pollState(page,s=>s.turns.some(t=>t.id===queued&&['completed','failed','interrupted'].includes(t.status)),240000);
  assert.equal(state.turns.find(t=>t.id===id)!.status,'completed');assert.equal(state.turns.find(t=>t.id===queued)!.status,'completed');assert.equal(state.tools.filter(t=>t.turnId===id).length,32);
  const requests=(await fs.readFile(records,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),sizes=requests.map(r=>JSON.stringify(r.messages).length),pruned=requests.some(r=>JSON.stringify(r.messages).includes('Duplicate tool output — same content as a more recent call'));
  assert.equal(pruned,true,'Actual long-turn context must use the configured pruning');assert.ok(requests.filter(r=>r.messages.some((m:any)=>m.role==='user'&&String(m.content).includes('TOOL_SEQUENCE_FIXTURE'))).every(r=>JSON.stringify(r.messages).includes('ANCHOR_EXACT')));
  assert.equal(state.tools.filter(t=>t.turnId===id&&JSON.stringify(t.result).length>8000).length,32,'Original tool bodies remain saved');
  const verified={openMs,render,estimatedPromptTokens:sizes.map(n=>Math.round(n/4)),pruningDrops:sizes.flatMap((n,i)=>i&&n<sizes[i-1]-10000?[{request:i,savedCharacters:sizes[i-1]-n}]:[]),longTurnMs:Date.now()-started,toolRounds:32,pruned,requestCharacters:sizes,originalsPreserved:true,queuedCompleted:true,packaged:!!packaged};await fs.writeFile(path.join(data,'verified.json'),JSON.stringify(verified,null,2));console.log(JSON.stringify(verified));
 }
}finally{if(app){await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}await packaged?.close();fake.stdin.end();lines.close();await host.host('delete_key');}
