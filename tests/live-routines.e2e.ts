// Paid real-model acceptance. Hidden, isolated profile; never changes the system clock.
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Backend} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';

if(process.env.TRISMEGISTUS_LIVE_ROUTINES!=='1')throw Error('Explicit live routines opt-in required.');
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/live-routines-')),folder=await fs.mkdtemp(path.join(root,'work/live-routine-files-'));
const namespace='Trismegistus/Test/'+path.basename(data),saved=new Backend(root,data,'Trismegistus',()=>{}),temporary=new Backend(root,data,namespace,()=>{});
const env={...process.env,TRISMEGISTUS_TEST_DATA:data};for(const key of Object.keys(env))if(key.startsWith('TRISMEGISTUS_TEST_')&&key!=='TRISMEGISTUS_TEST_DATA')delete (env as any)[key];
await fs.writeFile(path.join(folder,'keep.txt'),'Keep this unrelated file unchanged.');
const launch=async()=>{const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env});await instance.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});return instance;};
let app=await launch(),page=await mainWindow(app),routineId='',chatId='';
const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
const hidden=async()=>assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
const stop=async()=>{await app.evaluate(({app})=>app.quit());await app.close();};
const restart=async()=>{app=await launch();page=await mainWindow(app);await pollState(page,s=>s.backend==='ready');};
const firings=(state:any)=>state.turns.filter((turn:any)=>turn.routine?.id===routineId);
const lines=async()=>(await fs.readFile(path.join(folder,'runs.txt'),'utf8')).trim().split(/\r?\n/);
async function finish(count:number){
 for(const end=Date.now()+180000;Date.now()<end;await page.waitForTimeout(250)){
  const state=await call('state'),turns=firings(state);await fs.writeFile(path.join(data,'progress.json'),JSON.stringify({routine:state.routines.find((r:any)=>r.id===routineId),turns,tools:state.tools.filter((t:any)=>turns.some((turn:any)=>turn.id===t.turnId)),approvals:state.approvals,workReview:state.workReview},null,2));
  assert.equal(state.approvals.some((a:any)=>a.status==='pending'),false,'Unexpected approval');assert.ok(turns.length<=count,'Duplicate firing');
  const failed=turns.find((t:any)=>['failed','stopped','interrupted','partial','needs-model'].includes(t.status));assert.equal(failed,undefined,'Scheduled work failed; see progress.json');
  if(turns.length===count&&turns.every((t:any)=>t.status==='completed')){assert.equal(state.workReview.length,0);assert.equal(state.chats.find((c:any)=>c.id===chatId).draft,'Unsent desktop draft');assert.deepEqual(await lines(),Array(count).fill('scheduled-run'));await hidden();return state;}
 }
 throw Error('Scheduled task did not finish; see progress.json');
}
// Simulate saved schedule state only after this isolated app is fully stopped.
function savedSchedule(patch:Record<string,unknown>){const db=new DatabaseSync(path.join(data,'chat.sqlite'));try{const row=db.prepare("SELECT data FROM records WHERE kind='routine' AND id=?").get(routineId) as any;assert.ok(row);db.prepare("UPDATE records SET data=? WHERE kind='routine' AND id=?").run(JSON.stringify({...JSON.parse(row.data),...patch}),routineId);}finally{db.close();}}
console.log('Live routine evidence: '+data);
try{
 await pollState(page,s=>s.backend==='ready');await call('wizardFinish');await call('workingFolder',{folder});const credential=await saved.host('read_key');try{assert.ok(credential.key);await call('saveKey',{key:credential.key});}finally{credential.key=null;}await pollState(page,s=>s.backend==='ready'&&s.providerStatus==='Connected');
 chatId=await call('addProject');await call('mode',{projectId:(await call('state')).chats.find((c:any)=>c.id===chatId).projectId,mode:'bypass'});await call('modelSelection',{chatId,model:'deepseek-flash',selected:true});await call('effort',{chatId,effort:'none'});await call('draft',{chatId,text:'Unsent desktop draft'});
 await call('alwaysOn',{stayAwake:'always'});assert.equal((await call('state')).alwaysOn.awake,true);await call('alwaysOn',{stayAwake:'off'});assert.equal((await call('state')).alwaysOn.awake,false);
 const prompt=`In ${folder}, use a terminal command to append exactly one line, scheduled-run, to runs.txt, creating it if needed. Read the file to verify the append and report the total number of lines. Preserve existing lines and keep.txt. Use Node built-ins. Do not install anything, use agents or touch other folders.`;
 routineId=await call('routineSave',{name:'Real scheduled append',chatId,prompt,schedule:{kind:'cron',line:'* * * * *'}});
 const due=(await call('state')).routines.find((r:any)=>r.id===routineId).nextFiring;assert.ok(due>Date.now());
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!.close());await hidden();
 // Actual clock, ordinary scheduler. Pause future firings as soon as this one is accepted.
 await pollState(page,s=>{const failure=s.routines?.find(r=>r.id===routineId)?.error;if(failure)throw Error('Scheduled dispatch failed: '+failure);return firings(s).length===1;},90000);await call('routineSwitch',{id:routineId,enabled:false});let state=await finish(1);assert.equal(firings(state)[0].id,'routine-'+routineId+'-'+due);console.log('PASS actual scheduled task with window closed');
 await fs.writeFile(path.join(data,'first.json'),JSON.stringify(state.turns.filter((t:any)=>t.chatId===chatId),null,2));
 await stop();await restart();state=await call('state');assert.equal(state.routines.find((r:any)=>r.id===routineId).enabled,false);assert.equal(firings(state).length,1);assert.equal(state.alwaysOn.stayAwake,'off');await call('routineTick',{now:due+3*86400000});assert.equal(firings(await call('state')).length,1,'Paused schedule must not dispatch');
 // A crash after accepting a firing, before saving the new schedule. The already-saved turn must win.
 await stop();savedSchedule({enabled:true,nextFiring:due,schedule:{kind:'preset',preset:'hourly',time:'00:00'}});await restart();await pollState(page,s=>(s.routines?.find(r=>r.id===routineId)?.nextFiring||0)>Date.now(),90000);state=await call('state');assert.equal(firings(state).length,1);assert.deepEqual(await lines(),['scheduled-run']);await call('routineSwitch',{id:routineId,enabled:false});console.log('PASS accepted firing is not replayed after restart');
 // Several missed hours coalesce into one accepted firing on startup, with no fake provider.
 const missed=Date.now()-3*60*60*1000;await stop();savedSchedule({enabled:true,nextFiring:missed});await restart();await pollState(page,s=>firings(s).length===2,90000);await call('routineSwitch',{id:routineId,enabled:false});state=await finish(2);assert.equal(firings(state)[1].id,'routine-'+routineId+'-'+missed);console.log('PASS missed saved schedule runs once after restart');
 await call('routineDelete',{id:routineId});await call('routineTick',{now:Date.now()+3*86400000});await page.waitForTimeout(1500);assert.equal(firings(await call('state')).length,2);assert.equal(await fs.readFile(path.join(folder,'keep.txt'),'utf8'),'Keep this unrelated file unchanged.');await hidden();
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({executable:process.env.TRISMEGISTUS_EXE||'source',chatId,routineId,folder,model:'deepseek-flash',realClockFiring:due,turns:firings(state).map((t:any)=>({id:t.id,status:t.status,usage:t.usage})),closedWindow:true,draftPreserved:true,stayAwakeToggled:true,pausedAcrossRestart:true,deduplicatedAcceptedFiring:true,missedScheduleCoalesced:true,deletedStopsDispatch:true,physicalSleepTested:false,hidden:true},null,2));console.log('PASS real routines: '+data);
}finally{
 if(app.process().exitCode===null){if(routineId)await call('routineSwitch',{id:routineId,enabled:false}).catch(()=>{});await call('alwaysOn',{stayAwake:'off'}).catch(()=>{});await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}await temporary.host('delete_key');
}
