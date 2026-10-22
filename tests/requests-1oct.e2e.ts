// Desktop checks for the 1 October requests: sidebar collapse, model lock, queue cancel/merge,
// create_app, select duty and the Skills page. Supplier replies come from the local fixture provider.
import {_electron as electron} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/requests-')),workspace=await fs.mkdtemp(path.join(root,'work/requests-root-'));
const namespace='Trismegistus/Test/'+path.basename(data),host=new Backend(root,data,namespace,()=>{}),records=path.join(data,'requests.jsonl'),aux=path.join(data,'aux.jsonl');
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{windowsHide:true,stdio:'pipe',env:{...process.env,FIXTURE_RECORDS:records,FIXTURE_AUX_RECORDS:aux}}),lines=createInterface({input:fake.stdout});const [line]=await once(lines,'line');
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url}});
let app=await launch();const verified:Record<string,boolean>={};
const step=(name:string)=>{verified[name]=true;void fs.appendFile(path.join(data,'steps.log'),name+'\n');};
try{
 let page=await app.firstWindow();page.setDefaultTimeout(15000);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1500,950));
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(check:(s:any)=>boolean,limit=900)=>{for(let n=0;n<limit;n++){const s=await call('state');if(check(s))return s;await page.waitForTimeout(100);}throw Error('Timed out');};
 await wait(s=>s.backend==='ready');if(await page.getByLabel('Close settings',{exact:true}).count())await page.getByLabel('Close settings',{exact:true}).click();
 await call('workingFolder',{folder:workspace});
 const chatId=await call('newChat');await page.locator('[data-chat-id="'+chatId+'"] .chat-link').click();
 const main=page.getByRole('region',{name:'Main chat',exact:true}),message=main.getByLabel('Message',{exact:true});
 const send=async(text:string)=>{await message.fill(text);await message.press('Enter');};
 const turnOf=(s:any,needle:string)=>s.turns.find((t:any)=>t.chatId===chatId&&t.prompt.includes(needle));
 const idle=(s:any)=>s.turns.filter((t:any)=>t.chatId===chatId).every((t:any)=>!['queued','dispatching','running','waiting','stopping'].includes(t.status));

 // 8. Sidebar collapses with the panel button and stays as you left it.
 const toggle=page.getByRole('button',{name:'Sidebar',exact:true});
 assert.equal(await toggle.getAttribute('aria-expanded'),'true');await toggle.click();await page.locator('aside.sidebar').waitFor({state:'hidden'});
 assert.equal(await toggle.getAttribute('aria-expanded'),'false');await toggle.click();await page.locator('aside.sidebar').waitFor();step('sidebarCollapse');

 // 4. Ctrl+click locks a model for every message; the right-click menu offers lock, select duty and removal.
 const pill=main.locator('.model-row .model-pill:not(.jev)').first(),tab=pill.locator('.model-tab'),selectorTab=main.locator('.model-row .jev.model-pill');
 await tab.click({modifiers:['Control']});await wait(s=>s.chats.find((c:any)=>c.id===chatId).lockedModel==='deepseek-flash');await main.locator('.model-pill.locked').waitFor();
 await send('LOCK_FIXTURE hello');let state=await wait(s=>turnOf(s,'LOCK_FIXTURE')?.status==='completed');
 assert.deepEqual(turnOf(state,'LOCK_FIXTURE').requestedModels,['deepseek-flash']);assert.equal(state.chats.find((c:any)=>c.id===chatId).lockedModel,'deepseek-flash');
 await pill.click({button:'right'});const menu=page.getByRole('menu');
 for(const name of ['Stop always using','Put on select duty','Remove from chat'])await menu.getByRole('menuitem',{name:new RegExp('^'+name)}).waitFor();
 await menu.getByRole('menuitem',{name:/^Stop always using/}).click();await wait(s=>!s.chats.find((c:any)=>c.id===chatId).lockedModel);step('modelLock');

 // 2. Messages queued while busy can be cancelled, and the rest go out together as one message.
 await send('SLOW_FIXTURE first');await wait(s=>['running','dispatching'].includes(turnOf(s,'SLOW_FIXTURE')?.status));
 for(const text of ['QUEUE_ONE alpha','QUEUE_TWO beta','QUEUE_CANCEL gamma'])await send(text);
 state=await wait(s=>s.turns.filter((t:any)=>t.chatId===chatId&&t.status==='queued').length===3);const cancelled=turnOf(state,'QUEUE_CANCEL');
 await main.locator('.turn',{hasText:'QUEUE_CANCEL'}).getByLabel('Cancel queued message',{exact:true}).click();await wait(s=>!s.turns.some((t:any)=>t.id===cancelled.id));
 assert.equal(await call('submit',{id:cancelled.id,chatId,text:cancelled.prompt}),cancelled.id);assert.ok(!(await call('state')).turns.some((t:any)=>t.id===cancelled.id),'A repeated send must not revive a cancelled message');
 state=await wait(idle,1500);const merged=state.turns.filter((t:any)=>t.chatId===chatId&&t.prompt.includes('QUEUE_ONE'));
 assert.equal(merged.length,1);assert.equal(merged[0].prompt,'QUEUE_ONE alpha\n\nQUEUE_TWO beta');assert.equal(merged[0].status,'completed');assert.ok(!turnOf(state,'QUEUE_TWO')||turnOf(state,'QUEUE_TWO').id===merged[0].id);
 const sent=(await fs.readFile(records,'utf8')).trim().split('\n').map(row=>JSON.parse(row));
 assert.ok(sent.some(body=>{const text=JSON.stringify(body);return text.includes('QUEUE_ONE alpha')&&text.includes('QUEUE_TWO beta');}));assert.ok(!sent.some(body=>JSON.stringify(body).includes('QUEUE_CANCEL')));step('queueCancelAndMerge');

 // 3. The model starts an app: folder under the working folder, saved app linked to this chat, approval in Manual.
 await send('CREATE_APP_FIXTURE start the shop');
 state=await wait(s=>s.approvals.some((a:any)=>a.chatId===chatId&&a.status==='pending'&&JSON.stringify(a.params).includes('create_app')));
 await call('approve',{id:state.approvals.find((a:any)=>a.chatId===chatId&&a.status==='pending').id,choice:'once'});
 state=await wait(s=>turnOf(s,'CREATE_APP_FIXTURE')?.status==='completed');const folder=await fs.realpath(path.join(workspace,'Plush-Shop'));
 assert.ok((await fs.stat(folder)).isDirectory());const saved=state.savedApps.find((a:any)=>a.name==='Plush Shop');
 assert.ok(saved?.chatIds.includes(chatId));assert.ok(saved.repositories.includes(folder));assert.equal(saved.current,'A fixture shop app');step('createApp');

 // Select duty: drag a pill onto the selector tab; that model picks who answers; right-click hands the job back.
 await pill.dragTo(selectorTab);await wait(s=>s.chats.find((c:any)=>c.id===chatId).selector==='deepseek-flash');await main.locator('.model-row .jev.model-pill.on-duty',{hasText:'DeepSeek'}).waitFor();
 await send('SELECTOR_FIXTURE which model answers?');state=await wait(s=>turnOf(s,'SELECTOR_FIXTURE')?.status==='completed');const routed=turnOf(state,'SELECTOR_FIXTURE');
 assert.equal(routed.model,'deepseek-flash');assert.equal(routed.routingUsage.engine,'selector');assert.match(routed.routeNotice,/DeepSeek selected this model/);
 assert.ok((await fs.readFile(aux,'utf8')).includes('You are on select duty'));
 await selectorTab.click({button:'right'});await page.getByRole('menuitem',{name:'Hand back to Jev'}).click();await wait(s=>!s.chats.find((c:any)=>c.id===chatId).selector);
 await main.locator('.model-row .jev.model-pill:not(.on-duty)',{hasText:'Jev'}).waitFor();step('selectDuty');
 await page.screenshot({path:path.join(data,'chat.png')});

 // 7. Skills page: icon grids, pick details, and the reviewed install path for a root skill and a subfolder skill.
 await page.getByRole('navigation',{name:'App navigation'}).getByRole('button',{name:'Skills',exact:true}).click();
 const shelf=page.getByRole('region',{name:'Skill shelf',exact:true});await shelf.waitFor();
 assert.equal(await shelf.locator('.skill-grid').last().locator('.skill-tile').count(),14);await shelf.getByText('Nothing installed yet. Pick one below.').waitFor();
 const pickIcons=await shelf.locator('.skill-grid').last().locator('.skill-icon img').evaluateAll(imgs=>Promise.all(imgs.map(img=>(img as HTMLImageElement).decode().then(()=>(img as HTMLImageElement).naturalWidth))));
 assert.deepEqual(pickIcons,[128,128,128,128,128,128,128],'All seven pick icons load under the page CSP');
 await shelf.locator('.skill-tile',{hasText:'Caveman'}).click();const caveman=page.getByRole('region',{name:'Caveman details',exact:true});
 await caveman.getByRole('button',{name:'Review and install',exact:true}).waitFor();await caveman.getByRole('button',{name:'Open on GitHub',exact:true}).waitFor();
 await page.screenshot({path:path.join(data,'skills.png')});
 for(const [name,source] of [['Unlazy','Leonxlnx/unlazy'],['Poteto Mode','cursor/plugins/pstack/skills/poteto-mode']]){
  await shelf.locator('.skill-tile',{hasText:name}).click();await page.getByRole('region',{name:name+' details',exact:true}).getByRole('button',{name:'Review and install',exact:true}).click();
  const review=page.getByRole('region',{name:'Plugin review',exact:true});await review.waitFor({timeout:180000});assert.ok((await review.innerText()).includes(source),name+' review names its pinned source');
  if(name==='Unlazy'){await review.getByRole('button',{name:'Cancel',exact:true}).click();await review.waitFor({state:'detached'});continue;}
  await review.getByRole('button',{name:'Import and enable',exact:true}).click();await review.waitFor({state:'detached',timeout:180000});
 }
 // An installed pick shows its icon in the Installed grid and is marked Installed in Our picks.
 await shelf.getByText('Nothing installed yet. Pick one below.').waitFor({state:'detached'});
 assert.equal(await shelf.locator('.skill-grid').first().locator('.skill-icon img').evaluate(img=>(img as HTMLImageElement).decode().then(()=>(img as HTMLImageElement).naturalWidth)),128);
 await shelf.locator('.skill-grid').last().locator('.skill-tile',{hasText:'Poteto Mode'}).getByText('Installed',{exact:true}).waitFor();
 step('skillsPage');await page.getByLabel('Close settings',{exact:true}).click();

 // The collapsed sidebar survives a restart.
 await toggle.click();await page.locator('aside.sidebar').waitFor({state:'hidden'});await app.close();
 app=await launch();page=await app.firstWindow();page.setDefaultTimeout(15000);await page.locator('.app-rail').waitFor();
 assert.equal(await page.getByRole('button',{name:'Sidebar',exact:true}).getAttribute('aria-expanded'),'false');assert.equal(await page.locator('aside.sidebar').isVisible(),false);
 await page.getByRole('button',{name:'Sidebar',exact:true}).click();await page.locator('aside.sidebar').waitFor();step('sidebarRemembered');
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(data,'verified.json'),JSON.stringify(verified));console.log(data);
}finally{await app.close().catch(()=>{});fake.kill();execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;[v.delete(sys.argv[1]+'/'+s) for s in ('deepseek','encryption')]",namespace],{windowsHide:true});}
