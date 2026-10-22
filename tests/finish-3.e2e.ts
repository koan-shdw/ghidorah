import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';

// Finish plan section 3 in the desktop, through fakes: the picker list (3a-1), Kev (3a-2), GLiDE (3a-3), GLiNER (3a-4), Not Diamond (3a-5), learning (3c).
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','finish-3-')),namespace='Trismegistus/Test/'+path.basename(data);
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const ds=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'deepseek.jsonl'),FIXTURE_AUX_RECORDS:path.join(data,'aux.jsonl')},windowsHide:true,stdio:'pipe'}),[dline]=await once(createInterface({input:ds.stdout}),'line');
const gpt=spawn(PYTHON,['tests/fake_codex.py',namespace,path.join(data,'gpt.jsonl')],{env:host.environment(),windowsHide:true,stdio:'pipe'}),[gline]=await once(createInterface({input:gpt.stdout}),'line');
// A System One server in Jev's exact shape. It always picks GPT for one answering model.
const asked:{who:string;body:any}[]=[],servers:ReturnType<typeof createServer>[]=[];
const systemOne=(who:string,authorized:(req:any)=>boolean)=>{const server=createServer(async(req,res)=>{
 if(!authorized(req)){res.writeHead(401).end();return;}
 if(req.url?.endsWith('/models')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{name:who+'-latest'}]}));return;}
 let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);asked.push({who,body});
 const answers=Object.fromEntries(Object.entries(body.questions).map(([name,question]:[string,any])=>{const options=Object.keys(question.criteria);const state=typeof body.state==='string'?JSON.parse(body.state):body.state,preferred=state?.selected?.find((id:string)=>options.includes(id))||'gpt-6-astra';const choice=name==='execution'?'single':options.includes(preferred)?preferred:options[0];return [name,{type:'choice',choice,confidence:0.95}];}));
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:who,answers,usage:{input_tokens:70,output_tokens:5}}));
});servers.push(server);return new Promise<string>(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${(server.address() as any).port}/v1`)));};
const jevUrl=await systemOne('jev',req=>req.headers.authorization==='Bearer synthetic-jev-regression-credential');
let ndSeen:any;const notDiamond=createServer(async(req,res)=>{if(req.headers.authorization!=='Bearer synthetic-nd-test-credential'){res.writeHead(401).end();return;}if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{provider:'deepseek',model:'deepseek-flash'},{provider:'openai',model:'gpt-6-astra'}]}));return;}let text='';for await(const chunk of req)text+=chunk;ndSeen={url:req.url,body:JSON.parse(text)};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({providers:[{provider:'openai',model:'gpt-6-astra'}],session_id:'nd-session'}));});
servers.push(notDiamond);
const ndUrl=await new Promise<string>(resolve=>notDiamond.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${(notDiamond.address() as any).port}/v2`)));
const glideUrl=await systemOne('glide',req=>req.headers['x-api-key']==='synthetic-glide-test-credential'&&!req.headers.authorization);
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_JEV_URL:jevUrl,TRISMEGISTUS_TEST_GLIDE_URL:glideUrl,TRISMEGISTUS_TEST_NOTDIAMOND_URL:ndUrl,TRISMEGISTUS_TEST_GLINER_WORKER:path.join(root,'tests','fixtures','fake_gliner_worker.py'),TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(dline).url,TRISMEGISTUS_TEST_CODEX_URL:JSON.parse(gline).url};
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env,timeout:30000});
try{
 await instance.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
 const page=await instance.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(s:any)=>boolean)=>{const end=Date.now()+90000;while(Date.now()<end){const s=await call('state');if(predicate(s))return s;await page.waitForTimeout(150);}throw Error('Timed out: '+JSON.stringify((await call('state')).turns.slice(-2)));};
 const send=async(chatId:string,text:string)=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text});const s=await wait(s=>s.turns.some((t:any)=>t.id===id&&['completed','failed','interrupted','needs-model'].includes(t.status)));const turn=s.turns.find((t:any)=>t.id===id);assert.equal(turn.status,'completed',turn.error);return turn;};
 await wait(s=>s.backend==='ready'&&s.availableModels.includes('gpt-6-astra')&&s.availableModels.includes('deepseek-flash'));
 const chat=await call('addProject');await call('addModel',{chatId:chat,model:'gpt-6-astra'});
 await call('jevSave',{key:'synthetic-jev-regression-credential',summaryModel:'deepseek-flash',confidence:0.7,timeoutMs:3000});await wait(s=>s.jev.status==='Connected');

 let s=await call('state');assert.equal(s.decisionEngine.selected,'jev');
 assert.deepEqual(s.decisionEngine.pickers.map((row:any)=>row.id),['jev','kev','glide','gliner','notdiamond']);
 assert.deepEqual(s.decisionEngine.pickers.map((row:any)=>row.connected),[true,false,false,true,false]);
 let turn=await send(chat,'Pick a model for this.');assert.equal(turn.model,'gpt-6-astra');assert.equal(turn.routingUsage.engine,'jev');assert.equal(turn.routingUsage.pickerTokens,75);
 assert.equal(asked.filter(row=>row.who==='jev').length,1);
 console.log('PASS 3a-1 Jev picks through the shared picker record and records pickerTokens');

 await call('decisionEngine',{engine:'glide'});s=await call('state');assert.equal(s.decisionEngine.selected,'glide');assert.equal(s.decisionEngine.connected,false);
 turn=await send(chat,'And this one?');assert.equal(turn.routingUsage,undefined,'an unset picker falls back to the plain choice');assert.equal(turn.model,'gpt-6-astra','the last model answers');
 assert.equal(asked.length,1);
 if(!await page.getByRole('dialog',{name:'Settings'}).count())await page.locator('.settings-link').click();
 await page.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name:'Connections',exact:true}).click();
 const list=page.getByRole('list',{name:'Pickers',exact:true});await list.waitFor();
 assert.deepEqual(await list.locator('li strong').allInnerTexts(),['Jev · TypeSafe','Kev · Local','Fastino GLiDE','GLiNER2.5-Decide · Local','Not Diamond']);
 assert.match(await list.locator('li').filter({hasText:'Fastino GLiDE'}).innerText(),/Add key/);
 await fs.writeFile(path.join(data,'pickers.png'),Buffer.from(await instance.evaluate(async({BrowserWindow})=>Array.from((await BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG()))));
 await page.locator('summary[aria-label="Decision engine"]').click();await page.getByRole('radio',{name:'Jev · TypeSafe',exact:true}).click();await wait(s=>s.decisionEngine.selected==='jev');
 turn=await send(chat,'Back to Jev.');assert.equal(turn.routingUsage.engine,'jev');assert.equal(asked.length,2);
 console.log('PASS 3a-1 switching pickers routes through the chosen one; an unset picker uses the last model');

 const kevUrl=await systemOne('kev',req=>!req.headers.authorization);
 await assert.rejects(call('kevSave',{address:'http://localhost:8009/v1'}),/127\.0\.0\.1/);
 await call('kevSave',{address:kevUrl});await wait(s=>s.decisionEngine.pickers.find((row:any)=>row.id==='kev').status==='Connected');
 await call('decisionEngine',{engine:'kev'});turn=await send(chat,'Kev, pick one.');
 assert.equal(turn.routingUsage.engine,'kev');assert.equal(turn.model,'gpt-6-astra');assert.equal(asked.at(-1)!.who,'kev');assert.equal(typeof asked.at(-1)!.body.state,'string');
 await page.locator('.model-row > .jev').filter({hasText:'Kev'}).waitFor({state:'attached'});
 console.log('PASS 3a-2 Kev routes a turn through a local System One server with no key');

 await call('decisionEngine',{engine:'glide'});assert.equal((await call('state')).decisionEngine.pickers.find((row:any)=>row.id==='glide').status,'Add key');
 await call('pickerKeySave',{id:'glide',key:'synthetic-glide-test-credential'});await wait(s=>s.decisionEngine.connected);
 turn=await send(chat,'GLiDE, pick one.');assert.equal(turn.routingUsage.engine,'glide');assert.equal(turn.model,'gpt-6-astra');
 const glided=asked.at(-1)!;assert.equal(glided.who,'glide');assert.equal(glided.body.model,'fastino/GLiDE');assert.equal(typeof glided.body.questions.primary.criteria['gpt-6-astra'],'string');
 assert.ok((await call('state')).decisionEngine.pickers.find((row:any)=>row.id==='glide').connected);
 await page.locator('.model-row > .jev').filter({hasText:'GLiDE'}).waitFor({state:'attached'});
 console.log('PASS 3a-3 GLiDE routes a turn with its own key header and plain choice descriptions');

 await call('decisionEngine',{engine:'gliner'});s=await call('state');assert.equal(s.decisionEngine.connected,true,'the test stand-in counts as installed');
 turn=await send(chat,'GLiNER, pick one.');assert.equal(turn.routingUsage.engine,'gliner');assert.equal(turn.model,'gpt-6-astra');
 let asks=(await fs.readFile(path.join(data,'gliner.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(asks.length,1);
 assert.ok(asks[0].labels.some((label:string)=>label.startsWith('gpt-6-astra')||label.startsWith('GPT')));assert.equal(typeof asks[0].text,'string');assert.match(asks[0].text,/Recent routing outcomes:/);
 await call('modelSelection',{chatId:chat,model:'deepseek-flash',selected:true});turn=await send(chat,'My own pick.');assert.equal(turn.model,'deepseek-flash');assert.equal(turn.routingUsage,undefined);
 asks=(await fs.readFile(path.join(data,'gliner.jsonl'),'utf8')).trim().split('\n');assert.equal(asks.length,1,'his own pick needs no classification');
 await call('modelSelection',{chatId:chat,model:'deepseek-flash',selected:false});
 await page.locator('.model-row > .jev').filter({hasText:'GLiNER'}).waitFor({state:'attached'});
 console.log('PASS 3a-4 GLiNER picks through its worker; his own pick answers without asking it');

 await call('decisionEngine',{engine:'notdiamond'});await call('pickerKeySave',{id:'notdiamond',key:'synthetic-nd-test-credential'});await wait(s=>s.decisionEngine.connected);
 turn=await send(chat,'Not Diamond, pick one.');assert.equal(turn.routingUsage.engine,'notdiamond');assert.equal(turn.model,'gpt-6-astra');assert.doesNotMatch(turn.routeNotice,/confidence/);
 assert.equal(ndSeen.url,'/v2/modelRouter/modelSelect');assert.deepEqual(ndSeen.body.llm_providers.map((row:any)=>row.provider).sort(),['deepseek','openai']);assert.equal(ndSeen.body.messages[0].role,'user');assert.match(ndSeen.body.messages[0].content,/Recent routing outcomes:/);
 await page.locator('.model-row > .jev').filter({hasText:'Not Diamond'}).waitFor({state:'attached'});
 console.log('PASS 3a-5 Not Diamond picks from the chat\'s models in its own provider names, with its own key');

 await call('decisionEngine',{engine:'jev'});const learn=await call('addProject');await call('addModel',{chatId:learn,model:'gpt-6-astra'});
 const first=await send(learn,'LEARN_FIXTURE write the parser');assert.equal(first.model,'gpt-6-astra');
 await call('modelSelection',{chatId:learn,model:'deepseek-flash',selected:true});
 const second=await send(learn,'WRONG_FIXTURE that parser was wrong, try again');assert.equal(second.model,'deepseek-flash');
 await call('modelSelection',{chatId:learn,model:'deepseek-flash',selected:false});await send(learn,'LEARN_FIXTURE now the tests');
 const history=asked.at(-1)!.body.state.history;assert.equal(history.kind,'coding');
 assert.deepEqual(history.recent,[{model:'gpt-6-astra',outcome:'overridden'}]);
 assert.ok(history.models.some((row:any)=>row.model==='gpt-6-astra'&&row.turns===1&&row.accepted===0));
 console.log('PASS 3c an override and a correcting reply reach the next turn\'s picker state');
 await call('selectorModel',{chatId:learn,model:'deepseek-flash'});turn=await send(learn,'Select duty with the recorded outcomes.');assert.equal(turn.routingUsage.engine,'selector');
 const aux=(await fs.readFile(path.join(data,'aux.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 const selector=aux.findLast(row=>JSON.stringify(row).includes('You are on select duty')),selectedState=JSON.parse((selector.body||selector).messages.at(-1).content).state;
 assert.ok(selectedState.history.recent.some((row:any)=>row.outcome==='overridden'),'select duty receives override history');
 await page.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name:'Security',exact:true}).click();
 await page.locator('.rotation-list > li').filter({hasText:'Fastino GLiDE'}).getByRole('button',{name:'Replace key',exact:true}).click();await page.getByLabel('GLiDE API key',{exact:true}).waitFor();
 assert.equal((await call('state')).decisionEngine.selected,'jev','opening a replacement key does not change the active picker');
}finally{
 await instance.close().catch(()=>{});ds.stdin.end();ds.kill();gpt.kill();for(const server of servers){server.closeAllConnections();server.close();}
 for(const provider of ['deepseek','typesafe','fastino','notdiamond'])await host.host('delete_key',{provider}).catch(()=>{});
 const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');
}
