// Send now takes the path Stop already has, with the reason "superseded-by-message". This proves that path on both
// engines for a message sent while a reply runs: the check says it can be pushed, the reply stops and keeps its text
// and reads "Stopped for your new message", and the waiting message is answered by itself.
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {Backend,PYTHON} from '../app/backend';
import {sendNowCheck} from '../app/send-now';
import {mainWindow,pollState,wakeWindows} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work','send-now-')),folder=await fs.mkdtemp(path.join(root,'work','workspace-send-now-')),namespace='Trismegistus/Test/'+path.basename(data);
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{windowsHide:true,stdio:'pipe',env:{...process.env,FIXTURE_RECORDS:path.join(data,'provider-requests.jsonl')}}),lines=createInterface({input:fake.stdout}),[line]=await once(lines,'line');
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden','--disable-gpu']:[root,'--hidden','--disable-gpu'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath}});
try{
 const page=await mainWindow(app),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&!!s.availableModels?.includes('deepseek-flash')&&!!s.claude?.models?.length);await call('workingFolder',{folder});
 async function pushed(engine:string,chatId:string,send:(text:string)=>Promise<string>,slow:string,next:string,keepsText=true){
  const first=await send(slow);await pollState(page,s=>(s.turns.find(t=>t.id===first)?.text||'').length>20,60000);
  const second=await send(next);
  let state=await pollState(page,s=>{const row=s.turns.find(t=>t.id===second);return !!row&&(row.delivery==='sent'||row.status==='queued');},30000);
  const rows=state.turns.filter(t=>t.chatId===chatId),waiting=rows.find(t=>t.id===second)!;
  assert.deepEqual(sendNowCheck(waiting,rows,first),{ok:true},engine+': a message the reply has not read can be pushed');
  assert.equal(sendNowCheck(rows.find(t=>t.id===first)!,rows,first).ok,false,engine+': the running reply itself cannot');
  await call('stop',{chatId,reason:'superseded-by-message'});
  state=await pollState(page,s=>s.turns.find(t=>t.id===first)?.status==='stopped'&&['completed','failed','interrupted','stopped','needs-model'].includes(s.turns.find(t=>t.id===second)?.status||''),90000);
  const stopped=state.turns.find(t=>t.id===first)!,answered=state.turns.find(t=>t.id===second)!;
  assert.equal(stopped.stopReason,'superseded-by-message',engine);
  // The stand-in Claude ends an interrupted reply with the one word "Interrupted", which takes the place of what it
  // streamed; the real one leaves the streamed text in place.
  if(keepsText)assert.ok(stopped.text.length>20,engine+': the stopped reply keeps its text: '+JSON.stringify(stopped.text.slice(0,60)));
  assert.equal(answered.status,'completed',engine+': the waiting message is answered by itself: '+JSON.stringify({status:answered.status,error:answered.error,answeredIn:answered.answeredIn}));
  assert.ok(answered.text.trim().length>0,engine+': and has its own reply');assert.equal(answered.answeredIn,undefined,engine);
  assert.equal(sendNowCheck(answered,state.turns.filter(t=>t.chatId===chatId),null).ok,false,engine+': nothing left to push');
  console.log('PASS '+engine+': the reply stopped for the new message and the waiting message was answered');
 }
 const hermes=await call('addProject',{folder}) as string,project=(await call('state')).chats.find((c:any)=>c.id===hermes).projectId;await call('mode',{projectId:project,mode:'bypass'});
 await pushed('Hermes',hermes,async text=>{const id=crypto.randomUUID();await call('submit',{id,chatId:hermes,text,selected:true});return id;},'SLOW_FIXTURE stream a long answer','Say one more line after that.');
 await page.locator('[data-chat-id="'+hermes+'"] .chat-link').evaluate((element:HTMLElement)=>element.click());
 await page.getByText('Stopped for your new message',{exact:false}).first().waitFor({state:'attached',timeout:15000});
 console.log('PASS the stopped reply reads "Stopped for your new message" in the chat');
 const claude=await call('addProject',{folder}) as string;await call('addModel',{chatId:claude,model:'claude-code:haiku'});
 await pushed('Claude Code',claude,async text=>{const id=crypto.randomUUID();await call('submit',{id,chatId:claude,text,models:['claude-code:haiku']});return id;},JSON.stringify({action:'slow',repeat:400}),JSON.stringify({action:'reply'}),false);

 // The buttons. A message sent while a reply runs is drawn as waiting, with Send now and its remove button inside it.
 await wakeWindows(app);page.setDefaultTimeout(20000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].setBounds({x:0,y:0,width:1280,height:900});});
 const click=(locator:any)=>locator.first().evaluate((element:HTMLElement)=>element.click());
 const shot=async(name:string)=>{const png=await app.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!;await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await new Promise(r=>setTimeout(r,300));return (await w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64');});await fs.mkdir(path.join(root,'work','send-now-shots'),{recursive:true});await fs.writeFile(path.join(root,'work','send-now-shots',name+'.png'),Buffer.from(png,'base64'));};
 if(await page.getByLabel('Close settings',{exact:true}).count())await click(page.getByLabel('Close settings',{exact:true}));
 await click(page.locator('[data-chat-id="'+hermes+'"] .chat-link'));
 const main=page.getByRole('region',{name:'Main chat',exact:true}),box=main.getByLabel('Message',{exact:true}),send=async(text:string)=>{const id=crypto.randomUUID();await call('submit',{id,chatId:hermes,text,selected:true});return id;};
 const status=async(id:string)=>(await call('state')).turns.find((t:any)=>t.id===id);
 let slow=await send('SLOW_FIXTURE stream a long answer');await pollState(page,s=>(s.turns.find(t=>t.id===slow)?.text||'').length>20,60000);
 let next=await send('Then say one line.');await main.locator('.user-message.waiting').waitFor();
 const bubble=main.locator('.user-message.waiting');assert.match(await bubble.innerText(),/Then say one line\.[\s\S]*Waits its turn[\s\S]*Send now/);
 assert.equal(await bubble.getByRole('button',{name:'Cancel queued message',exact:true}).count(),1);
 assert.equal(await main.locator('article.turn',{has:page.locator('.user-message.waiting')}).locator('.model-label').count(),0,'a waiting message has no status line of its own');
 await box.fill('A draft while it works');assert.match(await main.locator('.correction-option').innerText(),/Enter waits its turn\. Ctrl\+Enter sends now\./);
 assert.equal(await main.locator('.composer-toolbar').getByRole('button',{name:'Send now',exact:true}).count(),1);await shot('waiting-and-draft');await box.fill('');
 await assert.rejects(call('sendNow',{chatId:hermes,id:slow}),/being answered now/);await assert.rejects(call('sendNow',{chatId:claude,id:next}),/another chat/);
 await click(bubble.getByRole('button',{name:'Send now',exact:true}));
 await pollState(page,s=>s.turns.find(t=>t.id===slow)?.status==='stopped'&&s.turns.find(t=>t.id===next)?.status==='completed',90000);
 assert.equal((await status(slow)).stopReason,'superseded-by-message');await assert.rejects(call('sendNow',{chatId:hermes,id:next}),/not waiting/);
 await page.waitForFunction(()=>!document.querySelector('.user-message.waiting'));
 console.log('PASS Send now on the waiting message stops the reply and the message is answered');

 // Ctrl+Enter with the switch off: the draft stops the reply and goes.
 slow=await send('SLOW_FIXTURE stream a long answer');await pollState(page,s=>(s.turns.find(t=>t.id===slow)?.text||'').length>20,60000);
 await box.fill('Pushed with the key');await box.press('Control+Enter');
 let state=await pollState(page,s=>s.turns.find(t=>t.id===slow)?.status==='stopped'&&s.turns.some(t=>t.chatId===hermes&&t.prompt==='Pushed with the key'&&t.status==='completed'),90000);
 assert.equal(state.turns.find(t=>t.id===slow)!.stopReason,'superseded-by-message');
 console.log('PASS Ctrl+Enter sends a draft now');

 // The chat bar's switch: on, Enter stops the reply and sends, and the button beside the arrow offers the wait.
 const toggle=main.getByRole('button',{name:'Send now',exact:true}).and(main.locator('.kit-switch'));assert.equal(await toggle.getAttribute('aria-pressed'),'false');
 await click(toggle);await pollState(page,s=>s.chats.find(c=>c.id===hermes)?.sendNow===true);
 // The state answers before the window draws: wait for the switch itself.
 await page.waitForFunction(()=>document.querySelector('[aria-label="Main chat"] .kit-switch[aria-label="Send now"]')?.getAttribute('aria-pressed')==='true');
 slow=await send('SLOW_FIXTURE stream a long answer');await pollState(page,s=>(s.turns.find(t=>t.id===slow)?.text||'').length>20,60000);
 await box.fill('Enter sends this now');assert.match(await main.locator('.correction-option').innerText(),/Enter stops the reply and sends now\. Ctrl\+Enter waits its turn\./);
 assert.equal(await main.locator('.composer-toolbar').getByRole('button',{name:'Wait its turn',exact:true}).count(),1);await shot('switch-on-draft');
 await box.press('Enter');
 state=await pollState(page,s=>s.turns.find(t=>t.id===slow)?.status==='stopped'&&s.turns.some(t=>t.chatId===hermes&&t.prompt==='Enter sends this now'&&t.status==='completed'),90000);
 assert.equal(state.turns.find(t=>t.id===slow)!.stopReason,'superseded-by-message');
 slow=await send('SLOW_FIXTURE stream a long answer');await pollState(page,s=>(s.turns.find(t=>t.id===slow)?.text||'').length>20,60000);
 await box.fill('This one waits');await box.press('Control+Enter');
 state=await pollState(page,s=>s.turns.some(t=>t.chatId===hermes&&t.prompt==='This one waits'&&(t.delivery==='sent'||t.status==='queued')),30000);
 assert.equal(state.turns.find(t=>t.id===slow)!.status,'running','with the switch on, Ctrl+Enter leaves the reply running');
 await call('stop',{chatId:hermes});await pollState(page,s=>!s.turns.some(t=>t.chatId===hermes&&['running','queued','dispatching','waiting','stopping'].includes(t.status)),90000);
 console.log('PASS the chat bar switch turns Enter into Send now, and Ctrl+Enter into the wait');

 // The start value for chats that have not set their own.
 assert.equal((await call('state')).sendNowDefault,false);await call('sendNowDefault',{enabled:true});await assert.rejects(call('sendNowDefault',{enabled:'yes'}),/on or off/);
 const fresh=await call('addProject',{folder}) as string;await click(page.locator('[data-chat-id="'+fresh+'"] .chat-link'));
 await page.waitForFunction(()=>document.querySelector('[aria-label="Main chat"] .kit-switch[aria-label="Send now"]')?.getAttribute('aria-pressed')==='true');
 await call('contextSettings',{chatId:fresh,sendNow:false});await page.waitForFunction(()=>document.querySelector('[aria-label="Main chat"] .kit-switch[aria-label="Send now"]')?.getAttribute('aria-pressed')==='false');
 await call('sendNowDefault',{enabled:false});assert.deepEqual(errors,[]);
 console.log('PASS a new chat starts with the Send now value from Settings, and keeps its own once set');
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end('\n');lines.close();await fs.rm(folder,{recursive:true,force:true});await host.host('delete_key').catch(()=>{});execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});}
