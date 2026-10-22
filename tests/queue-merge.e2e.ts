// Koan 2026-10-16: "when i send mutple messages in a row put them together tso they arrive ar the same prompts not
// indevidually". Messages typed while the first one is still being prepared (here a slow model pick) join it and
// reach the model as one message, as in 0.1.10 (his 1 October queue merge).
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work','queue-merge-')),folder=await fs.mkdtemp(path.join(root,'work','workspace-queue-merge-')),namespace='Trismegistus/Test/'+path.basename(data);
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const records=path.join(data,'provider-requests.jsonl');
const fake=spawn(PYTHON,['tests/fake_provider.py'],{windowsHide:true,stdio:'pipe',env:{...process.env,FIXTURE_RECORDS:records}}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath}});
try{
 const page=await mainWindow(app),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&!!s.availableModels?.includes('deepseek-flash'));await call('workingFolder',{folder});
 const chatId=await call('newChat');await call('selectorModel',{chatId,model:'deepseek-flash'});
 const [first,second,third]=[crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID()];
 await call('submit',{id:first,chatId,text:'SLOW_SELECT_FIXTURE one',models:[]});
 await pollState(page,s=>s.turns.some(t=>t.id===first&&t.preparation==='Selecting model'),30000);
 await call('submit',{id:second,chatId,text:'two',models:[]});await call('submit',{id:third,chatId,text:'three',models:[]});
 const state=await pollState(page,s=>s.turns.some(t=>t.id===first&&['completed','failed','interrupted','needs-model'].includes(t.status)),60000);
 const rows=state.turns.filter(t=>t.chatId===chatId),one=rows.find(t=>t.id===first)!;
 assert.equal(one.status,'completed',JSON.stringify(one.error));
 assert.equal(one.prompt,'SLOW_SELECT_FIXTURE one\n\ntwo\n\nthree');
 assert.deepEqual(rows.map(t=>t.id),[first],'the two later messages joined the first');
 assert.equal(await call('submit',{id:second,chatId,text:'two',models:[]}),second);assert.ok(!(await call('state')).turns.some((t:any)=>t.id===second),'a repeated send must not bring a joined message back');
 // The user message each model request ended with (the picks excluded).
 const lastUser=(body:any)=>{const content=[...(body.messages||[])].reverse().find((m:any)=>m.role==='user')?.content;return Array.isArray(content)?content.map((part:any)=>part.text||'').join('\n'):String(content??'');};
 const sent=(await fs.readFile(records,'utf8')).trim().split('\n').map(row=>JSON.parse(row)).filter(body=>!JSON.stringify(body).includes('You are on select duty')).map(lastUser);
 assert.ok(sent.some(text=>text.includes('SLOW_SELECT_FIXTURE one\n\ntwo\n\nthree')),'the model got all three in one message');
 assert.ok(!sent.some(text=>/\b(two|three)\s*$/.test(text)&&!text.includes('SLOW_SELECT_FIXTURE one')),'no message went out alone');
 console.log('PASS messages typed during the model pick reach the model as one message. '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end('\n');lines.close();await fs.rm(folder,{recursive:true,force:true});await host.host('delete_key').catch(()=>{});execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});}
