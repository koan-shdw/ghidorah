import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/routines-')),folder=await fs.mkdtemp(path.join(root,'work/routine-files-')),host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','inherit']}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url};
const launch=async()=>{const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env});await instance.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});return instance;};
let app=await launch();
try{
 let page=await mainWindow(app);const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});await pollState(page,s=>s.backend==='ready'&&s.availableModels?.includes('deepseek-flash')===true);await call('wizardFinish');await call('workingFolder',{folder});
 const chatId=await call('addProject');await call('mode',{projectId:(await call('state')).chats.find((c:any)=>c.id===chatId).projectId,mode:'bypass'});await call('draft',{chatId,text:'PRESERVE_MY_DRAFT'});
 const id=await call('routineSave',{name:'First reply',chatId,prompt:'COMMAND_FIXTURE scheduled work',schedule:{kind:'preset',preset:'hourly',time:'00:00'}});let state=await call('state');const due=state.routines.find((r:any)=>r.id===id).nextFiring;
 await call('routineTick',{now:due});await call('routineTick',{now:due+1000});state=await call('state');let routine=state.routines.find((r:any)=>r.id===id);assert.equal(routine.nextFiring,due);assert.equal(routine.lastFiring,undefined);assert.match(routine.error,/Select a connected model/);assert.equal(state.turns.length,0,'A rejected dispatch cannot consume a firing');
 await call('modelSelection',{chatId,model:'deepseek-flash',selected:true});await call('routineTick',{now:due+2000});state=await pollState(page,s=>s.turns.some((t:any)=>t.routine?.id===id&&t.status==='completed'));
 let turns=state.turns.filter((t:any)=>t.routine?.id===id);assert.equal(turns.length,1);assert.equal(turns[0].id,'routine-'+id+'-'+due);assert.deepEqual(turns[0].requestedModels,['deepseek-flash']);assert.ok(state.tools.some((t:any)=>t.turnId===turns[0].id&&t.status==='completed'&&JSON.stringify(t.result).includes('command-through-hermes')));
 assert.equal(state.chats.find((c:any)=>c.id===chatId)!.draft,'PRESERVE_MY_DRAFT');assert.deepEqual(state.chats.find((c:any)=>c.id===chatId)!.selectedModels,['deepseek-flash']);routine=state.routines!.find((r:any)=>r.id===id)!;assert.equal(routine.lastFiring,due);assert.equal(routine.error,undefined);assert.ok(routine.nextFiring!>due+2000);
 await call('routineTick',{now:due+3000});assert.equal((await call('state')).turns.length,1);
 await app.evaluate(({app})=>app.quit());await app.close();
 // Isolated saved state as if the process exited after accepting the turn and before updating its schedule.
 const db=new DatabaseSync(path.join(data,'chat.sqlite'));try{db.prepare("UPDATE records SET data=? WHERE kind='routine' AND id=?").run(JSON.stringify({...routine,nextFiring:due}),id);}finally{db.close();}
 app=await launch();page=await mainWindow(app);await pollState(page,s=>s.backend==='ready');await call('routineTick',{now:due});state=await call('state');assert.equal(state.turns.filter((t:any)=>t.routine?.id===id).length,1);assert.ok(state.routines.find((r:any)=>r.id===id).nextFiring>due);
 const missed=state.routines.find((r:any)=>r.id===id).nextFiring;await call('routineTick',{now:missed+3*86400000});state=await pollState(page,s=>s.turns.filter((t:any)=>t.routine?.id===id).length===2&&s.turns.filter((t:any)=>t.routine?.id===id).every((t:any)=>t.status==='completed'));
 assert.equal(state.turns.filter((t:any)=>t.routine?.id===id)[1].id,'routine-'+id+'-'+missed);
 await call('routineSwitch',{id,enabled:false});await call('routineTick',{now:missed+6*86400000});assert.equal((await call('state')).turns.length,2);await call('routineDelete',{id});await call('routineTick',{now:missed+10*86400000});assert.equal((await call('state')).turns.length,2);
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({firstReplySelection:true,failedDispatchPending:true,exactFiringRetried:true,draftAndSelectionPreserved:true,terminalTool:true,restartDeduplicated:true,missedCoalesced:true,pause:true,delete:true,hidden:true},null,2));console.log('PASS routines: '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end();lines.close();await host.host('delete_key');}
