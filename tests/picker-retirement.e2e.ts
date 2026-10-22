import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';import {once} from 'node:events';import {createInterface} from 'node:readline';
import {Backend,PYTHON} from '../app/backend';import {Store} from '../app/store';import {mainWindow,pollState} from './fixtures/poll-state';
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/picker-retirement-')),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-picker-')),namespace='Trismegistus/Test/'+path.basename(data);
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{windowsHide:true,stdio:'pipe'}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url},timeout:30000});
let app=await launch();
try{
 let page=await mainWindow(app);const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&s.availableModels?.includes('deepseek-flash')===true);await call('wizardFinish');await call('workingFolder',{folder});
 const chatId=await call('newChat');await call('selectorModel',{chatId,model:'deepseek-flash'});
 await app.evaluate(({app})=>app.quit());await app.close();
 const db=new Store(path.join(data,'chat.sqlite'));db.put('settings',{id:'decision-engine',engine:'laya'});db.put('settings',{id:'laya',summaryModel:'deepseek-flash'});db.db.close();
 app=await launch();page=await mainWindow(app);const state=await pollState(page,s=>s.backend==='ready'&&s.availableModels?.includes('deepseek-flash')===true);
 assert.equal(state.decisionEngine?.selected,'jev');assert.equal('laya' in state,false);assert.ok(!state.decisionEngine?.pickers?.some(p=>String(p.id)==='laya'));assert.equal(state.chats.find(c=>c.id===chatId)?.selector,'deepseek-flash');
 await assert.rejects(call('decisionEngine',{engine:'laya'}),/listed picker/);for(const method of ['layaInstall','layaCheck','layaSettings','layaCancel'])await assert.rejects(call(method));
 const close=page.getByLabel('Close settings',{exact:true});if(await close.isVisible())await close.click();await page.locator('.settings-link').click();
 const nav=page.getByRole('navigation',{name:'Settings sections'});await nav.getByRole('button',{name:'Connections',exact:true}).click();
 await page.locator('summary[aria-label="Decision engine"]').click();assert.equal(await page.getByRole('radio',{name:/LAYA/}).count(),0);await page.getByRole('radio',{name:'Jev · TypeSafe',exact:true}).click();await close.click();
 await page.locator('[data-chat-id="'+chatId+'"] .chat-link').click();await page.locator('.model-row .on-duty').filter({hasText:'DeepSeek'}).waitFor();
 const id=crypto.randomUUID();await call('submit',{id,chatId,text:'Pick the model and explain this project.'});const result=await pollState(page,s=>s.turns.some(t=>t.id===id&&['completed','failed','interrupted','needs-model'].includes(t.status)));const turn=result.turns.find(t=>t.id===id)!;
 assert.equal(turn.status,'completed',turn.error||'');assert.equal(turn.routingUsage?.engine,'selector');assert.equal(turn.model,'deepseek-flash');
 assert.equal(await fs.access(path.join(data,'laya')).then(()=>true,()=>false),false);assert.ok(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())),'test windows remain hidden');
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({migration:true,selectorPreserved:true,selectorReply:true,noLayaChoice:true,noLayaActions:true,noLayaRuntime:true,hidden:true}));console.log('PASS picker retirement and LLM select duty. '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.kill();lines.close();execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;[v.delete(sys.argv[1]+'/'+s) for s in ('deepseek','encryption')]",namespace],{windowsHide:true,stdio:'ignore'});}
