import {_electron as electron} from 'playwright';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PYTHON} from '../app/backend';
const working=await fs.mkdtemp(path.join(process.cwd(),'work','minimax-oauth-workspace-'));
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/minimax-oauth-'));
let authorized=false,challenge='',devices=0,prompts=0,exhausted=false,refreshes=0;
const access='synthetic-minimax-access',refresh='synthetic-minimax-refresh';
const apiKey='synthetic-minimax-api-key';
let currentAccess=access;
const server=createServer(async(req,res)=>{
 const reply=(code:number,body:any)=>res.writeHead(code,{'Content-Type':'application/json'}).end(JSON.stringify(body));
 let raw='';for await(const chunk of req)raw+=chunk;const form=new URLSearchParams(raw);
 const cn=req.url?.startsWith('/cn/'),route=req.url?.replace(/^\/cn/,'');
 if(route==='/oauth/code'){devices++;challenge=form.get('code_challenge')!;reply(200,{state:form.get('state'),user_code:'MINIMAX-TEST',verification_uri:cn?'https://platform.minimaxi.com/oauth':'https://platform.minimax.io/oauth',expired_in:120,interval:2000});return;}
 if(route==='/oauth/token'){if(form.get('grant_type')==='refresh_token'){assert.equal(form.get('refresh_token'),refresh);refreshes++;currentAccess=access+'-rotated';reply(200,{status:'success',access_token:currentAccess,refresh_token:refresh+'-rotated',expired_in:7200});return;}assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'),challenge);currentAccess=access;reply(200,authorized?{status:'success',access_token:access,refresh_token:refresh,expired_in:7200}:{status:'pending'});return;}
 const credential=req.headers.authorization?.replace(/^Bearer /,'')||req.headers['x-api-key'];
 if(route?.startsWith('/anthropic/')&&credential!==currentAccess&&credential!==apiKey){reply(401,{type:'error',error:{type:'authentication_error',message:'Invalid fixture credential'}});return;}
 if(route==='/anthropic/v1/models'){reply(200,{data:[{id:'MiniMax-M2.7'}]});return;}
 if(route==='/anthropic/v1/messages'){
  prompts++;if(exhausted&&credential===currentAccess){reply(402,{type:'error',error:{type:'insufficient_quota',message:'Subscription usage limit reached'}});return;}
  const body=JSON.parse(raw),messages=body.messages||[],last=messages.at(-1),prompt=JSON.stringify(last);
  const filename=/API_WRITE ([a-z.-]+)/.exec(prompt)?.[1],tool=filename&&!prompt.includes('tool_result');
  const content:any[]=tool?[{type:'tool_use',id:'tool_fixture',name:'write_file',input:{path:filename,content:'MiniMax approved write'}}]:[{type:'text',text:'MiniMax retained copperfinch.'}];
  const message={id:'msg_test',type:'message',role:'assistant',model:body.model,content,stop_reason:tool?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:100,output_tokens:20}};
  if(!body.stream){reply(200,message);return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const emit=(type:string,extra:any)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...extra})+'\n\n');
  emit('message_start',{message:{...message,content:[],stop_reason:null,usage:{input_tokens:100,output_tokens:0}}});
  emit('content_block_start',{index:0,content_block:tool?{...content[0],input:{}}:{type:'text',text:''}});
  emit('content_block_delta',{index:0,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(content[0].input)}:{type:'text_delta',text:content[0].text}});
  if(prompt.includes('API_SLOW'))for(let i=0;i<80&&!res.destroyed;i++){await new Promise(resolve=>setTimeout(resolve,100));emit('content_block_delta',{index:0,delta:{type:'text_delta',text:' Streaming.'}});}
  emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:20}});emit('message_stop',{});res.end();return;
 }
 reply(404,{});
});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('Fixture failed');
const base='http://127.0.0.1:'+address.port;
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_MINIMAX_URL:base,TRISMEGISTUS_TEST_API_URLS:JSON.stringify({minimax:base+'/anthropic','minimax-cn':base+'/cn/anthropic'})};
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env});let app=await launch();
try{
 let page=await app.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const row=(s:any)=>s.apiProviders.find((r:any)=>r.provider==='minimax-oauth');
 const wait=async(check:(s:any)=>boolean)=>{const end=Date.now()+90000;while(Date.now()<end){const s=await call('state');if(check(s))return s;await page.waitForTimeout(100);}throw Error('MiniMax timeout');};
 await wait(s=>s.backend==='ready');await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
 await page.getByLabel('Settings sections').getByRole('button',{name:'Connections',exact:true}).click();
 await page.locator('summary[aria-label="Connection supplier"]').click();await page.locator('input[value="minimax-oauth"]').click();
 await page.getByRole('button',{name:'Sign in with MiniMax',exact:true}).click();await page.getByText('MINIMAX-TEST',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Cancel sign-in',exact:true}).click();await wait(s=>!row(s).login);await page.waitForTimeout(500);
 await page.getByRole('button',{name:'Sign in with MiniMax',exact:true}).click();await page.getByText('MINIMAX-TEST',{exact:true}).waitFor();authorized=true;
 await wait(s=>s.backend==='ready'&&row(s).source==='live');assert.equal(devices,2);assert.equal(prompts,0);
 const stored=await fs.readFile(path.join(data,'hermes/auth.json'),'utf8');assert.ok(stored.includes('credential_envelope'));assert.ok(!stored.includes(access));assert.ok(!stored.includes(refresh));
 await page.getByLabel('Close settings',{exact:true}).click();await call('workingFolder',{folder:working});const chat=await call('newChat'),model='api:minimax-oauth:MiniMax-M2.7';await call('addModel',{chatId:chat,model});
 const id=crypto.randomUUID();await call('submit',{id,chatId:chat,text:'Remember copperfinch.',models:[model]});
 const completed=await wait(s=>s.turns.some((t:any)=>t.id===id&&!['queued','running','waiting','dispatching','stopping'].includes(t.status))),turn=completed.turns.find((t:any)=>t.id===id);
 assert.equal(turn.status,'completed',JSON.stringify(turn));assert.match(turn.text,/copperfinch/);assert.ok(prompts>0);
 const send=async(text:string,selected=model)=>{const id=crypto.randomUUID();await call('submit',{id,chatId:chat,text,models:[selected]});return id;};
 const done=async(id:string)=>{const s=await wait(s=>s.turns.some((t:any)=>t.id===id&&!['queued','running','waiting','dispatching','stopping'].includes(t.status)));return s.turns.find((t:any)=>t.id===id);};
 // Expire the encrypted root grant while this chat and its backend are still running.
 const resources=process.env.TRISMEGISTUS_EXE?path.join(path.dirname(process.env.TRISMEGISTUS_EXE),'resources'):root;
 execFileSync(PYTHON,['-c',"import sys;sys.path[:0]=[sys.argv[1]+'/backend',sys.argv[1]+'/runtime/hermes'];from security import install_codec;install_codec(sys.argv[2]+'/encryption');from hermes_cli.auth import _auth_store_lock,_load_auth_store,_save_auth_store\nwith _auth_store_lock():\n s=_load_auth_store();s['providers']['minimax-oauth']['expires_at']='2000-01-01T00:00:00+00:00';_save_auth_store(s)",resources,'Trismegistus/Test/'+path.basename(data)],{env:{...process.env,HERMES_HOME:path.join(data,'hermes')},windowsHide:true});
 assert.equal((await done(await send('Continue after the access token expires.'))).status,'completed');assert.equal(refreshes,1);
 const rotated=await fs.readFile(path.join(data,'hermes/auth.json'),'utf8');assert.ok(rotated.includes('credential_envelope'));assert.ok(!rotated.includes(currentAccess));
 for(const [filename,choice] of [['approved.txt','once'],['denied.txt','deny']]){const id=await send('API_WRITE '+filename),s=await wait(s=>s.approvals.some((a:any)=>a.turnId===id&&a.status==='pending'));assert.equal(await fs.access(path.join(working,filename)).then(()=>true,()=>false),false);await call('approve',{id:s.approvals.find((a:any)=>a.turnId===id&&a.status==='pending').id,choice});assert.equal((await done(id)).status,'completed');assert.equal(await fs.access(path.join(working,filename)).then(()=>true,()=>false),choice==='once');}
 const slow=await send('API_SLOW');await wait(s=>s.turns.some((t:any)=>t.id===slow&&t.text));await call('stop',{chatId:chat});assert.equal((await done(slow)).status,'stopped');assert.equal((await done(await send('Recovered after Stop.'))).status,'completed');
 for(const provider of ['minimax','minimax-cn']){await call('apiSave',{provider,key:apiKey});await wait(s=>s.backend==='ready'&&s.apiProviders.find((r:any)=>r.provider===provider)?.source==='live');const api='api:'+provider+':MiniMax-M2.7';await call('addModel',{chatId:chat,model:api});assert.equal((await done(await send('API connection reply.',api))).status,'completed');}
 exhausted=true;assert.notEqual((await done(await send('Check subscription limits.'))).status,'completed');assert.equal((await call('state')).availability.find((r:any)=>r.provider==='minimax-oauth'&&r.blocked)?.reason,'limit');
 assert.equal((await done(await send('API account remains usable.','api:minimax:MiniMax-M2.7'))).status,'completed');exhausted=false;await call('apiRetry',{provider:'minimax-oauth'});assert.equal((await done(await send('Recovered after retry.'))).status,'completed');
 await app.close();app=await launch();page=await app.firstWindow();await wait(s=>s.backend==='ready'&&row(s).connected);
 await call('apiDisconnect',{provider:'minimax-oauth'});await wait(s=>s.backend==='ready'&&!row(s).connected);
 await call('minimaxLogin',{region:'cn'});await wait(s=>s.backend==='ready'&&row(s).source==='live'&&row(s).region==='cn');assert.ok(row(await call('state')).baseUrl.endsWith('/cn/anthropic'));assert.equal((await done(await send('China sign-in reply.'))).status,'completed');
 await call('apiDisconnect',{provider:'minimax-oauth'});await wait(s=>s.backend==='ready'&&!row(s).connected);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({pkce:true,cancel:true,login:true,encrypted:true,noSetupInference:true,reply:true,restart:true,disconnect:true,approvedWrite:true,deniedWrite:true,stopRecovery:true,apiConnections:true,accountIsolation:true,limitRetry:true,chinaSignIn:true,activeSessionRefresh:true},null,2));console.log(data);
}finally{await app.close().catch(()=>{});server.closeAllConnections();server.close();execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;[v.delete(sys.argv[1]+'/'+s) for s in ('minimax','minimax-cn','encryption')]",'Trismegistus/Test/'+path.basename(data)],{windowsHide:true});}
