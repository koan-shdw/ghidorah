import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {oauthFixture} from './fixtures/mcp-oauth';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','mcp-hermes-')),folder=await fs.mkdtemp(path.join(root,'work','mcp-hermes-workspace-'));
const namespace='Trismegistus/Test/'+path.basename(data),host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const ds=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'hermes-requests.jsonl')},windowsHide:true,stdio:'pipe'}),dl=createInterface({input:ds.stdout}),[dline]=await once(dl,'line');
const gpt=spawn(PYTHON,['tests/fake_codex.py',namespace,path.join(data,'codex-requests.jsonl')],{env:{...process.env,HERMES_HOME:path.join(data,'hermes')},windowsHide:true,stdio:'pipe'}),gl=createInterface({input:gpt.stdout}),[gline]=await once(gl,'line');
const oauth=await oauthFixture();
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(dline).url,TRISMEGISTUS_TEST_CODEX_URL:JSON.parse(gline).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env,timeout:30000});
let instance=await launch();
try{
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.hide()));
 let page=await instance.firstWindow();const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(state:any)=>boolean)=>{const until=Date.now()+65000;while(Date.now()<until){const state=await call('state');if(predicate(state))return state;if(state.backend==='failed')throw Error(state.providerStatus);const failed=state.turns.find((turn:any)=>['interrupted','failed'].includes(turn.status));if(failed)throw Error(JSON.stringify(failed));await page.waitForTimeout(100);}throw Error('Timed out: '+JSON.stringify((await call('state')).turns));};
 await wait(state=>state.backend==='ready'&&state.codex?.models?.includes('gpt-6-astra')&&state.claude?.models?.some((m:any)=>m.id==='claude-code:haiku'));
 const connection=await call('mcpAdd',{name:'Shared OAuth',config:{url:oauth.origin+'/mcp',auth:'oauth',oauth:{cimd:false}}});
 await instance.evaluate(({shell})=>{shell.openExternal=async url=>{const {callback}=await(await fetch(url)).json();await fetch(callback);};});await call('mcpLogin',{id:connection});assert.equal(oauth.observed.exchanges,1);
 await call('workingFolder',{folder});const a=await call('addProject'),b=await call('addProject');
 for(const chatId of [a,b]){await call('addModel',{chatId,model:'gpt-6-astra'});await call('addModel',{chatId,model:'claude-code:haiku'});}
 const send=async(chatId:string,model:string,name:string,args:any)=>{await call('modelSelection',{chatId,model,selected:true});const id=crypto.randomUUID();const text=model.startsWith('claude-code:')?JSON.stringify(name.endsWith('_project_memory')?{action:'mcp',server:'ghidorah',tool:name,arguments:args}:{action:'mcp',marker:args.arguments?.marker}):'MCP_FIXTURE '+JSON.stringify({name,arguments:args});await call('submit',{id,chatId,text});return id;};
 const done=(id:string)=>wait(state=>state.turns.some((turn:any)=>turn.id===id&&turn.status==='completed'));
 const approve=async(id:string,choice='once')=>{const state=await wait(state=>state.approvals.some((approval:any)=>approval.turnId===id&&approval.status==='pending'));await call('approve',{id:state.approvals.find((approval:any)=>approval.turnId===id&&approval.status==='pending').id,choice});};
 const discovery=await send(a,'deepseek-flash','tool_search',{queries:['connected_tools call_connected_tool'],limit:5});let state=await done(discovery);assert.match(state.turns.find((t:any)=>t.id===discovery).text,/connected_tools/);
 const describe=await send(a,'deepseek-flash','tool_describe',{names:['connected_tools','call_connected_tool']});state=await done(describe);assert.match(state.turns.find((t:any)=>t.id===describe).text,/connection/);
 const list=await send(a,'deepseek-flash','connected_tools',{});state=await done(list);assert.match(state.turns.find((t:any)=>t.id===list).text,/Shared OAuth/);
 const schemas=await send(a,'deepseek-flash','connected_tools',{connection});state=await done(schemas);assert.match(state.turns.find((t:any)=>t.id===schemas).text,/inputSchema/);
 const [ta,tb]=await Promise.all([send(a,'deepseek-flash','call_connected_tool',{connection,tool:'echo',arguments:{marker:'alpha-project'}}),send(b,'gpt-6-astra','call_connected_tool',{connection,tool:'echo',arguments:{marker:'beta-project'}})]);
 await Promise.all([approve(ta),approve(tb)]);await done(ta);state=await done(tb);
 for(const [id,own,other] of [[ta,'alpha-project','beta-project'],[tb,'beta-project','alpha-project']]){const text=state.turns.find((turn:any)=>turn.id===id).text;assert.match(text,new RegExp(own));assert.doesNotMatch(text,new RegExp(other+'|synthetic-node-mcp-access'));}
 const tc=await send(a,'claude-code:haiku','call_connected_tool',{connection,tool:'echo',arguments:{marker:'claude-shared'}});await approve(tc);state=await done(tc);assert.match(state.turns.find((turn:any)=>turn.id===tc).text,/claude-shared/);assert.equal(oauth.observed.exchanges,1);
 const denied=await send(b,'gpt-6-astra','call_connected_tool',{connection,tool:'echo',arguments:{marker:'deny-marker'}});const before=oauth.observed.headers.length;await approve(denied,'deny');await done(denied);assert.equal(oauth.observed.headers.length,before);
 const callRecord=path.join(data,'mcp-calls.txt');
 const local=await call('mcpAdd',{name:'Local slow',config:{command:PYTHON,args:[path.join(root,'tests/fixtures/mcp_stdio.py')],env:{CALL_RECORD:callRecord,SERVICE_KEY:'synthetic-profile-mcp-key'}}});
 const slowA=await send(a,'deepseek-flash','call_connected_tool',{connection:local,tool:'slow',arguments:{marker:'slow-a'}});await approve(slowA);
 for(let i=0;i<200;i++){if((await fs.readFile(callRecord,'utf8').catch(()=>'' )).split('\n').filter(line=>line.trim()==='slow').length===1)break;await page.waitForTimeout(50);}
 assert.equal((await fs.readFile(callRecord,'utf8')).split('\n').filter(line=>line.trim()==='slow').length,1);
 // Unassessed external effects share the coordination gate. Stop the waiting
 // second chat without interrupting the first chat's already-dispatched tool.
 const slowB=await send(b,'gpt-6-astra','call_connected_tool',{connection:local,tool:'slow',arguments:{marker:'slow-b'}});await wait(s=>s.turns.some((t:any)=>t.id===slowB&&t.status==='running'));
 await call('stop',{chatId:b});await wait(state=>state.turns.some((t:any)=>t.id===slowB&&t.status==='stopped'));state=await call('state');assert.equal(state.turns.find((t:any)=>t.id===slowA).status,'running');
 await call('stop',{chatId:a});await wait(state=>state.turns.some((t:any)=>t.id===slowA&&t.status==='stopped'));
 // Stop cannot prove an arbitrary MCP effect did not happen. This fixture only
 // records the call name, waits and echoes; inspect its actual durable effects
 // before using the same connection again through the app's Work review.
 assert.equal((await fs.readFile(callRecord,'utf8')).split('\n').filter(line=>line.trim()==='slow').length,1);
 state=await call('state');
 for(const row of state.workReview.filter((row:any)=>[slowA,slowB].includes(row.job)))await call('inspectWork',{id:row.id,note:'Checked mcp_stdio.py and mcp-calls.txt: one slow call was recorded; this fixture only waits and echoes, with no further mutation.'});
 const afterStop=await send(b,'gpt-6-astra','call_connected_tool',{connection:local,tool:'echo',arguments:{marker:'after-stop'}});await approve(afterStop);state=await done(afterStop);assert.match(state.turns.find((t:any)=>t.id===afterStop).text,/after-stop/);
 for(const [chatId,own,other] of [[a,'alpha-project','beta-project'],[b,'beta-project','alpha-project']]){
  const search=await send(chatId,'deepseek-flash','session_search',{query:'"alpha-project" OR "beta-project"',detail:'full',role_filter:'tool',limit:20});state=await done(search);
  const text=JSON.stringify(JSON.parse(state.turns.find((t:any)=>t.id===search).text).results);assert.match(text,new RegExp(own));assert.doesNotMatch(text,new RegExp(other));
 }
 const [ma,mb]=await Promise.all([send(a,'deepseek-flash','memory',{action:'add',target:'memory',content:'ALPHA_PROJECT_MEMORY_ONLY'}),send(b,'gpt-6-astra','memory',{action:'add',target:'memory',content:'BETA_PROJECT_MEMORY_ONLY'})]);await Promise.all([approve(ma),approve(mb)]);await done(ma);state=await done(mb);
 const projectA=state.projects.find((p:any)=>p.id===state.chats.find((c:any)=>c.id===a).projectId),projectB=state.projects.find((p:any)=>p.id===state.chats.find((c:any)=>c.id===b).projectId);
 for(const [project,own,other] of [[projectA,'ALPHA_PROJECT_MEMORY_ONLY','BETA_PROJECT_MEMORY_ONLY'],[projectB,'BETA_PROJECT_MEMORY_ONLY','ALPHA_PROJECT_MEMORY_ONLY']]){const memory=await fs.readFile(path.join(data,'hermes/profiles',project.profile,'memories/MEMORY.md'),'utf8');assert.match(memory,new RegExp(own));assert.doesNotMatch(memory,new RegExp(other));}
 for(const [chatId,own,other] of [[a,'ALPHA_PROJECT_MEMORY_ONLY','BETA_PROJECT_MEMORY_ONLY'],[b,'BETA_PROJECT_MEMORY_ONLY','ALPHA_PROJECT_MEMORY_ONLY']]){
  const id=await send(chatId,'claude-code:haiku','read_project_memory',{});state=await done(id);assert.match(state.turns.find((t:any)=>t.id===id).text,new RegExp(own));assert.doesNotMatch(state.turns.find((t:any)=>t.id===id).text,new RegExp(other));assert.equal(state.approvals.filter((v:any)=>v.turnId===id).length,0);
 }
 const cm=await send(a,'claude-code:haiku','update_project_memory',{action:'add',target:'user',content:'CLAUDE_PROJECT_USER_FACT'});await approve(cm);state=await done(cm);assert.equal(state.approvals.filter((v:any)=>v.turnId===cm).length,1);
 const denyMemory=await send(a,'claude-code:haiku','update_project_memory',{action:'add',content:'MEMORY_MUST_NOT_SAVE'});await approve(denyMemory,'deny');state=await done(denyMemory);assert.match(state.turns.find((t:any)=>t.id===denyMemory).text,/denied/);
 const cancelMemory=await send(a,'claude-code:haiku','update_project_memory',{action:'add',content:'MEMORY_CANCELLED'});await wait(state=>state.approvals.some((v:any)=>v.turnId===cancelMemory&&v.status==='pending'));await call('stop',{chatId:a});await wait(state=>state.turns.some((t:any)=>t.id===cancelMemory&&t.status==='stopped'));
 await call('mode',{projectId:projectA.id,mode:'plan'});const planRead=await send(a,'claude-code:haiku','read_project_memory',{});state=await done(planRead);assert.match(state.turns.find((t:any)=>t.id===planRead).text,/CLAUDE_PROJECT_USER_FACT/);
 const planWrite=await send(a,'claude-code:haiku','update_project_memory',{action:'add',content:'MEMORY_PLAN_BLOCKED'});state=await done(planWrite);assert.match(state.turns.find((t:any)=>t.id===planWrite).text,/Plan mode/);
 await call('mode',{projectId:projectA.id,mode:'bypass'});const nativeForeign=await send(a,'claude-code:haiku','read_project_memory',{profile:projectB.profile});state=await done(nativeForeign);assert.match(state.turns.find((t:any)=>t.id===nativeForeign).text,/profile or path/);
 const foreign=await send(a,'deepseek-flash','session_search',{query:'BETA_PROJECT_MEMORY_ONLY',profile:projectB.profile});state=await done(foreign);assert.match(state.turns.find((t:any)=>t.id===foreign).text,/limited to this project/);await call('mode',{projectId:projectA.id,mode:'manual'});
 // The existing Hermes session receives Claude's new memory as appended context.
 const gptMemory=await send(a,'gpt-6-astra','memory',{action:'add',content:'GPT_SEES_CLAUDE_MEMORY'});await approve(gptMemory);await done(gptMemory);
 const gptBodies=(await fs.readFile(path.join(data,'codex-requests.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));const latestUser=gptBodies.at(-1).input.findLast((item:any)=>item.role==='user');const userText=typeof latestUser.content==='string'?latestUser.content:latestUser.content.map((block:any)=>block.text||'').join('');assert.match(userText.split('\n\nCurrent user message:')[0],/CLAUDE_PROJECT_USER_FACT/);
 const nativeBodies=(await fs.readFile(path.join(data,'claude-requests.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.ok(nativeBodies.some((body,index)=>((body.args.includes('--resume'))||nativeBodies.slice(0,index).some(earlier=>earlier.pid===body.pid&&earlier.sessionId===body.sessionId))&&body.content?.[1]?.text?.includes('CLAUDE_PROJECT_USER_FACT')),'retained or resumed native sessions receive fresh memory without replacing their history');
 assert.doesNotMatch(await fs.readFile(path.join(data,'hermes/profiles',projectA.profile,'memories/MEMORY.md'),'utf8'),/MEMORY_MUST_NOT_SAVE|MEMORY_CANCELLED|MEMORY_PLAN_BLOCKED/);
 console.log('PASS Claude shares Hermes project memory: cross-engine read/write, fresh resumed context, one approval, denial, cancellation, Plan, and foreign-profile refusal in Bypass');
 await call('mcpAction',{id:local,action:'remove'});
 console.log('PASS Hermes MCP cancellation is chat-scoped; next call succeeds; project memories and session-search results stay isolated, including a rejected foreign-profile search in Bypass');
 const profiles=await fs.readdir(path.join(data,'hermes/profiles'));for(const profile of profiles){const files=await fs.readdir(path.join(data,'hermes/profiles',profile));assert.ok(!files.includes('auth.json')&&!files.includes('mcp-tokens')&&!files.includes('.env'));}
 await instance.evaluate(({app})=>app.quit());await instance.close();instance=await launch();await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.hide()));page=await instance.firstWindow();await wait(state=>state.backend==='ready'&&state.codex?.connected);
 const restart=await send(b,'gpt-6-astra','call_connected_tool',{connection,tool:'echo',arguments:{marker:'after-restart'}});await approve(restart);state=await done(restart);assert.match(state.turns.find((turn:any)=>turn.id===restart).text,/after-restart/);assert.equal(oauth.observed.exchanges,1);
 const memoryRestart=await send(a,'claude-code:haiku','read_project_memory',{});state=await done(memoryRestart);assert.match(state.turns.find((t:any)=>t.id===memoryRestart).text,/CLAUDE_PROJECT_USER_FACT/);assert.doesNotMatch(state.turns.find((t:any)=>t.id===memoryRestart).text,/BETA_PROJECT_MEMORY_ONLY/);
 await call('mcpAction',{id:connection,action:'revoke'});await call('mcpAction',{id:connection,action:'on'});const after=oauth.observed.headers.length;
 const revoked=await send(b,'gpt-6-astra','call_connected_tool',{connection,tool:'echo',arguments:{marker:'revoked'}});await approve(revoked);await done(revoked);assert.ok(oauth.observed.headers.slice(after).every(header=>header===undefined));assert.equal(oauth.observed.exchanges,1);
 await call('mcpAction',{id:connection,action:'remove'});
 await call('workingFolder',{clear:true});const noRoot=await send(a,'claude-code:haiku','read_project_memory',{});state=await done(noRoot);assert.match(state.turns.find((t:any)=>t.id===noRoot).text,/CLAUDE_PROJECT_USER_FACT/);
 const bodies=(await fs.readFile(path.join(data,'hermes-requests.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)).filter(body=>body.tools?.length);
 // Hermes describes skill_manage with its owning profile's skills path. Compare within
 // each profile; different projects must keep their different paths.
 const catalogs=new Map<string,string>();
 for(const body of bodies){
  const catalog=JSON.stringify(body.tools),description=body.tools.find((tool:any)=>tool.function?.name==='skill_manage')?.function.description||'';
  const owners=[projectA,projectB].filter(project=>description.includes(path.join(data,'hermes/profiles',project.profile)));
  assert.equal(owners.length,1,'Each tool catalogue identifies exactly one test profile');
  const profile=owners[0].profile;
  if(catalogs.has(profile))assert.equal(catalog,catalogs.get(profile),'MCP connection changes preserve tool schemas within each project');else catalogs.set(profile,catalog);
 }
 assert.equal(catalogs.size,2,'Both project tool catalogues were checked');
 console.log('PASS shared MCP OAuth through real Hermes profiles and private Claude bridge: DeepSeek/GPT protocol fixtures, simultaneous isolated results, approvals/denial, restart, revocation, and no per-profile credential copies');
}finally{await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});ds.stdin.end();gpt.stdin.end();dl.close();gl.close();await oauth.close();}
