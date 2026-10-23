// Two chats work side by side while one waits on an approval (Koan's decisions 2026-10-08, RUN-PLAN 4j).
// Chat A (Manual) asks to write a file; while that approval waits, chat B (Bypass) runs an unknown command to the end.
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

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/two-chats-')),workspace=await fs.mkdtemp(path.join(root,'work/two-chats-workspace-'));
const seed=new Store(path.join(data,'chat.sqlite'));
seed.put('settings',{id:'working-folder',folder:workspace});
const projects=await Promise.all(['a','b'].map(async name=>{const folder=path.join(workspace,name);await fs.mkdir(folder);return seed.project(folder);}));
const [chatA,chatB]=projects.map(project=>{const chat=seed.chat(project.id);seed.update<any>('chat',chat.id,{pool:['deepseek-flash'],selectedModels:['deepseek-flash']});return chat;});seed.db.close();
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','inherit']}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url};
const packaged=process.env.TRISMEGISTUS_EXE?await launchPackaged(env):undefined,app=packaged?undefined:await electron.launch({args:[root,'--hidden'],env,timeout:60000});
try{
 if(app)await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};});
 const page=packaged?.page||await mainWindow(app!),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&s.connected);await call('wizardFinish');
 await call('mode',{projectId:projects[0].id,mode:'manual'});await call('mode',{projectId:projects[1].id,mode:'bypass'});
 const turn=(chatId:string,text:string)=>{const id=crypto.randomUUID();return call('submit',{id,chatId,text}).then(()=>id);};
 const a=await turn(chatA.id,'WRITE_FIXTURE');
 let state=await pollState(page,s=>s.approvals.some((row:any)=>row.turnId===a&&row.status==='pending'),60000);
 const b=await turn(chatB.id,'UNKNOWN_COMMAND_FIXTURE');
 state=await pollState(page,s=>s.turns.some((t:any)=>t.id===b&&['completed','failed','interrupted'].includes(t.status)),60000);
 assert.equal(state!.turns.find((t:any)=>t.id===b)!.status,'completed','chat B finished its unknown command');
 assert.ok(state!.approvals.some((row:any)=>row.turnId===a&&row.status==='pending'),'chat A was still waiting on its approval');
 await call('approve',{id:state!.approvals.find((row:any)=>row.turnId===a&&row.status==='pending')!.id,choice:'once'});
 state=await pollState(page,s=>s.turns.some((t:any)=>t.id===a&&t.status==='completed'),60000);
 assert.equal(await fs.readFile(path.join(workspace,'a','slice-result.txt'),'utf8'),'Written through Hermes tools.');
 console.log('PASS chat B ran an unknown command to the end while chat A waited on its approval; A then wrote after approval: '+data);
}finally{if(app){await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}await packaged?.close();fake.stdin.end();lines.close();await host.host('delete_key');}
