// Explicit real-account acceptance task. Never included in the automatic fixture suite.
import {_electron as electron,chromium} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {mainWindow,pollState} from './fixtures/poll-state';
if(process.env.TRISMEGISTUS_LIVE_CODING!=='1')throw Error('Explicit live coding task opt-in required.');
const root=path.resolve('.'),resume=process.env.TRISMEGISTUS_LIVE_CODING_DATA,data=resume||await fs.mkdtemp(path.join(root,'work','live-coding-'));let folder='';if(!resume){folder=path.join(await fs.mkdtemp(path.join(root,'work','live-coding-workspace-')),'Working folder');await fs.mkdir(folder);}
const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));env.TRISMEGISTUS_TEST_DATA=data;for(const name of ['TRISMEGISTUS_TEST_CLAUDE','TRISMEGISTUS_TEST_CLAUDE_NODE','TRISMEGISTUS_TEST_PROVIDER_URL'])delete env[name];
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env,timeout:30000});let app=await launch(),chatId:string|undefined;
console.log('Live coding evidence: '+data);
try{
 let page=await mainWindow(app);const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready');await call('wizardFinish');if(!resume)await call('workingFolder',{folder});await call('claudeCheck');let state=await call('state');assert.ok(state.claude.connected,'Claude account unavailable');
 const model=state.claude.models.find((m:any)=>/opus/i.test(m.id))?.id||state.claude.models[0]?.id;assert.ok(model);if(resume){chatId=JSON.parse(await fs.readFile(path.join(data,'progress.json'),'utf8')).chatId;folder=state.defaultFolder;}else{chatId=await call('newChat');assert.deepEqual(await fs.readdir(folder),[],'A new chat must not create a project folder');await call('addModel',{chatId,model});state=await call('state');await call('mode',{projectId:state.chats.find((c:any)=>c.id===chatId).projectId,mode:'bypass'});
 }
 const receipts:any[]=resume?JSON.parse(await fs.readFile(path.join(data,'turns.json'),'utf8')):[];
 async function task(text:string){
  const id=crypto.randomUUID();await call('submit',{id,chatId,models:[model],text});let stamp='';
  for(const deadline=Date.now()+15*60*1000;Date.now()<deadline;await page.waitForTimeout(500)){
   state=await call('state');const turn=state.turns.find((t:any)=>t.id===id),tools=state.tools.filter((t:any)=>t.turnId===id),pending=state.approvals.filter((a:any)=>a.turnId===id&&a.status==='pending');
   await fs.writeFile(path.join(data,'progress.json'),JSON.stringify({chatId,turnId:id,model,status:turn.status,text:turn.text,error:turn.error,tools,pending},null,2));
   const next=JSON.stringify([turn.status,tools.map((t:any)=>[t.name,t.status]),pending.map((p:any)=>p.id)]);if(next!==stamp){stamp=next;console.log(JSON.stringify({status:turn.status,tools:tools.length,last:tools.slice(-2).map((t:any)=>({name:t.name,status:t.status})),pending:pending.map((p:any)=>p.id)}));}
   let choices:Record<string,string>={};try{choices=JSON.parse(await fs.readFile(path.join(data,'decisions.json'),'utf8'));}catch{}
   for(const approval of pending)if(['once','deny'].includes(choices[approval.id]))await call('approve',{id:approval.id,choice:choices[approval.id]});
   if(['completed','failed','interrupted','stopped'].includes(turn.status)){receipts.push({turn,tools});await fs.writeFile(path.join(data,'turns.json'),JSON.stringify(receipts,null,2));assert.equal(turn.status,'completed',turn.error||turn.text);return;}
  }
  throw Error('Live coding task timed out');
 }
 if(!receipts.length)await task(`Build a small usable app named KOAN Tasks in the working folder ${folder}. Use create_app to register it and obtain its folder. Build a single-page local task board: an input labelled New task, an Add task button, a checkbox per task, filters All / Active / Done, and a Delete button per task. Save tasks and completion in localStorage across reloads. Treat task text as text, including angle brackets. Give it a clear dark layout that works at narrow widths. Use HTML/CSS/JavaScript with index.html as its entry, no downloaded packages or external services. Include npm test using Node's built-in test runner and npm run build that produces a standalone dist/index.html and its assets. Run the tests and build, inspect failures and fix them. Add the to-do "Add a clear completed button" to this saved app using add_app_todo, without doing that feature yet. Work directly without spawning agents; only change files inside this new app folder. Report the actual files and command results.`);
 const saved=state.savedApps.find((a:any)=>a.name==='KOAN Tasks');assert.ok(saved,'create_app must register the real app');assert.ok(saved.todos.some((t:any)=>t.title==='Add a clear completed button'));const appFolder=path.resolve(folder,saved.repositories[0]);assert.ok(appFolder.startsWith(folder+path.sep));assert.ok(saved.chatIds.includes(chatId));
 const run=(script:string)=>execFileSync(process.env.ComSpec||'C:\\Windows\\System32\\cmd.exe',['/d','/s','/c','npm run '+script],{cwd:appFolder,windowsHide:true,encoding:'utf8',timeout:90000});
 await fs.writeFile(path.join(data,'commands.txt'),run('test')+'\n'+run('build'));
 const browser=await chromium.launch({channel:'chrome',headless:true});try{
  const web=await browser.newPage({viewport:{width:1000,height:740}}),errors:string[]=[];web.on('pageerror',e=>errors.push(e.message));await web.goto(pathToFileURL(path.join(appFolder,'dist','index.html')).href);
  await web.getByRole('textbox',{name:'New task',exact:true}).fill('Ship <KOAN> & test');await web.getByRole('button',{name:'Add task',exact:true}).click();await web.getByText('Ship <KOAN> & test',{exact:true}).waitFor();await web.reload();await web.getByText('Ship <KOAN> & test',{exact:true}).waitFor();await web.getByRole('checkbox').first().check();await web.getByRole('button',{name:'Active',exact:true}).click();assert.equal(await web.getByRole('checkbox').count(),0);await web.getByRole('button',{name:'Done',exact:true}).click();assert.equal(await web.getByRole('checkbox').count(),1);await web.reload();assert.ok(await web.getByRole('checkbox').first().isChecked());await web.screenshot({path:path.join(data,'new-app.png')});assert.deepEqual(errors,[]);
 }finally{await browser.close();}
 await app.evaluate(({app})=>app.quit());await app.close();app=await launch();page=await mainWindow(app);await pollState(page,s=>s.backend==='ready');await call('claudeCheck');
 if(receipts.length<2)await task(`Continue KOAN Tasks. Implement the saved to-do: add a button named Clear completed which removes only completed tasks, persists the change and preserves active tasks. Keep the existing design and behavior. Add a meaningful regression test, run npm test and npm run build, fix any failures, and report the result. Work directly, only in the existing app folder. Do not create another app or folder.`);
 await fs.appendFile(path.join(data,'commands.txt'),'\nAFTER RESTART CHANGE\n'+run('test')+'\n'+run('build'));
 const changedBrowser=await chromium.launch({channel:'chrome',headless:true});try{
  const web=await changedBrowser.newPage({viewport:{width:700,height:740}});await web.goto(pathToFileURL(path.join(appFolder,'dist','index.html')).href);
  for(const title of ['Keep this active','Complete this one']){await web.getByRole('textbox',{name:'New task',exact:true}).fill(title);await web.getByRole('button',{name:'Add task',exact:true}).click();}
  await web.getByRole('checkbox').last().check();await web.getByRole('button',{name:'Clear completed',exact:true}).click();assert.equal(await web.getByRole('checkbox').count(),1);await web.getByText('Keep this active',{exact:true}).waitFor();await web.reload();assert.equal(await web.getByRole('checkbox').count(),1);await web.getByText('Keep this active',{exact:true}).waitFor();await web.screenshot({path:path.join(data,'changed-app.png')});
 }finally{await changedBrowser.close();}
 state=await call('state');assert.equal(state.savedApps.filter((a:any)=>a.name==='KOAN Tasks').length,1);assert.equal(state.workReview.length,0);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({executable:process.env.TRISMEGISTUS_EXE||'source',model,chatId,appFolder,newChatNoFolder:true,registeredByModel:true,todoAddedByModel:true,createBuildTest:true,realBrowser:true,persistence:true,escapedText:true,filters:true,restartContinuation:true,furtherChange:true,clearCompleted:true,activeTasksPreserved:true,turns:receipts.map(r=>r.turn.id)},null,2));console.log('PASS live new app and restart continuation: '+data);
}finally{if(chatId)await app.windows().find(p=>/index\.html$/.test(p.url()))?.evaluate(chatId=>window.desktop.invoke('stop',{chatId}),chatId).catch(()=>{});await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
