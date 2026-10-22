// Real packaged Hermes processes and permission middleware; local model replies.
import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','process-ownership-')),folder=path.join(data,'workspace');await fs.mkdir(folder);
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const record=path.join(data,'requests.jsonl');
const fake=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:record},windowsHide:true,stdio:'pipe'}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url};
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env,timeout:30000});
const pids:number[]=[];
try{
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.hide()));const page=await instance.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(state:any)=>boolean)=>{const until=Date.now()+65000;while(Date.now()<until){const state=await call('state');if(predicate(state))return state;await page.waitForTimeout(100);}throw Error('Timed out: '+JSON.stringify((await call('state')).turns));};
 await wait(s=>s.backend==='ready');await call('workingFolder',{folder});const a=await call('addProject'),b=await call('addProject');
 const tool=async(chatId:string,name:string,args:any,approved=true)=>{
  await call('modelSelection',{chatId,model:'deepseek-flash',selected:true});const id=crypto.randomUUID();
  await call('submit',{id,chatId,text:'MCP_FIXTURE '+JSON.stringify({name,arguments:args})});
  const state=await wait(s=>{
   for(const approval of s.approvals.filter((v:any)=>v.turnId===id&&v.status==='pending'))void call('approve',{id:approval.id,choice:approved?'once':'deny'});
   return s.turns.some((t:any)=>t.id===id&&['completed','failed','interrupted'].includes(t.status));
  });
  const turn=state.turns.find((t:any)=>t.id===id);assert.equal(turn.status,'completed',JSON.stringify(turn));return turn.text;
 };
 const decode=(text:any):any=>{if(typeof text==='string'){try{return decode(JSON.parse(text));}catch{return text;}}if(Array.isArray(text))return text.map(decode);if(text&&typeof text==='object')return Object.fromEntries(Object.entries(text).map(([key,value])=>[key,decode(value)]));return text;};
 const handle=(value:any):any=>{value=decode(value);if(value?.session_id&&value?.pid)return value;if(value&&typeof value==='object')for(const nested of Object.values(value)){const found=handle(nested);if(found)return found;}};
 const start=async(chatId:string,marker:string)=>{
  const script=marker.toLowerCase()+'.py';await fs.writeFile(path.join(folder,script),`import time\nprint('${marker}',flush=True)\ntime.sleep(300)\n`);
  const id=crypto.randomUUID();await call('submit',{id,chatId,text:'BACKGROUND_FIXTURE '+JSON.stringify({script,command:'python -u '+script,summary:'Read the isolated fixture: prints only to its own output stream and waits without shared file or service effects.',resources:[]}),models:['deepseek-flash']});
  const state=await wait(s=>{for(const approval of s.approvals.filter((v:any)=>v.turnId===id&&v.status==='pending'))void call('approve',{id:approval.id,choice:'once'});return s.turns.some((t:any)=>t.id===id&&t.status==='completed');});
  const text=state.turns.find((t:any)=>t.id===id).text,process=handle(text);assert.ok(process?.session_id,JSON.stringify(text));pids.push(process.pid);return process;
 };
 const alpha=await start(a,'ALPHA_PROCESS_PRIVATE'),beta=await start(b,'BETA_PROCESS_PRIVATE');
 const poll=async(chat:string,id:string)=>tool(chat,'process_manage',{action:'poll',session_id:id});
 assert.match(await poll(a,alpha.session_id),/ALPHA_PROCESS_PRIVATE/);
 assert.match(await poll(b,beta.session_id),/BETA_PROCESS_PRIVATE/);
 const project=(await call('state')).chats.find((c:any)=>c.id===a).projectId;await call('mode',{projectId:project,mode:'plan'});
 assert.match(await poll(a,alpha.session_id),/ALPHA_PROCESS_PRIVATE/);
 assert.match(await tool(a,'process_manage',{action:'kill',session_id:alpha.session_id}),/Plan mode/);assert.match(await poll(a,alpha.session_id),/ALPHA_PROCESS_PRIVATE/);
 assert.equal((await call('state')).workReview.length,0,'a mandatory permission refusal cannot leave an uncertain effect');await call('mode',{projectId:project,mode:'manual'});
 for(const [chat,own,other,ownMarker,otherMarker] of [[a,alpha,beta,'ALPHA_PROCESS_PRIVATE','BETA_PROCESS_PRIVATE'],[b,beta,alpha,'BETA_PROCESS_PRIVATE','ALPHA_PROCESS_PRIVATE']] as const){
  const list=await tool(chat,'process_manage',{action:'list'});assert.match(list,new RegExp(own.session_id));assert.doesNotMatch(list,new RegExp(other.session_id+'|'+otherMarker));
  for(const action of ['poll','log','kill','write']){
   const refused=await tool(chat,'process_manage',{action,session_id:other.session_id,data:'no foreign input'});
   assert.match(refused,/Process unavailable in this chat/);assert.doesNotMatch(refused,new RegExp(otherMarker));
  }
  const prefix=other.session_id.slice(0,-2);assert.match(await poll(chat,prefix),/Process unavailable in this chat/);
  assert.match(await poll(chat,own.session_id),new RegExp(ownMarker));
 }
 console.log('PASS actual processes survive their spawning replies; list, poll, log, kill, stdin and prefix access stay in the owning chat');
 const stopped=await tool(a,'process_manage',{action:'kill',session_id:alpha.session_id});assert.match(stopped,/killed|already_exited/);
 assert.match(await poll(b,beta.session_id),/BETA_PROCESS_PRIVATE/);
 assert.match(await poll(b,alpha.session_id),/Process unavailable in this chat/,'retained output remains private after exit');
 await assert.rejects(call('restart'),/Stop active work before restarting/);assert.match(await tool(b,'process_manage',{action:'kill',session_id:beta.session_id}),/killed|already_exited/);
 await wait(s=>!s.background?.some((row:any)=>['running','checking','stopping'].includes(row.status)));
 const before=(await fs.readFile(record,'utf8')).trim().split('\n').length;
 await call('restart');await wait(s=>s.backend==='ready');await page.waitForTimeout(500);
 assert.equal((await fs.readFile(record,'utf8')).trim().split('\n').length,before,'restart sends no automatic model prompt');
 for(const pid of pids)assert.throws(()=>process.kill(pid,0),'process tree must stop with the backend');
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({processes:2,turns:(await call('state')).turns.length,foreignAccessRefused:true,retainedOutputPrivate:true,restartNoReplay:true,processTreesStopped:true},null,2));
 console.log('PASS owner-only Stop preserves sibling process; restart ends children without model replay. Evidence: '+data);
}finally{
 await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close();fake.stdin.end('\n');lines.close();await host.host('delete_key');
}
