import {_electron as electron,type ElectronApplication,type Page} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';

// Finish plan section 1 in the desktop: Always on (1d, 1e), Claude Code (1c), Security and Connections dots (1g).
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','finish-1-')),healthFile=path.join(data,'health.json'),fixture=path.join(root,'tests','fixtures','claude-cli.mjs');
await fs.writeFile(healthFile,JSON.stringify({deepseek:'ready'}));
const namespace='Trismegistus/Test/'+path.basename(data),entry='Ghidorah Test '+path.basename(data),host=new Backend(root,data,namespace,()=>{});
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const ds=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'deepseek.jsonl'),FIXTURE_HEALTH_FILE:healthFile},windowsHide:true,stdio:'pipe'}),[dline]=await once(createInterface({input:ds.stdout}),'line');
const api=spawn(PYTHON,['tests/fake_api_providers.py',data],{windowsHide:true,stdio:'pipe'}),[aline]=await once(createInterface({input:api.stdout}),'line');
const launch=(claude:string,extra:string[]=[])=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:[...(process.env.TRISMEGISTUS_EXE?[]:[root]),...extra],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(dline).url,TRISMEGISTUS_TEST_API_URLS:JSON.stringify({gemini:JSON.parse(aline).gemini}),TRISMEGISTUS_TEST_CLAUDE:claude,TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath},timeout:30000});
const runKey='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const startup=(name:string,key=runKey)=>{try{return execFileSync('reg',['query',key,'/v',name],{windowsHide:true,stdio:'pipe'}).toString();}catch{return '';}};
const approvedKey='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const realBefore=startup('Ghidorah');
let app:ElectronApplication=await launch(fixture),page:Page;
const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
const wait=async(predicate:(s:any)=>boolean)=>{const end=Date.now()+90000;while(Date.now()<end){const s=await call('state');if(predicate(s))return s;await page.waitForTimeout(150);}throw Error('Timed out: '+JSON.stringify(await call('state')));};
const settings=async(name:string)=>{if(!await page.getByRole('dialog',{name:'Settings'}).count())await page.locator('.settings-link').click();await page.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name,exact:true}).click();};
try{
 page=await app.firstWindow();
 let s=await wait(s=>s.backend==='ready'&&s.claude?.status==='Signed in'&&s.availableModels.includes('deepseek-flash'));
 assert.deepEqual(s.alwaysOn,{startWithWindows:false,stayAwake:'remote',desktopNotifications:true,questionSound:true,awake:false},'a fresh profile starts nothing and keeps nothing awake; alerts are on');
 assert.equal(startup(entry),'');

 await app.evaluate(({app})=>{(globalThis as any).savedLoginSetter=app.setLoginItemSettings;app.setLoginItemSettings=()=>{throw Error('Fixture startup registration failed');};});
 await assert.rejects(()=>call('alwaysOn',{startWithWindows:true}),/Fixture startup registration failed/);
 assert.equal((await call('state')).alwaysOn.startWithWindows,false,'a failed Windows change must not update the saved preference');
 await app.evaluate(({app})=>{app.setLoginItemSettings=(globalThis as any).savedLoginSetter;});
 await settings('Always on');
 const toggle=page.getByRole('switch',{name:'Start with Windows',exact:true});assert.equal(await toggle.getAttribute('aria-checked'),'false');
 await toggle.click();await wait(s=>s.alwaysOn.startWithWindows);await page.getByRole('switch',{name:'Start with Windows',exact:true,checked:true}).waitFor();
 const where=await app.evaluate(({app})=>({exe:process.execPath,folder:app.getAppPath(),packaged:app.isPackaged}));
 const args=[...(where.packaged?[]:[where.folder]),'--hidden'];
 const item:any=await app.evaluate(({app},options)=>app.getLoginItemSettings(options),{path:where.exe,args});
 assert.ok(item.launchItems?.some((launch:any)=>launch.name===entry&&launch.path.toLowerCase()===where.exe.toLowerCase()),JSON.stringify(item));
 const value=startup(entry);assert.ok(value.includes(where.exe)&&value.includes('--hidden'),value);
 await page.screenshot({path:path.join(data,'always-on.png')});
 await toggle.click();await wait(s=>!s.alwaysOn.startWithWindows);assert.equal(startup(entry),'');assert.equal(startup(entry,approvedKey),'');
 assert.equal(startup('Ghidorah'),realBefore,'the real sign-in entry is never touched');
 console.log('PASS 1d start with Windows writes its own test entry with the running build and --hidden, and removes it');

 for(const [choice,awake] of [['Always',true],['Off',false],['Only while remote is on',false]] as const){
  await page.locator('summary[aria-label="Stay awake"]').click();await page.getByRole('radio',{name:choice,exact:true}).click();
  await wait(s=>s.alwaysOn.stayAwake==={'Always':'always','Off':'off','Only while remote is on':'remote'}[choice]&&s.alwaysOn.awake===awake);
 }
 assert.match(await page.locator('.always-on-settings').innerText(),/Computer stays awake, screen still locks\./);
 console.log('PASS 1e stay awake: Always keeps the computer awake; Off and Only while remote is on (remote off) do not');

 await settings('Claude Code');
 assert.match(await page.locator('.claude-code-settings').innerText(),/Signed in/);
 assert.equal(await page.getByRole('button',{name:'Install Claude Code ↗',exact:true}).count(),0);
 console.log('PASS 1c installed Claude Code shows its status and no install link');

 await call('apiSave',{provider:'gemini',key:'synthetic-gemini-test-credential'});await wait(s=>s.apiProviders?.some((row:any)=>row.provider==='gemini'&&row.connected));
 await settings('Security');
 const rows=page.locator('.rotation-list > li');await page.waitForFunction(()=>document.querySelectorAll('.rotation-list > li').length===3);
 assert.deepEqual(await rows.locator('label').allInnerTexts(),['DeepSeek','Claude Code','Google · Gemini']);
 await page.getByRole('checkbox',{name:'DeepSeek rotated',exact:true}).click();await wait(s=>typeof s.keyRotation?.deepseek==='number');await page.getByRole('checkbox',{name:'DeepSeek rotated',exact:true,checked:true}).waitFor();
 assert.match(await rows.first().innerText(),/Done /);
 await page.screenshot({path:path.join(data,'security.png')});
 await rows.filter({hasText:'Google · Gemini'}).getByRole('button',{name:'Replace key',exact:true}).click();
 await page.locator('details.supplier-pill[open]').filter({hasText:'Google · Gemini'}).waitFor();
 const dots=page.locator('details.supplier-pill > summary .health-dot');assert.equal(await dots.count(),3,'one dot per connected supplier: DeepSeek, Anthropic, Gemini');
 await fs.writeFile(healthFile,JSON.stringify({deepseek:'exhausted'}));await call('checkAccount');await wait(s=>s.providerStatus==='Credit exhausted');
 await page.locator('details.supplier-pill > summary').filter({hasText:'DeepSeek'}).locator('.health-dot.limited').waitFor();
 await page.screenshot({path:path.join(data,'connection-dots.png')});
 console.log('PASS 1g Security lists one row per connected supplier with key pages and Replace key; Connections rows carry health dots');

 const chat=await call('newChat'),opening=app.waitForEvent('window');await call('openChatWindow',{chatId:chat});const restored=await opening;
 await restored.getByLabel('Message',{exact:true}).waitFor();await restored.getByLabel('Message',{exact:true}).fill('Hidden restored draft');
 await app.evaluate(({BrowserWindow},chat)=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('#chat='+chat))!.maximize(),chat);
 await app.close();app=await launch(path.join(data,'no-claude-here.mjs'),['--hidden']);page=app.windows().find(window=>!window.url().includes('#chat='))||await app.waitForEvent('window',{predicate:window=>!window.url().includes('#chat=')});
 await wait(s=>s.backend==='ready'&&s.claude?.status==='Claude Code not installed');
 await wait(s=>s.chatWindows.includes(chat));
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(window=>window.isVisible())),false,'--hidden also keeps restored maximized chat windows hidden');
 assert.equal((await call('state')).keyRotation.deepseek>0,true,'the checklist survives a restart');
 await app.evaluate(({BrowserWindow,shell})=>{(globalThis as any).opened=[];shell.openExternal=async(url:string)=>{(globalThis as any).opened.push(url);};BrowserWindow.getAllWindows()[0].show();});
 await settings('Claude Code');
 await page.getByRole('button',{name:'Install Claude Code ↗',exact:true}).click();
 await page.waitForFunction(()=>true);assert.deepEqual(await app.evaluate(()=>(globalThis as any).opened),['https://code.claude.com/docs/en/setup']);
 await call('openChatWindow',{chatId:chat});
 const reopened=app.windows().find(window=>window.url().endsWith('#chat='+chat))!;
 await reopened.getByLabel('Message',{exact:true}).waitFor();assert.equal(await reopened.getByLabel('Message',{exact:true}).inputValue(),'Hidden restored draft');
 assert.equal(await app.evaluate(({BrowserWindow},chat)=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('#chat='+chat))!.isVisible(),chat),true);
 assert.equal(await app.evaluate(({BrowserWindow},chat)=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('#chat='+chat))!.isMaximized(),chat),true);
 await page.screenshot({path:path.join(data,'claude-missing.png')});
 console.log('PASS 1c missing Claude Code shows the install link; --hidden starts unseen');
}finally{
 await app.close().catch(()=>{});ds.stdin.end();ds.kill();api.kill();
 for(const key of [runKey,approvedKey])try{execFileSync('reg',['delete',key,'/v',entry,'/f'],{windowsHide:true,stdio:'ignore'});}catch{}
 for(const provider of ['deepseek','gemini'])await host.host('delete_key',{provider}).catch(()=>{});
 const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');
}
