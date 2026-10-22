// The Anthropic panel and the Claude Code page run Claude Code's own sign-in (10-22: its sign-in expired and Ghidorah
// had no way back in). Stand-in Claude Code only; never his account.
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';
import {launchPackaged} from './fixtures/launch-packaged';
import type {Page} from 'playwright';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/claude-signin-')),namespace='Trismegistus/Test/'+path.basename(data);
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
// A release build disables the Node inspector, so it is driven through CDP (fixtures/launch-packaged).
let page:Page,quit:()=>Promise<void>;
if(process.env.TRISMEGISTUS_EXE)({page,close:quit}=await launchPackaged(env));
else{
 const app=await electron.launch({args:[root,'--hidden'],env,timeout:30000});
 await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
 page=await mainWindow(app);quit=async()=>{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});};
}
try{
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 page.setDefaultTimeout(20000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await pollState(page,s=>s.backend==='ready'&&s.claude?.status==='Signed in');await call('wizardFinish');
 if(await page.getByLabel('Close settings',{exact:true}).isVisible())await page.getByLabel('Close settings',{exact:true}).click();
 const logins=()=>fs.readFile(path.join(data,'login-requests.jsonl'),'utf8').then(text=>text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),()=>[]);
 const waitFor=async(count:number)=>{for(let i=0;i<100&&(await logins()).length<count;i++)await new Promise(r=>setTimeout(r,100));};
 await page.locator('.settings-link').click();const dialog=page.getByRole('dialog',{name:'Settings',exact:true}),nav=dialog.getByRole('navigation',{name:'Settings sections'});
 await nav.getByRole('button',{name:'Connections',exact:true}).click();
 const panel=dialog.locator('details.supplier-pill').filter({has:page.locator('summary strong',{hasText:/^Anthropic$/})}).first();
 await panel.locator('summary').click();
 const button=panel.getByRole('button',{name:'Switch account',exact:true});await button.click();
 await waitFor(1);await pollState(page,s=>s.claude?.status==='Signed in');
 assert.deepEqual((await logins()).map(row=>row.args.slice(-3).join(' ')),['auth login --claudeai'],'Anthropic panel runs Claude Code sign-in once');
 await nav.getByRole('button',{name:'Claude Code',exact:true}).click();await page.locator('[data-settings-page="claude-code"]').waitFor();
 await page.locator('[data-settings-page="claude-code"]').getByRole('button',{name:'Switch account',exact:true}).click();
 await waitFor(2);await pollState(page,s=>s.claude?.status==='Signed in');
 assert.equal((await logins()).length,2,'Claude Code page runs Claude Code sign-in');
 assert.deepEqual(errors,[]);
 console.log('PASS Claude Code sign-in from the Anthropic panel and the Claude Code page. '+data);
}finally{await quit();execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});}
