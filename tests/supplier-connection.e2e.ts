import {_electron as electron} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PYTHON} from '../app/backend';
const working=await fs.mkdtemp(path.join(process.cwd(),'work','supplier-connection-workspace-'));
const root=process.cwd(),provider=process.env.TRISMEGISTUS_TEST_SUPPLIER||'mistral',data=await fs.mkdtemp(path.join(root,'work/supplier-'+provider+'-'));
await fs.writeFile(path.join(data,'health.json'),'{}');
const fake=spawn(PYTHON,['tests/fake_api_providers.py',data],{windowsHide:true,stdio:'pipe'}),lines=createInterface({input:fake.stdout});const [line]=await once(lines,'line');
const endpoints=JSON.parse(line);assert.ok(endpoints[provider]);
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,...(provider==='nous'?{TRISMEGISTUS_TEST_NOUS_URL:endpoints.nous.replace(/\/v1$/,'')}:{TRISMEGISTUS_TEST_API_URLS:JSON.stringify({[provider]:endpoints[provider]})})};
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env});let app=await launch();
try{
 let page=await app.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const row=(s:any)=>s.apiProviders.find((r:any)=>r.provider===provider);
 const wait=async(check:(s:any)=>boolean)=>{const end=Date.now()+90000;while(Date.now()<end){const s=await call('state');if(check(s))return s;await page.waitForTimeout(100);}throw Error('Supplier check timed out');};
 await wait(s=>s.backend==='ready');
 if(provider==='nous'){
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
  await page.getByLabel('Settings sections').getByRole('button',{name:'Connections',exact:true}).click();
  await page.locator('summary[aria-label="Connection supplier"]').click();await page.locator('input[value="nous"]').click();
  await page.getByRole('button',{name:'Sign in with Nous',exact:true}).click();await page.getByText('NOUS-TEST',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Cancel sign-in',exact:true}).click();await wait(s=>!row(s).login);await page.waitForTimeout(500);
  await page.getByRole('button',{name:'Sign in with Nous',exact:true}).click();await page.getByText('NOUS-TEST',{exact:true}).waitFor();await fs.writeFile(path.join(data,'nous-authorized'),'yes');
  await wait(s=>s.backend==='ready'&&row(s).source==='live');
  for(const file of ['auth.json','shared/nous_auth.json']){const saved=await fs.readFile(path.join(data,'hermes',file),'utf8');assert.equal(JSON.parse(saved).credential_envelope,1);assert.ok(!saved.includes('synthetic-nous-refresh'));}
  await page.getByLabel('Close settings',{exact:true}).click();
 }else if(provider==='openrouter-api'){
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
  await page.getByLabel('Settings sections').getByRole('button',{name:'Connections',exact:true}).click();
  await page.locator('summary[aria-label="Connection supplier"]').click();await page.locator('input[value="openrouter-api"]').click();
  await page.getByRole('button',{name:'Sign in with OpenRouter',exact:true}).click();await wait(s=>!!row(s).login);
  const cancelled=new URL(row(await call('state')).login.url).searchParams.get('callback_url')!;
  await page.getByRole('button',{name:'Cancel sign-in',exact:true}).click();await wait(s=>!row(s).login);await page.waitForTimeout(500);
  assert.equal(await fetch(cancelled).then(()=>true,()=>false),false);
  await page.getByRole('button',{name:'Sign in with OpenRouter',exact:true}).click();const pending=await wait(s=>!!row(s).login);
  const url=new URL(row(pending).login.url),callback=new URL(url.searchParams.get('callback_url')!);assert.equal(url.origin,'https://openrouter.ai');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  const wrong=new URL(callback);wrong.pathname='/callback/wrong';wrong.search='?code=fixture-code';assert.equal((await fetch(wrong)).status,404);assert.equal(row(await call('state')).connected,false);
  await fs.writeFile(path.join(data,'openrouter-pkce.json'),JSON.stringify({code:'fixture-code',challenge:url.searchParams.get('code_challenge')}));
  callback.search='?code=fixture-code';assert.equal((await fetch(callback)).status,200);
  await wait(s=>s.backend==='ready'&&row(s).source==='live');
  await page.getByLabel('Close settings',{exact:true}).click();
 }else if(provider==='alibaba'){
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
  await page.getByLabel('Settings sections').getByRole('button',{name:'Connections',exact:true}).click();
  await page.locator('summary[aria-label="Connection supplier"]').click();await page.locator('input[value="alibaba"]').click();
  await page.getByLabel('Model Studio region',{exact:true}).selectOption('ap-northeast-1');
  await page.getByLabel('Model Studio workspace ID',{exact:true}).fill('workspace-123');
  await page.getByLabel('Alibaba Model Studio API key',{exact:true}).fill('synthetic-alibaba-test-credential');
  await page.getByRole('button',{name:'Save Alibaba Model Studio connection',exact:true}).click();
  await wait(s=>s.backend==='ready'&&row(s).source==='live');
  assert.equal(row(await call('state')).region,'ap-northeast-1');assert.equal(row(await call('state')).workspaceId,'workspace-123');
  await page.getByLabel('Close settings',{exact:true}).click();
 }else await call('apiSave',{provider,key:'synthetic-'+provider+'-test-credential'});
 let state=await wait(s=>s.backend==='ready'&&row(s).source==='live');const model=row(state).models[0].id;assert.equal(row(state).models.length,1);
 if(provider==='openrouter-api'){assert.equal(row(state).keyBudgetRemaining,5);assert.ok(!JSON.stringify(state).includes('synthetic-openrouter-api-test-credential'));}
 assert.equal(await fs.readFile(path.join(data,'requests.jsonl'),'utf8').catch(()=>''),'');
 await call('workingFolder',{folder:working});const chat=await call('newChat');await call('addModel',{chatId:chat,model});
 if(provider==='openrouter-api'){await page.locator('.context-ring').click();await page.getByLabel('OpenRouter account usage').getByText('$5.00',{exact:true}).waitFor();await page.getByLabel('Close usage',{exact:true}).click();}
 const send=async(text:string)=>{const id=crypto.randomUUID();await call('submit',{id,chatId:chat,text,models:[model]});return id;};
 const done=async(id:string)=>{const s=await wait(s=>s.turns.some((t:any)=>t.id===id&&!['queued','running','waiting','dispatching','stopping'].includes(t.status)));return s.turns.find((t:any)=>t.id===id);};
 let turn=await done(await send('Remember copperfinch.'));assert.equal(turn.status,'completed',JSON.stringify(turn));assert.match(turn.text,/copperfinch/);
 if(provider==='alibaba'){
  for(const mode of ['free-tier','unpurchased']){
   await fs.writeFile(path.join(data,'health.json'),JSON.stringify({alibaba:mode}));
   assert.notEqual((await done(await send('Exercise '+mode+' refusal.'))).status,'completed');
   const refused=await call('state');assert.ok(refused.availability.some((r:any)=>r.provider==='alibaba'&&r.blocked&&r.scope===model&&r.reason===(mode==='free-tier'?'limit':'model')));
   assert.ok(!refused.availability.some((r:any)=>r.provider==='alibaba'&&r.blocked&&r.scope==='account'));
   await fs.writeFile(path.join(data,'health.json'),'{}');await call('apiCheck',{provider});assert.ok(!(await call('state')).availableModels.includes(model));
   await call('apiRetry',{provider});assert.equal((await done(await send('Recover after '+mode+'.'))).status,'completed');
  }
 }
 if(provider==='nous'){
  await fs.writeFile(path.join(data,'health.json'),JSON.stringify({nous:'expired'}));
  const refreshed=await done(await send('Continue after the access token expires.'));assert.equal(refreshed.status,'completed',JSON.stringify(refreshed));assert.equal(await fs.readFile(path.join(data,'nous-refreshed'),'utf8'),'yes');
 }
 for(const [filename,choice] of [['approved.txt','once'],['denied.txt','deny']]){const id=await send('API_WRITE '+filename),s=await wait(s=>s.approvals.some((a:any)=>a.turnId===id&&a.status==='pending'));assert.equal(await fs.access(path.join(working,filename)).then(()=>true,()=>false),false);await call('approve',{id:s.approvals.find((a:any)=>a.turnId===id&&a.status==='pending').id,choice});assert.equal((await done(id)).status,'completed');assert.equal(await fs.access(path.join(working,filename)).then(()=>true,()=>false),choice==='once');}
 const slow=await send('API_SLOW');await wait(s=>s.turns.some((t:any)=>t.id===slow&&t.text));await call('stop',{chatId:chat});assert.equal((await done(slow)).status,'stopped');assert.equal((await done(await send('Recover after Stop.'))).status,'completed');
 await fs.writeFile(path.join(data,'health.json'),JSON.stringify({[provider]:'exhausted'}));assert.notEqual((await done(await send('Exercise credit exhaustion.'))).status,'completed');
 await fs.writeFile(path.join(data,'health.json'),'{}');await call('apiCheck',{provider});assert.ok(!(await call('state')).availableModels.includes(model));await call('apiRetry',{provider});assert.equal((await done(await send('Recover after credit retry.'))).status,'completed');
 await app.close();app=await launch();page=await app.firstWindow();await wait(s=>s.backend==='ready'&&row(s).connected);assert.ok((await call('state')).turns.some((t:any)=>t.chatId===chat&&t.text.includes('copperfinch')));
 if(provider==='alibaba'){assert.equal(row(await call('state')).region,'ap-northeast-1');assert.equal(row(await call('state')).workspaceId,'workspace-123');}
 await call('apiDisconnect',{provider});await wait(s=>s.backend==='ready'&&!row(s).connected);assert.ok(!(await call('state')).availableModels.includes(model));
 if(provider==='nous'){
  assert.equal(await fs.access(path.join(data,'hermes/shared/nous_auth.json')).then(()=>true,()=>false),false);
  execFileSync(PYTHON,['-c',"import sys;from pathlib import Path;sys.path[:0]=['backend','runtime/hermes'];from security import install_codec;install_codec(sys.argv[2]+'/encryption');from hermes_cli.auth import _load_auth_store\nroot=Path(sys.argv[1])\nfor path in [root/'auth.json',*root.glob('profiles/p-*/auth.json')]:\n s=_load_auth_store(path);assert 'nous' not in s.get('providers',{});assert 'nous' not in s.get('credential_pool',{})",path.join(data,'hermes'),'Trismegistus/Test/'+path.basename(data)],{env:{...process.env,HERMES_HOME:path.join(data,'hermes')},windowsHide:true});
 }
 if(provider==='openrouter-api'){
  await call('apiSave',{provider,key:'invalid-key'});await wait(s=>s.backend==='ready'&&row(s).authFailed);assert.equal(row(await call('state')).source,'unverified');
  await call('apiSave',{provider,key:'synthetic-'+provider+'-test-credential'});await wait(s=>s.backend==='ready'&&row(s).source==='live');assert.equal((await done(await send('Reply after API-key entry.'))).status,'completed');
  await call('apiDisconnect',{provider});await wait(s=>s.backend==='ready'&&!row(s).connected);
 }
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({provider,setupNoPrompt:true,reply:true,approvedWrite:true,deniedWrite:true,stopRecovery:true,exhaustionRetry:true,restart:true,disconnect:true,...(provider==='openrouter-api'?{oauthPkce:true,callbackNonce:true,cancelClosesListener:true,apiKeyEntry:true,invalidKeyRejected:true,keyBudgetDisplay:true}: {})},null,2));console.log(data);
}finally{await app.close().catch(()=>{});fake.kill();execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;[v.delete(sys.argv[1]+'/'+s) for s in (sys.argv[2],'encryption')]",'Trismegistus/Test/'+path.basename(data),provider],{windowsHide:true});}
