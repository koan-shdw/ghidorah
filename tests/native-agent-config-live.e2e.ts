// Opt-in native custom-plugin agent through the app's normal import and approval paths.
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
if(process.env.TRISMEGISTUS_LIVE_CLAUDE!=='1')throw Error('Explicit subscription-test opt-in required.');
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work/native-agent-config-live-')),folder=await fs.mkdtemp(path.join(root,'work/custom-agent-project-')),source=path.join(data,'fixture-claude-home/plugins/cache/config-check/version');
const marker='custom-agent-'+crypto.randomUUID();
await fs.mkdir(path.join(source,'.claude-plugin'),{recursive:true});await fs.mkdir(path.join(source,'agents'),{recursive:true});
await fs.writeFile(path.join(source,'.claude-plugin/plugin.json'),JSON.stringify({name:'config-check',version:'1.0.0',description:'Local native configuration check'}));
await fs.writeFile(path.join(source,'agents/check.md'),`---\nname: check\ndescription: Write the single configuration-check marker\nmodel: haiku\neffort: low\npermissionMode: acceptEdits\n---\nUse Write once to create custom-agent.txt containing exactly ${marker}. Use no other tools. If denied, stop. Report the result.\n`);
await fs.writeFile(path.join(data,'fixture-claude-home/plugins/installed_plugins.json'),JSON.stringify({plugins:{'config-check@local':[{scope:'user',installPath:source,version:'1.0.0'}]}}));
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data},timeout:30000}),page=await app.firstWindow();
const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});let latest:any;const approvals:any[]=[];
const wait=async(predicate:(s:any)=>boolean)=>{const until=Date.now()+100000;while(Date.now()<until){latest=await call('state');if(predicate(latest))return latest;
 for(const p of latest.approvals.filter((p:any)=>p.status==='pending')){const child=latest.turns.find((t:any)=>t.id===p.turnId),text=p.params.description||'',name=text.split('\n')[0];let allowed=false;
  if(child?.automatic?.kind==='agent'&&name==='Write'){const input=JSON.parse(text.slice(text.indexOf('\n')+1));allowed=path.resolve(folder,input.file_path)===path.join(folder,'custom-agent.txt')&&input.content.trim()===marker;}
  approvals.push({turnId:p.turnId,name,allowed});await call('approve',{id:p.id,choice:allowed?'once':'deny'});
 }await page.waitForTimeout(100);}throw Error('Timeout '+JSON.stringify(latest.turns.map((t:any)=>({status:t.status,error:t.error,automatic:t.automatic}))));};
try{
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));await wait(s=>s.backend==='ready');
 const review=await call('nativePluginReview',{id:'config-check@local'});await call('nativePluginInstall',{token:review.token});await call('claudeCheck');await wait(s=>s.claude?.models?.length);
 const model='claude-code:sonnet';assert.ok(latest.claude.models.some((m:any)=>m.id===model));await call('workingFolder',{folder});
 const chatId=await call('addProject');await call('addModel',{chatId,model});await call('effort',{chatId,model,effort:'medium'});
 const id=crypto.randomUUID();await call('submit',{id,chatId,models:[model],text:'Use Agent exactly once with subagent_type config-check:check. Omit the model argument so its definition chooses the model. Ask it to perform its single marker Write. Wait for it and report the result. Do no file work yourself.'});
 await wait(s=>s.turns.find((t:any)=>t.id===id)?.status==='completed'&&s.turns.some((t:any)=>t.automatic?.originTurnId===id&&t.automatic.kind==='agent'&&t.status==='completed'));
 const child=latest.turns.find((t:any)=>t.automatic?.originTurnId===id&&t.automatic.kind==='agent'),launch=latest.tools.find((t:any)=>t.turnId===id&&t.name==='Agent');
 assert.ok(launch);assert.equal(launch.args.model,undefined);assert.equal(child.model,'claude-code:haiku');assert.equal(child.automatic.agentType,'config-check:check');assert.match(child.automatic.resolvedModel,/haiku/i);
 assert.equal(child.effort,undefined);assert.equal(child.automatic.permissionMode,'default');assert.ok(approvals.some(p=>p.turnId===child.id&&p.name==='Write'&&p.allowed));
 assert.equal((await fs.readFile(path.join(folder,'custom-agent.txt'),'utf8')).trim(),marker);assert.ok(latest.tools.some((t:any)=>t.turnId===child.id&&t.name==='Write'&&t.status==='completed'));assert.ok(!latest.tools.some((t:any)=>t.turnId===id&&t.name==='Write'));
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({parent:id,parentModel:model,parentEffort:'medium',child:child.id,childModel:child.model,nativeSettings:child.automatic,childEffort:child.effort??null,definitionModel:true,separateApproval:true,markerWritten:true,approvals},null,2));
 console.log('PASS real Sonnet parent / plugin-defined Haiku child, actual model saved, unknown effort and inherited Manual approval. Evidence: '+data);
}finally{if(latest)await fs.writeFile(path.join(data,'last-state.json'),JSON.stringify(latest,null,2));await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
