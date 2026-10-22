import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {fakeTelegram} from './fixtures/fake-telegram';
import {createServer} from 'node:http';
import os from 'node:os';
import {hotp,fromBase32} from '../app/remote-code';
import {DatabaseSync} from 'node:sqlite';
import {mainWindow} from './fixtures/poll-state';

// Finish plan section 6 in the desktop, through fakes: Remote's gateway supervision (6a), the gate and dispatch (6b), Telegram commands, alerts and no waiting on a model choice (6c), the code before risky actions (6d), routines (6e).
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','finish-6-')),namespace='Trismegistus/Test/'+path.basename(data);
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const ds=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'deepseek.jsonl')},windowsHide:true,stdio:'pipe'}),[dline]=await once(createInterface({input:ds.stdout}),'line');
// A fake Telegram Bot API stands in for api.telegram.org; the owner is user 4242.
const telegram=await fakeTelegram(),OWNER=4242;
const env:Record<string,string>={...process.env as Record<string,string>,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(dline).url,TRISMEGISTUS_TEST_TELEGRAM_URL:telegram.baseUrl};
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
const launch=async()=>{const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env,timeout:30000});await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});return app;};
let instance=await launch();
const screenshot=async(name:string)=>fs.writeFile(path.join(data,name),Buffer.from(await instance.evaluate(async({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(w=>/index\.html$/.test(w.webContents.getURL()))!;return (await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG();})));
try{
 let page=await mainWindow(instance);
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(s:any)=>boolean,timeout=90000)=>{const end=Date.now()+timeout;while(Date.now()<end){const s=await call('state');if(predicate(s))return s;await page.waitForTimeout(250);}throw Error('Timed out: '+JSON.stringify((await call('state')).remote));};
 await wait(s=>s.backend==='ready');
 if(await page.getByRole('button',{name:'Close settings',exact:true}).count())await page.getByRole('button',{name:'Close settings',exact:true}).click();
 let s=await call('state');
 assert.deepEqual([s.remote.enabled,s.remote.status,s.alwaysOn.awake],[false,'off',false],'a fresh profile starts no gateway and keeps nothing awake');
 await assert.rejects(call('remoteSwitch',{on:true}),/user ID/);
 await assert.rejects(call('remoteSave',{token:'not a token'}),/BotFather/);
 await call('remoteSave',{token:'123456789:AAEsyntheticTelegramTokenForTests_0123456789',owner:String(OWNER)});
 s=await call('state');assert.deepEqual([s.remote.tokenSaved,s.remote.owner],[true,String(OWNER)]);assert.equal(JSON.stringify(s).includes('AAEsynthetic'),false,'the token never comes back to the window');
 await assert.rejects(call('remoteSwitch',{on:true}),/Install Telegram support/);
 // Telegram's package installs into this profile's runtime folder from PyPI (section 4 lists it).
 await page.locator('.settings-link').click();await page.getByRole('button',{name:'Remote',exact:true}).click();
 await page.getByRole('button',{name:'Install Telegram support',exact:true}).click();
 await wait(s=>s.remote.installing||s.remote.installed);s=await wait(s=>!s.remote.installing,660000);
 assert.equal(s.remote.installed,true,await page.locator('.remote-settings [role=alert]').textContent().catch(()=>'')||'install did not finish');
 await page.getByRole('switch',{name:'Remote',exact:true}).click();
 s=await wait(s=>s.remote.status==='running',180000);
 assert.equal(s.alwaysOn.awake,true,'stay awake follows Remote (1e)');assert.ok(telegram.calls.includes('getme')&&telegram.calls.includes('getupdates'),'the gateway reached the fake Telegram only');
 await screenshot('remote.png');
 // 6b: the owner's message becomes one turn through the normal dispatcher and the reply comes back named by its
 // model. A repeated delivery makes no second turn; a stranger and a group get nothing.
 const toOwner=()=>telegram.sent.filter(message=>message.chat_id===String(OWNER)).map(message=>String(message.text));
 let replyCursor=0;
 const replied=async(pattern:RegExp,timeout=120000)=>{const end=Date.now()+timeout;while(Date.now()<end){const rows=toOwner(),index=rows.findIndex((text,i)=>i>=replyCursor&&pattern.test(text));if(index>=0){replyCursor=index+1;return rows[index];}await page.waitForTimeout(200);}throw Error('No new Telegram reply like '+pattern+': '+JSON.stringify(toOwner().slice(replyCursor)));};
 telegram.message(OWNER,'/start connection-proof');await replied(/^\/help:/);assert.equal((await call('state')).turns.length,0,'Start is onboarding, not a model task');
 telegram.message(OWNER,'/new');await replied(/^New chat\. Messages go there now\.$/);
 s=await call('state');const remoteChat=s.remote.chatId;await call('draft',{chatId:remoteChat,text:'Unsent desktop draft'});
 telegram.message(OWNER,'Reply with the word remote.');await replied(/^Sent to /);
 s=await wait(s=>s.turns.some((turn:any)=>turn.remote&&turn.status==='completed'),120000);
 assert.equal(s.chats.find((chat:any)=>chat.id===remoteChat).draft,'Unsent desktop draft');
 const remoteTurn=s.turns.find((turn:any)=>turn.remote);assert.match(remoteTurn.id,/^telegram-4242-\d+$/);
 assert.equal(remoteTurn.remote.fallback,true,'a first remote message can choose an available model without desktop input');
 assert.equal(await replied(/\n\nDeepSeek\n/),remoteTurn.text.trim()+'\n\nDeepSeek\nThe picker was unsure; an available model answered.','the reply names the model and discloses fallback');
 const before=telegram.sent.length;telegram.repeat();telegram.message(9999,'stranger');telegram.message(OWNER,'group message',-100123);
 await page.waitForTimeout(4000);s=await call('state');
 assert.equal(s.turns.filter((turn:any)=>turn.remote).length,1,'a repeated delivery makes one turn');
 assert.deepEqual(telegram.sent.slice(before),[],'the repeat, the stranger and the group get no answer');
 assert.equal(s.turns.some((turn:any)=>/stranger|group message/.test(turn.prompt)),false);
 console.log('PASS 6b gate: the owner\'s message runs as one turn and its reply comes back; repeats, strangers and groups get nothing');
 // 6c: /project lists and switches chats; refused commands stay refused; a paused Remote blocks tasks but still
 // alerts; an unsure picker never makes a Telegram message wait; replies arrive with the window closed.
 telegram.message(OWNER,'/project');assert.match(await replied(/^1\. /),/^1\. .+\(current\)/m);
 telegram.message(OWNER,'/project 1');await replied(/^Messages go to .+ now\.$/);
 const turnsBefore=(await call('state')).turns.length;
 telegram.message(OWNER,'/yolo');await replied(/^That command is not available from Telegram\.$/);
 telegram.message(OWNER,'/pause');await replied(/paused\. Send \/pause off/);
 telegram.message(OWNER,'Blocked while paused.');await replied(/^Remote messages are paused/);
 telegram.message(OWNER,'/pause off');await replied(/^Remote messages resume\.$/);
 s=await call('state');assert.equal(s.turns.length,turnsBefore,'refused and paused messages start nothing');
 assert.ok(s.remote.alerts.some((alert:any)=>alert.title==='Remote task'&&alert.body==='Blocked while paused.'),'a blocked task still gets its desktop alert');
 // A local picker that is never sure: the chat's last model answers instead of waiting for a choice at the desktop.
 const unsure=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url?.endsWith('/models')){res.end(JSON.stringify({models:[{name:'kev-latest'}]}));return;}
  let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);
  res.end(JSON.stringify({model:'kev',answers:Object.fromEntries(Object.entries(body.questions).map(([name,question]:[string,any])=>[name,{type:'choice',choice:Object.keys(question.criteria)[0],confidence:0.05}])),usage:{input_tokens:10,output_tokens:2}}));
 });
 const unsureUrl=await new Promise<string>(resolve=>unsure.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+(unsure.address() as any).port+'/v1')));
 try{
  await call('kevSave',{address:unsureUrl});await wait(s=>s.decisionEngine.pickers.find((row:any)=>row.id==='kev').status==='Connected');await call('decisionEngine',{engine:'kev'});
  // The main window closes to the tray; the reply still arrives.
  await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>!window.webContents.getURL().includes('#'))!.close());
  telegram.message(OWNER,'Answer even though the picker is unsure.');
  const answer=await replied(/The picker was unsure; an available model answered\.$/,180000);
  s=await call('state');const unsureTurn=s.turns.filter((turn:any)=>turn.remote).at(-1);
  assert.equal(unsureTurn.status,'completed');assert.equal(unsureTurn.model,'deepseek-flash');assert.ok(answer.startsWith(unsureTurn.text.trim()));
  assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(window=>window.isVisible())),false,'the window stayed closed');
 }finally{await call('decisionEngine',{engine:'jev'}).catch(()=>{});unsure.close();}
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
 console.log('PASS 6c Telegram: /project switches chats, /yolo is refused, pause blocks with an alert, an unsure picker never makes a message wait, and replies arrive with the window closed');
 // 6d: every approval a remote turn raises needs a fresh code from the paired authenticator. Wrong codes, a replayed
 // code and a code used before a restart are refused; Deny refuses; the secrets list is refused, never offered.
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'tris-remote-'));await call('workingFolder',{folder:workspace});
 telegram.message(OWNER,'COMMAND_FIXTURE before pairing');await replied(/^An approval is waiting on the desktop\./);
 s=await call('state');const waitingTurn=s.turns.filter((turn:any)=>turn.remote).at(-1);
 await call('approve',{id:s.approvals.find((row:any)=>row.turnId===waitingTurn.id&&row.status==='pending').id,choice:'deny'});
 const attempts=await Promise.allSettled([call('remotePair'),call('remotePair')]);
 assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1,'overlapping pairing requests cannot race vault writes');
 const rejected=attempts.find(result=>result.status==='rejected') as PromiseRejectedResult;assert.match(String(rejected.reason),/Wait for Remote account or authenticator changes/);
 const pairing=(attempts.find(result=>result.status==='fulfilled') as PromiseFulfilledResult<any>).value;assert.match(pairing.uri,/^otpauth:\/\/hotp\/Ghidorah:Remote\?secret=[A-Z2-7]{32}&/);assert.match(pairing.qr,/^data:image\/png;base64,/);
 s=await call('state');assert.equal(s.remote.paired,true);assert.equal(JSON.stringify(s).includes(pairing.secret),false,'the key is not in the snapshot');
 const code=(counter:number)=>hotp(fromBase32(pairing.secret),counter);
 const lookAhead=new Set([0,1,2,3,4,5,6,7,8,9].map(code));let wrong='000000';while(lookAhead.has(wrong))wrong=String(Number(wrong)+1).padStart(6,'0');
 const approval=async(text:string)=>{const count=telegram.sent.filter(message=>message.reply_markup).length;telegram.message(OWNER,text);const end=Date.now()+120000;while(Date.now()<end){const shown=telegram.sent.filter(message=>message.reply_markup);if(shown.length>count){const row=shown.at(-1),db=new DatabaseSync(path.join(data,'chat.sqlite'),{readOnly:true});try{const saved:any=db.prepare("SELECT data FROM records WHERE kind='settings' AND id='remote-shown'").get();if(saved&&JSON.parse(saved.data).messageId===String(row.message_id))return row;}finally{db.close();}}await page.waitForTimeout(200);}throw Error('No approval was shown for '+text);};
 let shown=await approval('COMMAND_FIXTURE first');assert.match(shown.text,/^Approval needed:\n/);assert.match(shown.text,/echo command-through-hermes/);assert.match(String(shown.reply_markup),/Deny/,'Deny is a button that sends the word');
 telegram.message(OWNER,wrong,OWNER,shown.message_id);await replied(/^That code is not right\.$/);
 telegram.message(OWNER,code(0),OWNER,shown.message_id);await replied(/^Approved\.$/);await replied(/^The tool finished\. Result saved\.\n\nDeepSeek$/);
 s=await call('state');const executed=s.turns.find((turn:any)=>turn.prompt==='COMMAND_FIXTURE first');
 assert.ok(s.tools.some((tool:any)=>tool.turnId===executed.id&&tool.status==='completed'&&JSON.stringify(tool.result).includes('command-through-hermes')),'the approved command actually ran');
 shown=await approval('COMMAND_FIXTURE second');
 telegram.message(OWNER,code(0),OWNER,shown.message_id);await replied(/^That code is not right\.$/);
 telegram.message(OWNER,code(1),OWNER,shown.message_id);await replied(/^Approved\.$/);
 shown=await approval('COMMAND_FIXTURE third');telegram.message(OWNER,'Deny',OWNER,shown.message_id);await replied(/^Denied\.$/);
 const oldShown=shown;shown=await approval('COMMAND_FIXTURE replacement');
 telegram.message(OWNER,code(2),OWNER,oldShown.message_id);await replied(/^Reply to the current approval message/);
 s=await call('state');assert.ok(s.approvals.some((row:any)=>row.status==='pending'));
 telegram.message(OWNER,'Deny',OWNER,shown.message_id);await replied(/^Denied\.$/);
 telegram.message(OWNER,'SECRET_FIXTURE read it');await replied(/^Refused: a message from Telegram cannot open the protected credentials/);
 s=await call('state');
 assert.equal(s.turns.some((turn:any)=>[code(0),code(1),wrong].some(value=>turn.prompt.includes(value)||String(turn.text).includes(value))),false,'codes never reach a chat');
 // A restart keeps the used counters: the next approval refuses code 1 again and takes code 2.
 await instance.evaluate(({app})=>app.quit());await instance.close();
 instance=await launch();page=await mainWindow(instance);
 s=await wait(s=>s.backend==='ready'&&s.remote.status==='running',180000);assert.equal(s.remote.paired,true);
 if(await page.getByRole('button',{name:'Close settings',exact:true}).count())await page.getByRole('button',{name:'Close settings',exact:true}).click();
 shown=await approval('COMMAND_FIXTURE after restart');
 telegram.message(OWNER,code(1),OWNER,shown.message_id);await replied(/^That code is not right\.$/);
 telegram.message(OWNER,code(2),OWNER,shown.message_id);await replied(/^Approved\.$/);
 await page.locator('.settings-link').click();await page.getByRole('button',{name:'Remote',exact:true}).click();await page.getByRole('button',{name:'Pair again',exact:true}).waitFor();
 await screenshot('remote-code.png');
 console.log('PASS 6d Remote code: approvals ask for a fresh code; wrong, replayed and pre-restart codes are refused; Deny refuses; the secrets list is refused; codes stay out of chats');
 // 6e: a routine sends one turn per firing through the dispatcher; the same firing after a restart adds nothing;
 // times missed while closed fire once; a cron line is read by the bundled croniter.
 s=await call('state');const routineChat=s.chats.filter((chat:any)=>!chat.archived&&!chat.parentChatId).at(-1).id;
 await assert.rejects(call('routineSave',{name:'Bad',chatId:routineChat,prompt:'x',schedule:{kind:'cron',line:'99 * * * *'}}),/cannot be read/);
 const cronId=await call('routineSave',{name:'Quarter hours',chatId:routineChat,prompt:'Cron fixture.',schedule:{kind:'cron',line:'*/15 * * * *'}});
 s=await call('state');const cron=s.routines.find((row:any)=>row.id===cronId);assert.equal(new Date(cron.nextFiring).getMinutes()%15,0);assert.ok(cron.nextFiring>Date.now());
 await call('routineSwitch',{id:cronId,enabled:false});
 const changing=call('routineSwitch',{id:cronId,enabled:true});
 const changed=Promise.allSettled([changing,call('routineDelete',{id:cronId})]);
 const outcomes=await changed;assert.equal(outcomes[0].status,'rejected','an async schedule calculation cannot restore a deleted routine');
 assert.equal((await call('state')).routines.some((row:any)=>row.id===cronId),false);
 await call('modelSelection',{chatId:routineChat,model:'deepseek-flash',selected:true});
 const routineId=await call('routineSave',{name:'Morning',chatId:routineChat,prompt:'Routine fixture prompt.',schedule:{kind:'preset',preset:'daily',time:'09:00'}});
 s=await call('state');const due=s.routines.find((row:any)=>row.id===routineId).nextFiring;assert.equal(new Date(due).getHours(),9);
 const firings=async()=>(await call('state')).turns.filter((turn:any)=>turn.id.startsWith('routine-'+routineId+'-')).map((turn:any)=>turn.id);
 await call('draft',{chatId:routineChat,text:'Unsent draft during scheduled work'});
 await call('routineTick',{now:due});assert.equal((await call('state')).chats.find((chat:any)=>chat.id===routineChat).draft,'Unsent draft during scheduled work');assert.deepEqual(await firings(),['routine-'+routineId+'-'+due]);
 await call('routineTick',{now:due+1000});assert.equal((await firings()).length,1,'a later tick adds nothing');
 await wait(s=>s.turns.filter((turn:any)=>turn.id.startsWith('routine-')).every((turn:any)=>turn.status==='completed'));
 // The schedule set back to that firing, as after a crash before it was saved: the same firing runs nothing new.
 await instance.evaluate(({app})=>app.quit());await instance.close();
 {const db=new DatabaseSync(path.join(data,'chat.sqlite'));const row:any=db.prepare("SELECT data FROM records WHERE kind='routine' AND id=?").get(routineId);db.prepare("UPDATE records SET data=? WHERE kind='routine' AND id=?").run(JSON.stringify({...JSON.parse(row.data),nextFiring:due}),routineId);db.close();}
 instance=await launch();page=await mainWindow(instance);
 s=await wait(s=>s.backend==='ready'&&s.remote.status==='running',180000);
 await call('routineTick',{now:due});assert.equal((await firings()).length,1,'a restart does not repeat a firing');
 s=await call('state');const next=s.routines.find((row:any)=>row.id===routineId).nextFiring;assert.ok(next>due);
 await call('routineTick',{now:next+3*86400000});const fired=await firings();
 assert.equal(fired.length,2,'three missed days fire once');assert.equal(fired.at(-1),'routine-'+routineId+'-'+next);
 await wait(s=>s.turns.filter((turn:any)=>turn.id.startsWith('routine-')).every((turn:any)=>turn.status==='completed'));
 if(!await page.getByRole('dialog',{name:'Settings'}).count())await page.locator('.settings-link').click();
 await page.getByRole('button',{name:'Routines',exact:true}).click();await page.getByRole('list',{name:'Routines',exact:true}).waitFor();
 await screenshot('routines.png');await page.getByRole('button',{name:'Remote',exact:true}).click();
 console.log('PASS 6e routines: one turn per firing, none again after a restart, missed days fire once, cron lines read by croniter');
 // A killed gateway comes back.
 const first=s.remote.pid;assert.ok(first&&alive(first));process.kill(first);
 s=await wait(s=>s.remote.status==='running'&&!!s.remote.pid&&s.remote.pid!==first,180000);const second=s.remote.pid;
 // Remote off stops it.
 await page.getByRole('switch',{name:'Remote',exact:true}).click();
 s=await wait(s=>s.remote.status==='off');assert.equal(s.alwaysOn.awake,false);
 const end=Date.now()+15000;while(alive(second)&&Date.now()<end)await page.waitForTimeout(200);assert.equal(alive(second),false,'the gateway process is gone');
 assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 console.log('PASS 6a Remote: nothing runs on a fresh profile; Telegram support installs on its click; on starts the gateway, a killed one comes back, off stops it; stay awake follows Remote');
}finally{
 await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});telegram.close();ds.stdin.end();ds.kill();
 for(const provider of ['deepseek','telegram','remote-code'])await host.host('delete_key',{provider}).catch(()=>{});
 const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');
}
