// Opt-in real native delegation through the desktop's approvals and storage.
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
if(process.env.TRISMEGISTUS_LIVE_CLAUDE!=='1')throw Error('Explicit subscription-test opt-in required.');
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work/native-agents-live-')),folder=await fs.mkdtemp(path.join(root,'work/agent-live-project-'));
const marker='delegated-'+crypto.randomUUID();await fs.writeFile(path.join(folder,'source.txt'),marker);
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data},timeout:30000}),page=await app.firstWindow();
const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});let latest:any;const approvals:any[]=[];
const wait=async(predicate:(s:any)=>boolean)=>{const until=Date.now()+100000;while(Date.now()<until){latest=await call('state');if(predicate(latest))return latest;for(const p of latest.approvals.filter((p:any)=>p.status==='pending')){const child=latest.turns.find((t:any)=>t.id===p.turnId),text=p.params.description||'',name=text.split('\n')[0];let allowed=false;
 if(child?.automatic?.kind==='agent'&&['Read','Write'].includes(name)){const input=JSON.parse(text.slice(text.indexOf('\n')+1));allowed=path.resolve(folder,input.file_path)===path.join(folder,name==='Read'?'source.txt':'copied.txt')&&(name==='Read'||input.content.trim()===marker);}
 approvals.push({turnId:p.turnId,name,allowed});await call('approve',{id:p.id,choice:allowed?'once':'deny'});
 }await page.waitForTimeout(100);}throw Error('Timeout '+JSON.stringify(latest.turns.map((t:any)=>({status:t.status,text:t.text,error:t.error}))));};
try{
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));await wait(s=>s.backend==='ready');await call('claudeCheck');await wait(s=>s.claude?.models?.length);
 const model=(latest.claude.models.find((m:any)=>m.id==='claude-code:haiku')||latest.claude.models.find((m:any)=>m.id==='claude-code:claude-haiku-4-5')).id;
 await call('workingFolder',{folder});const chatId=await call('addProject');await call('addModel',{chatId,model});await call('effort',{chatId,model,effort:'low'});
 const id=crypto.randomUUID();await call('submit',{id,chatId,models:[model],text:'Use Agent exactly once, subagent_type general-purpose and model haiku. Ask it to Read source.txt, then Write copied.txt with the exact marker it read. It must use only Read and Write, no shell commands or other tools. Do not do the file work yourself. Reply STARTED after launching it; report its result when it completes.'});
 await wait(s=>s.turns.some((t:any)=>t.automatic?.originTurnId===id&&t.automatic.kind==='agent'&&t.status==='completed')&&s.turns.some((t:any)=>t.automatic?.originTurnId===id&&!t.automatic.kind&&t.status==='completed'));
 const child=latest.turns.find((t:any)=>t.automatic?.originTurnId===id&&t.automatic.kind==='agent');assert.equal((await fs.readFile(path.join(folder,'copied.txt'),'utf8')).trim(),marker);assert.ok(approvals.some(p=>p.turnId===child.id&&p.name==='Write'&&p.allowed));
 assert.ok(latest.tools.some((t:any)=>t.turnId===child.id&&t.name==='Read'));assert.ok(latest.tools.some((t:any)=>t.turnId===child.id&&t.name==='Write'&&t.status==='completed'));assert.ok(!latest.tools.some((t:any)=>t.turnId===id&&['Read','Write'].includes(t.name)));assert.ok(child.usage.native_task_usage.total_tokens>0);assert.equal(child.usage.turn_total,null);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({parent:id,child:child.id,separateToolOwnership:true,approvedWrite:true,markerCopied:true,reportedUsage:child.usage.native_task_usage,approvals},null,2));console.log('PASS real native agent read/write, separate desktop approval/result and reported task usage. Evidence: '+data);
}finally{if(latest)await fs.writeFile(path.join(data,'last-state.json'),JSON.stringify(latest,null,2));await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
