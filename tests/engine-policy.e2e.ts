import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';
import {launchPackaged} from './fixtures/launch-packaged';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/engine-policy-')),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-policy-'));
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{windowsHide:true,stdio:'pipe'}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const app=process.env.TRISMEGISTUS_EXE?null:await electron.launch({args:[root,'--hidden'],env});
const run=app?{page:await mainWindow(app),close:async()=>{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}}:await launchPackaged(env);
try{
 const page=run.page,call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&!!s.claude?.models?.length&&!!s.availableModels?.includes('deepseek-flash'));
 await call('wizardFinish');await call('workingFolder',{folder});
 for(const model of ['deepseek-flash','claude-code:haiku']){
  const chatId=await call('newChat'),state=await call('state'),id=crypto.randomUUID();
  await call('addModel',{chatId,model});
  await call('mode',{projectId:state.chats.find((c:any)=>c.id===chatId).projectId,mode:'bypass'});
  const command='powershell -NoProfile -Command "Get-ExecutionPolicy -Scope Process; Get-ExecutionPolicy -List"';
  await call('submit',{id,chatId,models:[model],text:model.startsWith('claude')?JSON.stringify({action:'powershell'}):'COORDINATION_COMMAND '+JSON.stringify({command})});
  const done=await pollState(page,s=>s.turns.some(t=>t.id===id&&['completed','failed','interrupted'].includes(t.status)));
  assert.equal(done.turns.find(t=>t.id===id)!.status,'completed');
  const tool=done.tools.find(t=>t.turnId===id&&['Bash','terminal'].includes(t.name));assert.ok(tool,model+' command missing');
  assert.equal(tool.status,'completed',JSON.stringify(tool.result));const output=JSON.stringify(tool.result);
  assert.match(output,/Bypass/);assert.match(output,/Process\s+Bypass/);
  assert.match(output,/MachinePolicy\s+Undefined/);assert.match(output,/UserPolicy\s+Undefined/);
 }
 console.log('PASS model-started PowerShell in both engines: Process Bypass, MachinePolicy and UserPolicy Undefined.');
}finally{await run.close();fake.stdin.end();lines.close();await host.host('delete_key');}
