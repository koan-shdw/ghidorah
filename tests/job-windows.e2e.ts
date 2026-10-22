import {_electron as electron} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PYTHON} from '../app/backend';
import {Store} from '../app/store';
import type {Chat,Turn} from '../app/types';
import {group,split,allPaneIds} from '../app/pane-tree';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/job-windows-')),namespace='Trismegistus/Test/'+path.basename(data);
// Saved completed jobs exercise window ownership and restart without any model account or request.
const store=new Store(path.join(data,'chat.sqlite')),project=store.project(),parent=store.chat(project.id),turn=store.accept(crypto.randomUUID(),parent.id,'saved parallel work'),jobs=['deepseek-flash','gpt-6-astra'].map(model=>{
 const chat={...store.chat(project.id),parentChatId:parent.id,groupTurnId:turn.id,draft:'retained '+model};store.put('chat',chat);const job={...store.accept(crypto.randomUUID(),chat.id,'saved '+model,model),parentTurnId:turn.id,status:'completed',text:'saved result'};store.put('turn',job);store.update<Chat>('chat',chat.id,{draft:chat.draft});return job;
});
store.update<Turn>('turn',turn.id,{jobs:jobs.map(job=>job.id),status:'completed'});
store.put('settings',{id:'chat-layout',chatId:parent.id,splitId:'',direction:'row',size:50});store.put('settings',{id:'pane-layout',tree:split('row',[group(['main']),...jobs.map(job=>group(['job:'+job.chatId])),group(['workspace'])])});store.db.close();
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data}});let app=await launch();
try{
 let page=await app.firstWindow();page.setDefaultTimeout(15000);
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const until=async(check:()=>Promise<boolean>)=>{for(const end=Date.now()+30000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,100)))if(await check())return;throw Error('Model window state timed out');};
 const ready=async()=>{await until(async()=>(await call('state')).backend==='ready');await page.getByLabel('Close settings',{exact:true}).click();};
 const restart=async()=>{await app.close();app=await launch();await until(async()=>app.windows().some(view=>/index\.html$/.test(view.url())));page=app.windows().find(view=>/index\.html$/.test(view.url()))!;page.setDefaultTimeout(15000);await ready();};
 await ready();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1800,1100));
 const dock=page.locator('[data-pane="job:'+jobs[0].chatId+'"]');assert.equal(await dock.getByLabel('Job correction',{exact:true}).inputValue(),'retained deepseek-flash');await dock.getByLabel('Job correction',{exact:true}).fill('edited correction');
 const opening=app.waitForEvent('window');await dock.getByRole('button',{name:'Pop out ↗',exact:true}).click();let popped=await opening;await popped.getByLabel('Job correction',{exact:true}).waitFor();assert.equal(await popped.getByLabel('Job correction',{exact:true}).inputValue(),'edited correction');await until(async()=>await page.locator('[data-pane="job:'+jobs[0].chatId+'"]').count()===0);
 const bounds=await app.evaluate(({BrowserWindow},id)=>{const view=BrowserWindow.getAllWindows().find(view=>view.webContents.getURL().endsWith('#job='+id))!;view.setBounds({x:110,y:90,width:690,height:590});return view.getNormalBounds();},jobs[0].chatId);
 await call('openJob',{id:jobs[1].id});await restart();assert.deepEqual(new Set((await call('state')).jobWindows),new Set(jobs.map(job=>job.chatId)));assert.equal(await page.locator('.job-dock-pane').count(),0);assert.ok(!allPaneIds((await call('state')).paneLayout).some(id=>id.startsWith('job:')));
 await until(async()=>app.windows().filter(view=>view.url().includes('#job=')).length===2);popped=app.windows().find(view=>view.url().endsWith('#job='+jobs[0].chatId))!;assert.equal(await popped.getByLabel('Job correction',{exact:true}).inputValue(),'edited correction');assert.deepEqual(await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows().find(view=>view.webContents.getURL().endsWith('#job='+id))!.getNormalBounds(),jobs[0].chatId),bounds);
 const cross=await popped.evaluate(async({chatId})=>{try{await window.desktop.invoke('draft',{chatId,text:'wrong owner'});return '';}catch(error){return String(error);}},{chatId:jobs[1].chatId});assert.match(cross,/another job/);
 const closed=popped.waitForEvent('close');void popped.evaluate(()=>window.desktop.invoke('window',{action:'close'})).catch(()=>{});await closed;await restart();assert.deepEqual((await call('state')).jobWindows,[jobs[1].chatId]);assert.equal((await call('state')).turns.length,3);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({dockedDraft:true,popoutDraft:true,oneEditor:true,bounds:true,twoWindowsRestored:true,immediateQuit:true,scopedIpc:true,closedStaysClosed:true,noInference:true}));console.log(data);
}catch(error){console.error('Profile: '+data,error);const view=app.windows()[0];if(view){await view.screenshot({path:path.join(data,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(data,'failure.html'),await view.content().catch(()=>''));}throw error;
}finally{await app.close();execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1]+'/encryption')",namespace],{windowsHide:true});}
