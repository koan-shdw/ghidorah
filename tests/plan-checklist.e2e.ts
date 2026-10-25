// The reply's plan checklist (his pick 10-25, V1): steps at the top of the reply with the current one spinning while
// it works, folded to "N of M steps done" when it ends; task-list calls are not counted as actions. Claude CLI fixture
// (TodoWrite) and DeepSeek fixture (the Hermes todo tool).
import {_electron as electron} from 'playwright';import {spawn} from 'node:child_process';import {once} from 'node:events';import {createInterface} from 'node:readline';import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';import {mainWindow,pollState} from './fixtures/poll-state';
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/plan-checklist-')),folder=await fs.mkdtemp(path.join(root,'work/plan-checklist-files-')),host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','inherit']}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env});
await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};BrowserWindow.getAllWindows()[0]?.setSize(1500,950);});
const haiku='claude-code:haiku';
try{
 const page=await mainWindow(app);page.setDefaultTimeout(15000);const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&s.claude?.models?.some(m=>m.id===haiku)===true);await call('wizardFinish');await call('workingFolder',{folder});
 if(await page.getByLabel('Close settings',{exact:true}).count())await page.getByLabel('Close settings',{exact:true}).click();
 const chat=async(name:string,model:string)=>{const id=await call('addProject');await call('sidebarChat',{action:'rename',chatId:id,name});await call('addModel',{chatId:id,model});await call('mode',{projectId:(await call('state')).chats.find((c:any)=>c.id===id).projectId,mode:'bypass'});await page.locator('[data-chat-id="'+id+'"] .chat-link').dispatchEvent('click');await page.locator('.chat-title').filter({hasText:name}).waitFor();return id;};
 const submit=async(chatId:string,model:string,text:string)=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text,models:[model]});return id;};
 const main=page.getByRole('region',{name:'Main chat',exact:true});

 // Claude's TodoWrite: four steps, the second spinning with its "doing" words while the reply works.
 const claude=await chat('Claude plan',haiku),reply=await submit(claude,haiku,JSON.stringify({action:'todo-plan',hold:5000}));
 const turn=main.locator('[data-turn-id="'+reply+'"]');
 await turn.locator('.plan-checklist>li').nth(3).waitFor();
 assert.equal(await turn.locator('.plan-checklist>li').count(),4);
 assert.equal(await turn.locator('.plan-checklist>li.in_progress .plan-text').evaluate(el=>el.firstChild?.textContent),'Write the fix');
 assert.match(await turn.locator('.plan-now').textContent()||'',/Writing the fix/);
 assert.equal(await turn.locator('.plan-mark.completed').count(),1);
 // When the reply ends the list folds; it opens on a click, every step ticked; TodoWrite is not an action.
 await pollState(page,s=>s.turns.find(t=>t.id===reply)?.status==='completed');
 await turn.locator('.plan-fold').waitFor();assert.match(await turn.locator('.plan-fold').textContent()||'',/4 of 4 steps done/);
 assert.equal(await turn.locator('.plan-checklist').count(),0,'folded when finished');
 await turn.locator('.plan-fold').click();assert.equal(await turn.locator('.plan-checklist .plan-mark.completed').count(),4);
 assert.equal(await turn.locator('.activity-list').count(),0,'task-list calls are not counted as actions');

 // The Hermes todo tool: one of three done, so the folded mark is not a tick.
 const hermes=await chat('Hermes plan','deepseek-flash'),second=await submit(hermes,'deepseek-flash','TODO_FIXTURE');
 await pollState(page,s=>s.turns.find(t=>t.id===second)?.status==='completed');
 const folded=main.locator('[data-turn-id="'+second+'"] .plan-fold');await folded.waitFor();
 assert.match(await folded.textContent()||'',/1 of 3 steps done/);assert.equal(await folded.locator('.plan-mark.pending').count(),1);
 console.log('PASS plan checklist: Claude TodoWrite while working and folded, Hermes todo folded.');
}catch(error){console.log('Plan checklist evidence: '+data);throw error;}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end();lines.close();await host.host('delete_key');}
