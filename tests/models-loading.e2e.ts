import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {mainWindow} from './fixtures/poll-state';
import {Store} from '../app/store';
import type {Chat} from '../app/types';

// A message sent while models are still loading waits in the composer and goes once they are ready (7f192dd).
// Claude is the only supplier; the fixture holds its model list while work\...\initialize-delay exists.
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','models-loading-')),gate=path.join(data,'initialize-delay');
await fs.writeFile(gate,'hold');
// Like Koan's chats after a restart: the model row already holds Claude (picked) while its model list loads.
const db=new Store(path.join(data,'chat.sqlite')),chatId=db.chat(db.project().id).id;db.update<Chat>('chat',chatId,{pool:['claude-code:haiku'],selectedModels:['claude-code:haiku']});db.db.close();
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const app=await electron.launch({args:[root,'--hidden'],env,timeout:30000});
try{
 const page=await mainWindow(app);page.setDefaultTimeout(30000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(check:(s:any)=>boolean,timeout=60000)=>{const until=Date.now()+timeout;while(Date.now()<until){const s=await call('state');if(check(s))return s;await page.waitForTimeout(100);}const s=await call('state');throw Error('Timed out: '+JSON.stringify({claude:s.claude?.status,models:s.availableModels,turns:s.turns.map((t:any)=>[t.chatId,t.prompt,t.status]),alerts:await page.getByRole('alert').allInnerTexts(),draft:await page.getByRole('combobox',{name:'Message',exact:true}).inputValue().catch(()=>'?')}));};
 await wait(s=>s.claude?.connected&&!s.availableModels?.length);
 if(await page.getByLabel('Close settings',{exact:true}).count())await page.getByLabel('Close settings',{exact:true}).click();
 await page.locator('[data-chat-id="'+chatId+'"] .chat-link').click();
 const message=page.getByRole('combobox',{name:'Message',exact:true});await message.fill('Reply with: models loaded');await message.press('Enter');
 await page.getByRole('alert').filter({hasText:'Models are still loading. Your message sends when they are ready.'}).waitFor();
 let state=await call('state');assert.equal(state.turns.filter((t:any)=>t.chatId===chatId).length,0,'nothing is sent while models load');
 assert.equal(await page.getByRole('dialog',{name:'Setup',exact:true}).count(),0,'a connected supplier never opens setup');
 const released=Date.now();await fs.rm(gate);
 state=await wait(s=>s.turns.some((t:any)=>t.chatId===chatId));
 const turn=state.turns.find((t:any)=>t.chatId===chatId);assert.equal(turn.prompt,'Reply with: models loaded');assert.ok(turn.created>=released,'sent after the models arrived');
 assert.ok(state.availableModels.length>0);assert.equal(await message.inputValue(),'');assert.equal(await page.getByRole('alert').filter({hasText:'Models are still loading'}).count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS a message sent while models load waits in the composer, opens no setup, and goes once the models arrive: '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});await fs.rm(gate,{force:true});}
