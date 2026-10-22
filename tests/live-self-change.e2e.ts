// Opt-in: exercise Trismegistus changing its own working-folder validation.
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mainWindow,pollState} from './fixtures/poll-state';
if(process.env.TRISMEGISTUS_LIVE_SELF_CHANGE!=='1')throw Error('Explicit self-change opt-in required.');
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','live-self-change-'));
const hash=async(file:string)=>createHash('sha256').update(await fs.readFile(file)).digest('hex'),before=await hash('app/main.ts');
const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));env.TRISMEGISTUS_TEST_DATA=data;for(const name of ['TRISMEGISTUS_TEST_CLAUDE','TRISMEGISTUS_TEST_CLAUDE_NODE','TRISMEGISTUS_TEST_PROVIDER_URL'])delete env[name];
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env,timeout:30000});let chatId:string|undefined;
console.log('Self-change evidence: '+data);
try{
 const page=await mainWindow(app),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready');await call('wizardFinish');await call('workingFolder',{folder:root});await call('claudeCheck');let state=await call('state');assert.ok(state.claude.connected);
 const model=state.claude.models.find((m:any)=>/opus/i.test(m.id))?.id||state.claude.models[0]?.id;assert.ok(model);chatId=await call('newChat');await call('addModel',{chatId,model});state=await call('state');await call('mode',{projectId:state.chats.find((c:any)=>c.id===chatId).projectId,mode:'bypass'});
 const id=crypto.randomUUID(),prompt=`Fix one confirmed Trismegistus setup bug in ${root}: the workingFolder action in app/main.ts accepts the app's private data directory as a working folder, and then every native tool call fails with Protected credential directory. Validate the selected folder before changing any saved setting, profile or session. Reuse the existing real-path/credential-directory check in app/claude.ts (claudeDirectory) where suitable; preserve valid roots, paths containing spaces, clear-folder behavior and the old root on rejection. Keep all existing credential protections and folder-change coordination. Only edit app/main.ts and add tests/working-folder.e2e.ts. The test must use isolated test data and hidden Electron windows, proving that a normal folder works and that the private data directory, a descendant and a junction into it are rejected without changing the saved root or the existing project folders. Do not use real credentials in the test. Follow existing mainWindow/pollState test helpers and support TRISMEGISTUS_EXE for later packaged verification. Then run npm run typecheck, npm run build and node --import tsx tests/working-folder.e2e.ts, fixing failures within those two files. Preserve all other existing edits. Work directly without agents. Do not commit, package, publish or restart the production app. Report actual changes and check results.`;
 await fs.writeFile(path.join(data,'task.txt'),prompt);await call('submit',{id,chatId,models:[model],text:prompt});let stamp='';
 for(const deadline=Date.now()+15*60*1000;Date.now()<deadline;await page.waitForTimeout(500)){
  state=await call('state');const turn=state.turns.find((t:any)=>t.id===id),tools=state.tools.filter((t:any)=>t.turnId===id),pending=state.approvals.filter((a:any)=>a.turnId===id&&a.status==='pending');
  await fs.writeFile(path.join(data,'progress.json'),JSON.stringify({chatId,turnId:id,model,status:turn.status,text:turn.text,error:turn.error,tools,pending},null,2));
  const next=JSON.stringify([turn.status,tools.map((t:any)=>[t.name,t.status]),pending.map((p:any)=>p.id)]);if(next!==stamp){stamp=next;console.log(JSON.stringify({status:turn.status,tools:tools.length,last:tools.slice(-2).map((t:any)=>({name:t.name,status:t.status})),pending:pending.map((p:any)=>p.id)}));}
  let choices:Record<string,string>={};try{choices=JSON.parse(await fs.readFile(path.join(data,'decisions.json'),'utf8'));}catch{}for(const approval of pending)if(['once','deny'].includes(choices[approval.id]))await call('approve',{id:approval.id,choice:choices[approval.id]});
  if(['completed','failed','interrupted','stopped'].includes(turn.status)){assert.equal(turn.status,'completed',turn.error||turn.text);assert.notEqual(await hash('app/main.ts'),before);await fs.access('tests/working-folder.e2e.ts');await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({chatId,turnId:id,model,before,after:await hash('app/main.ts'),answer:turn.text,tools},null,2));console.log('PASS self-change performed: '+data);break;}
 }
 await fs.access(path.join(data,'verified.json'));
}finally{if(chatId)await app.windows().find(p=>/index\.html$/.test(p.url()))?.evaluate(chatId=>window.desktop.invoke('stop',{chatId}),chatId).catch(()=>{});await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
