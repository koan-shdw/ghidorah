// Settings › Subscriptions on a test copy: the fake model, the stand-in Claude and a stand-in ElevenLabs on this
// computer. It checks the command the page reads, the rows and the foot of the page, a typed price moving a row from
// "paid, amount unknown" to confirmed, and the month's tokens per app. No real service is called and no link opened.
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState,wakeWindows} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work','subscriptions-')),folder=await fs.mkdtemp(path.join(root,'work','workspace-subscriptions-')),namespace='Trismegistus/Test/'+path.basename(data);
await fs.writeFile(path.join(data,'health.json'),JSON.stringify({claude:'ready'}));
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{windowsHide:true,stdio:'pipe',env:{...process.env,FIXTURE_RECORDS:path.join(data,'provider-requests.jsonl')}}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
// ElevenLabs: the key check's socket and the account answer, both on one port of this computer.
const asked:string[]=[],eleven=http.createServer((request,response)=>{
 asked.push(request.method+' '+request.url+' '+request.headers['xi-api-key']);
 if(request.url!=='/v1/user/subscription'||request.headers['xi-api-key']!=='synthetic-eleven'){response.writeHead(401).end();return;}
 response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({tier:'starter',character_count:3700,character_limit:10000,status:'active',next_character_count_reset_unix:Math.floor(Date.now()/1000)+86400*9,currency:'usd',billing_period:'monthly_period',next_invoice:{amount_due_cents:600}}));
}),sockets=new WebSocketServer({noServer:true});
eleven.on('upgrade',(request,socket,head)=>{if(request.headers['xi-api-key']!=='synthetic-eleven'){socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');socket.destroy();return;}sockets.handleUpgrade(request,socket,head,ws=>ws.send(JSON.stringify({message_type:'session_started',session_id:'s1'})));});
eleven.listen(0,'127.0.0.1');await once(eleven,'listening');const port=(eleven.address() as any).port;
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden','--disable-gpu']:[root,'--hidden','--disable-gpu'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath,TRISMEGISTUS_TEST_ELEVENLABS_WS:'ws://127.0.0.1:'+port,TRISMEGISTUS_TEST_ELEVENLABS_API:'http://127.0.0.1:'+port},timeout:60000});
try{
 const page=await mainWindow(app);await wakeWindows(app);page.setDefaultTimeout(20000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].setBounds({x:0,y:0,width:1280,height:940});});
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const click=(locator:any)=>locator.first().evaluate((element:HTMLElement)=>element.click());
 await pollState(page,s=>s.backend==='ready'&&!!s.claude?.connected&&!!s.claude.models?.length&&!!s.availableModels?.includes('deepseek-flash'));await call('wizardFinish');await call('claudeCheck');await call('workingFolder',{folder});
 const chatId=await call('addProject',{folder}) as string;await call('addModel',{chatId,model:'claude-code:haiku'});
 const done=(id:string)=>pollState(page,s=>s.turns.find(t=>t.id===id)?.status==='completed',60000);
 const first=crypto.randomUUID();await call('submit',{id:first,chatId,text:'Say hello in one line.',selected:true});await done(first);
 const second=crypto.randomUUID();await call('submit',{id:second,chatId,text:JSON.stringify({action:'reply'}),models:['claude-code:haiku']});await done(second);
 await call('listeningKey',{engine:'elevenlabs',key:'synthetic-eleven'});

 // The command the page reads.
 const month=new Date().getFullYear()+'-'+String(new Date().getMonth()+1).padStart(2,'0');
 let view=await call('subscriptions',{});
 assert.equal(view.month,month);assert.deepEqual(view.months,[month]);assert.deepEqual(view.prices,{});assert.equal(view.elevenlabsNote,'');
 assert.equal(view.elevenlabs.tier,'starter');assert.deepEqual(view.elevenlabs.invoice,{amount:6,currency:'usd',months:1});
 assert.ok(view.usage.tokens>0,'the two replies were counted');assert.ok(view.usage.models['deepseek-flash']>0);assert.equal(view.usage.unlinked.tokens,view.usage.tokens,'no app links this chat');
 assert.equal(view.titles[chatId].length>0,true);
 const before=asked.filter(row=>row.startsWith('GET /v1/user/subscription')).length;await call('subscriptions',{});assert.equal(asked.filter(row=>row.startsWith('GET /v1/user/subscription')).length,before,'the account is not asked for again within ten minutes');
 await call('subscriptions',{fresh:true});assert.equal(asked.filter(row=>row.startsWith('GET /v1/user/subscription')).length,before+1,'a fresh read asks again');
 assert.deepEqual(await call('subscriptionPrice',{id:'chatgpt',usd:20.004}),{chatgpt:20});assert.deepEqual(await call('subscriptionPrice',{id:'chatgpt',usd:null}),{});
 await assert.rejects(call('subscriptionPrice',{id:'claude',usd:-1}),/as a number/);await assert.rejects(call('subscriptionPrice',{id:'../x',usd:1}),/Unknown subscription/);
 await assert.rejects(call('link',{kind:'sub:nothing:0'}),/Unknown link/);await assert.rejects(call('link',{kind:'toString'}),/Unknown link/);
 console.log('PASS the subscriptions command: month sums, the ElevenLabs account read once, typed prices saved and refused');

 // The page.
 if(await page.getByLabel('Close settings',{exact:true}).count())await click(page.getByLabel('Close settings',{exact:true}));
 await click(page.locator('.rail-settings'));const dialog=page.getByRole('dialog',{name:'Settings',exact:true});
 await click(dialog.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name:'Subscriptions',exact:true}));
 const body=page.locator('[data-settings-page="subscriptions"] .settings-body');await body.locator('.sub-row').first().waitFor();await body.locator('.sub-usage').waitFor();
 const names=await body.locator('.sub-row .sub-name strong').allInnerTexts();assert.deepEqual(names,['Claude Code','ElevenLabs','DeepSeek']);
 const row=(name:string)=>body.locator('.sub-row').filter({has:page.locator('.sub-name strong',{hasText:name})});
 assert.match(await row('ElevenLabs').locator('summary').innerText(),/Starter[\s\S]*63% left[\s\S]*3\.7K credits[\s\S]*\$6\.00/);
 assert.match(await row('DeepSeek').locator('summary').innerText(),/Prepaid[\s\S]*tok[\s\S]*Paid/);
 assert.match(await row('Claude Code').locator('summary').innerText(),/% left[\s\S]*tok[\s\S]*Paid/);
 const foot=()=>body.locator('.sub-totals').innerText();
 assert.match(await foot(),/Confirmed\s*\$6\.00[\s\S]*Estimated\s*\$0\.00[\s\S]*2\s*paid, amount unknown[\s\S]*A month\s*\$6\.00/);
 assert.equal(await body.locator('.sub-look li').count(),2,'the two paid rows with no figure');
 await click(body.locator('.sub-look .link-button').first());assert.equal(await row('Claude Code').evaluate((element:HTMLDetailsElement)=>element.open),true,'Show opens the row');
 await row('Claude Code').getByLabel('Monthly price of Claude Code',{exact:true}).fill('120');
 await page.waitForFunction(()=>/Confirmed\s*\$126\.00/.test(document.querySelector('.sub-totals')?.textContent||''));
 assert.match(await foot(),/1\s*paid, amount unknown[\s\S]*A month\s*\$126\.00/);assert.match(await row('Claude Code').locator('summary').innerText(),/\$120\.00/);
 assert.deepEqual((await call('subscriptions',{})).prices,{claude:120});
 await row('Claude Code').getByLabel('Monthly price of Claude Code',{exact:true}).fill('');
 await page.waitForFunction(()=>/Confirmed\s*\$6\.00/.test(document.querySelector('.sub-totals')?.textContent||''));
 assert.match(await body.locator('.sub-usage').innerText(),/Where it went[\s\S]*tokens[\s\S]*All models[\s\S]*No app[\s\S]*of the month/);
 await click(body.locator('.sub-legend button').nth(1));assert.match(await body.locator('.sub-app .sub-share').first().innerText(),/% of /);
 await row('Claude Code').getByLabel('Monthly price of Claude Code',{exact:true}).fill('120');await page.waitForFunction(()=>/Confirmed\s*\$126\.00/.test(document.querySelector('.sub-totals')?.textContent||''));
 const shot=async(file:string)=>{const png=await app.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!;await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await new Promise(r=>setTimeout(r,300));return (await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64');});await fs.writeFile(file,Buffer.from(png,'base64'));};
 await fs.mkdir(path.join(root,'work','subscriptions-shots'),{recursive:true});await shot(path.join(root,'work','subscriptions-shots','page.png'));
 await body.evaluate((element:HTMLElement)=>{element.scrollTop=element.scrollHeight;});await page.waitForTimeout(300);await shot(path.join(root,'work','subscriptions-shots','page-end.png'));
 assert.deepEqual(errors,[]);
 console.log('PASS the Subscriptions page: rows, what needs a look, a typed price confirming a row, totals, the month per app and model');
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end('\n');lines.close();eleven.close();await fs.rm(folder,{recursive:true,force:true});await host.host('delete_key').catch(()=>{});await host.host('delete_key',{provider:'elevenlabs'}).catch(()=>{});execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});}
