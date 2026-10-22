import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','pinned-plugins-'));
const namespace='Trismegistus/Test/'+path.basename(data),host=new Backend(root,data,namespace,()=>{});
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const ds=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'requests.jsonl')},windowsHide:true,stdio:'pipe'}),lines=createInterface({input:ds.stdout}),[line]=await once(lines,'line');
const gpt=spawn(PYTHON,['tests/fake_codex.py',namespace,path.join(data,'gpt.jsonl')],{env:{...process.env,HERMES_HOME:path.join(data,'hermes')},windowsHide:true,stdio:'pipe'}),gLines=createInterface({input:gpt.stdout}),[gLine]=await once(gLines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CODEX_URL:JSON.parse(gLine).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env,timeout:30000});
let instance=await launch();
try{
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.hide()));let page=await instance.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(state:any)=>boolean)=>{const until=Date.now()+90000;while(Date.now()<until){const state=await call('state');if(predicate(state))return state;await page.waitForTimeout(100);}throw Error('Timed out: '+JSON.stringify((await call('state')).turns));};
 await wait(state=>state.backend==='ready'&&state.codex?.connected&&state.claude?.models?.length);
 const a=await call('addProject'),b=await call('addProject');for(const chatId of [a,b]){await call('addModel',{chatId,model:'gpt-6-astra'});await call('addModel',{chatId,model:'claude-code:haiku'});}
 const send=async(chatId:string,text:string,model='deepseek-flash')=>{await call('modelSelection',{chatId,model,selected:true});const id=crypto.randomUUID();await call('submit',{id,chatId,text});const state=await wait(state=>state.turns.some((turn:any)=>turn.id===id&&['completed','interrupted'].includes(turn.status)));const turn=state.turns.find((turn:any)=>turn.id===id);assert.equal(turn.status,'completed',turn.error);return turn;};
 await send(a,'Before enabling plugin');
 await page.locator('.settings-link').click();await page.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name:'Plugins',exact:true}).click();await page.getByLabel('Plugin commit',{exact:true}).fill('e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156');await page.getByRole('button',{name:'Review repository',exact:true}).click();
 const review=page.getByRole('region',{name:'Plugin review',exact:true});await Promise.race([review.getByText('This code can use all your keys.',{exact:true}).waitFor({timeout:120000}),page.locator('.plugins-settings > .error').waitFor({timeout:120000}).then(async()=>{throw Error(await page.locator('.plugins-settings > .error').innerText());})]);assert.equal((await call('nativePlugins')).installed.length,0);console.log('Reviewed exact Ponytail commit');
 await page.screenshot({path:path.join(data,'review.png')});await review.getByRole('button',{name:'Import and enable',exact:true}).click();await Promise.race([review.waitFor({state:'hidden',timeout:90000}),page.locator('.plugins-settings > .error').waitFor({timeout:90000}).then(async()=>{throw Error(await page.locator('.plugins-settings > .error').innerText());})]);
 const [installed]=(await call('nativePlugins')).installed;assert.equal(installed.commit,'e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156');assert.equal(installed.enabled,true);console.log('Enabled pinned snapshot');
 const skill='MCP_FIXTURE '+JSON.stringify({name:'skills_list',arguments:{}});
 for(const chatId of [a,b,a]){const turn=await send(chatId,skill);assert.match(turn.text,/ponytail/);assert.equal((await call('state')).approvals.filter((item:any)=>item.turnId===turn.id).length,0);}
 const view=await send(a,'MCP_FIXTURE '+JSON.stringify({name:'skill_view',arguments:{name:'ponytail:ponytail'}}));assert.match(view.text,/laziest solution/i);
 const requests=()=>fs.readFile(path.join(data,'requests.jsonl'),'utf8').then(text=>text.trim().split('\n').map(line=>JSON.parse(line)));
 assert.match(JSON.stringify((await requests()).at(-1)),/PONYTAIL MODE ACTIVE/);
 await send(b,'Check GPT plugin context','gpt-6-astra');assert.match(await fs.readFile(path.join(data,'gpt.jsonl'),'utf8'),/PONYTAIL MODE ACTIVE/);
 await send(a,'Native plugin fixture','claude-code:haiku');const native=JSON.parse((await fs.readFile(path.join(data,'claude-requests.jsonl'),'utf8')).trim().split('\n').at(-1)!);assert.equal(native.args[native.args.indexOf('--plugin-dir')+1],installed.directory);
 await call('modelSelection',{chatId:a,model:'deepseek-flash',selected:true});const slow=crypto.randomUUID();await call('submit',{id:slow,chatId:a,text:'SLOW_FIXTURE'});await wait(state=>state.turns.some((turn:any)=>turn.id===slow&&turn.status==='running'));
 await assert.rejects(call('nativePluginToggle',{id:installed.id,enabled:false}),/active work/);await call('stop',{chatId:a});await wait(state=>state.turns.some((turn:any)=>turn.id===slow&&turn.status==='stopped'));
 await call('nativePluginToggle',{id:installed.id,enabled:false});await send(a,'PLUGIN_FIXTURE off after existing session');assert.doesNotMatch(JSON.stringify((await requests()).at(-1)),/PONYTAIL MODE ACTIVE/);
 await call('nativePluginToggle',{id:installed.id,enabled:true});await instance.evaluate(({app})=>app.quit());await instance.close();instance=await launch();await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.hide()));page=await instance.firstWindow();await wait(state=>state.backend==='ready');await send(b,'PLUGIN_FIXTURE pinned after restart');assert.match(JSON.stringify((await requests()).at(-1)),/PONYTAIL MODE ACTIVE/);
 const before=(await requests()).length;await fs.appendFile(path.join(installed.directory,'__init__.py'),'\n# tamper');await call('modelSelection',{chatId:a,model:'deepseek-flash',selected:true});const id=crypto.randomUUID();await call('submit',{id,chatId:a,text:'Must reject changed plugin'});const failed=await wait(state=>state.turns.some((turn:any)=>turn.id===id&&turn.status==='interrupted'));assert.match(failed.turns.find((turn:any)=>turn.id===id).error,/plugin changed/);assert.equal((await requests()).length,before);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({commit:installed.commit,hash:installed.hash,tests:['UI review before execution','real pinned repository','A-B-A skill discovery','full skill read without folder','DeepSeek and GPT hook context','native Claude snapshot transport','off clears context','restart pin','tamper denied before model request']},null,2));
 console.log('PASS pinned plugin integration '+data);
}catch(error){const page=await instance.firstWindow();await page.screenshot({path:path.join(data,'failure.png')}).catch(()=>{});console.log((await page.locator('.plugins-settings').innerText().catch(()=>'' )).slice(-3000));throw error;
}finally{await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close();ds.stdin.end('\n');gpt.stdin.end('\n');lines.close();gLines.close();await Promise.all([host.host('delete_key'),once(ds,'close'),once(gpt,'close')]);}
