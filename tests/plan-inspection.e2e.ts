import {_electron as electron} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/plan-inspection-')),folder=await fs.mkdtemp(path.join(root,'work/plan-inspection-work-'));
const git=(...args:string[])=>execFileSync('git',['-C',folder,...args],{encoding:'utf8',windowsHide:true}).trim();
git('init','-q','-b','main');await fs.writeFile(path.join(folder,'calc.py'),'def add(a,b): return a+b\n');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','base');
await fs.writeFile(path.join(folder,'calc.py'),'def add(a,b): return a-b\n');await fs.writeFile(path.join(folder,'.gitattributes'),'*.py filter=trip diff=trip\n');
const marker=path.join(folder,'helper-ran.txt').replaceAll('\\','/'),canary=`echo forbidden > '${marker}'`;
for(const key of ['filter.trip.clean','filter.trip.process','diff.trip.textconv','diff.external','core.fsmonitor','core.pager'])git('config',key,canary);
git('config','filter.trip.required','true');
const namespace='Trismegistus/Test/'+path.basename(data),host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const ds=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'deepseek.jsonl')},windowsHide:true,stdio:'pipe'}),dl=createInterface({input:ds.stdout}),[dline]=await once(dl,'line');
const gpt=spawn(PYTHON,['tests/fake_codex.py',namespace,path.join(data,'gpt.jsonl')],{env:host.environment(),windowsHide:true,stdio:'pipe'}),gl=createInterface({input:gpt.stdout}),[gline]=await once(gl,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(dline).url,TRISMEGISTUS_TEST_CODEX_URL:JSON.parse(gline).url};
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env,timeout:30000});
let app=await launch(),page=await app.firstWindow(),latest:any;
const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
const wait=async(test:(s:any)=>boolean)=>{const end=Date.now()+90000;while(Date.now()<end){latest=await call('state');if(test(latest))return;await page.waitForTimeout(50);}throw Error('Timed out: '+JSON.stringify(latest.turns));};
const row=(id:string)=>latest.turns.find((t:any)=>t.id===id),done=(id:string)=>wait(s=>['completed','failed','interrupted','stopped'].includes(s.turns.find((t:any)=>t.id===id)?.status));
const send=async(chatId:string,model:string,command:string)=>{const id=crypto.randomUUID();await call('submit',{id,chatId,models:[model],text:'MCP_FIXTURE '+JSON.stringify({name:'terminal',arguments:{command}})});return id;};
try{
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));await wait(s=>s.backend==='ready'&&s.availableModels.includes('gpt-6-astra'));await call('workingFolder',{folder});
 const saved:string[]=[];
 for(const model of ['deepseek-flash','gpt-6-astra']){
  const chatId=await call('addProject');if(model!=='deepseek-flash')await call('addModel',{chatId,model});latest=await call('state');const projectId=latest.chats.find((c:any)=>c.id===chatId).projectId;
  await call('mode',{projectId,mode:'plan'});
  const good=await send(chatId,model,'pwd; git status --short; echo "---DIFF---"; git diff; git log -1 --oneline; cat calc.py | head -1');await done(good);
  assert.equal(row(good).status,'completed');assert.match(row(good).text,/\+def add\(a,b\): return a-b/);assert.match(row(good).text,/-def add\(a,b\): return a\+b/);assert.equal(latest.approvals.filter((a:any)=>a.turnId===good).length,0);saved.push(good);
  if(model==='deepseek-flash'){
   const review=crypto.randomUUID();await call('submit',{id:review,chatId,models:[model],text:'/review --base main PLAN_BATCH_FIXTURE'});await done(review);const child=row(row(review).jobs[0]);assert.equal(child.status,'completed');assert.match(child.text,/\+def add\(a,b\): return a-b/);assert.doesNotMatch(child.text,/shared action guard|uncertain outcome/);saved.push(review);
  }
  for(const command of ['git diff > must-not-exist.txt','git checkout -- calc.py','git diff; echo bad > must-not-exist.txt','git diff --output=must-not-exist.txt']){
   const bad=await send(chatId,model,command);await done(bad);assert.match(row(bad).text,/Plan mode permits/);assert.equal(latest.approvals.filter((a:any)=>a.turnId===bad).length,0);
  }
  const protectedRead=await send(chatId,model,'cat .claude/auth.json');await wait(s=>s.approvals.some((a:any)=>a.turnId===protectedRead&&a.status==='pending'));await call('stop',{chatId});await done(protectedRead);assert.equal(row(protectedRead).status,'stopped');
  // The ordinary approval path still receives the submitted command in Manual.
  await call('mode',{projectId,mode:'manual'});const manual=await send(chatId,model,'pwd');await wait(s=>s.approvals.some((a:any)=>a.turnId===manual&&a.status==='pending'));const approval=latest.approvals.find((a:any)=>a.turnId===manual&&a.status==='pending');assert.match(JSON.stringify(approval),/pwd/);await call('approve',{id:approval.id,choice:'once'});await done(manual);assert.equal(row(manual).status,'completed');
 }
 for(const file of ['must-not-exist.txt','helper-ran.txt'])assert.equal(await fs.access(path.join(folder,file)).then(()=>true,()=>false),false);
 assert.equal(await fs.readFile(path.join(folder,'calc.py'),'utf8'),'def add(a,b): return a-b\n');
 await app.evaluate(({app})=>app.quit());await app.close();app=await launch();page=await app.firstWindow();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));await wait(s=>s.backend==='ready');for(const id of saved){assert.equal(row(id).status,'completed');assert.match(row(id).jobs?row(row(id).jobs[0]).text:row(id).text,/\+def add/);}
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({engines:['DeepSeek','GPT'],realTerminal:true,gitDiff:true,helpersSuppressed:true,writesRefused:true,protectedReadApproval:true,stopApproval:true,manualApproval:true,restart:true,protocolFixtures:true},null,2));console.log('PASS Plan Git/file inspection, writes/helpers refused, fixed approval, Stop, Manual and restart. '+data);
}finally{if(latest)await fs.writeFile(path.join(data,'last-state.json'),JSON.stringify(latest,null,2));await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});ds.stdin.end();gpt.stdin.end();dl.close();gl.close();await host.host('delete_key');}
