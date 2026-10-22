import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/work-notifications-')),folder=await fs.mkdtemp(path.join(root,'work/notification-files-')),host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','inherit']}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_NOTIFICATIONS:'1'};
const launch=async()=>{const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env});await instance.evaluate(({BrowserWindow,Notification})=>{
 (globalThis as any).notices=[];Notification.isSupported=()=>true;Notification.prototype.show=function(){(globalThis as any).notices.push(this);};
 BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};
});return instance;};
let app=await launch();
try{
 let page=await mainWindow(app);const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const labels=()=>app.evaluate(()=>((globalThis as any).notices as any[]).map(n=>n.body));
 const waitNotice=async(label:string)=>{for(let n=0;n<100;n++){if((await labels()).includes(label))return;await page.waitForTimeout(100);}throw Error('Missing notification: '+label);};
 await pollState(page,s=>s.backend==='ready'&&s.availableModels?.includes('deepseek-flash')===true);await call('wizardFinish');await call('workingFolder',{folder});
 const chatId=await call('addProject');await call('draft',{chatId,text:'PRESERVED_DRAFT'});
 await call('submit',{id:randomUUID(),chatId,text:'WRITE_FIXTURE notification approval',models:['deepseek-flash']});
 let state=await pollState(page,s=>s.approvals.some(a=>a.status==='pending'));await waitNotice('Your approval is needed');
 const approval=state.approvals.find(a=>a.status==='pending')!;await call('approve',{id:approval.id,choice:'once'});await pollState(page,s=>s.turns.some(t=>t.status==='completed'));await waitNotice('Reply ready');
 assert.equal(await fs.readFile(path.join(folder,'slice-result.txt'),'utf8'),'Written through Hermes tools.');
 const destination=await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(w=>/index\.html$/.test(w.webContents.getURL()))!;let target:any=null;const send=win.webContents.send.bind(win.webContents);win.webContents.send=(channel:string,...args:any[])=>{if(channel==='select-chat')target=args;send(channel,...args);};(globalThis as any).notices.at(-1).emit('click');return target;});assert.equal(destination[0],chatId);assert.equal(destination[1],approval.turnId);
 await call('openChatWindow',{chatId});
 for(let n=0;n<300;n++){if(await app.evaluate(({BrowserWindow},chatId)=>BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('#chat='+chatId)&&!w.webContents.isLoading()),chatId))break;await page.waitForTimeout(100);}
 const detached=await app.evaluate(({BrowserWindow},chatId)=>{const view=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('#chat='+chatId));if(!view)return null;let target:any=null;const count=BrowserWindow.getAllWindows().length,send=view.webContents.send.bind(view.webContents);view.webContents.send=(channel:string,...args:any[])=>{if(channel==='select-chat')target=args;send(channel,...args);};(globalThis as any).notices.at(-1).emit('click');const result={target,sameCount:BrowserWindow.getAllWindows().length===count};view.close();return result;},chatId);assert.equal(detached?.target[0],chatId);assert.equal(detached?.sameCount,true);
 const count=(await labels()).length;await call('draft',{chatId,text:'PRESERVED_DRAFT'});await page.waitForTimeout(100);assert.equal((await labels()).length,count);
 await call('submit',{id:randomUUID(),chatId,text:'CLARIFY_FIXTURE notification question',models:['deepseek-flash']});state=await pollState(page,s=>s.approvals.some(a=>a.method==='clarify'&&a.status==='pending'));await waitNotice('Your answer is needed');const question=state.approvals.find(a=>a.method==='clarify'&&a.status==='pending')!;
 await call('answer',{id:question.id,answers:Object.fromEntries((question.params.questions||[{qid:'single'}]).map((q:any)=>[q.qid,'Blue']))});await pollState(page,s=>s.turns.filter(t=>t.status==='completed').length===2);
 await call('alwaysOn',{desktopNotifications:false});await page.waitForTimeout(100);const before=(await labels()).length;await call('submit',{id:randomUUID(),chatId,text:'Muted notification',models:['deepseek-flash']});await pollState(page,s=>s.turns.filter(t=>t.status==='completed').length===3);await page.waitForTimeout(150);assert.equal((await labels()).length,before);
 await call('alwaysOn',{desktopNotifications:true});await call('voiceFocus',{chatId});await app.evaluate(({BrowserWindow})=>{(globalThis as any).getFocused=BrowserWindow.getFocusedWindow;BrowserWindow.getFocusedWindow=()=>BrowserWindow.getAllWindows().find(w=>/index\.html$/.test(w.webContents.getURL()))!;});
 await call('submit',{id:randomUUID(),chatId,text:'Focused notification',models:['deepseek-flash']});await pollState(page,s=>s.turns.filter(t=>t.status==='completed').length===4);await page.waitForTimeout(150);assert.equal((await labels()).length,before);await app.evaluate(({BrowserWindow})=>{BrowserWindow.getFocusedWindow=(globalThis as any).getFocused;});
 await call('draft',{chatId,text:'PRESERVED_DRAFT'});await app.evaluate(({app})=>app.quit());await app.close();app=await launch();page=await mainWindow(app);state=await pollState(page,s=>s.backend==='ready');await page.waitForTimeout(200);assert.deepEqual(await labels(),[]);assert.equal(state.chats.find(c=>c.id===chatId)?.draft,'PRESERVED_DRAFT');assert.equal(state.alwaysOn?.desktopNotifications,true);
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({approval:true,completion:true,question:true,clickTarget:true,detachedTarget:true,focusedSuppression:true,muted:true,restartNoReplay:true,draftPreserved:true,hidden:true,nativeToastDelivery:'not verified; OS display intercepted'},null,2));console.log('PASS work notifications: '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end();lines.close();await host.host('delete_key');}
