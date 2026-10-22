import {mainWindow} from './fixtures/poll-state';
import {_electron as electron,type Page} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work/native-desktop-')),folder=await fs.mkdtemp(path.join(root,'work','native-desktop-workspace-'));
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'requests.jsonl')},windowsHide:true,stdio:'pipe'}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env,timeout:30000});let app=await launch(),page:Page;
const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
const jobWindow=async(turnId:string,chatId:string)=>{await call('openJob',{id:turnId});for(const until=Date.now()+30000;Date.now()<until;await page.waitForTimeout(100)){const found=app.windows().find(w=>w.url().endsWith('#job='+chatId));if(found){await found.waitForFunction(()=>!!window.desktop);return found;}}throw Error('The job window did not open.');};
const wait=async(check:(state:any)=>boolean,approve=true)=>{const until=Date.now()+65000;while(Date.now()<until){const state=await call('state');if(check(state))return state;if(approve)for(const a of state.approvals.filter((a:any)=>a.status==='pending'))await call('approve',{id:a.id,choice:'once'});await page.waitForTimeout(70);}throw Error('Timed out '+JSON.stringify((await call('state')).turns));};
const send=async(chatId:string,spec:any,models=['claude-code:haiku'])=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text:typeof spec==='string'?spec:JSON.stringify(spec),models});const state=await wait(s=>s.turns.some((t:any)=>t.id===id&&['completed','failed','interrupted'].includes(t.status)));assert.equal(state.turns.find((t:any)=>t.id===id).status,'completed');return id;};
const port=async()=>{const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const value=(server.address() as net.AddressInfo).port;await new Promise<void>(r=>server.close(()=>r()));return value;};
const requests=async()=>(await fs.readFile(path.join(data,'claude-requests.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
const alive=async(port:number)=>{const until=Date.now()+5000;while(true){try{assert.equal(await (await fetch('http://127.0.0.1:'+port)).text(),'native-fixture');return;}catch(error){if(Date.now()>until)throw error;await page.waitForTimeout(50);}}};
const add=async()=>{const id=await call('addProject');await call('addModel',{chatId:id,model:'claude-code:haiku'});return id;};
try{
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));page=await mainWindow(app);await wait(s=>s.backend==='ready'&&s.claude?.models?.some((m:any)=>m.id==='claude-code:haiku'));await call('workingFolder',{folder});
 const a=await add(),alphaPort=await port(),alpha=await send(a,{action:'background',port:alphaPort,inspect:true,command:'alpha server'});let state=await wait(s=>s.background.some((r:any)=>r.turnId===alpha&&r.status==='running'));const alphaRow=state.background.find((r:any)=>r.turnId===alpha);await alive(alphaPort);
 const first=(await requests()).at(-1);await send(a,{action:'reply'});const second=(await requests()).at(-1);assert.equal(first.pid,second.pid);assert.equal(first.sessionId,second.sessionId);
 await send(a,'Inspect the native server result without restarting it.',['deepseek-flash']);await send(a,{action:'reply'});assert.equal((await requests()).at(-1).pid,first.pid);assert.match((await requests()).at(-1).prompt,/Inspect the native server result/);await alive(alphaPort);
 await assert.rejects(call('workingFolder',{clear:true}),/active work/);await assert.rejects(call('removeModel',{chatId:a,model:'claude-code:haiku'}),/background work/);
 await call('effort',{chatId:a,model:'claude-code:haiku',effort:'low'});await send(a,{action:'reply'});const changed=(await requests()).at(-1);assert.notEqual(changed.pid,first.pid);assert.equal(changed.args.includes('--resume'),false);assert.match(changed.prompt,/alpha server/);await alive(alphaPort);
 const b=await add(),betaPort=await port(),beta=await send(b,{action:'background',port:betaPort,inspect:true,command:'beta server'});state=await wait(s=>s.background.some((r:any)=>r.turnId===beta&&r.status==='running'));const betaRow=state.background.find((r:any)=>r.turnId===beta);await alive(betaPort);
 const bounded=await send(b,{action:'background',port:await port(),inspect:true,command:'bounded server',duration:1300});state=await wait(s=>s.turns.some((t:any)=>t.automatic?.originTurnId===bounded&&t.status==='completed'));
 const update=state.turns.find((t:any)=>t.automatic?.originTurnId===bounded);assert.equal(update.text,'Background complete.');assert.ok(update.usage.turn_total>0);assert.notEqual(state.turns.find((t:any)=>t.id===bounded).text,update.text);assert.equal(state.background.find((r:any)=>r.turnId===bounded).status,'exited');
 console.log('PASS native desktop session reuse, cross-engine return, safe effort replacement, durable natural completion and fresh update turn');
 const written=path.join(folder,'background-update.txt'),writeOrigin=await send(b,{action:'background',port:await port(),inspect:true,command:'write after completion',duration:1300,completionWrite:'background-update.txt'});
 state=await wait(s=>s.approvals.some((a:any)=>a.status==='pending'&&s.turns.some((t:any)=>t.id===a.turnId&&t.automatic?.originTurnId===writeOrigin)),false);
 const writing=state.turns.find((t:any)=>t.automatic?.originTurnId===writeOrigin),approval=state.approvals.find((a:any)=>a.turnId===writing.id&&a.status==='pending');assert.notEqual(approval.turnId,writeOrigin);
 await call('approve',{id:approval.id,choice:'once'});await wait(s=>s.turns.find((t:any)=>t.id===writing.id)?.status==='completed');assert.equal(await fs.readFile(written,'utf8'),'background update');
 const cancelled=path.join(folder,'cancelled-update.txt'),stopOrigin=await send(b,{action:'background',port:await port(),inspect:true,command:'cancel completion write',duration:1300,completionWrite:'cancelled-update.txt'});
 state=await wait(s=>s.approvals.some((a:any)=>a.status==='pending'&&s.turns.some((t:any)=>t.id===a.turnId&&t.automatic?.originTurnId===stopOrigin)),false);
 const stopping=state.turns.find((t:any)=>t.automatic?.originTurnId===stopOrigin);await call('stop',{chatId:b});state=await wait(s=>s.turns.find((t:any)=>t.id===stopping.id)?.status==='stopped');assert.ok(!state.approvals.some((a:any)=>a.turnId===stopping.id&&a.status==='pending'));assert.ok(!state.workReview.some((r:any)=>r.job===stopping.id));await assert.rejects(fs.access(cancelled));await alive(betaPort);
 console.log('PASS background updates own fresh approvals and Stop cancels their writes while preserving earlier servers');
 await page.evaluate(id=>localStorage.setItem('chat',id),a);await page.reload();await page.waitForTimeout(200);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());
 const title=state.chats.find((c:any)=>c.id===a).title;await page.locator('.chat-link').filter({hasText:title}).first().click();const card=page.locator(`[data-process-id="${alphaRow.id}"]`);await card.locator('summary').click();await card.getByRole('button',{name:'Stop process '+alphaRow.processId,exact:true}).click();await wait(s=>s.background.find((r:any)=>r.id===alphaRow.id)?.status==='stopped');await alive(betaPort);await page.screenshot({path:path.join(data,'native-status.png')});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());
 const parent=await add(),sidePort=await port(),group=await send(parent,{action:'background',port:sidePort,inspect:true,command:'side server'},['claude-code:haiku','deepseek-flash']);state=await wait(s=>s.background.some((r:any)=>r.command==='side server'&&r.status==='running'));const sideRow=state.background.find((r:any)=>r.command==='side server'),side=await jobWindow(sideRow.turnId,sideRow.chatId);
 await assert.rejects(side.evaluate(id=>window.desktop.invoke('backgroundStop',{id}),betaRow.id),/another job/);await side.evaluate(()=>window.desktop.invoke('window',{action:'close'})).catch(error=>{if(!String(error).includes('closed'))throw error;});await alive(sidePort);await call('openJob',{id:sideRow.turnId});await call('stop',{chatId:sideRow.chatId});await wait(s=>s.background.find((r:any)=>r.id===sideRow.id)?.status==='stopped');await alive(betaPort);
 console.log('PASS native desktop Stop, side-window ownership and close/reopen preserving live work');
 const automaticParent=await add(),automaticGroup=crypto.randomUUID();await call('submit',{id:automaticGroup,chatId:automaticParent,text:JSON.stringify({action:'background',port:await port(),inspect:true,command:'side completion',duration:3500,completionWrite:'side-update.txt'}),models:['claude-code:haiku','deepseek-flash']});
 state=await wait(s=>s.turns.some((t:any)=>t.parentTurnId===automaticGroup&&t.automatic&&t.status==='waiting'));
 const sideUpdate=state.turns.find((t:any)=>t.parentTurnId===automaticGroup&&t.automatic);assert.equal(state.turns.find((t:any)=>t.id===automaticGroup).status,'running');
 await call('stop',{chatId:automaticParent,turnId:automaticGroup});state=await wait(s=>s.turns.find((t:any)=>t.id===sideUpdate.id)?.status==='stopped');assert.ok(['partial','stopped'].includes(state.turns.find((t:any)=>t.id===automaticGroup).status));await assert.rejects(fs.access(path.join(folder,'side-update.txt')));await alive(betaPort);
 console.log('PASS group Stop owns a later background update and leaves unrelated work running');
 const agentParent=await add();for(const correction of [false,true]){
  const agentGroup=crypto.randomUUID(),filename=correction?'agent-correction.txt':'agent-group-stop.txt';await call('submit',{id:agentGroup,chatId:agentParent,text:JSON.stringify({action:'agent',path:filename,description:'Side agent'}),models:['claude-code:haiku','deepseek-flash']});
  state=await wait(s=>s.turns.some((t:any)=>t.parentTurnId===agentGroup&&t.automatic?.kind==='agent'&&t.status==='waiting'),false);
  const child=state.turns.find((t:any)=>t.parentTurnId===agentGroup&&t.automatic?.kind==='agent'),origin=state.turns.find((t:any)=>t.id===child.automatic.originTurnId);
  assert.equal(origin.status,'completed');assert.equal(state.turns.find((t:any)=>t.id===agentGroup).status,'running');
  const childView=await jobWindow(child.id,child.chatId);await childView.getByText('Agent · Side agent',{exact:true}).waitFor();
  await assert.rejects(childView.evaluate(id=>window.desktop.invoke('backgroundStop',{id}),betaRow.id),/another job/);
  if(correction){const correctionId=crypto.randomUUID();await childView.evaluate(({chatId,id})=>window.desktop.invoke('correctJob',{chatId,id,text:'Correction: reply without writing a file.'}),{chatId:child.chatId,id:correctionId});await wait(s=>s.turns.find((t:any)=>t.id===correctionId)?.status==='completed');}
  else await call('stop',{chatId:agentParent,turnId:agentGroup});
  state=await wait(s=>s.turns.find((t:any)=>t.id===child.id)?.status==='stopped');assert.ok(!state.approvals.some((p:any)=>p.turnId===child.id&&p.status==='pending'));await assert.rejects(fs.access(path.join(folder,filename)));await alive(betaPort);
 }
 console.log('PASS delegated side agents keep the group active; group Stop and side correction stop their own pending writes');
 const before=(await requests()).length,crashPid=app.process().pid!;
 try{execFileSync('taskkill',['/PID',String(crashPid),'/T','/F'],{windowsHide:true,stdio:'pipe'});}catch(error){let gone=false;try{process.kill(crashPid,0);}catch(check){gone=(check as NodeJS.ErrnoException).code==='ESRCH';}if(!gone)throw error;}
 await app.close().catch(()=>{});app=await launch();page=await mainWindow(app);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));state=await wait(s=>s.backend==='ready');
 assert.equal((await requests()).length,before);assert.equal(state.background.find((r:any)=>r.id===betaRow.id).status,'lost');assert.ok(state.workReview.some((r:any)=>r.id===betaRow.actionId));await assert.rejects(fetch('http://127.0.0.1:'+betaPort));
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({sameNativeWorker:true,crossEngine:true,configPreservesTasks:true,automaticSaved:true,uiStop:true,sideScope:true,agentGroupStop:true,agentSideCorrection:true,crashNoReplay:true,group},null,2));console.log('PASS native app crash retains receipts and uncertainty without process/model replay. Evidence: '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end('\n');lines.close();await host.host('delete_key');}
