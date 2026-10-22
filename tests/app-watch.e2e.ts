import {_electron as electron} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import {saveApp} from '../app/saved-apps';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow} from './fixtures/poll-state';
// Update watch: suggest a watch list, check in the background, mark the icon, then start a chat from a ticked update.
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/app-watch-')),namespace='Trismegistus/Test/'+path.basename(data),host=new Backend(root,data,namespace,()=>{}),searches:string[]=[];
const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;await new Promise(done=>setTimeout(done,1500));const value=JSON.parse(raw),{arguments:args}=value.params;searches.push(args.query);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:value.id,result:{isError:false,content:[{type:'text',text:'Title: Fixture video model\nURL: https://93.184.216.34/model\nHighlights:\nOpen weights released.'}]}}));});
server.listen(0,'127.0.0.1');await once(server,'listening');
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const folder=await fs.mkdtemp(path.join(root,'work/app-watch-files-')),db=new Store(path.join(data,'chat.sqlite')),project=db.project(folder),chat=db.chat(project.id);
const useClaude=process.argv.includes('--claude'),model=useClaude?'claude-code:haiku':'deepseek-flash';
const saved=saveApp(db,{name:'Studio',current:'Video timeline editor.',chatIds:[chat.id]});db.put('app-watch',{id:saved.id,topics:'',sources:'',frequency:'off',model:'gpt-disconnected',nextRun:null,seen:0});db.db.close();
const fake=spawn(PYTHON,['tests/fake_provider.py'],{windowsHide:true,stdio:['pipe','pipe','inherit']}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_WEB_URL:'http://127.0.0.1:'+(server.address() as any).port,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env,timeout:30000});
await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};});
try{
 const page=await mainWindow(app);page.setDefaultTimeout(30000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(check:(s:any)=>boolean)=>{const until=Date.now()+120000;while(Date.now()<until){const s=await call('state');if(check(s))return s;await page.waitForTimeout(100);}throw Error('Watch check timed out: '+JSON.stringify((await call('state')).savedApps));};
 const entry=(s:any)=>s.savedApps.find((item:any)=>item.id===saved.id);
 await wait(s=>s.backend==='ready'&&s.availableModels.includes('deepseek-flash')&&s.availableModels.includes('claude-code:haiku'));if(await page.getByLabel('Close settings',{exact:true}).count())await page.getByLabel('Close settings',{exact:true}).click();
 await page.getByLabel('Show chats for Studio').click();
 const picker=page.getByLabel('Update model',{exact:true}),connected=(await call('state')).availableModels;
 assert.deepEqual(await picker.locator('option:not([disabled])').evaluateAll(options=>options.map(o=>(o as HTMLOptionElement).value)),connected);
 assert.equal(await picker.inputValue(),'');assert.equal(await picker.locator('option[value="gpt-disconnected"]').count(),0);
 assert.equal(await page.getByRole('button',{name:'Check now',exact:true}).isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'Suggest sources',exact:true}).isDisabled(),true);
 await assert.rejects(call('savedAppWatchSuggest',{id:saved.id}),/Choose an available update model/);
 await picker.selectOption(model);await wait(s=>entry(s).watch.model===model);
 // The brief stays in the user's words: suggesting sources never rewrites it, and it is what gets searched.
 const brief='new video models and vid2vid workflows';await page.getByLabel('What to look for',{exact:true}).fill(brief);await page.getByLabel('What to look for',{exact:true}).blur();await wait(s=>entry(s).watch.topics===brief);
 await page.getByRole('button',{name:'Suggest sources',exact:true}).click();await wait(s=>entry(s).watch.sources==='Two Minute Papers news');assert.equal(await page.getByLabel('What to look for',{exact:true}).inputValue(),brief);assert.equal(entry(await call('state')).watch.topics,brief);
 await page.getByLabel('Update check frequency',{exact:true}).selectOption('daily');assert.ok((await wait(s=>entry(s).watch.nextRun>Date.now())).savedApps);
 // A check finished while the user is elsewhere marks the app icon until its page is opened.
 await page.locator('[data-chat-id="'+chat.id+'"] .chat-link').click();
 // While checking, the icon dot pulses and the step is reported.
 const run=call('savedAppWatchRun',{id:saved.id});await wait(s=>entry(s).watch.step==='Reading sources…');await page.locator('[data-saved-app-id="'+saved.id+'"] .app-watch-dot.checking').waitFor();
 assert.equal(await run,1,'The unsourced idea must be dropped');await page.locator('.app-watch-dot.checking').waitFor({state:'detached'});
 let state=await wait(s=>entry(s).watchUnread);assert.deepEqual(searches,[brief]);assert.deepEqual(entry(state).watch.unchecked,['Two Minute Papers news']);assert.equal(entry(state).watch.step,undefined);
 await page.locator('[data-saved-app-id="'+saved.id+'"] .app-watch-dot').waitFor();
 await page.getByLabel('Show chats for Studio').click();await wait(s=>!entry(s).watchUnread);await page.locator('.app-watch-dot').waitFor({state:'detached'});
 const idea=entry(state).updates[0];assert.equal(idea.title,'Try Fixture video model');assert.deepEqual(idea.sources.map((s:any)=>s.url),['https://93.184.216.34/model']);
 await page.locator('.app-updates').scrollIntoViewIfNeeded();await page.waitForTimeout(200);
 await fs.writeFile(path.join(data,'updates.png'),Buffer.from(await app.evaluate(async({BrowserWindow})=>Array.from((await BrowserWindow.getAllWindows().find(w=>/index\.html$/.test(w.webContents.getURL()))!.webContents.capturePage()).toPNG()))));
 await page.getByLabel('Select update Try Fixture video model',{exact:true}).check();
 await page.getByRole('button',{name:'Start chat with 1 update',exact:true}).click();
 state=await wait(s=>entry(s).updates[0].status==='started'&&s.turns.some((t:any)=>t.chatId===entry(s).updates[0].chatId&&t.status==='completed'));
 const started=entry(state).updates[0],turn=state.turns.find((t:any)=>t.chatId===started.chatId);
 assert.match(turn.prompt,/^Review these updates for Studio/);assert.match(turn.prompt,/Wait for my GO/);assert.match(turn.prompt,/1\. Try Fixture video model \(small effort\)[\s\S]*Suggested update: Add it as a render backend\.[\s\S]*https:\/\/93\.184\.216\.34\/model/);
 assert.ok(entry(state).chatIds.includes(started.chatId),'The new chat is linked to the app');
 // An already reported source does not come back as a new idea.
 await page.getByLabel('Show chats for Studio').click();const again=call('savedAppWatchRun',{id:saved.id});await page.locator('.app-updates .app-watch-spinner').waitFor();await fs.writeFile(path.join(data,'checking.png'),await page.screenshot());assert.equal(await again,0);await page.locator('.app-watch-spinner').waitFor({state:'detached'});assert.equal(entry(await call('state')).updates.length,1);
 if(useClaude){
  const requests=(await fs.readFile(path.join(data,'context-requests.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(requests.length,4,'Sources, queries, ideas and repeat queries use Claude');
  for(const request of requests){assert.equal(request.args[request.args.indexOf('--model')+1],'haiku');assert.equal(request.args[request.args.indexOf('--tools')+1],'');assert.ok(request.args.includes('--strict-mcp-config'));}
 }
 assert.deepEqual(errors,[]);assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 console.log('app watch verified',model,data);
}catch(error){console.log(data);throw error;}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});server.close();fake.stdin.end('\n');lines.close();await host.host('delete_key');execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true});}
