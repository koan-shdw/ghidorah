// Screen control for Claude models (FEATURE-SPECS 1, Koan 2026-10-10), through the Claude fixture and a fake
// cua-driver MCP server: the first touch of an app asks "Let <model> control <app>?" with Allow for this chat,
// Always and No; Always is remembered; the whole screen asks on its own; the bar and Esc are live while the model
// works; the bar's Stop ends the turn; tools outside the allowed list never reach the model; the switch turns it off.
import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','screen-control-')),namespace='Trismegistus/Test/'+path.basename(data),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-screen-'));
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');
const app=await electron.launch({args:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath,TRISMEGISTUS_TEST_CUA_DRIVER:path.join(root,'tests/fixtures/fake-cua-driver.cmd')},timeout:30000});
try{
 await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.webContents.setBackgroundThrottling(false);BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
 const page=await mainWindow(app),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,state=>state.backend==='ready'&&!!state.claude?.models?.length);await call('wizardFinish');await call('workingFolder',{folder});
 const chatId=await call('newChat');await call('addModel',{chatId,model:'claude-code:haiku'});
 await call('mode',{projectId:(await call('state')).chats.find((chat:any)=>chat.id===chatId).projectId,mode:'bypass'});
 assert.equal((await call('state')).browserTools.screen,true,'screen control is on by default');
 const send=async(tool:string,args:any)=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text:JSON.stringify({action:'mcp',server:'screen',tool,arguments:args}),models:['claude-code:haiku']});return id;};
 const finished=(id:string)=>pollState(page,state=>state.turns.some((turn:any)=>turn.id===id&&['completed','failed','stopped','interrupted'].includes(turn.status)),60000);
 const asked=(id:string)=>pollState(page,state=>state.approvals.some((row:any)=>row.turnId===id&&row.status==='pending'&&row.params?.screenApp),30000).then((state:any)=>state.approvals.find((row:any)=>row.turnId===id&&row.status==='pending'));
 const bar=()=>app.evaluate(({BrowserWindow,globalShortcut})=>({open:BrowserWindow.getAllWindows().some(w=>!w.isDestroyed()&&w.getTitle()==='Screen control'),esc:globalShortcut.isRegistered('Escape')}));
 const until=async(check:()=>Promise<boolean>,what:string)=>{for(const end=Date.now()+15000;!await check();){if(Date.now()>end)throw Error('Timed out: '+what);await page.waitForTimeout(100);}};
 const text=(state:any,id:string)=>JSON.stringify(state.turns.find((turn:any)=>turn.id===id));

 // 1. First touch of an app asks; Always remembers it; the bar and Esc are live while the (slow) click runs.
 let id=await send('click',{pid:process.pid,x:999,y:5});
 const question=await asked(id);assert.match(question.params.description,/^Let .+ control Node\?$/);assert.equal(question.params.screenApp,'Node');
 await call('approve',{id:question.id,choice:'always'});
 await until(async()=>{const b=await bar();return b.open&&b.esc;},'the bar and Esc while the model works');
 let state:any=await finished(id);assert.equal(state!.turns.find((turn:any)=>turn.id===id).status,'completed');assert.match(text(state,id),/fake click done/);
 assert.deepEqual(state!.browserTools.apps,['Node']);
 await until(async()=>{const b=await bar();return !b.open&&!b.esc;},'the bar and Esc end with the turn');

 // 2. An app allowed always is not asked about again.
 id=await send('click',{pid:process.pid,x:5,y:5});state=await finished(id);
 assert.match(text(state,id),/fake click done/);assert.ok(!state!.approvals.some((row:any)=>row.turnId===id),'no question the second time');

 // 3. The whole screen asks on its own; No refuses the action.
 id=await send('get_desktop_state',{});const whole=await asked(id);assert.match(whole.params.description,/whole screen\?$/);
 await call('approve',{id:whole.id,choice:'deny'});state=await finished(id);assert.match(text(state,id),/did not allow the whole screen/);

 // 4. The bar's Stop ends the turn (the click would take 30 s).
 id=await send('click',{pid:process.pid,x:998,y:5});const stopAt=Date.now();await until(async()=>(await bar()).open,'the bar while the model works');
 await app.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Screen control')!;await w.webContents.executeJavaScript("document.querySelector('button').click()");});
 state=await finished(id);assert.match(state!.turns.find((turn:any)=>turn.id===id).status,/stopped|interrupted/);assert.ok(Date.now()-stopAt<25000,'Stop does not wait for the click');

 // 5. Tools outside the allowed list never reach the model.
 id=await send('kill_app',{pid:process.pid});state=await finished(id);assert.match(text(state,id),/No MCP tool/);

 // 6. The switch turns screen control off for every model.
 await call('screenSettingsSave',{screen:false});await pollState(page,s=>s.backend==="ready"&&s.browserTools?.screen===false,60000);
 id=await send('click',{pid:process.pid,x:5,y:5});state=await finished(id);assert.match(text(state,id),/No MCP tool/);
 console.log('PASS screen control for Claude models: app and whole-screen questions, Always remembered, bar and Esc while working, Stop ends the turn, blocked tools hidden, switch off. '+data);
}finally{await app.close().catch(()=>{});const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');}
