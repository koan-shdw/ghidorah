// TRIS-TODO 1.11, a GPT message that sat on "Checking plugins" for 8 min 45 s while Hermes never got it: every
// preparation step now writes its time to prepare.log, and a step with no time limit of its own that runs past
// the limit ends the message with the step's name, so the next message goes out. The hang is a test hook.
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';
import {launchPackaged} from './fixtures/launch-packaged';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work','prepare-steps-')),folder=await fs.mkdtemp(path.join(root,'work','workspace-prepare-')),namespace='Trismegistus/Test/'+path.basename(data);
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{windowsHide:true,stdio:'pipe'}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_PREPARE_HANG:'Checking plugins: plugin files',TRISMEGISTUS_TEST_PREPARE_LIMIT:'3000',TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
// A release build has the Node inspector fuse off, so electron.launch cannot attach: use Chromium CDP there (as finish-W).
const open=process.env.TRISMEGISTUS_EXE?launchPackaged(env):electron.launch({args:[root],env}).then(async app=>({page:await mainWindow(app),close:async()=>{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}}));
const opened=await open;
try{
 const page=opened.page,call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&!!s.availableModels?.includes('deepseek-flash'));await call('workingFolder',{folder});
 const chatId=await call('newChat'),first=crypto.randomUUID(),second=crypto.randomUUID(),started=Date.now();
 await call('submit',{id:first,chatId,text:'First message',models:['deepseek-flash']});
 // Past the model pick, so the second message no longer joins the first (queue-merge.e2e.ts).
 await pollState(page,s=>s.turns.some(t=>t.id===first&&t.preparation==='Checking plugins'));
 await call('submit',{id:second,chatId,text:'Second message',models:['deepseek-flash']});
 // The stuck step ends the first message with its name; the second one, queued behind it, then goes out.
 const state=await pollState(page,s=>s.turns.some(t=>t.id===first&&t.status==='interrupted')&&s.turns.some(t=>t.id===second&&['completed','failed','interrupted'].includes(t.status)),60000);
 const one=state.turns.find(t=>t.id===first)!,two=state.turns.find(t=>t.id===second)!;
 assert.equal(one.error,'Tris got stuck on "Checking plugins: plugin files" for 3 s, so nothing was sent to the model. Send your message again.');
 assert.ok(Date.now()-started<30000,'ended by the limit, not by waiting');
 assert.equal(two.status,'completed',JSON.stringify(two.error));assert.equal(two.prompt,'Second message','not merged into the stuck one');
 // prepare.log: one line per message with each step's time.
 const log=(await fs.readFile(path.join(data,'prepare.log'),'utf8')).trim().split('\n');
 const stuck=log.find(line=>line.includes('turn='+first)),sent=log.find(line=>line.includes('turn='+second));
 assert.match(stuck!,/ model=deepseek-flash stuck: Checking plugins: plugin files total=\d+ms steps=Preparing reply \d+ms, Checking attachments \d+ms, Selecting model \d+ms, Checking plugins: plugin files \d+ms$/);
 assert.match(sent!,/ model=deepseek-flash sent total=\d+ms steps=Preparing reply \d+ms, Checking attachments \d+ms, Selecting model \d+ms, Checking plugins: plugin files \d+ms, Checking plugins: plugin runtime \d+ms, Checking plugins: plugin copies \d+ms, Checking plugins: history \d+ms, Opening model session \d+ms, Configuring model \d+ms, Loading project memory \d+ms$/);
 console.log('PASS preparation steps: each step timed in prepare.log; a stuck step ends the message with its name and the next message goes out. '+data);
 // TURN-REVIEW part 4 target: on a warm session his message reaches the engine in under 0.3 s (prepare.log total).
 await pollState(page,s=>!!s.claude?.models?.length,60000);await call('addModel',{chatId,model:'claude-code:haiku'});
 const send=async(model:string)=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text:'Speed check for '+model,models:[model]});await pollState(page,s=>s.turns.some(t=>t.id===id&&['completed','failed','interrupted'].includes(t.status)),60000);return id;};
 const total=async(id:string)=>Number(/ total=(\d+)ms/.exec((await fs.readFile(path.join(data,'prepare.log'),'utf8')).split('\n').find(line=>line.includes('turn='+id))||'')?.[1]);
 const gpt=await send('deepseek-flash');await send('claude-code:haiku');const opus=await send('claude-code:haiku');
 const times={gpt:await total(gpt),claude:await total(opus)};console.log('Warm send to the engine: '+JSON.stringify(times));
 assert.ok(times.gpt<300,'GPT warm '+times.gpt+' ms');assert.ok(times.claude<300,'Claude warm '+times.claude+' ms');
 console.log('PASS a warm session gets his message in under 0.3 s: GPT '+times.gpt+' ms, Claude '+times.claude+' ms');
}finally{await opened.close();fake.stdin.end('\n');lines.close();await fs.rm(folder,{recursive:true,force:true});await host.host('delete_key').catch(()=>{});execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});}
