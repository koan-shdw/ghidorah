import {_electron as electron} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {Store} from '../app/store';
import type {Turn} from '../app/types';
import {mainWindow,pollState} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/activity-panes-')),namespace='Trismegistus/Test/'+path.basename(data);
const store=new Store(path.join(data,'chat.sqlite')),project=store.project(),first=store.chat(project.id),other=store.chat(project.id);
for(const [chatId,text] of [[first.id,'Owned plan'],[other.id,'Foreign plan']]){const turn=store.accept(crypto.randomUUID(),chatId,'Plan review');store.update<Turn>('turn',turn.id,{status:'completed'});store.put('approval',{id:'plan-'+chatId,chatId,turnId:turn.id,method:'approval',params:{plan:'# '+text+'\nRead the source before changing it.\n```text\ncopy this plan\n```'},status:'once'});}
store.db.close();const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});await host.stop();
const fake=spawn(PYTHON,['tests/fake_provider.py'],{windowsHide:true,stdio:'pipe'}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url}});let app=await launch();
try{
 let page=await mainWindow(app);page.setDefaultTimeout(15000);const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const ready=async()=>{await pollState(page,state=>state.backend==='ready'&&!!state.availableModels?.includes('deepseek-flash'));if(await page.getByLabel('Close settings',{exact:true}).count())await page.getByLabel('Close settings',{exact:true}).click();};
 const todos=async(chatId:string,items:any[])=>{const id=crypto.randomUUID();await call('submit',{id,chatId,models:['deepseek-flash'],text:'MCP_FIXTURE '+JSON.stringify({name:'todo_list',arguments:{todos:items}})});const state=await pollState(page,state=>!!state.turns.find(turn=>turn.id===id&&['completed','failed'].includes(turn.status)));assert.equal(state.turns.find(turn=>turn.id===id)!.status,'completed');assert.ok(state.tools.some(tool=>tool.turnId===id&&tool.name==='todo_list'&&tool.status==='completed'));};
 await ready();for(const chatId of [first.id,other.id])await call('addModel',{chatId,model:'deepseek-flash'});await todos(first.id,[{id:'a',content:'Inspect actual source',status:'completed'},{id:'b',content:'Verify restored tasks',status:'in_progress'}]);await todos(other.id,[{id:'foreign',content:'Private other task',status:'pending'}]);
 await page.locator('[data-chat-id="'+first.id+'"] .chat-link').click();await page.getByLabel('Open tasks',{exact:true}).click();const tasks=page.getByRole('region',{name:'Tasks view',exact:true});await tasks.getByText('Inspect actual source',{exact:true}).waitFor();assert.equal(await tasks.getByText('Private other task',{exact:true}).count(),0);
 const workspace=page.getByRole('complementary',{name:'Workspace',exact:true});await workspace.getByRole('button',{name:'Detach Tasks',exact:true}).click();await tasks.getByText('Verify restored tasks',{exact:true}).waitFor();
 await page.getByLabel('Open plan',{exact:true}).click();const plan=page.getByRole('region',{name:'Plan view',exact:true});await plan.getByRole('heading',{name:'Owned plan',exact:true}).waitFor();assert.equal(await plan.getByText('Foreign plan',{exact:true}).count(),0);await workspace.getByRole('button',{name:'Detach Plan',exact:true}).click();
 let opening=app.waitForEvent('window');await plan.getByLabel('Pop out Plan',{exact:true}).click();let planWindow=await opening;await planWindow.getByRole('heading',{name:'Owned plan',exact:true}).waitFor();await planWindow.getByRole('button',{name:'Copy code',exact:true}).click();await planWindow.waitForFunction(()=>document.querySelector('[aria-label="Copy code"]')?.textContent==='Copied');await assert.rejects(planWindow.evaluate(id=>window.desktop.invoke('approve',{id,choice:'once'}),'plan-'+other.id),/another chat/);
 opening=app.waitForEvent('window');await tasks.getByLabel('Pop out Tasks',{exact:true}).click();let tasksWindow=await opening;await tasksWindow.getByText('Verify restored tasks',{exact:true}).waitFor();await assert.rejects(tasksWindow.evaluate(id=>window.desktop.invoke('approve',{id,choice:'once'}),'plan-'+first.id),/another chat/);
 await app.close();app=await launch();page=await mainWindow(app);await ready();await pollState(page,state=>state.workspaceWindows?.includes('plan')===true&&state.workspaceWindows.includes('tasks'));planWindow=app.windows().find(view=>view.url().endsWith('#workspace=plan'))!;tasksWindow=app.windows().find(view=>view.url().endsWith('#workspace=tasks'))!;await planWindow.getByRole('heading',{name:'Owned plan',exact:true}).waitFor();await tasksWindow.getByText('Verify restored tasks',{exact:true}).waitFor();await todos(first.id,[]);await tasksWindow.getByText('Task list cleared.',{exact:true}).waitFor();
 await tasksWindow.screenshot({path:path.join(data,'tasks-window.png')});await planWindow.screenshot({path:path.join(data,'plan-window.png')});await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({realHermesTodoTool:true,scopedTasks:true,scopedPlans:true,clear:true,detached:true,twoPopouts:true,clipboard:true,restart:true,foreignApprovalDenied:true,paidInference:false}));console.log(data);
}catch(error){console.error('Profile: '+data,error);const view=app.windows()[0];if(view){await view.screenshot({path:path.join(data,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(data,'failure.html'),await view.content().catch(()=>''));}throw error;
}finally{await app.close();fake.stdin.end();lines.close();execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;[v.delete(sys.argv[1]+'/'+key) for key in ('deepseek','encryption')]",namespace],{windowsHide:true});}
