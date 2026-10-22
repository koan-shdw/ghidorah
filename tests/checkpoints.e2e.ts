import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';

// Protocol fixtures exercise actual native and Hermes tools, approvals and files.
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/checkpoints-')),folder=await fs.mkdtemp(path.join(root,'work/checkpoint-files-'));
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','inherit']}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const launch=async()=>{const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env});await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};});return app;};
let app=await launch();
try{
 let page=await mainWindow(app);page.setDefaultTimeout(15000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&s.claude?.models?.some(m=>m.id==='claude-code:haiku')===true);await call('wizardFinish');await call('workingFolder',{folder});
 const chatId=await call('newChat'),other=await call('newChat');await call('addModel',{chatId,model:'claude-code:haiku'});await call('mode',{projectId:(await call('state')).chats.find((c:any)=>c.id===chatId).projectId,mode:'bypass'});
 const send=async(text:string,model='claude-code:haiku')=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text,models:[model]});return id;};
 const finish=async(id:string)=>{
  for(const deadline=Date.now()+60000;Date.now()<deadline;await page.waitForTimeout(80)){
   const state=await call('state');for(const a of state.approvals.filter((a:any)=>a.turnId===id&&a.status==='pending')){assert.match(a.params.description,/^(Read|Write)\n/);const args=JSON.parse(a.params.description.split('\n').slice(1).join('\n'));assert.equal(path.dirname(args.file_path),folder);await call('approve',{id:a.id,choice:'once'});}
   const turn=state.turns.find((t:any)=>t.id===id);if(['completed','stopped','failed','interrupted'].includes(turn?.status)){assert.equal(turn.status,'completed',turn.error);return;}
  }throw Error('Fixture turn did not finish');
 };
 const source=path.join(folder,'source.txt'),userFile=path.join(folder,'user.txt'),before='\uFEFForiginal\r\n';await fs.writeFile(source,before);
 const selected=await send(JSON.stringify({action:'write',path:source,content:'agent change',readFirst:true}));await finish(selected);
 const second=await send(JSON.stringify({action:'write',path:userFile,content:'agent created'}));await finish(second);
 const hermes=await send('WRITE_FIXTURE','deepseek-flash');await finish(hermes);assert.equal(await fs.readFile(path.join(folder,'slice-result.txt'),'utf8'),'Written through Hermes tools.');
 const p=await call('checkpointPreview',{chatId,turnId:selected});assert.deepEqual(p.files.map((r:any)=>r.action),['restore','remove','remove']);
 await fs.writeFile(userFile,'later user work');await assert.rejects(call('checkpointRestore',{chatId,turnId:selected,revision:p.revision}),/Refresh/);
 let preview=await call('checkpointPreview',{chatId,turnId:selected});assert.equal(preview.files.find((r:any)=>r.path==='user.txt').action,'preserve');
 await call('workspaceDraft',{dirty:true});await assert.rejects(call('checkpointRestore',{chatId,turnId:selected,revision:preview.revision}),/drafts/);await call('workspaceDraft',{dirty:false});
 const terminal=await call('terminalOpen',{chatId});await assert.rejects(call('checkpointRestore',{chatId,turnId:selected,revision:preview.revision}),/terminals/);await call('terminalClose',{chatId,id:terminal.id});
 const slow=await send('SLOW_CLAUDE');await pollState(page,s=>s.turns.some(t=>t.id===slow&&t.status==='running'&&!!t.text));await assert.rejects(call('checkpointRestore',{chatId,turnId:selected,revision:preview.revision}),/active work/);await call('stop',{chatId});await pollState(page,s=>s.turns.some(t=>t.id===slow&&['stopped','interrupted'].includes(t.status)));
 await app.evaluate(({app})=>app.quit());await app.close();app=await launch();page=await mainWindow(app);page.setDefaultTimeout(15000);await pollState(page,s=>s.backend==='ready');
 await call('openMainChat',{chatId});const main=page.getByRole('region',{name:'Main chat',exact:true});await main.locator('.turn').first().getByRole('button',{name:'Message actions',exact:true}).click();await page.getByRole('menuitem',{name:'Restore checkpoint…',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Restore a checkpoint'});await dialog.getByText('2 to restore',{exact:true}).waitFor();await dialog.locator('.checkpoint-file').first().locator('summary').click();assert.match(await dialog.locator('.checkpoint-compare').first().innerText(),/agent change/);
 assert.ok((await dialog.boundingBox())!.width>700);assert.equal(await dialog.locator('.checkpoint-choice').evaluate(e=>getComputedStyle(e).display),'flex');
 const capture=await app.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!;await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await new Promise(r=>setTimeout(r,100));return (await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64');});await fs.writeFile(path.join(data,'preview.png'),Buffer.from(capture,'base64'));
 await dialog.getByRole('button',{name:'Restore files',exact:true}).click();await dialog.getByText('Restore result',{exact:true}).waitFor();assert.equal(await fs.readFile(source,'utf8'),before);assert.equal(await fs.readFile(userFile,'utf8'),'later user work');assert.equal(await fs.access(path.join(folder,'slice-result.txt')).then(()=>true,()=>false),false);await dialog.getByRole('button',{name:'Done',exact:true}).click();
 await call('claudeCheck');await pollState(page,s=>s.claude?.models?.some(m=>m.id==='claude-code:haiku')===true);const next=await send('Inspect the current state before continuing');await finish(next);
 const request=JSON.parse((await fs.readFile(path.join(data,'claude-requests.jsonl'),'utf8')).trim().split('\n').at(-1)!);assert.match(request.prompt,/checkpoint_restore/);assert.match(request.prompt,/later.*|unchanged/);assert.equal(request.args.includes('--resume'),false);
 const branchTurn=await send(JSON.stringify({action:'write',path:source,content:'second approach',readFirst:true}));await finish(branchTurn);
 await call('openChatWindow',{chatId});let detached;
 for(let n=0;n<100&&!detached;n++){detached=app.windows().find(p=>p.url().endsWith('#chat='+chatId));if(!detached)await page.waitForTimeout(100);}assert.ok(detached);detached.setDefaultTimeout(15000);
 const fromWindow=(method:string,args:any={})=>detached!.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await assert.rejects(fromWindow('checkpointPreview',{chatId:other,turnId:selected}),/another chat/);await assert.rejects(fromWindow('checkpointRestore',{chatId:other,turnId:selected,revision:p.revision}),/another chat/);
 await detached.locator('.turn').last().getByRole('button',{name:'Message actions',exact:true}).click();await detached.getByRole('menuitem',{name:'Restore checkpoint…',exact:true}).click();const d=detached.getByRole('dialog',{name:'Restore a checkpoint'});await d.getByText('1 to restore',{exact:true}).waitFor();await d.getByLabel('Also prepare this message in a new chat').check();await d.getByRole('button',{name:'Restore files and retry',exact:true}).click();
 const state=await pollState(page,s=>s.chats.some(c=>c.branchTurnId===branchTurn)),branch=state.chats.find(c=>c.branchTurnId===branchTurn)!;assert.equal(branch.draft,JSON.stringify({action:'write',path:source,content:'second approach',readFirst:true}));assert.equal(await fs.readFile(source,'utf8'),before);assert.equal(state.workReview?.length,0);assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({nativeAndHermes:true,preview:true,exactBytes:true,externalEditsPreserved:true,stalePreview:true,draftGuard:true,terminalGuard:true,activeGuard:true,restart:true,freshContext:true,detached:true,crossChatRefusal:true,restoreAndRetry:true,hidden:true},null,2));console.log('PASS checkpoint preview, restore, restart and ownership; '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end('\n');lines.close();await host.host('delete_key');}
