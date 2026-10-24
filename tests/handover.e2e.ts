// Handover mode end to end (notes/HANDOVER-MODE-PLAN.md): Hand off from the chat menu, START HANDOVER on the reply,
// the new chat in the main view with the old one beside it, a push each way, then Close handover. DeepSeek fixture only.
import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
const root=process.cwd(),working=await fs.mkdtemp(path.join(root,'work','handover-workspace-')),data=await fs.mkdtemp(path.join(root,'work/handover-')),host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{windowsHide:true,stdio:'pipe'}),lines=createInterface({input:fake.stdout});const [line]=await once(lines,'line');
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url}});
await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(15000);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1500,950));
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(check:(s:any)=>boolean)=>{for(let n=0;n<900;n++){const s=await call('state');if(check(s))return s;await page.waitForTimeout(100);}throw Error('Timed out');};
 const settled=(s:any,id:string)=>s.turns.some((t:any)=>t.id===id&&t.status==='completed');
 await wait(s=>s.backend==='ready');if(await page.getByLabel('Close settings',{exact:true}).count())await page.getByLabel('Close settings',{exact:true}).click();await call('workingFolder',{folder:working});
 const old=await call('newChat');await call('sidebarChat',{action:'rename',chatId:old,name:'Handover work'});await call('sidebarChat',{action:'pin',chatId:old,pinned:true});
 let state=await call('state');const oldProject=state.chats.find((c:any)=>c.id===old).projectId;await call('mode',{projectId:oldProject,mode:'accept-edits'});
 const routine=await call('routineSave',{name:'Morning check',schedule:{kind:'preset',preset:'daily',time:'09:00'},chatId:old,prompt:'Check the build',enabled:false});
 await page.locator('[data-chat-id="'+old+'"] .chat-link').click();
 const seed=crypto.randomUUID();await call('submit',{id:seed,chatId:old,text:'Build the handover feature',models:['deepseek-flash']});await wait(s=>settled(s,seed));
 const main=page.getByRole('region',{name:'Main chat',exact:true}),side=page.getByRole('region',{name:'Split chat',exact:true});

 // Hand off from the caret menu: the protocol goes to the old chat and its reply offers START HANDOVER with the check.
 await main.getByRole('button',{name:'Chat menu',exact:true}).dispatchEvent('click');await page.getByRole('menuitem',{name:'Hand off'}).dispatchEvent('click');
 state=await wait(s=>s.turns.some((t:any)=>t.chatId===old&&t.prompt.startsWith('Write a handover')&&t.status==='completed'));
 const handover=state.turns.find((t:any)=>t.chatId===old&&t.prompt.startsWith('Write a handover'));assert.equal(state.chats.find((c:any)=>c.id===old).handover.stage,'writing');
 await main.getByRole('region',{name:'Start handover'}).getByText('Ghidorah’s check').waitFor();
 await assert.rejects(call('handoverStart',{chatId:old,turnId:seed}),/latest finished handover reply/);
 await main.getByRole('button',{name:'START HANDOVER',exact:true}).dispatchEvent('click');

 // START: the next chat in the series, every setting the same, the handover its only message; old chat beside it.
 state=await wait(s=>s.chats.some((c:any)=>c.handoverFrom===old));
 const fresh=state.chats.find((c:any)=>c.handoverFrom===old),before=state.chats.find((c:any)=>c.id===old);
 assert.equal(before.title,'Handover work 1');assert.equal(fresh.title,'Handover work 2');assert.equal(fresh.pinned,true);assert.deepEqual(fresh.pool,before.pool);
 assert.equal(state.projects.find((p:any)=>p.id===fresh.projectId).mode,'accept-edits');
 state=await wait(s=>s.projects.find((p:any)=>p.id===oldProject).mode==='plan');
 assert.equal(state.routines.find((r:any)=>r.id===routine).chatId,fresh.id);
 state=await wait(s=>s.turns.some((t:any)=>t.chatId===fresh.id&&t.status==='completed'));
 const first=state.turns.filter((t:any)=>t.chatId===fresh.id);assert.equal(first.length,1);assert.equal(first[0].handoff.push,true);assert.match(first[0].prompt,/continues "Handover work 1"/);assert.ok(first[0].prompt.includes(handover.text.trim()));assert.equal(first[0].model,'deepseek-flash');
 await side.getByText('This chat wrote the handover for').waitFor();await main.getByText('Started from the handover of').waitFor();

 // Show old chat: the new chat's reply goes to the old chat (even in Plan mode); the handover itself does not.
 await main.getByRole('button',{name:'Show old chat (1 new)'}).dispatchEvent('click');
 state=await wait(s=>s.turns.some((t:any)=>t.chatId===old&&t.prompt.startsWith('Update from the new chat')&&t.status==='completed'));
 const update=state.turns.find((t:any)=>t.chatId===old&&t.prompt.startsWith('Update from the new chat'));assert.ok(!update.prompt.includes('**User:** This chat continues'),'the handover message itself stays out; the fixture reply echoes it');assert.match(update.prompt,/\*\*Reply:\*\*/);
 await main.getByRole('button',{name:'Show old chat'}).and(page.locator(':disabled')).waitFor();

 // Send to new chat: one click on the old chat's reply sends it across, marked as from the old chat.
 await side.locator('[data-turn-id="'+update.id+'"]').getByRole('button',{name:'Send to new chat'}).dispatchEvent('click');
 state=await wait(s=>s.turns.some((t:any)=>t.chatId===fresh.id&&t.prompt.startsWith('Comments from the old chat')&&t.status==='completed'));
 const comment=state.turns.find((t:any)=>t.chatId===fresh.id&&t.prompt.startsWith('Comments from the old chat'));assert.equal(comment.handoff.sourceChatId,old);assert.equal(comment.handoff.title,'Handover work 1');
 await assert.rejects(call('handoverPush',{chatId:old}),/Nothing new/);


 // Close handover: the old chat stays, numbered and unpinned, back in its own mode; the side panel closes.
 await main.getByRole('button',{name:'Close handover'}).dispatchEvent('click');
 state=await wait(s=>!s.chats.find((c:any)=>c.id===old).handover);
 const closed=state.chats.find((c:any)=>c.id===old);assert.equal(closed.pinned,false);assert.equal(closed.title,'Handover work 1');
 await wait(s=>s.projects.find((p:any)=>p.id===oldProject).mode==='accept-edits');
 await side.waitFor({state:'detached'});
 console.log('Handover mode: hand off, START, both pushes and close passed.');
}catch(error){console.log('Handover evidence: '+data);throw error;}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end();lines.close();await host.host('delete_key');}
