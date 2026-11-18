// Agent pills on a test copy with the stand-in Claude: an agent that waits for a permission shows as a pill in the
// chat's corner and takes Allow there, a finished one shows its tick and leaves, the stop square stops one, and Hide
// folds the stack. No real account is used.
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {mainWindow,pollState,wakeWindows} from './fixtures/poll-state';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','agent-pills-')),folder=await fs.mkdtemp(path.join(root,'work','workspace-agent-pills-'));
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden','--disable-gpu']:[root,'--hidden','--disable-gpu'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath},timeout:60000});
try{
 const page=await mainWindow(app);await wakeWindows(app);page.setDefaultTimeout(20000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].setBounds({x:0,y:0,width:1280,height:900});});
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const click=(locator:any)=>locator.first().evaluate((element:HTMLElement)=>element.click());
 await pollState(page,s=>s.backend==='ready'&&!!s.claude?.models?.length);await call('wizardFinish');await call('workingFolder',{folder});
 const chatId=await call('addProject',{folder}) as string;await call('addModel',{chatId,model:'claude-code:haiku'});
 if(await page.getByLabel('Close settings',{exact:true}).count())await click(page.getByLabel('Close settings',{exact:true}));
 await click(page.locator('[data-chat-id="'+chatId+'"] .chat-link'));
 const pills=page.locator('.agent-pills'),agentOf=async(file:string)=>{
  const origin=crypto.randomUUID();await call('submit',{id:origin,chatId,text:JSON.stringify({action:'agent',path:file,delay:300}),models:['claude-code:haiku']});
  const state=await pollState(page,s=>s.turns.some(t=>t.automatic?.originTurnId===origin&&t.automatic.kind==='agent'&&t.status==='waiting')&&s.approvals.some(a=>a.status==='pending'),60000);
  return state.turns.find(t=>t.automatic?.originTurnId===origin&&t.automatic.kind==='agent')!;};
 assert.equal(await pills.count(),0,'no agents, no pills');

 // A waiting agent: amber, named by its task, with what it asks for and Allow right there.
 const first=await agentOf('one.txt');await pills.locator('.agent-pill.ask').waitFor();
 assert.match(await pills.locator('.agent-pills-head').innerText(),/1\s*agent working · 1 needs you/);
 const text=await pills.locator('.agent-pill').innerText();assert.ok(text.includes(first.automatic!.description||'Agent'),text);assert.match(text,/Needs your permission: Write one\.txt[\s\S]*Allow once[\s\S]*Deny/);
 assert.equal(await pills.locator('.agent-pill-stop').count(),1,'a live agent can be stopped');assert.equal(await pills.getByRole('button',{name:'Stop all'}).count(),0,'Stop all only with more than one');
 const shot=async(name:string)=>{const png=await app.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!;await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await new Promise(r=>setTimeout(r,300));return (await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64');});await fs.mkdir(path.join(root,'work','agent-pills-shots'),{recursive:true});await fs.writeFile(path.join(root,'work','agent-pills-shots',name+'.png'),Buffer.from(png,'base64'));};
 const second=await agentOf('two.txt');await pollState(page,s=>s.turns.filter(t=>t.automatic?.kind==='agent'&&t.status==='waiting').length===2);
 await page.waitForFunction(()=>document.querySelectorAll('.agent-pills .agent-pill').length===2);assert.match(await pills.locator('.agent-pills-head').innerText(),/2\s*agents working · 2 need you[\s\S]*Stop all[\s\S]*Hide/);
 await shot('two-waiting');
 await click(pills.getByRole('button',{name:'Hide',exact:true}));assert.equal(await pills.locator('.agent-pill').count(),0);assert.match(await pills.locator('.agent-pills-head').innerText(),/2\s*agents working[\s\S]*Show/);
 await click(pills.getByRole('button',{name:'Show',exact:true}));assert.equal(await pills.locator('.agent-pill').count(),2);
 console.log('PASS waiting agents show as pills with what they ask for; Hide folds the stack');

 // Allow on the pill: the agent writes its file, finishes, shows its tick, then leaves.
 await click(pills.locator('.agent-pill').first().getByRole('button',{name:'Allow once',exact:true}));
 await pollState(page,s=>s.turns.find(t=>t.id===first.id)?.status==='completed',60000);
 assert.equal(await fs.readFile(path.join(folder,'one.txt'),'utf8').then(()=>true,()=>false),true,'the allowed write happened');
 await pills.locator('.agent-pill.done').waitFor();assert.match(await pills.locator('.agent-pill.done').innerText(),/Done in \d+[smh]/);await shot('one-done');
 await page.waitForFunction(()=>!document.querySelector('.agent-pills .agent-pill.done'),null,{timeout:15000});
 console.log('PASS Allow on the pill lets the agent finish; its tick shows, then leaves');

 // The stop square.
 assert.equal(await pills.locator('.agent-pill').count(),1);await click(pills.locator('.agent-pill-stop'));
 const end=await pollState(page,s=>!['running','waiting'].includes(s.turns.find(t=>t.id===second.id)?.status||''),60000);
 assert.equal(end.turns.find(t=>t.id===second.id)!.status,'stopped');
 await page.waitForFunction(()=>!document.querySelector('.agent-pills'),null,{timeout:15000});
 assert.equal(await fs.readFile(path.join(folder,'two.txt'),'utf8').then(()=>true,()=>false),false,'a stopped agent wrote nothing');
 assert.deepEqual(errors,[]);
 console.log('PASS the stop square stops its agent and the stack goes when nothing works');
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});await fs.rm(folder,{recursive:true,force:true});}
