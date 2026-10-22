import {_electron as electron} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import type {Chat} from '../app/types';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow} from './fixtures/poll-state';

// After a restart, a message that was still queued waits paused, on screen, until one click on Send (Koan, 2026-10-08, 6dea2e8).
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','paused-restart-')),namespace='Trismegistus/Test/'+path.basename(data),host=new Backend(root,data,namespace,()=>{});
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const db=new Store(path.join(data,'chat.sqlite')),chatId=db.chat(db.project().id).id,id=randomUUID();
db.update<Chat>('chat',chatId,{pool:['deepseek-flash'],selectedModels:['deepseek-flash']});db.accept(id,chatId,'Reply after the restart','deepseek-flash');db.db.close();
const fake=spawn(PYTHON,['tests/fake_provider.py'],{windowsHide:true,stdio:['pipe','pipe','inherit']}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url};
const app=await electron.launch({args:[root,'--hidden'],env,timeout:30000});
try{
 const page=await mainWindow(app);page.setDefaultTimeout(30000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(check:(s:any)=>boolean)=>{const until=Date.now()+90000;while(Date.now()<until){const s=await call('state');if(check(s))return s;await page.waitForTimeout(100);}throw Error('Timed out: '+JSON.stringify((await call('state')).turns));};
 const capture=async(name:string)=>fs.writeFile(path.join(data,name),Buffer.from(await app.evaluate(async({BrowserWindow})=>Array.from((await BrowserWindow.getAllWindows().find(w=>/index\.html$/.test(w.webContents.getURL()))!.webContents.capturePage()).toPNG()))));
 let state=await wait(s=>s.backend==='ready'&&s.availableModels.includes('deepseek-flash'));
 if(await page.getByLabel('Close settings',{exact:true}).count())await page.getByLabel('Close settings',{exact:true}).click();
 const turn=state.turns.find((t:any)=>t.id===id);assert.equal(turn.status,'queued');assert.equal(turn.paused,true,'the restart paused it');
 await page.waitForTimeout(6000);assert.equal((await call('state')).turns.find((t:any)=>t.id===id).status,'queued','the 5 s sweep never sends a paused message');
 await page.locator('[data-chat-id="'+chatId+'"] .chat-link').click();
 const row=page.locator('.queued-paused');await row.waitFor();assert.match(await row.innerText(),/Paused after restart/);
 const send=row.getByRole('button',{name:'Send',exact:true});assert.ok(await send.isVisible());await capture('paused.png');
 await send.click();
 state=await wait(s=>s.turns.find((t:any)=>t.id===id)?.status==='completed');assert.equal(state.turns.find((t:any)=>t.id===id).paused,false);
 assert.equal(await page.locator('.queued-paused').count(),0);await capture('sent.png');
 assert.deepEqual(errors,[]);
 console.log('PASS a message queued before a restart shows "Paused after restart" with Send, is never swept, and one click sends it: '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end('\n');lines.close();await host.host('delete_key').catch(()=>{});}
