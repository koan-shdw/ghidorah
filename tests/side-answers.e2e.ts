// Side answers (FEATURE-SPECS 2, Koan 2026-10-07 and 10-10), through the Claude fixture as both the main and the side
// model: while a slow main turn runs, "??" questions are answered in the floating card without touching the main turn
// (it finishes with its full reply); a plain message goes to the main model as before and never sees the side answers; Tell sends one on as a correction; Ask queues the question; answers stay folded.
import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','side-answers-')),namespace='Trismegistus/Test/'+path.basename(data),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-side-'));
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');
const app=await electron.launch({args:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath},timeout:30000});
try{
 await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.webContents.setBackgroundThrottling(false);BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
 const page=await mainWindow(app),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,state=>state.backend==='ready'&&!!state.claude?.models?.length);await call('wizardFinish');await call('workingFolder',{folder});
 const chatId=await call('newChat');await call('addModel',{chatId,model:'claude-code:haiku'});
 await call('openMainChat',{chatId});await page.locator(`[data-chat-id="${chatId}"] .chat-link[aria-current="page"]`).waitFor();if(await page.getByLabel('Close settings').count())await page.getByLabel('Close settings').click();
 let state:any=await call('state');assert.equal(state.sideAnswerModel,'claude-code:haiku','Haiku is the default side model when Claude is connected');
 const turn=(state:any,id:string)=>state.turns.find((row:any)=>row.id===id),side=(state:any,id:string)=>state.sideAnswers.find((row:any)=>row.id===id);
 const send=async(text:string)=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text,models:['claude-code:haiku']});return id;};
 const finished=(id:string)=>pollState(page,state=>['completed','failed','stopped','interrupted'].includes(turn(state,id)?.status),90000);
 const slow=()=>send(JSON.stringify({action:'slow',repeat:400}));

 // 1. "??" while the main model works: answered from live state, the main turn untouched.
 const main=await slow();await pollState(page,state=>turn(state,main)?.status==='running'&&turn(state,main).text.length>20,30000);
 const forced=await send('?? how far along are you');state=await call('state');
 assert.match(side(state,forced).text,/^Side fixture: running/,'the side model read the live status');assert.equal(side(state,forced).forced,true);
 assert.equal(turn(state,main).status,'running','the main turn keeps running');assert.ok(!turn(state,forced),'no turn was created for the side question');
 const card=page.locator('.side-card');await card.locator('.side-text',{hasText:'Side fixture: running'}).waitFor();assert.match(await card.innerText(),/how far along are you[\s\S]*Side fixture: running/);
 assert.match(await card.innerText(),/Side answer · .*haiku.* · from live state/i);
 // Hidden test windows do not play animations, so the slide-up is finished by hand before measuring.
 await card.evaluate(el=>el.getAnimations().forEach(animation=>animation.finish()));
 const box=(await card.boundingBox())!,composer=(await page.locator('.composer-box').first().boundingBox())!;
 assert.ok(box.height>40&&box.y+box.height<=composer.y+1&&box.y>0,'the card sits just above the message box: '+JSON.stringify({box,composer}));
 assert.equal(await card.evaluate(el=>getComputedStyle(el).opacity),'1');
 await page.screenshot({path:path.join(data,'side-card.png')});

 // 2. Not a side question: it goes to the main model as before.
 const queued=await send('also add a test for the menu');state=await call('state');
 assert.ok(turn(state,queued),'a turn for the main model');assert.ok(!side(state,queued),'nothing is kept as a side answer');

 // 3. A second "??" question; the earlier answer sits behind "Earlier".
 const sorted=await send('?? what is it doing right now');state=await call('state');
 assert.match(side(state,sorted).text,/^Side fixture: running/);assert.equal(turn(state,main).status,'running');
 await page.locator('.side-earlier summary',{hasText:'Earlier (1)'}).waitFor();

 // 4. The main turn finishes with its whole reply; the queued message never sees the side answers.
 state=await finished(main);assert.equal(turn(state,main).status,'completed');assert.ok(turn(state,main).text.includes('Slow Claude stream. '.repeat(400).trim()),'the session was not interrupted');
 await finished(queued);
 const requests=(await fs.readFile(path.join(data,'claude-requests.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 const sentLater=requests.find(row=>String(row.prompt).includes('also add a test for the menu'));assert.ok(sentLater,'the queued message reached the main model');
 assert.doesNotMatch(JSON.stringify(requests),/Side fixture/,'side answers never enter the main model’s context');
 const rows=page.locator(`article[data-turn-id="${main}"] .side-row`);await rows.first().waitFor();assert.equal(await rows.count(),2,'both side answers stay in the chat under their turn');
 assert.ok(Number(await page.locator(`article[data-turn-id="${main}"] .side-rows`).evaluate(el=>getComputedStyle(el).opacity))<1,'dimmed');
 assert.equal(await rows.first().evaluate(el=>(el as HTMLDetailsElement).open),false,'folded');

 // 5. Close: the card goes once every answer is closed.
 await page.getByRole('button',{name:'Close side answer'}).click();await pollState(page,state=>side(state,sorted).closed===true);
 await page.getByRole('button',{name:'Close side answer'}).click();await pollState(page,state=>side(state,forced).closed===true);await card.waitFor({state:'detached'});

 // 6. Tell the main model: Stop and send, with his question and the side answer.
 const second=await slow();await pollState(page,state=>turn(state,second)?.status==='running'&&turn(state,second).text.length>20,30000);
 const told=await send('?? are you done');await card.getByRole('button',{name:'Tell the main model',exact:true}).waitFor();
 const before=(await call('state')).turns.length;await page.getByRole('button',{name:'Tell the main model',exact:true}).click();
 state=await finished(second);assert.equal(turn(state,second).stopReason,'superseded-by-message');
 state=await pollState(page,state=>state.turns.length>before&&side(state,told).sent==='told');
 const correction=state.turns.at(-1);assert.match(correction.prompt,/^are you done\n\n\(A side answer from .*haiku.*Side fixture: running/i);
 await finished(correction.id);

 // 7. Ask the main model instead: the question is queued as an ordinary message. "??" works with nothing running too.
 const asked=await send('?? which files changed');await card.getByRole('button',{name:'Ask the main model instead',exact:true}).waitFor();assert.match(side(await call('state'),asked).text,/^Side fixture: completed/);
 await page.getByRole('button',{name:'Ask the main model instead',exact:true}).click();
 state=await pollState(page,state=>state.turns.some((row:any)=>row.prompt==='which files changed')&&side(state,asked).sent==='asked');
 await finished(state.turns.find((row:any)=>row.prompt==='which files changed').id);

 // 8. Settings and ownership.
 await assert.rejects(call('sideAnswerModel',{model:'not-a-model'}),/Choose an available model/);
 await assert.rejects(call('sideAnswerClose',{id:asked,chatId:crypto.randomUUID()}),/another chat/);
 await call('sideAnswerModel',{model:'claude-code:haiku'});
 console.log('PASS side answers: ?? and sorted questions answered from live state while the main turn ran on untouched, MAIN queued without side answers in its context, Earlier link, folded dimmed rows, close, Tell as a correction, Ask queued, settings. '+data);
}finally{await app.close().catch(()=>{});const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');}
