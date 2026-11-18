// The Workspace panel's sections on a test copy with the stand-in Claude: the tab strip is gone and the panel opens on
// Environment, Context, Plan, Changes, Outputs, Agents, Background and Tools; a tool opens from its row or its
// title-bar button under a bar with the way back, Detach and Pop out; a section folds and stays folded; an agent that
// waits takes Allow in its row, a finished one moves to the fold, and the stop squares stop an agent and a command.
// No real account is used.
import {_electron as electron} from 'playwright';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
import {mainWindow,pollState,wakeWindows} from './fixtures/poll-state';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','workspace-sections-')),folder=await fs.mkdtemp(path.join(root,'work','workspace-of-sections-'));
const git=(...args:string[])=>execFileSync('git',['-C',folder,...args],{windowsHide:true,encoding:'utf8'}).trim();
git('init','-q','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','core.autocrlf','false');git('config','commit.gpgSign','false');git('config','core.hooksPath',path.join(folder,'.git/hooks'));
await fs.writeFile(path.join(folder,'kept.txt'),'one\n');git('add','.');git('commit','-q','-m','first');await fs.writeFile(path.join(folder,'kept.txt'),'one\ntwo\n');await fs.writeFile(path.join(folder,'new.txt'),'new\n');
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden','--disable-gpu']:[root,'--hidden','--disable-gpu'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath},timeout:60000});
try{
 const page=await mainWindow(app);await wakeWindows(app);page.setDefaultTimeout(20000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].setBounds({x:0,y:0,width:1280,height:900});});
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const click=(locator:any)=>locator.first().evaluate((element:HTMLElement)=>element.click());
 const shot=async(name:string)=>{const png=await app.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!;await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await new Promise(r=>setTimeout(r,300));return (await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64');});await fs.mkdir(path.join(root,'work','workspace-sections-shots'),{recursive:true});await fs.writeFile(path.join(root,'work','workspace-sections-shots',name+'.png'),Buffer.from(png,'base64'));};
 await pollState(page,s=>s.backend==='ready'&&!!s.claude?.models?.length);await call('wizardFinish');await call('workingFolder',{folder});
 const chatId=await call('addProject',{folder}) as string;await call('addModel',{chatId,model:'claude-code:haiku'});
 if(await page.getByLabel('Close settings',{exact:true}).count())await click(page.getByLabel('Close settings',{exact:true}));
 await click(page.locator('[data-chat-id="'+chatId+'"] .chat-link'));
 const panel=page.locator('aside.workspace-panel'),body=panel.locator('.ws-body'),sec=(id:string)=>body.locator('[data-section="'+id+'"]'),bar=panel.locator('.ws-back');
 const tool=async(name:string)=>{await bar.locator('strong').filter({hasText:name}).waitFor();assert.equal(await body.count(),0,'a tool takes the sections\' place');};

 // The Tasks button opens the panel on its sections; there is no tab strip.
 await click(page.getByLabel('Open tasks',{exact:true}));await body.waitFor();
 assert.equal(await panel.locator('.workspace-nav').count(),0,'the tab strip is gone');assert.equal(await bar.count(),0);
 assert.deepEqual(await body.locator('.ws-sec>summary>span:first-child').allInnerTexts(),['Environment','Context','Plan','Changes','Outputs','Agents','Background','Tools']);
 await sec('changes').locator('.ws-row').filter({hasText:'new.txt'}).waitFor();
 const environment=await sec('environment').innerText();
 assert.ok(environment.includes(path.basename(folder)),environment);assert.match(environment,/main\s*2 changed/);assert.match(environment,/Manual/);assert.match(environment,/Haiku[\s\S]*High/);
 assert.match(await sec('changes').locator('summary').innerText(),/Changes\s*2[\s\S]*Review ›/);assert.deepEqual(await sec('changes').locator('.ws-status').allInnerTexts(),['M','??']);
 assert.match(await sec('context').innerText(),/Haiku[\s\S]*Not reported yet/);assert.match(await sec('context').locator('summary').innerText(),/Manage[\s\S]*All subscriptions ›/);
 assert.match(await sec('plan').innerText(),/No plan yet/);assert.match(await sec('outputs').innerText(),/No saved outputs/);assert.match(await sec('agents').innerText(),/No agents/);assert.match(await sec('background').innerText(),/Nothing running/);
 assert.deepEqual(await sec('tools').locator('.ws-row .ws-label').allInnerTexts(),['Files','Changes','Terminal','Preview']);assert.match(await sec('tools').innerText(),/Changes\s*2 files/);
 await shot('sections');await page.evaluate(()=>{document.documentElement.dataset.theme='light';});await shot('sections-light');await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
 console.log('PASS the panel opens on its eight sections with the folder, branch, mode, model and changed files');

 // A tool opens from its row under the bar with the way back, Detach and Pop out; the way back returns the sections.
 await click(sec('tools').locator('[data-open="files"]'));await tool('Files');
 assert.match(await bar.innerText(),/‹ Workspace\s*Files\s*Detach\s*Pop out/);
 await page.getByRole('region',{name:'Files view',exact:true}).locator('.workspace-files button').filter({hasText:'kept.txt'}).waitFor();
 assert.equal(await panel.getByRole('button',{name:'Detach Files',exact:true}).count(),1);assert.equal(await panel.getByRole('button',{name:'Pop out Files',exact:true}).count(),1);
 await shot('tool-files');
 await click(bar.getByRole('button',{name:'‹ Workspace',exact:true}));await body.waitFor();assert.equal(await bar.count(),0);
 // The title bar's tool buttons still open the tool; Plan and Tasks open the sections.
 await click(page.getByLabel('Open changes',{exact:true}));await tool('Changes');await page.getByRole('region',{name:'Changes view',exact:true}).locator('.change-list').getByText('new.txt',{exact:true}).waitFor();
 await click(page.getByLabel('Open plan',{exact:true}));await body.waitFor();
 await click(sec('changes').getByRole('button',{name:'Review ›',exact:true}));await tool('Changes');
 await click(page.getByLabel('Open terminal',{exact:true}));await tool('Terminal');for(let n=0;n<150&&!((await call('terminalList',{chatId})) as any[]).length;n++)await page.waitForTimeout(100);
 await click(page.getByLabel('Open tasks',{exact:true}));await body.waitFor();assert.equal(await sec('changes').evaluate((element:HTMLDetailsElement)=>element.open),true,'a link in a heading does not fold its section');
 await page.waitForFunction(()=>/Terminal\s*1 open/.test(document.querySelector<HTMLElement>('[data-section="tools"]')?.innerText||''));
 for(const terminal of (await call('terminalList',{chatId})) as any[])await call('terminalClose',{chatId,id:terminal.id});
 console.log('PASS a tool opens from its row and from the title bar, with the way back, Detach and Pop out');

 // A section folds, and stays folded.
 await click(sec('environment').locator('summary'));await page.waitForFunction(()=>!document.querySelector<HTMLDetailsElement>('[data-section="environment"]')!.open);
 await page.waitForFunction(()=>localStorage.getItem('workspace-folds')==='["environment"]');
 await click(sec('tools').locator('[data-open="preview"]'));await tool('Preview');await click(bar.getByRole('button',{name:'‹ Workspace',exact:true}));await body.waitFor();
 assert.equal(await sec('environment').evaluate((element:HTMLDetailsElement)=>element.open),false,'the fold is kept');
 await click(sec('environment').locator('summary'));await page.waitForFunction(()=>localStorage.getItem('workspace-folds')==='[]');
 // The Context links: Manage opens the chat's context, All subscriptions opens that Settings page.
 await click(sec('context').getByRole('button',{name:'Manage',exact:true}));await page.getByRole('dialog',{name:'Chat context'}).waitFor();await click(page.getByLabel('Close chat context',{exact:true}));
 await click(sec('context').getByRole('button',{name:'All subscriptions ›',exact:true}));await page.getByRole('dialog',{name:'Settings',exact:true}).locator('.sub-page').waitFor();await click(page.getByLabel('Close settings',{exact:true}));
 console.log('PASS a section folds and stays folded; Manage and All subscriptions open their pages');

 // Agents: one that waits takes Allow in its row, a finished one moves to the fold, the stop square stops one.
 const agentOf=async(file:string)=>{
  const origin=crypto.randomUUID();await call('submit',{id:origin,chatId,text:JSON.stringify({action:'agent',path:file,delay:300}),models:['claude-code:haiku']});
  const state=await pollState(page,s=>s.turns.some(t=>t.automatic?.originTurnId===origin&&t.automatic.kind==='agent'&&t.status==='waiting')&&s.approvals.some(a=>a.status==='pending'),60000);
  return state.turns.find(t=>t.automatic?.originTurnId===origin&&t.automatic.kind==='agent')!;};
 const first=await agentOf('one.txt');await sec('agents').locator('.ws-agent.ask').waitFor();
 const waiting=await sec('agents').innerText();assert.ok(waiting.includes(first.automatic!.description||'Agent'),waiting);assert.match(waiting,/Needs your permission: Write one\.txt[\s\S]*Allow once[\s\S]*Deny/);
 assert.match(await sec('agents').locator('summary').first().innerText(),/Agents\s*1/);assert.equal(await sec('agents').getByRole('button',{name:'Stop all'}).count(),0,'Stop all only with more than one');
 const second=await agentOf('two.txt');await page.waitForFunction(()=>document.querySelectorAll('.ws-body .ws-agent').length===2);
 assert.match(await sec('agents').locator('summary').first().innerText(),/Agents\s*2[\s\S]*Stop all/);assert.equal(await page.locator('.agent-pills .agent-pill').count(),2,'the pills show the same agents');
 await shot('agents-waiting');
 await click(sec('agents').locator('.ws-ask').first().getByRole('button',{name:'Allow once',exact:true}));
 await pollState(page,s=>s.turns.find(t=>t.id===first.id)?.status==='completed',60000);
 assert.equal(await fs.readFile(path.join(folder,'one.txt'),'utf8').then(()=>true,()=>false),true,'the allowed write happened');
 const fold=sec('agents').locator('.ws-fold');await fold.waitFor();await page.waitForFunction(()=>/1 finished/.test(document.querySelector<HTMLElement>('.ws-body .ws-fold>summary')?.innerText||''));
 await click(fold.locator('summary'));assert.match(await fold.locator('.ws-row.done').innerText(),/✓[\s\S]*\d+[smh]/);
 await page.waitForFunction(()=>document.querySelectorAll('.ws-body .ws-agent').length===1);
 await click(sec('agents').locator('.ws-agent .ws-stop'));
 const end=await pollState(page,s=>!['running','waiting'].includes(s.turns.find(t=>t.id===second.id)?.status||''),60000);assert.equal(end.turns.find(t=>t.id===second.id)!.status,'stopped');
 await page.waitForFunction(()=>!document.querySelector('.ws-body .ws-agent')&&/2 finished/.test(document.querySelector<HTMLElement>('.ws-body .ws-fold>summary')?.innerText||''),null,{timeout:15000});
 assert.match(await fold.innerText(),/✕[\s\S]*stopped/);assert.equal(await fs.readFile(path.join(folder,'two.txt'),'utf8').then(()=>true,()=>false),false,'a stopped agent wrote nothing');
 await page.waitForFunction(()=>/one\.txt/.test(document.querySelector<HTMLElement>('[data-section="changes"]')?.innerText||''),null,{timeout:15000});
 await shot('agents-finished');
 console.log('PASS an agent takes Allow in its row, a finished one moves to the fold, the stop square stops one');

 // Background: a command the reply left running is a row with a stop square.
 const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));
 const origin=crypto.randomUUID();await call('submit',{id:origin,chatId,text:JSON.stringify({action:'background',port,inspect:true,command:'fixture server'}),models:['claude-code:haiku']});
 for(const until=Date.now()+60000;;){const state=await call('state') as any;if(state.background?.some((row:any)=>row.turnId===origin&&row.status==='running'))break;if(Date.now()>until)throw Error('The background command did not start.');for(const ask of state.approvals.filter((a:any)=>a.status==='pending'))await call('approve',{id:ask.id,choice:'once'}).catch(()=>{});await page.waitForTimeout(100);}
 await sec('background').locator('.ws-row').filter({hasText:'fixture server'}).waitFor();assert.match(await sec('background').locator('summary').innerText(),/Background\s*1/);await shot('background');
 await click(sec('background').locator('.ws-stop'));
 await pollState(page,s=>!s.background?.some(row=>row.turnId===origin&&['running','checking','stopping'].includes(row.status)),60000);
 await page.waitForFunction(()=>/Nothing running/.test(document.querySelector<HTMLElement>('[data-section="background"]')?.innerText||''),null,{timeout:15000});
 assert.deepEqual(errors,[]);
 console.log('PASS a running command is a row in Background and its stop square stops it');
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});await fs.rm(folder,{recursive:true,force:true});}
