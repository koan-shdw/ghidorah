// Delete cancels what a chat has waiting and stops what runs (his ask 10-25: "we should be able to cancel by
// deleting"), instead of "Wait for queued work to finish". DeepSeek fixture only.
import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
const root=process.cwd(),working=await fs.mkdtemp(path.join(root,'work','delete-busy-workspace-')),data=await fs.mkdtemp(path.join(root,'work/delete-busy-')),host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{windowsHide:true,stdio:'pipe'}),lines=createInterface({input:fake.stdout});const [line]=await once(lines,'line');
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url}});
await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};});
const pending=['queued','dispatching','running','waiting','stopping','needs-model'];
try{
 const page=await app.firstWindow();page.setDefaultTimeout(15000);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1500,950));
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(check:(s:any)=>boolean)=>{for(let n=0;n<900;n++){const s=await call('state');if(check(s))return s;await page.waitForTimeout(100);}throw Error('Timed out');};
 await wait(s=>s.backend==='ready');if(await page.getByLabel('Close settings',{exact:true}).count())await page.getByLabel('Close settings',{exact:true}).click();await call('workingFolder',{folder:working});
 const busy=await call('newChat'),other=await call('newChat');await call('sidebarChat',{action:'rename',chatId:busy,name:'Busy chat'});
 const send=async(chatId:string,text:string)=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text,models:['deepseek-flash']});return id;};
 const running=await send(busy,'SLOW_FIXTURE');await wait(s=>s.turns.some((t:any)=>t.id===running&&t.status==='running'));
 // A command message waits in the queue behind the running reply (plain messages reach the model at once).
 const queued=await send(busy,'/compact');await wait(s=>s.turns.some((t:any)=>t.id===queued&&t.status==='queued'));

 await page.locator('[data-chat-id="'+busy+'"] .chat-link').click({button:'right'});await page.getByRole('menuitem',{name:'Delete',exact:true}).click();
 const dialog=page.getByRole('dialog').filter({hasText:'Delete chat?'});
 await dialog.getByText('1 queued message is cancelled and running work is stopped first.').waitFor();
 await dialog.getByRole('button',{name:'Delete',exact:true}).click();
 const state=await wait(s=>!s.chats.some((c:any)=>c.id===busy));
 assert.equal(state.turns.some((t:any)=>t.chatId===busy&&pending.includes(t.status)),false);
 await dialog.waitFor({state:'detached'});

 // The engine is free afterwards: another chat replies, and nothing blocks a ChatGPT account switch's check.
 const after=await send(other,'After the delete');await wait(s=>s.turns.some((t:any)=>t.id===after&&t.status==='completed'));
 assert.equal((await call('state')).turns.some((t:any)=>pending.includes(t.status)),false);
 console.log('Delete cancelled the queued message, stopped the running reply and removed the chat.');
}catch(error){console.log('Delete evidence: '+data);throw error;}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end();lines.close();await host.host('delete_key');}
