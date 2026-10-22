import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {findClaude,runClaude} from '../app/claude';
import {SecretScrubber} from '../app/redaction';

const working=await fs.mkdtemp(path.join(process.cwd(),'work','skills-conversion-workspace-'));
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','skills-conversion-'));
const namespace='Trismegistus/Test/'+path.basename(data),host=new Backend(root,data,namespace,()=>{});
const source=path.join(data,'fixture-claude-home/plugins/cache/example/version'),record=path.join(data,'mcp-calls.txt');
async function put(name:string,value:any){const file=path.join(source,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value));}
await put('.claude-plugin/plugin.json',{name:'example',version:'1',description:'Conversion fixture'});
await put('skills/hello/SKILL.md','---\nname: hello\ndescription: Say a fixture greeting.\n---\nReply CONVERTED-SKILL-COPPERFINCH.\n');
await put('commands/run.md','---\ndescription: Shared command fixture.\n---\nCOMMAND-COPPERFINCH in ${CLAUDE_PLUGIN_ROOT}\n$ARGUMENTS');
await put('commands/restricted.md','---\nallowed-tools: Read\n---\nKeep native restrictions.');
await put('agents/worker.md','---\nname: worker\ndescription: Native worker fixture.\n---\nYou are a test worker.');
await put('hooks/hooks.json',{hooks:{SessionStart:[{hooks:[{type:'command',command:'echo CONVERSION_NATIVE_HOOK'}]}]}});
await fs.copyFile(path.join(root,'tests/fixtures/mcp_stdio.py'),path.join(source,'server.py'));
await put('.mcp.json',{mcpServers:{local:{command:PYTHON,args:['${CLAUDE_PLUGIN_ROOT}/server.py'],env:{CALL_RECORD:record}}}});
await fs.writeFile(path.join(data,'fixture-claude-home/plugins/installed_plugins.json'),JSON.stringify({plugins:{'example@local':[{scope:'user',installPath:source,version:'1',gitCommitSha:'a'.repeat(40)}]}}));
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const ds=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'requests.jsonl')},windowsHide:true,stdio:'pipe'}),dl=createInterface({input:ds.stdout}),[dline]=await once(dl,'line');
const gpt=spawn(PYTHON,['tests/fake_codex.py',namespace,path.join(data,'gpt.jsonl')],{env:{...process.env,HERMES_HOME:path.join(data,'hermes')},windowsHide:true,stdio:'pipe'}),gl=createInterface({input:gpt.stdout}),[gline]=await once(gl,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(dline).url,TRISMEGISTUS_TEST_CODEX_URL:JSON.parse(gline).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env,timeout:30000});
let instance=await launch();
try{
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.hide()));let page=await instance.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(state:any)=>boolean)=>{const until=Date.now()+100000;while(Date.now()<until){const state=await call('state');if(predicate(state))return state;await page.waitForTimeout(100);}throw Error('Timed out: '+JSON.stringify((await call('state')).turns));};
 await wait(state=>state.backend==='ready'&&state.codex?.connected&&state.claude?.models?.length);
 const a=await call('addProject'),b=await call('addProject');for(const chatId of [a,b]){await call('addModel',{chatId,model:'gpt-6-astra'});await call('addModel',{chatId,model:'claude-code:haiku'});}
 const submit=async(chatId:string,text:string,model='deepseek-flash')=>{await call('modelSelection',{chatId,model,selected:true});const id=crypto.randomUUID();await call('submit',{id,chatId,text});return id;};
 const done=async(id:string)=>{const state=await wait(state=>state.turns.some((turn:any)=>turn.id===id&&['completed','interrupted'].includes(turn.status)));const turn=state.turns.find((turn:any)=>turn.id===id);assert.equal(turn.status,'completed',turn.error);return turn;};
 const send=async(chatId:string,text:string,model='deepseek-flash')=>done(await submit(chatId,text,model));
 const inspect=async()=>{await page.locator('.settings-link').click();await page.getByRole('navigation',{name:'Settings sections',exact:true}).getByRole('button',{name:'Plugins',exact:true}).click();};
 await send(a,'Before conversion');await inspect();await page.getByText('Installed in Claude Code',{exact:true}).click();await page.getByRole('button',{name:'Convert example',exact:true}).click();
 const review=page.getByRole('region',{name:'Plugin review',exact:true});await review.getByText('This code can use all your keys.',{exact:true}).waitFor({timeout:90000});
 assert.match(await review.innerText(),/allowed-tools/);assert.match(await review.innerText(),/agents: remains native/);assert.match(await review.innerText(),/hooks: remains native/);
 assert.equal((await call('nativePlugins')).installed.length,0);assert.equal(await fs.access(record).then(()=>true,()=>false),false);
 await page.screenshot({path:path.join(data,'conversion-review.png')});await review.getByRole('button',{name:'Import and enable',exact:true}).click();await review.waitFor({state:'hidden',timeout:90000});
 const installed=(await call('nativePlugins')).installed[0];assert.equal(installed.conversion.commands.some((row:any)=>row.name==='restricted'),false);
 // Completion reads reviewed metadata only; selecting an entry never dispatches it.
 await page.getByRole('button',{name:'Close settings',exact:true}).click();
 const message=page.getByRole('combobox',{name:'Message',exact:true}),options=page.getByRole('listbox',{name:'Available commands',exact:true});
 const beforePicker=(await call('state')).turns.length;
 await message.fill('/exa');await options.waitFor();assert.equal(await options.getByRole('option').count(),2);assert.doesNotMatch(await options.innerText(),/restricted/);
 await message.evaluate(element=>element.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true})));assert.equal(await message.inputValue(),'/exa');assert.equal((await call('state')).turns.length,beforePicker);
 await message.press('ArrowDown');await message.press('Tab');assert.equal(await message.inputValue(),'/example:run ');assert.equal(await options.count(),0);assert.equal((await call('state')).turns.length,beforePicker);
 await message.fill('/example');await message.press('Escape');assert.equal(await message.inputValue(),'/example');assert.equal(await options.count(),0);
 await message.fill('keep these arguments');await page.getByRole('button',{name:'Browse skills and commands',exact:true}).click();await options.getByRole('option',{name:/\/example:run/}).click();assert.equal(await message.inputValue(),'/example:run keep these arguments');
 await message.press('Shift+Enter');assert.equal(await message.inputValue(),'/example:run keep these arguments\n');assert.equal((await call('state')).turns.length,beforePicker);
 await message.fill('/exa');await page.screenshot({path:path.join(data,'composer-commands.png')});
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(720,620));
 const picker=page.getByRole('region',{name:'Skills and commands',exact:true});const bounds=await picker.boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=720&&bounds.y+bounds.height<=620);await page.screenshot({path:path.join(data,'composer-narrow.png')});await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1280,850));
 await message.press('Enter');assert.equal(await message.inputValue(),'/example:hello ');assert.equal((await call('state')).turns.length,beforePicker);
 await message.fill('/example:run literal $& copperfinch');await call('modelSelection',{chatId:b,model:'deepseek-flash',selected:true});await message.press('Enter');
 const picked=await wait(state=>state.turns.some((turn:any)=>turn.chatId===b&&turn.prompt==='/example:run literal $& copperfinch'&&turn.status==='completed'));assert.match(picked.turns.find((turn:any)=>turn.chatId===b&&turn.prompt==='/example:run literal $& copperfinch').commandContext,/COMMAND-COPPERFINCH/);
 assert.equal(await message.inputValue(),'');
 await message.fill('draft stays with this chat');await page.locator('[data-chat-id="'+a+'"] .chat-link').click();for(let n=0;n<50&&await message.inputValue()==='draft stays with this chat';n++)await page.waitForTimeout(100);assert.notEqual(await message.inputValue(),'draft stays with this chat');await page.locator('[data-chat-id="'+b+'"] .chat-link').click();for(let n=0;n<50&&await message.inputValue()!=='draft stays with this chat';n++)await page.waitForTimeout(100);assert.equal(await message.inputValue(),'draft stays with this chat');await message.fill('');
 await inspect();
 console.log('PASS composer command filtering, keyboard/mouse insertion, no execution on selection, draft preservation and explicit dispatch');
 for(const chatId of [a,b,a]){const turn=await send(chatId,'MCP_FIXTURE '+JSON.stringify({name:'skills_list',arguments:{}}));assert.match(turn.text,/example:hello/);}
 const viewed=await send(a,'MCP_FIXTURE '+JSON.stringify({name:'skill_view',arguments:{name:'example:hello'}}));assert.match(viewed.text,/CONVERTED-SKILL-COPPERFINCH/);
 for(const model of ['deepseek-flash','gpt-6-astra','claude-code:haiku']){const turn=await send(a,'/example:run literal $& copperfinch',model);assert.equal(turn.prompt,'/example:run literal $& copperfinch');assert.match(turn.commandContext,/COMMAND-COPPERFINCH/);assert.ok(turn.commandContext.endsWith('literal $& copperfinch'));}
 const native=JSON.parse((await fs.readFile(path.join(data,'claude-requests.jsonl'),'utf8')).trim().split('\n').at(-1)!);assert.equal(native.args[native.args.indexOf('--plugin-dir')+1],path.join(installed.directory,'source'));assert.match(native.prompt,/COMMAND-COPPERFINCH/);
 assert.match(await fs.readFile(path.join(data,'gpt.jsonl'),'utf8'),/COMMAND-COPPERFINCH/);
 console.log('PASS conversion review, unsupported features, real Hermes A-B-A discovery/read and shared commands through all three transports');
 // Existing MCP connection review owns configuration and process launch, including plugin servers.
 const pill=page.locator('.supplier-pill').filter({has:page.locator('summary > strong',{hasText:/^example$/})});await pill.locator(':scope > summary').click();await pill.getByRole('button',{name:'Review server local',exact:true}).click();
 const form=page.getByRole('region',{name:'Plugin server import',exact:true});const config=JSON.parse(await form.getByLabel('Imported server configuration').inputValue());assert.equal(config.args[0],path.join(installed.directory,'source')+'/server.py');
 await form.getByRole('button',{name:'Save imported server',exact:true}).click();await form.waitFor({state:'hidden'});assert.equal(await fs.access(record).then(()=>true,()=>false),false);
 const connection=(await call('state')).mcp.find((row:any)=>row.name==='example · local').id;await call('mcpAction',{id:connection,action:'test'});await page.getByRole('button',{name:'Close settings',exact:true}).click();await call('workingFolder',{folder:working});
 for(const [chatId,model,marker] of [[a,'deepseek-flash','converted-alpha'],[b,'gpt-6-astra','converted-beta']]){
  const id=await submit(chatId,'MCP_FIXTURE '+JSON.stringify({name:'call_connected_tool',arguments:{connection,tool:'echo',arguments:{marker}}}),model);
  const state=await wait(state=>state.approvals.some((row:any)=>row.turnId===id&&row.status==='pending'));await call('approve',{id:state.approvals.find((row:any)=>row.turnId===id&&row.status==='pending').id,choice:'once'});
  assert.match((await done(id)).text,new RegExp(marker));assert.equal((await call('state')).approvals.filter((row:any)=>row.turnId===id).length,1);
 }
 assert.equal((await fs.readFile(record,'utf8')).trim().split('\n').length,2);
 // Actual native CLI discovery needs no model prompt or paid inference.
 const cli=await findClaude();assert.ok(cli);const capabilities=await runClaude({executable:cli.executable,python:PYTHON,worker:path.join(root,'backend/claude_worker.py'),directory:data,dataRoot:path.join(data,'private'),exchangeRoot:data,model:'claude-haiku-4-5',effort:'low',mode:'manual',hasFolder:true,scrubber:new SecretScrubber(),signal:AbortSignal.timeout(60000),event:()=>{},approve:async()=>false,prompt:'',inspectCapabilities:true,pluginDirectories:[path.join(installed.directory,'source')]});
 assert.match(JSON.stringify(capabilities.result.commands),/example:hello/);assert.match(JSON.stringify(capabilities.result.commands),/example:run/);assert.match(JSON.stringify(capabilities.result.commands),/example:restricted/);assert.match(JSON.stringify(capabilities.result.agents),/example:worker/);
 console.log('PASS converted MCP server review/save/test, one approval per call, and real native CLI discovery of original skills/commands/agents without a model prompt');
 // Real Skills Hub and GitHub; the protocol fixtures still own all model responses.
 await inspect();await page.getByText('Skills Hub',{exact:true}).click();await page.getByLabel('Skills Hub search',{exact:true}).fill('skill-creator');await page.getByRole('button',{name:'Search skills',exact:true}).click();
 const hub=page.locator('.hub-skill').filter({hasText:'skills-sh/anthropics/skills/skill-creator'});await hub.getByRole('button',{name:'Review skill skill-creator',exact:true}).click({timeout:90000});await review.getByText('This code can use all your keys.',{exact:true}).waitFor({timeout:180000});
 await page.screenshot({path:path.join(data,'hub-review.png')});await review.getByRole('button',{name:'Import and enable',exact:true}).click();await review.waitFor({state:'hidden',timeout:90000});
 const skill=(await call('nativePlugins')).installed.find((row:any)=>row.conversion?.kind==='skill');assert.match(skill.commit,/^[a-f0-9]{40}$/);assert.equal(skill.nativeSubdir,'native');
 const hubNative=await runClaude({executable:cli.executable,python:PYTHON,worker:path.join(root,'backend/claude_worker.py'),directory:data,dataRoot:path.join(data,'private'),exchangeRoot:data,model:'claude-haiku-4-5',effort:'low',mode:'manual',hasFolder:true,scrubber:new SecretScrubber(),signal:AbortSignal.timeout(60000),event:()=>{},approve:async()=>false,prompt:'',inspectCapabilities:true,pluginDirectories:[path.join(skill.directory,'native')]});assert.match(JSON.stringify(hubNative.result.commands),/skill-creator:skill-creator/);
 assert.match((await send(b,'MCP_FIXTURE '+JSON.stringify({name:'skill_view',arguments:{name:'skill-creator:skill-creator'}}))).text,/skill/i);
 await call('nativePluginToggle',{id:installed.id,enabled:false});const off=await send(a,'/example:run PLUGIN_FIXTURE after off');assert.equal(off.commandContext,undefined);assert.ok((await call('state')).mcp.some((row:any)=>row.id===connection));
 assert.ok(!(await call('state')).commands.some((row:any)=>row.name.startsWith('/example:')));
 const listing=await send(a,'MCP_FIXTURE '+JSON.stringify({name:'skills_list',arguments:{}}));assert.doesNotMatch(listing.text,/example:hello/);assert.match(listing.text,/skill-creator/);
 await call('nativePluginToggle',{id:installed.id,enabled:true});await instance.evaluate(({app})=>app.quit());await instance.close();instance=await launch();await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.hide()));page=await instance.firstWindow();await wait(state=>state.backend==='ready');
 assert.match((await send(b,'MCP_FIXTURE '+JSON.stringify({name:'skills_list',arguments:{}}))).text,/example:hello/);assert.match((await send(a,'/example:run PLUGIN_FIXTURE after restart')).commandContext,/COMMAND-COPPERFINCH/);
 assert.ok((await call('state')).commands.some((row:any)=>row.name==='/example:hello'&&row.kind==='Skill'));
 const before=(await fs.readFile(path.join(data,'requests.jsonl'),'utf8')).trim().split('\n').length;await fs.appendFile(path.join(installed.directory,'source/commands/run.md'),'\nchanged');const rejected=await submit(a,'/example:run must reject');const state=await wait(state=>state.turns.some((turn:any)=>turn.id===rejected&&turn.status==='interrupted'));assert.match(state.turns.find((turn:any)=>turn.id===rejected).error,/plugin changed/);assert.equal((await fs.readFile(path.join(data,'requests.jsonl'),'utf8')).trim().split('\n').length,before);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({converted:{commit:installed.commit,hash:installed.hash},hub:{commit:skill.commit,hash:skill.hash,repository:skill.repository},checks:['review before load','unsupported features','Hermes A-B-A skills','three-engine commands','persisted command context','MCP review and approvals','real native discovery','real Hub and Git commit','off/re-enable/restart','tamper refusal']},null,2));
 console.log('PASS real Skills Hub pinned installation, persisted commands, off/re-enable/restart and tamper denial. Evidence: '+data);
}catch(error){const page=await instance.firstWindow();await page.screenshot({path:path.join(data,'failure.png')}).catch(()=>{});console.log((await page.locator('.plugins-settings').innerText().catch(()=>'')).slice(-3500));throw error;
}finally{await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});ds.stdin.end('\n');gpt.stdin.end('\n');dl.close();gl.close();await host.host('delete_key');}
