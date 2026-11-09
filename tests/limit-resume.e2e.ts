import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';

// Resume after the usage limit (Koan 2026-11-09): a message Claude's limit stops waits with the reset time the limit
// gave, says so on its row, and goes by itself at that time, also when the app was closed at the reset; the messages
// behind it say what they wait for; Stop on the message cancels the wait.
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','limit-resume-')),folder=await fs.mkdtemp(path.join(root,'work','limit-resume-files-')),namespace='Trismegistus/Test/'+path.basename(data);
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'deepseek.jsonl')},windowsHide:true,stdio:'pipe'}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const codex=spawn(PYTHON,['tests/fake_codex.py',namespace,path.join(data,'gpt.jsonl')],{env:host.environment(),windowsHide:true,stdio:'pipe'}),codexLines=createInterface({input:codex.stdout}),[codexLine]=await once(codexLines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CODEX_URL:JSON.parse(codexLine).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env,timeout:30000});
let instance=await launch(),page=await instance.firstWindow();
const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
const wait=async(predicate:(s:any)=>boolean,limit=60000)=>{const end=Date.now()+limit;while(Date.now()<end){const s=await call('state');if(predicate(s))return s;await page.waitForTimeout(150);}throw Error('Timed out: '+JSON.stringify((await call('state')).turns));};
const hide=()=>instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.hide()));
const requests=()=>fs.readFile(path.join(data,'claude-requests.jsonl'),'utf8').then(text=>text.trim().split('\n').filter(Boolean).map(row=>JSON.parse(row)),()=>[] as any[]);
const turn=(s:any,id:string)=>s.turns.find((t:any)=>t.id===id);
const finished=['completed','failed','interrupted','needs-model','stopped'];
const done=async(id:string,status='completed')=>{const t=turn(await wait(s=>finished.includes(turn(s,id)?.status)),id);assert.equal(t.status,status,t.error);return t;};
const pauseText=/^Paused until \d\d:\d\d, limit\. Resumes by itself$/;
try{
 await hide();await wait(s=>s.backend==='ready'&&s.availableModels.includes('claude-code:haiku'));
 const chatId=await call('addProject');await call('workingFolder',{folder});await call('addModel',{chatId,model:'claude-code:haiku'});await call('modelSelection',{chatId,model:'claude-code:haiku',selected:true});
 const send=async(text:string)=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text});return id;};
 // A message the limit stops, with the reset `seconds` ahead: it waits as the spec says.
 const limited=async(seconds:number)=>{
  const reset=Math.ceil(Date.now()/1000)+seconds,id=await send(JSON.stringify({action:'limit',reset,once:true})),row=turn(await wait(s=>turn(s,id)?.resume),id);
  assert.equal(row.status,'queued');assert.deepEqual(row.resume,{at:reset*1000,reason:'limit'});assert.match(row.hold,pauseText);assert.equal(row.error,null);assert.equal(row.paused,undefined);
  return {id,reset};
 };
 const sentFor=async(reset:number)=>(await requests()).filter(row=>String(row.prompt).includes(String(reset))).length;

 // 1. The limit pauses the message; the message behind it says so; both go at the reset, by themselves.
 const first=await limited(12);assert.equal((await call('state')).availableModels.includes('claude-code:haiku'),false,'the limit blocks the model until its reset');
 const behind=await send('Behind the paused one.');await wait(s=>turn(s,behind)?.hold==='Waiting for the paused message above');
 assert.equal(await sentFor(first.reset),1);
 const resumed=await done(first.id);assert.ok(Date.now()>=first.reset*1000,'went at the reset, not before');
 assert.equal(await sentFor(first.reset),2,'the same message went twice: once stopped by the limit, once by itself');
 assert.equal(resumed.text,'Resumed after the limit.');assert.equal(resumed.resume,undefined);assert.equal(resumed.hold,undefined);
 await done(behind);assert.equal(turn(await call('state'),behind).hold,undefined);
 console.log('PASS the limit pauses the message with its reset time, the message behind it says so, both go by themselves at the reset');

 // 2. Closed at the reset: the wait carries on at the next start, unpaused, and the message goes once the time has passed.
 const second=await limited(20);
 await instance.evaluate(({app})=>app.quit());await instance.close();instance=await launch();page=await instance.firstWindow();await hide();
 await wait(s=>s.backend==='ready'&&s.claude?.models?.length);
 const after=turn(await call('state'),second.id);assert.equal(after.status,'queued');assert.deepEqual(after.resume,{at:second.reset*1000,reason:'limit'});assert.equal(after.paused,undefined,'a restart leaves a message waiting for its reset unpaused');
 assert.equal((await done(second.id)).text,'Resumed after the limit.');assert.equal(await sentFor(second.reset),2);
 console.log('PASS the wait carries on across a restart and the message goes when the time has passed');

 // 3. Stop on the message cancels the wait.
 const third=await limited(600);await call('cancelQueued',{id:third.id});await wait(s=>!turn(s,third.id));
 await page.waitForTimeout(1500);assert.equal(await sentFor(third.reset),1,'nothing goes for a removed message');
 console.log('PASS Stop on the paused message cancels the wait');
 console.log('Evidence: '+data);
}finally{await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});fake.stdin.end('\n');codex.stdin.end('\n');lines.close();codexLines.close();await host.host('delete_key').catch(()=>{});}
