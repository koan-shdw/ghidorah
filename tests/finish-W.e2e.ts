import {_electron as electron,type Page} from 'playwright';
import {launchPackaged} from './fixtures/launch-packaged';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';

// Finish plan section W in the desktop, through fakes: the setup wizard on first launch (1b).
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','finish-W-')),namespace='Trismegistus/Test/'+path.basename(data);
const ds=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'deepseek.jsonl')},windowsHide:true,stdio:'pipe'}),[dline]=await once(createInterface({input:ds.stdout}),'line');
// The test asks for the wizard; a test profile never shows it otherwise (rule 13).
const env:Record<string,string>={...process.env as Record<string,string>,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(dline).url,TRISMEGISTUS_TEST_WIZARD:'1'};
// Console windows: none of the app's processes may show one (spawned processes stay windowsHide).
const consoles=()=>execFileSync('powershell',['-NoProfile','-Command',"Get-Process | Where-Object {$_.MainWindowHandle -ne 0 -and $_.ProcessName -match '^(python|pythonw|cmd|conhost|pwsh|powershell|node|uv|git|taskkill)$'} | ForEach-Object {$_.Id}"],{encoding:'utf8',windowsHide:true}).split(/\s+/).filter(Boolean);
const before=new Set(consoles());
// A release build has the Node inspector fuse off, so electron.launch cannot attach: use Chromium CDP there.
const launch=async():Promise<{firstWindow:()=>Promise<Page>;close:()=>Promise<void>}>=>{
 if(!process.env.TRISMEGISTUS_EXE)return electron.launch({args:[root],env,timeout:30000});
 const {page,close}=await launchPackaged(env,{hidden:false});return {firstWindow:async()=>page,close};
};
let instance=await launch();
try{
 let page=await instance.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(s:any)=>boolean,timeout=90000)=>{const end=Date.now()+timeout;while(Date.now()<end){const s=await call('state');if(predicate(s))return s;await page.waitForTimeout(200);}throw Error('Timed out');};
 await wait(s=>s.backend==='ready');
 let wizard=page.getByRole('dialog',{name:'Setup',exact:true});await wizard.waitFor();
 assert.equal(await wizard.evaluate(dialog=>dialog.matches(':modal')),true,'native modal makes the app behind setup inert');
 await page.keyboard.press('Tab');assert.equal(await wizard.evaluate(dialog=>dialog.contains(document.activeElement)),true);
 assert.equal(await page.getByRole('dialog',{name:'Settings',exact:true}).count(),0,'the wizard shows instead of Settings');
 // Suppliers: the same rows Settings shows, with real vendor icons, without the picker and MCP parts.
 await wizard.locator('.supplier-pill summary').filter({hasText:'DeepSeek'}).locator('.vendor-icon svg').waitFor();
 assert.equal(await wizard.locator('.decision-settings, .mcp-settings').count(),0);
 await wizard.getByLabel('DeepSeek API key',{exact:true}).fill('synthetic-deepseek-regression-credential');
 await wizard.getByRole('button',{name:'Save connection',exact:true}).click();await wait(s=>s.connected&&s.providerStatus==='Connected');
 await wizard.getByRole('button',{name:'Next',exact:true}).click();
 await instance.close();instance=await launch();page=await instance.firstWindow();await wait(s=>s.backend==='ready');wizard=page.getByRole('dialog',{name:'Setup',exact:true});
 for(const step of ['Claude Code','Jev','Start with Windows']){await wizard.locator('.wizard-steps [aria-current]').filter({hasText:step}).waitFor();if(step==='Jev')await wizard.getByLabel('Jev API key',{exact:true}).waitFor({state:'visible'});await wizard.getByRole('button',{name:'Skip',exact:true}).click();}
 // An error on a later step leaves what is done as it was.
 await wizard.locator('.wizard-steps [aria-current]').filter({hasText:'Remote'}).waitFor();
 await wizard.getByRole('switch',{name:'Remote',exact:true}).click();await wizard.getByRole('alert').filter({hasText:'user ID'}).waitFor();
 await wizard.getByRole('button',{name:'Skip',exact:true}).click();
 await wizard.locator('.wizard-steps [aria-current]').filter({hasText:'Share with clients'}).waitFor();await wizard.getByRole('button',{name:'Skip',exact:true}).click();
 await wizard.locator('.wizard-summary li').nth(5).waitFor();
 const rows=await wizard.locator('.wizard-summary li').evaluateAll(items=>items.map(item=>[item.querySelector('strong')!.textContent,item.getAttribute('data-outcome')]));
 assert.deepEqual(rows,[['DeepSeek','connected'],['Claude Code','skipped'],['Jev','skipped'],['Start with Windows','skipped'],['Remote','skipped'],['Share with clients','skipped']]);
 let s=await call('state');assert.deepEqual(s.wizard.steps,{suppliers:'done',claude:'skipped',jev:'skipped','always-on':'skipped',remote:'skipped',sharing:'skipped'});
 await page.screenshot({path:path.join(data,'wizard-summary.png')});
 // A step's next action opens its page in Settings.
 await wizard.locator('.wizard-summary li').filter({hasText:'Remote'}).getByRole('button').click();
 await page.getByRole('dialog',{name:'Settings',exact:true}).getByRole('switch',{name:'Remote',exact:true}).waitFor();
 for(const name of ['Connections','Claude Code','Always on','Remote'])assert.equal(await page.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name,exact:true}).count(),1);
 const close=page.getByRole('button',{name:'Close settings',exact:true});await close.waitFor();await close.click();
 await call('wizardOpen');await wizard.getByRole('button',{name:'Finish',exact:true}).click();await wizard.waitFor({state:'hidden'});
 // The first message gets a reply.
 const chatId=await call('newChat');await page.locator('[data-chat-id="'+chatId+'"] .chat-link').click();
 await page.locator('.model-tab').filter({hasText:'DeepSeek'}).click();
 await page.getByLabel('Message',{exact:true}).fill('First message after setup.');await page.getByLabel('Message',{exact:true}).press('Enter');
 s=await wait(s=>s.turns.some((turn:any)=>turn.chatId===chatId&&turn.status==='completed'),120000);
 assert.match(s.turns.find((turn:any)=>turn.chatId===chatId).text,/First message after setup/);
 // A relaunch shows no wizard.
 await instance.close();instance=await launch();page=await instance.firstWindow();await wait(s=>s.backend==='ready');
 await page.waitForTimeout(2000);assert.equal(await page.getByRole('dialog',{name:'Setup',exact:true}).count(),0,'finished: no wizard again');
 // Closing setup ends it: it does not come back on the next launch (Koan, 2026-10-08: it reopened after an update).
 await call('wizardOpen',{step:'suppliers'});await page.getByRole('dialog',{name:'Setup',exact:true}).waitFor();await page.keyboard.press('Escape');
 await page.getByRole('dialog',{name:'Setup',exact:true}).waitFor({state:'hidden'});assert.equal((await call('state')).wizard.show,false);
 await instance.close();instance=await launch();page=await instance.firstWindow();await wait(s=>s.backend==='ready');
 await page.waitForTimeout(2000);assert.equal(await page.getByRole('dialog',{name:'Setup',exact:true}).count(),0,'closed: no wizard again');
 assert.deepEqual(consoles().filter(id=>!before.has(id)),[],'no console window appeared');
 console.log('PASS W wizard: shown on a fresh profile; DeepSeek connects in it; skips and an error keep what is done; the Summary reads the live state; steps open in Settings; first message answered; not shown again');
}finally{
 await instance.close().catch(()=>{});ds.stdin.end();ds.kill();
 const host=new Backend(root,data,namespace,()=>{});await host.host('delete_key',{provider:'deepseek'}).catch(()=>{});
 const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');
}
