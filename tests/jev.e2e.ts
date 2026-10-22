import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Backend,PYTHON} from '../app/backend';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','jev-')),folder=await fs.mkdtemp(path.join(root,'work','jev-files-'));
const namespace='Trismegistus/Test/'+path.basename(data),host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const ds=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_DEEPSEEK_MODELS:JSON.stringify(['deepseek-flash','deepseek-fixture-secondary']),FIXTURE_RECORDS:path.join(data,'deepseek.jsonl'),FIXTURE_AUX_RECORDS:path.join(data,'aux.jsonl')},windowsHide:true,stdio:'pipe'}),dl=createInterface({input:ds.stdout}),[dline]=await once(dl,'line');
const gpt=spawn(PYTHON,['tests/fake_codex.py',namespace,path.join(data,'gpt.jsonl')],{env:host.environment(),windowsHide:true,stdio:'pipe'}),gl=createInterface({input:gpt.stdout}),[gline]=await once(gl,'line');
let mode='gpt',requests:any[]=[],checks=0;
const fake=createServer(async(req,res)=>{
 if(req.headers.authorization!=='Bearer synthetic-jev-regression-credential'){res.writeHead(401).end();return;}
 if(req.url==='/v1/models'){checks++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{name:'jev-latest'}]}));return;}
 let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);requests.push(body);
 if(mode==='credit'){res.writeHead(402).end();return;}
 const answers=Object.fromEntries(Object.entries(body.questions).map(([name,q]:[string,any])=>{
  const options=Object.keys(q.criteria),preferred=mode==='claude'?'claude-code:haiku':mode==='deepseek'||mode.startsWith('parallel')?'deepseek-flash':'gpt-6-astra';
  const pick=name==='execution'?(mode.startsWith('parallel')?'parallel':'single'):name==='collaboration'?(mode==='parallel-review'?'review':'ownership'):name.startsWith('include_')?(mode.startsWith('parallel')?'include':'omit'):name==='primary'||name==='lead'?(options.includes(preferred)?preferred:'ask'):mode==='deepseek-backup'?(options.includes('deepseek-fixture-secondary')?'deepseek-fixture-secondary':'ask'):options.includes('gpt-6-astra')?'gpt-6-astra':'ask';
  return [name,{type:'choice',choice:pick,confidence:mode==='unsure'?0.1:0.95,probabilities:Object.fromEntries(options.map(option=>[option,option===pick?1:0]))}];
 }));
 if(mode==='timeout'||mode==='hold')await new Promise(resolve=>setTimeout(resolve,mode==='hold'?2500:1000));
 if(!res.destroyed){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'jev-fixture',answers,usage:{input_tokens:80,output_tokens:10}}));}
});await new Promise<void>(resolve=>fake.listen(0,'127.0.0.1',resolve));const endpoint=`http://127.0.0.1:${(fake.address() as any).port}/v1`;
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_JEV_URL:endpoint,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(dline).url,TRISMEGISTUS_TEST_CODEX_URL:JSON.parse(gline).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const launch=async()=>{const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env,timeout:30000});await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});return app;};let instance=await launch();
try{
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));let page=await instance.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(s:any)=>boolean)=>{const end=Date.now()+90000;while(Date.now()<end){const state=await call('state');if(predicate(state))return state;await page.waitForTimeout(100);}throw Error('Timed out: '+JSON.stringify((await call('state')).turns));};
 const ready=()=>wait(s=>s.backend==='ready'&&s.availableModels?.includes('gpt-6-astra')&&s.claude?.models?.length);
 const send=async(chatId:string,text:string,model?:string)=>{if(model)await call('modelSelection',{chatId,model,selected:true});const id=crypto.randomUUID();await call('submit',{id,chatId,text});return id;};
 const done=async(id:string,status='completed')=>{const s=await wait(s=>s.turns.some((t:any)=>t.id===id&&['completed','failed','interrupted','stopped','needs-model'].includes(t.status)));const t=s.turns.find((t:any)=>t.id===id);assert.equal(t.status,status,t.error);return t;};
 await ready();assert.equal((await call('state')).jev.connected,false);assert.equal(requests.length,0);
 await call('workingFolder',{folder});const a=await call('addProject'),b=await call('addProject');for(const chatId of [a,b])for(const model of ['gpt-6-astra','claude-code:haiku'])await call('addModel',{chatId,model});
 if(!await page.getByRole('dialog').count())await page.locator('.settings-link').click();
 await page.getByLabel('Settings sections').getByRole('button',{name:'Connections',exact:true}).click();
 await page.locator('details.supplier-pill').filter({has:page.locator('summary strong',{hasText:'TypeSafe'})}).locator(':scope > summary').click();
 await page.getByLabel('Jev API key').fill('synthetic-jev-regression-credential');await page.getByRole('button',{name:'Save Jev connection',exact:true}).click();await wait(s=>s.jev.status==='Connected');
 await page.getByLabel('Jev API key').fill('');await page.screenshot({path:path.join(data,'jev-settings.png')});await page.getByLabel('Close settings').click();assert.equal(checks,1);assert.equal(requests.length,0);assert.equal((await call('state')).jev.status,'Connected');
 const first=await done(await send(a,'JEV_CASE_GPT\n```python\nPRIVATE_RAW_BODY = 42\n```'));assert.equal(first.model,'gpt-6-astra');assert.match(first.routeNotice,/Jev selected/);assert.equal(first.routingUsage.summaryTokens,120);assert.equal(first.routingUsage.pickerTokens,90);assert.doesNotMatch(JSON.stringify(requests),/PRIVATE_RAW_BODY|synthetic-jev/);
 mode='deepseek';assert.equal((await done(await send(b,'Private task in B','deepseek-flash'))).model,'deepseek-flash');
 mode='claude';assert.equal((await done(await send(a,'Use native Claude for the next step.'))).model,'claude-code:haiku');
 assert.doesNotMatch(JSON.stringify(requests.at(-1)),/Private task in B/);
 mode='unsure';const unsure=await send(a,'Choose carefully.');await done(unsure,'needs-model');await call('chooseTurnModel',{id:unsure,model:'gpt-6-astra'});await done(unsure);
 mode='timeout';assert.equal((await done(await send(a,'Use my explicit choice on timeout.','deepseek-flash'))).model,'deepseek-flash');
 mode='hold';const beforeHold=requests.length,held=await send(a,'Stop during routing.');await wait(()=>requests.length>beforeHold);await call('stop',{chatId:a});await done(held,'stopped');
 console.log('PASS encrypted connection/free check, real summary calls, first-chat Jev picks, native handover, isolated summary-only state, uncertainty, timeout and Stop');
 mode='parallel-review';const parallel=crypto.randomUUID();await call('submit',{id:parallel,chatId:b,text:'WRITE_FIXTURE WRITE_GPT_FIXTURE WRITE_CLAUDE'});
 let reviewState=await wait(s=>s.turns.find((t:any)=>t.id===parallel)?.jobs?.length===3&&s.approvals.some((a:any)=>a.status==='pending'));
 const group=reviewState.turns.find((t:any)=>t.id===parallel);assert.deepEqual(group.collaboration,{strategy:'review',lead:'deepseek-flash'});
 const permit=reviewState.approvals.find((a:any)=>group.jobs.includes(a.turnId)&&a.status==='pending');assert.equal(reviewState.turns.find((t:any)=>t.id===permit.turnId).model,'deepseek-flash');await call('approve',{id:permit.id,choice:'once'});await done(parallel);
 assert.equal(await fs.access(path.join(folder,'gpt-result.txt')).then(()=>true,()=>false),false);assert.equal(await fs.access(path.join(folder,'claude-result.txt')).then(()=>true,()=>false),false);
 mode='parallel';assert.equal((await done(await send(b,'Compare approaches together.'))).jobs.length,3);
 mode='timeout';const beforeManual=requests.length,multiTimeout=crypto.randomUUID();await call('submit',{id:multiTimeout,chatId:b,text:'Keep both explicit models after routing timeout.',models:['deepseek-flash','claude-code:haiku']});const manual=await done(multiTimeout);assert.equal(manual.jobs.length,2);assert.equal(manual.routingUsage,undefined);assert.equal(requests.length,beforeManual);
 console.log('PASS composed Jev sets, preserved explicit models, enforced implementer/reviewer roles and multi-model timeout fallback');
 mode='deepseek';const effect=await send(a,'HEALTH_EFFECT');let state=await wait(s=>s.approvals.some((x:any)=>x.turnId===effect&&x.status==='pending'));await call('approve',{id:state.approvals.find((x:any)=>x.turnId===effect&&x.status==='pending').id,choice:'once'});
 const continued=await done(effect);assert.equal(continued.model,'gpt-6-astra');assert.match(continued.routeNotice,/Continued/);assert.deepEqual(continued.usage.mixed_models,['deepseek-flash','gpt-6-astra']);assert.equal(await fs.readFile(path.join(folder,'before-limit.txt'),'utf8'),'Write completed before the account limit.');
 const tools=(await call('state')).tools.filter((tool:any)=>tool.turnId===effect);assert.equal(tools.filter((tool:any)=>tool.name==='write_file').length,1);
 console.log('PASS Jev-ordered Hermes fallback after a completed write without replay');
 // The next pick must replace the fallback's old primary and adopt the new backup list.
 await call('jevSave',{key:'',summaryModel:'gpt-6-astra',confidence:0.7,timeoutMs:500});mode='gpt';const next=await done(await send(a,'Continue on the new primary.'));assert.equal(next.model,'gpt-6-astra');assert.equal(next.routingUsage.summaryModel,'gpt-6-astra');assert.deepEqual(next.fallbacks,[]);
 // A subscription Claude can write the routing summary through the background Claude runner (Koan 2026-10-19).
 await call('jevSave',{key:'',summaryModel:'claude-code:haiku',confidence:0.7,timeoutMs:500});const byClaude=await done(await send(a,'Route with a Claude summary.'));assert.equal(byClaude.model,'gpt-6-astra');assert.equal(byClaude.routingUsage.summaryModel,'claude-code:haiku');assert.equal(byClaude.routingUsage.summaryTokens,880);
 await call('jevSave',{key:'',summaryModel:'gpt-6-astra',confidence:0.7,timeoutMs:500});
 await call('checkAccount');mode='credit';await done(await send(a,'Jev is exhausted; retain the previous eligible model.'));const count=requests.length;await call('jevCheck');await call('jevSave',{key:'',summaryModel:'gpt-6-astra',confidence:0.75,timeoutMs:500});await done(await send(a,'Do not retry the exhausted routing account.','gpt-6-astra'));assert.equal(requests.length,count);
 await instance.evaluate(({app})=>app.quit());await instance.close();instance=await launch();await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));page=await instance.firstWindow();await ready();await done(await send(a,'Retain the Jev block across restart.','gpt-6-astra'));assert.equal(requests.length,count);
 mode='gpt';await call('jevRetry');await done(await send(a,'Explicitly retry Jev.'));assert.equal(requests.length,count+1);
 // A non-flash DeepSeek backup must reach the DeepSeek endpoint after the primary supplier fails.
 mode='deepseek-backup';await call('jevSave',{key:'',summaryModel:'deepseek-flash',confidence:0.7,timeoutMs:500});
 const backupChat=await call('addProject');for(const model of ['gpt-6-astra','deepseek-fixture-secondary'])await call('addModel',{chatId:backupChat,model});
 const backup=await done(await send(backupChat,'EXHAUST_GPT_FIXTURE Use the configured DeepSeek backup.'));
 assert.equal(backup.model,'deepseek-fixture-secondary');assert.match(backup.routeNotice,/Continued/);
 const backupRequests=(await fs.readFile(path.join(data,'deepseek.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 assert.ok(backupRequests.some(body=>body.model==='deepseek-fixture-secondary'&&JSON.stringify(body).includes('EXHAUST_GPT_FIXTURE')));
 await call('jevDisconnect');assert.equal((await call('state')).jev.connected,false);assert.equal((await call('state')).jev.status,'Not connected');
 await instance.evaluate(({app})=>app.quit());await instance.close();const db=new DatabaseSync(path.join(data,'chat.sqlite'),{readOnly:true});const raw=db.prepare('SELECT data FROM records').all().map((r:any)=>r.data).join('\n');db.close();assert.doesNotMatch(raw,/synthetic-jev-regression-credential/);assert.match(raw,/routing-requested/);assert.match(raw,/fallback/);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({checks:['connection','summary-only state','same-chat context','three engines','uncertainty','timeout','cancellation','ordered fallback','no tool replay','billing block','restart','retry','disconnect','no plaintext key']},null,2));console.log('PASS durable Jev billing refusal/restoration, restart, disconnect and recorded choices\nEvidence: '+data);
}finally{await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});ds.stdin.end();gpt.stdin.end();dl.close();gl.close();fake.closeAllConnections();fake.close();}
