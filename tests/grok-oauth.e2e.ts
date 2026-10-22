import {_electron as electron} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PYTHON} from '../app/backend';

const working=await fs.mkdtemp(path.join(process.cwd(),'work','grok-oauth-workspace-'));
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/grok-oauth-'));
await fs.writeFile(path.join(data,'health.json'),'{}');
const fake=spawn(PYTHON,['tests/fake_api_providers.py',data],{windowsHide:true,stdio:'pipe'}),lines=createInterface({input:fake.stdout});
const [line]=await once(lines,'line'),endpoints=JSON.parse(line);
let authorized=false,exhausted=false,denied=false,posts=0,deviceCalls=0;
const access='synthetic-grok-subscription-access',apiKey='synthetic-xai-test-credential';
const server=createServer(async(req,res)=>{
 const reply=(status:number,body:any)=>{res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(body));};
 if(req.url==='/discovery'){reply(200,{authorization_endpoint:'https://auth.x.ai/authorize',token_endpoint:base+'/token'});return;}
 if(req.url==='/device'){deviceCalls++;reply(200,{device_code:'synthetic-device',user_code:'TEST-GROK',verification_uri:'https://auth.x.ai/device',verification_uri_complete:'https://auth.x.ai/device?code=TEST-GROK',expires_in:120,interval:1});return;}
 if(req.url==='/token'){reply(authorized?200:400,authorized?{access_token:access,refresh_token:'synthetic-grok-refresh',token_type:'Bearer'}:{error:'authorization_pending'});return;}
 const subscription=req.headers.authorization==='Bearer '+access;
 if(!subscription&&req.headers.authorization!=='Bearer '+apiKey){reply(401,{error:{code:'invalid_api_key'}});return;}
 if(subscription&&denied){reply(403,{error:{code:'forbidden'}});return;}
 if(req.method==='POST'){posts++;if(subscription&&exhausted){reply(402,{error:{code:'insufficient_quota',type:'insufficient_quota',message:'Subscription usage limit reached'}});return;}}
 const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
 try{
  const upstream=await fetch(endpoints.xai+req.url!.replace(/^\/v1/,''),{method:req.method,headers:{'Authorization':'Bearer '+apiKey,'Content-Type':req.headers['content-type']||'application/json'},body:req.method==='GET'?undefined:Buffer.concat(chunks)});
  res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'application/json'});
  if(upstream.body)for await(const chunk of upstream.body)res.write(chunk);res.end();
 }catch{if(!res.headersSent)reply(502,{});else res.end();}
});
server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('Fixture failed');const base='http://127.0.0.1:'+address.port;
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_GROK_URL:base,TRISMEGISTUS_TEST_API_URLS:JSON.stringify({xai:base+'/v1'})};
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env,timeout:30000});let app=await launch();
try{
 let page=await app.firstWindow();page.setDefaultTimeout(20000);
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(check:(s:any)=>boolean)=>{const until=Date.now()+90000;while(Date.now()<until){const s=await call('state');if(check(s))return s;await page.waitForTimeout(100);}throw Error('Grok check timed out: '+JSON.stringify((await call('state')).apiProviders));};
 const row=(s:any)=>s.apiProviders.find((r:any)=>r.provider==='xai-oauth');
 await wait(s=>s.backend==='ready');await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
 await page.getByLabel('Settings sections').getByRole('button',{name:'Connections',exact:true}).click();
 await page.locator('summary[aria-label="Connection supplier"]').click();await page.locator('input[type="radio"][value="xai-oauth"]').click();
 await page.getByRole('button',{name:'Sign in with Grok',exact:true}).click();await page.getByText('TEST-GROK',{exact:true}).waitFor();
 assert.equal(posts,0);await page.getByRole('button',{name:'Cancel sign-in',exact:true}).click();await wait(s=>!row(s).login);await page.waitForTimeout(500);
 await page.getByRole('button',{name:'Sign in with Grok',exact:true}).click();await page.getByText('TEST-GROK',{exact:true}).waitFor();authorized=true;
 await wait(s=>s.backend==='ready'&&row(s).source==='live');assert.equal(posts,0);assert.equal(deviceCalls,2);
 const encrypted=await fs.readFile(path.join(data,'hermes/auth.json'),'utf8');assert.ok(!encrypted.includes(access));assert.ok(encrypted.includes('credential_envelope'));
 await call('apiSave',{provider:'xai',key:apiKey});await wait(s=>s.backend==='ready'&&s.apiProviders.find((r:any)=>r.provider==='xai').source==='live');
 await page.getByLabel('Close settings',{exact:true}).click();await call('workingFolder',{folder:working});const chat=await call('newChat');
 const oauth='api:xai-oauth:grok-4.6',api='api:xai:grok-4.6';for(const model of [oauth,api])await call('addModel',{chatId:chat,model});
 const send=async(model:string,text:string)=>{const id=crypto.randomUUID();await call('submit',{id,chatId:chat,text,models:[model]});return id;};
 const done=async(id:string)=>{const s=await wait(s=>s.turns.some((t:any)=>t.id===id&&!['queued','running','waiting','dispatching','stopping'].includes(t.status)));return s.turns.find((t:any)=>t.id===id);};
 let turn=await done(await send(oauth,'Remember copperfinch.'));assert.equal(turn.status,'completed',JSON.stringify(turn));assert.match(turn.text,/copperfinch/);
 for(const [filename,choice] of [['grok-approved.txt','once'],['grok-denied.txt','deny']]){
  const id=await send(oauth,'API_WRITE '+filename),s=await wait(s=>s.approvals.some((a:any)=>a.turnId===id&&a.status==='pending'));
  assert.equal(await fs.access(path.join(working,filename)).then(()=>true,()=>false),false);
  await call('approve',{id:s.approvals.find((a:any)=>a.turnId===id&&a.status==='pending').id,choice});await done(id);
  assert.equal(await fs.access(path.join(working,filename)).then(()=>true,()=>false),choice==='once');
 }
 const slow=await send(oauth,'API_SLOW');await wait(s=>s.turns.some((t:any)=>t.id===slow&&t.text));await call('stop',{chatId:chat});assert.equal((await done(slow)).status,'stopped');
 assert.equal((await done(await send(oauth,'Recovered after Stop.'))).status,'completed');
 exhausted=true;turn=await done(await send(oauth,'Check subscription limit.'));assert.notEqual(turn.status,'completed');const limit=(await call('state')).availability.find((r:any)=>r.provider==='xai-oauth'&&r.blocked);assert.equal(limit.reason,'limit');
 turn=await done(await send(api,'API credit remains separate.'));assert.equal(turn.status,'completed',JSON.stringify(turn));
 exhausted=false;await call('apiRetry',{provider:'xai-oauth'});turn=await done(await send(oauth,'Resume after reset.'));assert.equal(turn.status,'completed',JSON.stringify(turn));
 denied=true;await call('apiCheck',{provider:'xai-oauth'});assert.match(row(await call('state')).status,/denied/);denied=false;await call('apiCheck',{provider:'xai-oauth'});
 await app.evaluate(({app})=>app.quit());await app.close();app=await launch();page=await app.firstWindow();await wait(s=>s.backend==='ready'&&row(s).connected);assert.ok(row(await call('state')).models.some((m:any)=>m.id===oauth));
 await call('apiDisconnect',{provider:'xai-oauth'});await wait(s=>s.backend==='ready'&&!row(s).connected);assert.ok((await call('state')).apiProviders.find((r:any)=>r.provider==='xai').connected);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({deviceLogin:true,cancel:true,noSetupPrompt:true,encrypted:true,subscriptionReply:true,approvedWrite:true,deniedWrite:true,stopRecovery:true,apiAndSubscriptionIsolation:true,limit:true,recovery:true,denial:true,restart:true,disconnect:true},null,2));console.log('PASS Grok subscription',data);
}finally{
 await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});server.closeAllConnections();server.close();fake.kill();
 execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;[v.delete(sys.argv[1]+'/'+s) for s in ('xai','encryption')]",'Trismegistus/Test/'+path.basename(data)],{windowsHide:true});
}
