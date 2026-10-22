import {_electron as electron} from 'playwright';
import {createServer} from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {PYTHON} from '../app/backend';
const working=await fs.mkdtemp(path.join(process.cwd(),'work','vertex-connection-workspace-'));
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/vertex-connection-'));
await fs.writeFile(path.join(data,'health.json'),'{}');
const fake=spawn(PYTHON,['tests/fake_api_providers.py',data],{windowsHide:true,stdio:'pipe'}),lines=createInterface({input:fake.stdout});
const [line]=await once(lines,'line'),endpoints=JSON.parse(line);
let refreshes=0,prompts=0,deny=false;
const token='synthetic-vertex-access',secret='synthetic-vertex-refresh';
const server=createServer(async(req,res)=>{
 const reply=(status:number,body:any)=>res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(body));
 if(req.url==='/token'){refreshes++;reply(200,{access_token:token,expires_in:3600,token_type:'Bearer'});return;}
 if(req.headers.authorization!=='Bearer '+token){reply(401,{});return;}
 if(req.url==='/v1/models'){reply(200,{data:[{id:'google/gemini-2.5-flash'}]});return;}
 if(req.url?.startsWith('/models')){reply(deny?403:200,{publisherModels:[{name:'publishers/google/models/gemini-2.5-flash'}]});return;}
 prompts++;
 const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
 try{const upstream=await fetch(endpoints.xai+req.url!.replace(/^\/v1/,''),{method:req.method,headers:{Authorization:'Bearer synthetic-xai-test-credential','Content-Type':'application/json'},body:Buffer.concat(chunks)});res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'application/json'});if(upstream.body)for await(const chunk of upstream.body)res.write(chunk);res.end();}catch{res.end();}
});
server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('Fixture failed');
const file=path.join(data,'adc.json');await fs.writeFile(file,JSON.stringify({type:'authorized_user',client_id:'synthetic-client',client_secret:'synthetic-secret',refresh_token:secret}));
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_VERTEX_URL:'http://127.0.0.1:'+address.port};
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env});
let app=await launch();
try{
 let page=await app.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const row=(s:any)=>s.apiProviders.find((r:any)=>r.provider==='vertex');
 const wait=async(check:(s:any)=>boolean)=>{const end=Date.now()+90000;while(Date.now()<end){const s=await call('state');if(check(s))return s;await page.waitForTimeout(100);}throw Error('Vertex timeout: '+JSON.stringify(await call('state')));};
 await wait(s=>s.backend==='ready');await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
 await page.getByLabel('Settings sections').getByRole('button',{name:'Connections',exact:true}).click();
 await page.locator('summary[aria-label="Connection supplier"]').click();await page.locator('input[type="radio"][value="vertex"]').click();
 await page.getByLabel('Google Cloud project ID').fill('fixture-project');await page.getByLabel('Google Cloud region').fill('global');
 assert.equal(await page.getByRole('button',{name:'Import credential JSON'}).isEnabled(),true);
 await call('vertexImport',{file,projectId:'fixture-project',region:'global'});
 let state=await wait(s=>s.backend==='ready'&&row(s).source==='live');assert.equal(row(state).models[0].id,'api:vertex:google/gemini-2.5-flash');
 assert.equal(refreshes,1);assert.equal(prompts,0);
 const encrypted=await fs.readFile(path.join(data,'hermes/vertex-auth.json'),'utf8');assert.ok(encrypted.includes('credential_envelope'));assert.ok(!encrypted.includes(secret));assert.ok(!encrypted.includes(token));
 await call('apiCheck',{provider:'vertex'});assert.equal(refreshes,1);
 deny=true;await call('apiCheck',{provider:'vertex'});state=await call('state');assert.equal(row(state).source,'cached');assert.equal(row(state).models.length,1);assert.equal(row(state).status,'Cloud access denied');deny=false;
 await page.getByLabel('Close settings',{exact:true}).click();await call('workingFolder',{folder:working});const chat=await call('newChat'),model='api:vertex:google/gemini-2.5-flash';await call('addModel',{chatId:chat,model});
 const send=async(text:string)=>{const id=crypto.randomUUID();await call('submit',{id,chatId:chat,text,models:[model]});return id;};
 const done=async(id:string)=>{const s=await wait(s=>s.turns.some((t:any)=>t.id===id&&!['queued','running','waiting','dispatching','stopping'].includes(t.status)));return s.turns.find((t:any)=>t.id===id);};
 let turn=await done(await send('Remember copperfinch.'));assert.equal(turn.status,'completed',JSON.stringify(turn));assert.match(turn.text,/copperfinch/);
 for(const [filename,choice] of [['vertex-approved.txt','once'],['vertex-denied.txt','deny']]){const id=await send('API_WRITE '+filename),s=await wait(s=>s.approvals.some((a:any)=>a.turnId===id&&a.status==='pending'));await call('approve',{id:s.approvals.find((a:any)=>a.turnId===id&&a.status==='pending').id,choice});assert.equal((await done(id)).status,'completed');assert.equal(await fs.access(path.join(working,filename)).then(()=>true,()=>false),choice==='once');}
 const slow=await send('API_SLOW');await wait(s=>s.turns.some((t:any)=>t.id===slow&&t.text));await call('stop',{chatId:chat});assert.equal((await done(slow)).status,'stopped');assert.equal((await done(await send('Recover after Stop.'))).status,'completed');
 await app.close();app=await launch();page=await app.firstWindow();await wait(s=>s.backend==='ready'&&row(s).connected);assert.equal(refreshes,1);
 await call('apiDisconnect',{provider:'vertex'});await wait(s=>s.backend==='ready'&&!row(s).connected);assert.equal(await fs.access(path.join(data,'hermes/vertex-auth.json')).then(()=>true,()=>false),false);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({import:true,encrypted:true,cachedToken:true,catalogOutage:true,restart:true,disconnect:true,noSetupInference:true,reply:true,approvedWrite:true,deniedWrite:true,stopRecovery:true,prompts},null,2));console.log(data);
}finally{await app.close();server.close();server.closeAllConnections();fake.kill();execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1]+'/encryption')",'Trismegistus/Test/'+path.basename(data)],{windowsHide:true});}
