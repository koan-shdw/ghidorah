// Send now takes the path Stop already has, with the reason "superseded-by-message". This proves that path on both
// engines for a message sent while a reply runs: the check says it can be pushed, the reply stops and keeps its text
// and reads "Stopped for your new message", and the waiting message is answered by itself.
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {Backend,PYTHON} from '../app/backend';
import {sendNowCheck} from '../app/send-now';
import {mainWindow,pollState} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work','send-now-')),folder=await fs.mkdtemp(path.join(root,'work','workspace-send-now-')),namespace='Trismegistus/Test/'+path.basename(data);
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{windowsHide:true,stdio:'pipe',env:{...process.env,FIXTURE_RECORDS:path.join(data,'provider-requests.jsonl')}}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden','--disable-gpu']:[root,'--hidden','--disable-gpu'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath}});
try{
 const page=await mainWindow(app),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&!!s.availableModels?.includes('deepseek-flash')&&!!s.claude?.models?.length);await call('workingFolder',{folder});
 async function pushed(engine:string,chatId:string,send:(text:string)=>Promise<string>,slow:string,next:string,keepsText=true){
  const first=await send(slow);await pollState(page,s=>(s.turns.find(t=>t.id===first)?.text||'').length>20,60000);
  const second=await send(next);
  let state=await pollState(page,s=>{const row=s.turns.find(t=>t.id===second);return !!row&&(row.delivery==='sent'||row.status==='queued');},30000);
  const rows=state.turns.filter(t=>t.chatId===chatId),waiting=rows.find(t=>t.id===second)!;
  assert.deepEqual(sendNowCheck(waiting,rows,first),{ok:true},engine+': a message the reply has not read can be pushed');
  assert.equal(sendNowCheck(rows.find(t=>t.id===first)!,rows,first).ok,false,engine+': the running reply itself cannot');
  await call('stop',{chatId,reason:'superseded-by-message'});
  state=await pollState(page,s=>s.turns.find(t=>t.id===first)?.status==='stopped'&&['completed','failed','interrupted','stopped','needs-model'].includes(s.turns.find(t=>t.id===second)?.status||''),90000);
  const stopped=state.turns.find(t=>t.id===first)!,answered=state.turns.find(t=>t.id===second)!;
  assert.equal(stopped.stopReason,'superseded-by-message',engine);
  // The stand-in Claude ends an interrupted reply with the one word "Interrupted", which takes the place of what it
  // streamed; the real one leaves the streamed text in place.
  if(keepsText)assert.ok(stopped.text.length>20,engine+': the stopped reply keeps its text: '+JSON.stringify(stopped.text.slice(0,60)));
  assert.equal(answered.status,'completed',engine+': the waiting message is answered by itself: '+JSON.stringify({status:answered.status,error:answered.error,answeredIn:answered.answeredIn}));
  assert.ok(answered.text.trim().length>0,engine+': and has its own reply');assert.equal(answered.answeredIn,undefined,engine);
  assert.equal(sendNowCheck(answered,state.turns.filter(t=>t.chatId===chatId),null).ok,false,engine+': nothing left to push');
  console.log('PASS '+engine+': the reply stopped for the new message and the waiting message was answered');
 }
 const hermes=await call('addProject',{folder}) as string,project=(await call('state')).chats.find((c:any)=>c.id===hermes).projectId;await call('mode',{projectId:project,mode:'bypass'});
 await pushed('Hermes',hermes,async text=>{const id=crypto.randomUUID();await call('submit',{id,chatId:hermes,text,selected:true});return id;},'SLOW_FIXTURE stream a long answer','Say one more line after that.');
 await page.locator('[data-chat-id="'+hermes+'"] .chat-link').evaluate((element:HTMLElement)=>element.click());
 await page.getByText('Stopped for your new message',{exact:false}).first().waitFor({state:'attached',timeout:15000});
 console.log('PASS the stopped reply reads "Stopped for your new message" in the chat');
 const claude=await call('addProject',{folder}) as string;await call('addModel',{chatId:claude,model:'claude-code:haiku'});
 await pushed('Claude Code',claude,async text=>{const id=crypto.randomUUID();await call('submit',{id,chatId:claude,text,models:['claude-code:haiku']});return id;},JSON.stringify({action:'slow',repeat:400}),JSON.stringify({action:'reply'}),false);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end('\n');lines.close();await fs.rm(folder,{recursive:true,force:true});await host.host('delete_key').catch(()=>{});execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});}
