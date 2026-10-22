// Real Hermes transport, synthetic provider and isolated data. No user accounts.
import {_electron as electron} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../app/store';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';
import {launchPackaged} from './fixtures/launch-packaged';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work','work-completion-')),folder=await fs.mkdtemp(path.join(root,'work','completion-workspace-'));
execFileSync('git',['init','--quiet',folder],{windowsHide:true});
const marker=path.join(folder,'started.txt'),script=path.join(folder,'slow.py');await fs.writeFile(script,`from pathlib import Path\nimport time\nPath(${JSON.stringify(marker)}).write_text('started')\nprint('started once',flush=True)\ntime.sleep(25)\n`);
// Simulate a result saved by the tool just before the old desktop disappeared.
const seed=new Store(path.join(data,'chat.sqlite')),project=seed.project(folder),chat=seed.chat(project.id),lease=crypto.randomUUID();
seed.put('work-action',{id:lease,group:'before-restart',job:'before-restart',name:'terminal',args:{command:'old completed build'},resource:'*',access:'unknown',signature:'fixture',before:null,status:'running',owner:{generation:'old',sessionId:'old-session',chatId:chat.id,profile:project.profile}});seed.db.close();
const receipts=path.join(data,'hermes','profiles',project.profile,'desktop','work-results');await fs.mkdir(receipts,{recursive:true});await fs.writeFile(path.join(receipts,lease+'.json'),JSON.stringify({lease,session_id:'old-session',result:{exit_code:0,output:'already completed'},uncertain:false,refused:false}));
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const provider=spawn(PYTHON,['tests/fake_provider.py'],{windowsHide:true,stdio:'pipe'}),lines=createInterface({input:provider.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url},packaged=process.env.TRISMEGISTUS_EXE?await launchPackaged(env):undefined,app=packaged?undefined:await electron.launch({args:[root,'--hidden'],env,timeout:30000});
const actions=()=>{const db=new DatabaseSync(path.join(data,'chat.sqlite'),{readOnly:true});try{return db.prepare("SELECT data FROM records WHERE kind='work-action'").all().map((r:any)=>JSON.parse(r.data));}finally{db.close();}};
try{
 if(app)await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
 const page=packaged?.page||await mainWindow(app!),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready');assert.equal(actions().find(a=>a.id===lease).status,'completed');await assert.rejects(fs.stat(path.join(receipts,lease+'.json')),{code:'ENOENT'});
 await call('wizardFinish');await call('workingFolder',{folder});await call('mode',{projectId:project.id,mode:'bypass'});
 await call('addModel',{chatId:chat.id,model:'deepseek-flash'});
 const command={command:'python -u '+JSON.stringify(script),timeout:30,workdir:folder},turn=crypto.randomUUID();
 await call('submit',{id:turn,chatId:chat.id,text:'TOOL_SEQUENCE_FIXTURE '+JSON.stringify([{name:'read_file',arguments:{path:script}},{name:'inspect_action',arguments:{tool:'terminal',arguments:command,summary:'Writes only the marker, prints a status and sleeps; no services or external effects.',evidence:[script],resources:[{kind:'path',value:marker,access:'write'}]}},{name:'terminal',arguments:command}]),models:['deepseek-flash']});
 for(const end=Date.now()+60000;Date.now()<end&&!await fs.stat(marker).catch(()=>null);)await page.waitForTimeout(100);
 assert.equal(await fs.readFile(marker,'utf8'),'started');await call('stop',{chatId:chat.id});await pollState(page,s=>s.turns.some(t=>t.id===turn&&t.status==='stopped'));
 let original:any;for(const end=Date.now()+30000;Date.now()<end;){original=actions().find(a=>a.job===turn&&a.name==='terminal');if(original?.result!=null)break;await page.waitForTimeout(100);}
 assert.ok(original?.result!=null,'Stopping must retain the actual terminal result');assert.doesNotMatch(JSON.stringify(original.result),/This work has stopped|did not return a confirmed result/);
 assert.equal(original.status,'uncertain','An interrupted writer retains review even if the terminal reports error:null');
 const next=crypto.randomUUID();await call('submit',{id:next,chatId:chat.id,text:'MCP_FIXTURE '+JSON.stringify({name:'terminal',arguments:{command:'git status --short && git branch --show-current',workdir:folder}}),models:['deepseek-flash']});
 await pollState(page,s=>s.turns.some(t=>t.id===next&&['completed','failed'].includes(t.status)));const diagnostic=actions().find(a=>a.job===next&&a.name==='terminal');assert.equal(diagnostic?.status,'completed');
 assert.equal(await fs.readFile(marker,'utf8'),'started');assert.equal(actions().filter(a=>a.args.command===command.command).length,1);
 if(app)assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({restartReceiptRecovered:true,stoppedResultPreserved:original,diagnosticAfterStop:diagnostic,noReplay:true,noVisibleWindows:true},null,2));console.log('PASS restart receipt, real interrupted terminal result and diagnostic after Stop. '+data);
}finally{if(app){await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}await packaged?.close();provider.stdin.end('\n');lines.close();await host.host('delete_key');}
