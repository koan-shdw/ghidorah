// Live check with the fake model, real Hermes runtime (audit 2026-10-20, section 9 A to D). Free: no real model.
// 1. Stop cuts off a running tool; the next message reuses the same Hermes session and every tool call it sends has
//    its result (part D: a stopped turn keeps its session).
// 2. A background job's completion notice becomes exactly one automatic row and closes (part A: 10-19 ghost rows).
// 3. Hermes's background review is off in the profile config Tris writes (part C).
import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PYTHON} from '../app/backend';
import {launchPackaged} from './fixtures/launch-packaged';

const root=path.resolve('.'),data=path.join(root,'work','session-after-stop-'+Date.now());
const folder=await fs.mkdtemp(path.join(path.dirname(data),'session-after-stop-project-'));
const records=path.join(data,'requests.jsonl');
const fake=spawn(PYTHON,['tests/fake_provider.py'],{cwd:root,windowsHide:true,stdio:'pipe',env:{...process.env,FIXTURE_RECORDS:records}});
fake.stderr.on('data',b=>process.stderr.write(b));
const lines=createInterface({input:fake.stdout});const [line]=await once(lines,'line');const {url}=JSON.parse(line);
// A release build has the Node inspector fuse off: it is driven through Chromium CDP, as the other release checks are.
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:url};
const packaged=process.env.TRISMEGISTUS_EXE?await launchPackaged(env):undefined,instance=packaged?undefined:await electron.launch({args:[root],env,timeout:30000});
try{
 const page=packaged?packaged.page:await instance!.firstWindow();page.setDefaultTimeout(15000);
 const get=()=>page.evaluate(()=>window.desktop.invoke('state'));
 const invoke=(method:string,args:any={})=>page.evaluate(({method,args}:{method:string,args:any})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(check:(s:any)=>boolean,label:string,timeout=60000)=>{const until=Date.now()+timeout;let last;while(Date.now()<until){last=await get();if(check(last))return last;await page.waitForTimeout(250);}throw Error('Timed out waiting for '+label+': '+JSON.stringify(last?.turns?.map((t:any)=>[t.prompt.slice(0,30),t.status,t.error])));};
 await wait(s=>s.backend==='ready'||s.backend==='failed','startup',100000);
 await invoke('saveKey',{key:'synthetic-deepseek-regression-credential'});
 await wait(s=>s.backend==='ready'&&s.connected,'vault connection',100000);
 const chatId=await invoke('addProject',{folder});
 const projectId=(await get()).chats.find((c:any)=>c.id===chatId).projectId;await invoke('mode',{projectId,mode:'bypass'});
 const submit=async(text:string)=>{const id=crypto.randomUUID();await invoke('submit',{id,chatId,text,selected:true});return id;};
 const done=(id:string,status='completed')=>wait(s=>s.turns.find((t:any)=>t.id===id)?.status===status,status+' '+id);

 // 1. Stop mid-tool, then the next message.
 const first=await submit('First message ANCHOR_SESSION');await done(first);
 const stored=(await get()).chats.find((c:any)=>c.id===chatId).storedId;assert.ok(stored);
 const running=await submit('PROCESS_FIXTURE');
 const pidFile=path.join(folder,'process.pid');const deadline=Date.now()+30000;
 while(Date.now()<deadline){try{await fs.access(pidFile);break;}catch{await page.waitForTimeout(200);}}
 await invoke('stop',{chatId});await done(running,'stopped');
 const next=await submit('After the stop');await done(next);
 const chat=(await get()).chats.find((c:any)=>c.id===chatId);
 assert.equal(chat.storedId,stored,'the stopped turn kept its Hermes session');
 const requests=(await fs.readFile(records,'utf8')).trim().split('\n').map(row=>JSON.parse(row));
 const last=requests.findLast((body:any)=>JSON.stringify(body.messages).includes('After the stop'));assert.ok(last,'the next message reached the model');
 const calls=last.messages.flatMap((m:any)=>(m.tool_calls||[]).map((c:any)=>c.id)),results=new Set(last.messages.filter((m:any)=>m.role==='tool').map((m:any)=>m.tool_call_id));
 assert.ok(calls.length>0,'the cut-off tool call is in the resumed history');
 for(const id of calls)assert.ok(results.has(id),'tool call '+id+' has its result');
 assert.ok(JSON.stringify(last.messages).includes('ANCHOR_SESSION'),'the earlier conversation is still in the session');
 assert.ok(!(await get()).chats.find((c:any)=>c.id===chatId).compacting,'no summary was needed');
 console.log('PASS a stop mid-tool keeps the Hermes session; the next request answers every tool call');

 // 2. A background completion notice: one automatic row, closed.
 const before=(await get()).turns.filter((t:any)=>t.chatId===chatId&&t.automatic).length;
 const job=await submit('BACKGROUND_NOTICE_FIXTURE');await done(job);
 const notices=await wait(s=>s.turns.filter((t:any)=>t.chatId===chatId&&t.automatic).length>before&&s.turns.filter((t:any)=>t.chatId===chatId&&t.automatic).every((t:any)=>t.status==='completed'),'the notice turn',60000);
 await page.waitForTimeout(3000);
 const rows=(await get()).turns.filter((t:any)=>t.chatId===chatId&&t.automatic);
 assert.equal(rows.length,before+1,'one row per background update: '+JSON.stringify(rows.map((t:any)=>[t.status,t.text.slice(0,40)])));
 assert.ok(notices);assert.ok(rows.every((t:any)=>t.status==='completed'),'nothing left waiting');
 console.log('PASS a background completion notice is one automatic row and it closes');

 // 3. The background review is off in the profile config.
 const profile=(await get()).projects.find((p:any)=>p.id===projectId).profile;
 const config=await fs.readFile(path.join(data,'hermes','profiles',profile,'config.yaml'),'utf8');
 const settings=JSON.parse(config);assert.equal(settings.skills.creation_nudge_interval,0);assert.equal(settings.memory.nudge_interval,0);
 console.log('PASS Hermes background review is off');
}finally{if(packaged)await packaged.close();else{await instance!.evaluate(({app}:any)=>app.quit()).catch(()=>{});await instance!.close().catch(()=>{});}fake.stdin.end('\n');lines.close();}
