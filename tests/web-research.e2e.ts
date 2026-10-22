import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/web-research-')),calls:any[]=[],pageText='# Fixture documentation\nUse node --test to run tests.\n'+('Saved public text. '.repeat(1600))+'\nEND_OF_SOURCE';
let activeSlow=0;
const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const value=JSON.parse(raw),{name,arguments:args}=value.params;calls.push({name,args});
 const send=()=>{if(res.destroyed)return;const failed=args.query==='unavailable'||args.urls?.[0]?.endsWith('/missing');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:value.id,result:{isError:failed,content:[{type:'text',text:failed?'HTTP 429 · research unavailable':name==='web_search_exa'?'Title: Fixture documentation\nURL: https://93.184.216.34/docs\nHighlights:\nUse node --test.':pageText}]}}));};
 if(args.query==='slow'){activeSlow++;const timer=setTimeout(send,30000);res.on('close',()=>{clearTimeout(timer);activeSlow--;});}else send();
});server.listen(0,'127.0.0.1');await once(server,'listening');const webUrl='http://127.0.0.1:'+(server.address() as any).port;
const host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','inherit']}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_WEB_URL:webUrl,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const launch=async()=>{const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env});await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};});return app;};let app=await launch();
try{
 let page=await mainWindow(app);const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});await pollState(page,s=>s.backend==='ready'&&s.claude?.models?.some(m=>m.id==='claude-code:haiku')===true);await call('wizardFinish');const chatId=await call('newChat'),foreign=await call('newChat');await call('addModel',{chatId,model:'claude-code:haiku'});await call('mode',{projectId:(await call('state')).chats.find((c:any)=>c.id===chatId).projectId,mode:'plan'});
 const send=async(model:string,name:string,args:any,owner=chatId)=>{const id=crypto.randomUUID(),text=model.startsWith('claude')?JSON.stringify({action:'mcp',server:'ghidorah',tool:name,arguments:args,requiredTools:['search_web','read_web_page']}):'MCP_FIXTURE '+JSON.stringify({name,arguments:args});await call('submit',{id,chatId:owner,text,models:[model]});return id;};
 const done=async(id:string)=>{const state=await pollState(page,s=>s.turns.some(t=>t.id===id&&['completed','failed','interrupted'].includes(t.status)));const turn=state.turns.find(t=>t.id===id)!;assert.equal(turn.status,'completed',turn.error||turn.text);assert.equal(state.approvals.filter(a=>a.turnId===id&&a.status==='pending').length,0);return {state,turn,output:JSON.stringify(state.tools.filter(t=>t.turnId===id).map(t=>t.result))+turn.text};};
 for(const model of ['deepseek-flash','claude-code:haiku']){
  const search=await done(await send(model,'search_web',{query:'Node documentation',limit:2}));assert.match(search.output,/Fixture documentation/);assert.match(search.output,/93\.184\.216\.34/);
  const read=await done(await send(model,'read_web_page',{url:'https://93.184.216.34/docs',length:100}));assert.match(read.output,/untrusted/);assert.match(read.output,/node --test/);
 }
 const state=await call('state'),serialized=JSON.stringify(state.tools),match=/sourceId\\?":\\?"([0-9a-f-]{36})/.exec(serialized);assert.ok(match,'Source ID must be returned');const sourceId=match[1];
 const count=calls.length;const tail=await done(await send('deepseek-flash','read_web_page',{sourceId,offset:pageText.length-13}));assert.match(tail.output,/END_OF_SOURCE/);assert.equal(calls.length,count);
 const rejected=await done(await send('claude-code:haiku','read_web_page',{url:'http://127.0.0.1/private'}));assert.match(rejected.output,/private network/);assert.equal(calls.length,count);
 const unavailable=await done(await send('deepseek-flash','search_web',{query:'unavailable'}));assert.match(unavailable.output,/429/);await done(await send('deepseek-flash','search_web',{query:'recovered'}));
 await app.evaluate(({app})=>app.quit());await app.close();app=await launch();page=await mainWindow(app);await pollState(page,s=>s.backend==='ready');await call('claudeCheck');await pollState(page,s=>s.availableModels?.includes('claude-code:haiku')===true);
 const after=await done(await send('claude-code:haiku','read_web_page',{sourceId,offset:pageText.length-13}));assert.match(after.output,/END_OF_SOURCE/);
 await call('addModel',{chatId:foreign,model:'claude-code:haiku'});const refused=await done(await send('claude-code:haiku','read_web_page',{sourceId},foreign));assert.match(refused.output,/another chat/);
 for(const model of ['deepseek-flash','claude-code:haiku']){
  const id=await send(model,'search_web',{query:'slow'});for(let n=0;n<200&&!activeSlow;n++)await page.waitForTimeout(50);assert.ok(activeSlow);await call('stop',{chatId});await pollState(page,s=>s.turns.some(t=>t.id===id&&t.status==='stopped'));for(let n=0;n<100&&activeSlow;n++)await page.waitForTimeout(50);assert.equal(activeSlow,0,'Stop must close the provider request');
 }
 assert.equal((await call('state')).workReview.length,0);assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({bothEngines:true,noFolder:true,planMode:true,search:true,read:true,pagination:true,restart:true,ownership:true,privateUrlRefused:true,rateLimitRecovery:true,cancellation:true,hidden:true},null,2));console.log('PASS shared web research: '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});server.closeAllConnections();server.close();fake.stdin.end('\n');lines.close();await host.host('delete_key');}
