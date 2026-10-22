import {createServer} from 'node:http';
import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {apiSuppliers} from '../app/api-catalog';
import {mainWindow} from './fixtures/poll-state';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','api-providers-')),folder=await fs.mkdtemp(path.join(root,'work','api-provider-files-'));await fs.writeFile(path.join(data,'health.json'),'{}');
const namespace='Trismegistus/Test/'+path.basename(data),host=new Backend(root,data,namespace,()=>{});await host.host('initialize');
const server=spawn(PYTHON,['tests/fake_api_providers.py',data],{windowsHide:true,stdio:'pipe'}),lines=createInterface({input:server.stdout});server.stderr.on('data',b=>process.stderr.write(b));const [line]=await once(lines,'line');
const routing=createServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json');if(req.url==='/v1/models'){res.end(JSON.stringify({models:[{name:'jev-latest'}]}));return;}
 let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
 const answers=Object.fromEntries(Object.entries(body.questions).map(([name,q]:[string,any])=>{const choices=Object.keys(q.criteria),choice=name==='primary'||name==='lead'?choices.find(c=>c.startsWith('api:gemini:'))||'ask':name==='execution'?'single':name==='collaboration'?'ownership':name.startsWith('include_')?'omit':'ask';return [name,{type:'choice',choice,confidence:0.95}];}));
 res.end(JSON.stringify({answers,usage:{input_tokens:15,output_tokens:10}}));
});await new Promise<void>(resolve=>routing.listen(0,'127.0.0.1',resolve));
const urls=JSON.parse(line),env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_API_URLS:JSON.stringify(urls),TRISMEGISTUS_TEST_JEV_URL:`http://127.0.0.1:${(routing.address() as any).port}/v1`};
const launch=async()=>{const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env,timeout:30000});await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});return app;};let instance=await launch();
try{
 let page=await mainWindow(instance);
 const capture=async(name:string)=>fs.writeFile(path.join(data,name),Buffer.from(await instance.evaluate(async({BrowserWindow})=>Array.from((await BrowserWindow.getAllWindows().find(w=>/index\.html$/.test(w.webContents.getURL()))!.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG()))));
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>{if(method==='attachmentAdd')args.bytes=new Uint8Array(args.bytes);return window.desktop.invoke(method,args);},{method,args});
 const wait=async(predicate:(s:any)=>boolean)=>{const end=Date.now()+90000;while(Date.now()<end){const s=await call('state');if(predicate(s))return s;await page.waitForTimeout(150);}throw Error('Timed out: '+JSON.stringify(await call('state'))+' UI '+await page.locator('.error').allTextContents());};
 const done=async(id:string,status='completed')=>{const s=await wait(s=>s.turns.some((t:any)=>t.id===id&&['completed','failed','stopped','interrupted','needs-model'].includes(t.status))),turn=s.turns.find((t:any)=>t.id===id);assert.equal(turn.status,status,turn.error);return turn;};
 const send=async(chatId:string,model:string,text:string)=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text,models:[model]});return id;};
 await wait(s=>s.backend==='ready');await call('workingFolder',{folder});
 if(!await page.getByRole('dialog').count())await page.locator('.settings-link').click();
 await page.getByLabel('Settings sections').getByRole('button',{name:'Connections',exact:true}).click();
 for(const [provider,info] of Object.entries(apiSuppliers).filter(([id])=>id in urls)){
  await page.locator('summary[aria-label="Connection supplier"]').click();await page.getByRole('radio',{name:info.name,exact:true}).click();
  await page.getByLabel(info.name+' API key',{exact:true}).fill('synthetic-'+provider+'-test-credential');
  await page.getByRole('button',{name:'Save '+info.name+' connection',exact:true}).click();
  await wait(s=>s.backend==='ready'&&s.apiProviders.some((r:any)=>r.provider===provider&&r.source==='live'));
  await page.waitForFunction(label=>(document.querySelector('input[aria-label="'+label+'"]') as HTMLInputElement)?.value==='',info.name+' API key');
 }
 assert.equal(await page.locator('.backend-status').innerText(),'Connected');
 const connected=await call('state');connected.apiProviders=connected.apiProviders.filter((row:any)=>row.connected);assert.equal(connected.apiProviders.length,Object.keys(urls).length);assert.ok(connected.apiProviders.every((r:any)=>r.models.length===1));
 assert.equal(await fs.readFile(path.join(data,'requests.jsonl'),'utf8').catch(()=>''),'','Setup must not send model prompts');
 await capture('connections.png');await page.getByLabel('Close settings').click();
 const chat=await call('addProject'),other=await call('addProject');
 await page.locator('[data-chat-id="'+chat+'"]').locator('.chat-link').click();await page.getByRole('button',{name:'Add model',exact:true}).click();
 for(const row of connected.apiProviders){const model=row.models[0].id,label=model.split(':').slice(2).join(':');await page.getByRole('button',{name:'Add '+label+' to this chat',exact:true}).click();await page.locator('[data-model="'+model+'"]').click({button:'right'});}
 await page.getByLabel('Close settings').click();
 await page.locator('.model-tab').filter({hasText:'gemini-3.8-flash'}).click();await page.getByLabel('Message',{exact:true}).fill('UI sends with Gemini only.');await page.getByRole('button',{name:'Send',exact:true}).click();const sent=await wait(s=>s.turns.some((t:any)=>t.prompt==='UI sends with Gemini only.'));await done(sent.turns.find((t:any)=>t.prompt==='UI sends with Gemini only.').id);
 await capture('models-chat.png');
 assert.ok(!(await call('state')).chats.find((c:any)=>c.id===other).pool.some((m:string)=>m.startsWith('api:')));
 for(const row of connected.apiProviders){
  const model=row.models[0].id,provider=row.provider;
  const reply=await done(await send(chat,model,'Remember copperfinch. Say it back.'));assert.match(reply.text,/copperfinch/);assert.equal(reply.model,model);assert.ok(reply.usage?.turn_total>0);console.log(provider+' chat passed');
  const filename=provider+'.txt',id=await send(chat,model,'API_WRITE '+filename);
  const pending=await wait(s=>s.approvals.some((a:any)=>a.turnId===id&&a.status==='pending'));const approval=pending.approvals.find((a:any)=>a.turnId===id&&a.status==='pending');
  assert.equal(await fs.access(path.join(folder,filename)).then(()=>true,()=>false),false);
  await call('approve',{id:approval.id,choice:'once'});await done(id);assert.equal(await fs.readFile(path.join(folder,filename),'utf8'),provider+' approved write');console.log(provider+' approval passed');
 }
 const gemini=connected.apiProviders.find((r:any)=>r.provider==='gemini').models[0].id;
 const slow=await send(chat,gemini,'API_SLOW');await wait(s=>s.turns.some((t:any)=>t.id===slow&&t.text));await call('stop',{chatId:chat});await done(slow,'stopped');
 await done(await send(chat,gemini,'Recovered after cancellation.'));
 await fs.writeFile(path.join(data,'health.json'),JSON.stringify({gemini:'unknown'}));await call('apiCheck',{provider:'gemini'});assert.ok((await call('state')).availableModels.includes(gemini),'Metadata failure must preserve a usable saved model');
 await fs.writeFile(path.join(data,'health.json'),'{}');await call('apiCheck',{provider:'gemini'});
 const denied=await send(chat,gemini,'API_WRITE denied.txt');let denial=await wait(s=>s.approvals.some((a:any)=>a.turnId===denied&&a.status==='pending'));await call('approve',{id:denial.approvals.find((a:any)=>a.turnId===denied&&a.status==='pending').id,choice:'deny'});await done(denied);assert.equal(await fs.access(path.join(folder,'denied.txt')).then(()=>true,()=>false),false);
 for(const row of connected.apiProviders){
  const isolated=await call('addProject'),model=row.models[0].id;await call('addModel',{chatId:isolated,model});await fs.writeFile(path.join(data,'health.json'),JSON.stringify({[row.provider]:'exhausted'}));
  const exhausted=await send(isolated,model,'Exercise account exhaustion.');await done(exhausted,'failed');
  assert.ok(!(await call('state')).availableModels.includes(model));await fs.writeFile(path.join(data,'health.json'),'{}');await call('apiCheck',{provider:row.provider});assert.ok(!(await call('state')).availableModels.includes(model),'A model list cannot clear known exhaustion');
  const before=await fs.readFile(path.join(data,'requests.jsonl'),'utf8');await assert.rejects(()=>send(isolated,model,'Refuse before provider IO.'));assert.equal(await fs.readFile(path.join(data,'requests.jsonl'),'utf8'),before);
  await call('apiRetry',{provider:row.provider});await done(await send(isolated,model,'Account retry recovered.'));console.log(row.provider+' exhaustion/retry passed');
 }
 for(const row of connected.apiProviders){await call('jevSave',{key:'synthetic-typesafe-api-regression-key',summaryModel:row.models[0].id,confidence:0.7,timeoutMs:3000});const summarized=await done(await send(chat,gemini,'Exercise supplier routing summary.'));assert.equal(summarized.routingUsage?.summaryModel,row.models[0].id);assert.equal(summarized.routingUsage?.summaryTokens,120);console.log(row.provider+' routing summary passed');}
 await call('jevDisconnect');
 const imageChat=await call('addProject');await call('addModel',{chatId:imageChat,model:gemini});
 await call('attachmentAdd',{chatId:imageChat,name:'pixel.png',bytes:Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==','base64'))});
 await done(await send(imageChat,gemini,'Read the attached image.'));
 const requests=(await fs.readFile(path.join(data,'requests.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 assert.ok(requests.some(r=>r.provider==='gemini'&&r.path.includes(':streamGenerateContent')&&r.body.contents));for(const provider of ['openai-api','xai'])assert.ok(requests.some(r=>r.provider===provider&&r.path.endsWith('/responses')));assert.ok(requests.some(r=>r.provider==='gemini'&&JSON.stringify(r.body).includes('inlineData')));
 assert.ok(requests.filter(r=>r.provider!=='gemini').every(r=>!r.body.model.startsWith('api:')));
 await instance.evaluate(({app})=>app.quit());await instance.close();instance=await launch();page=await mainWindow(instance);await wait(s=>s.backend==='ready'&&s.availableModels.includes(gemini));
 assert.ok((await call('state')).turns.some((t:any)=>t.chatId===chat&&t.text.includes('copperfinch')));
 await call('apiDisconnect',{provider:'gemini'});await wait(s=>s.backend==='ready'&&!s.apiProviders.find((r:any)=>r.provider==='gemini').connected);assert.ok(!(await call('state')).availableModels.includes(gemini));
 assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({chat,providers:connected.apiProviders.map((r:any)=>r.provider),requests:requests.length,checks:['setup-no-prompt','metadata-filter','per-chat-models','model-pool-clicks','favourites','actual-ui-send','streaming','supplier-approved-writes','supplier-routing-summaries','gemini-image-transport','native-gemini','openai-and-xai-responses','cancellation-recovery','denied-write','supplier-exhaustion-blocks','explicit-retry','metadata-outage','restart','disconnect']},null,2));console.log('PASS',data);
}finally{
 await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});server.stdin.end();lines.close();routing.closeAllConnections();routing.close();
 for(const provider of [...Object.keys(urls),'typesafe'])await host.host('delete_key',{provider});
 const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');
}
