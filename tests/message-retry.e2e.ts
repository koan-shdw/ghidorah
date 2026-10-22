import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {mainWindow,pollState} from './fixtures/poll-state';

// Synthetic Claude responses; real renderer, IPC, persisted history, file write and restart.
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/message-retry-')),folder=await fs.mkdtemp(path.join(root,'work/message-retry-files-'));
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const launch=async()=>{const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env});await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};});return app;};
let app=await launch();
try{
 let page=await mainWindow(app);page.setDefaultTimeout(15000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&s.claude?.models?.some(m=>m.id==='claude-code:haiku')===true);await call('wizardFinish');await call('workingFolder',{folder});
 const source=await call('newChat'),other=await call('newChat');await call('addModel',{chatId:source,model:'claude-code:haiku'});
 const project=(await call('state')).chats.find((c:any)=>c.id===source).projectId;await call('mode',{projectId:project,mode:'manual'});
 const send=async(chatId:string,text:string)=>{const id=crypto.randomUUID();await call('submit',{chatId,id,text,models:['claude-code:haiku']});return id;};
 const first=await send(source,'Remember the earlier decision: copperfinch');await pollState(page,s=>s.turns.some(t=>t.id===first&&t.status==='completed'));
 const target=path.join(folder,'app.txt'),prompt=JSON.stringify({action:'write',path:target,content:'the existing file'});
 await page.evaluate(chatId=>window.desktop.invoke('attachmentAdd',{chatId,name:'brief.txt',bytes:new TextEncoder().encode('Keep the existing work')}),source);
 const write=await send(source,prompt);const waiting=await pollState(page,s=>s.approvals.some(a=>a.turnId===write&&a.status==='pending'));
 for(const approval of waiting.approvals.filter(a=>a.turnId===write&&a.status==='pending')){assert.match(approval.params.description,/^Write\n/);await call('approve',{id:approval.id,choice:'once'});}
 await pollState(page,s=>s.turns.some(t=>t.id===write&&t.status==='completed'));assert.equal(await fs.readFile(target,'utf8'),'the existing file');
 const later=await send(source,'Later conversation should stay in the original');await pollState(page,s=>s.turns.some(t=>t.id===later&&t.status==='completed'));
 await call('draft',{chatId:source,text:'Unsent source draft'});const saved=await call('savedAppSave',{name:'Retry test app',chatIds:[source],repositories:[folder]});
 const before=await call('state'),requests=await fs.readFile(path.join(data,'claude-requests.jsonl'),'utf8');
 await call('openMainChat',{chatId:source});const main=page.getByRole('region',{name:'Main chat',exact:true});
 await main.locator('[data-turn-id="'+write+'"]').getByRole('button',{name:'Edit / retry',exact:true}).click();
 const branched=await pollState(page,s=>s.chats.some(c=>c.branchTurnId===write)),branch=branched.chats.find(c=>c.branchTurnId===write)!;
 assert.equal(branch.draft,prompt);assert.equal(branch.attachments?.[0].chatId,branch.id);assert.equal(branched.turns.filter(t=>t.chatId===branch.id).length,1);
 assert.deepEqual(branched.turns.filter(t=>t.chatId===source),before.turns.filter((t:any)=>t.chatId===source));assert.equal(branched.chats.find(c=>c.id===source)?.draft,'Unsent source draft');
 assert.equal(branched.savedApps?.find(a=>a.id===saved.id)?.chatIds.includes(branch.id),true);assert.equal(await fs.readFile(path.join(data,'claude-requests.jsonl'),'utf8'),requests);
 await main.locator('.branch-notice').waitFor();assert.equal(await main.getByLabel('Message',{exact:true}).inputValue(),prompt);
 await main.getByLabel('Message',{exact:true}).fill('Explain the current file without editing it');
 const draft='Explain the current file without editing it';await pollState(page,s=>s.chats.find(c=>c.id===branch.id)?.draft===draft);
 await app.evaluate(({app})=>app.quit());await app.close();app=await launch();page=await mainWindow(app);page.setDefaultTimeout(15000);
 await pollState(page,s=>s.backend==='ready');await call('claudeCheck');await pollState(page,s=>s.claude?.models?.some(m=>m.id==='claude-code:haiku')===true);
 assert.equal((await call('state')).chats.find((c:any)=>c.id===branch.id).draft,draft);
 const retry=await send(branch.id,draft);await pollState(page,s=>s.turns.some(t=>t.id===retry&&t.status==='completed'));
 const last=JSON.parse((await fs.readFile(path.join(data,'claude-requests.jsonl'),'utf8')).trim().split('\n').at(-1)!);
 assert.match(last.prompt,/copperfinch/);assert.match(last.prompt,/Files and external effects have not been reverted/);assert.match(last.prompt,/the existing file/);assert.doesNotMatch(last.prompt,/Later conversation should stay in the original/);assert.ok(!last.args.includes('--resume'));
 assert.equal(await fs.readFile(target,'utf8'),'the existing file');
 // Detached ownership and the same control remain available; a branch opens in the main view.
 await call('openChatWindow',{chatId:source});let detached;
 for(let n=0;n<100&&!detached;n++){detached=app.windows().find(p=>p.url().endsWith('#chat='+source));if(!detached)await page.waitForTimeout(100);}assert.ok(detached);
 const fromWindow=(method:string,args:any={})=>detached!.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await assert.rejects(fromWindow('branchMessage',{chatId:other,turnId:first}),/another chat/);
 await assert.rejects(fromWindow('branchMessage',{chatId:source,turnId:retry}),/another chat/);
 await detached.locator('.turn').first().getByRole('button',{name:'Message actions',exact:true}).click();await detached.getByRole('menuitem',{name:'Edit or retry in a new chat',exact:true}).click();
 const final=await pollState(page,s=>s.chats.some(c=>c.branchTurnId===first));assert.equal(final.turns.filter(t=>t.chatId===source).length,3);assert.equal(await fs.readFile(target,'utf8'),'the existing file');
 await assert.rejects(call('branchMessage',{chatId:other,turnId:first}),/another chat/);
 const slow=await send(branch.id,'SLOW_CLAUDE');await pollState(page,s=>s.turns.some(t=>t.id===slow&&t.status==='running'&&!!t.text));await assert.rejects(call('branchMessage',{chatId:branch.id,turnId:retry}),/work/);
 await call('openMainChat',{chatId:branch.id});const liveMain=page.getByRole('region',{name:'Main chat',exact:true});
 await liveMain.getByLabel('Message',{exact:true}).fill('An unrelated follow-up for later');await liveMain.getByLabel('Message',{exact:true}).press('Enter');
 // TURN-REVIEW part 1: a message typed while Claude answers goes to Claude at once; it keeps its remove button until Claude reads it.
 const queued=await pollState(page,s=>s.turns.some(t=>t.chatId===branch.id&&t.prompt==='An unrelated follow-up for later'&&t.status==='running'&&t.delivery==='sent'));
 assert.equal(queued.turns.find(t=>t.id===slow)?.status,'running');await liveMain.getByRole('button',{name:'Cancel queued message',exact:true}).focus();await page.keyboard.press('Enter');
 await pollState(page,s=>!s.turns.some(t=>t.prompt==='An unrelated follow-up for later'));
 await liveMain.getByLabel('Message',{exact:true}).fill('Use this correction and finish a short explanation');
 await liveMain.getByRole('button',{name:'Stop and send',exact:true}).waitFor();
 const composerPng=await app.evaluate(async({BrowserWindow})=>Array.from((await BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG()));await fs.writeFile(path.join(data,'correction-composer.png'),Buffer.from(composerPng));
 await liveMain.getByRole('button',{name:'Stop and send',exact:true}).evaluate(button=>{for(let n=0;n<2;n++)(button as HTMLButtonElement).click();});
 const corrected=await pollState(page,s=>s.turns.some(t=>t.chatId===branch.id&&t.prompt==='Use this correction and finish a short explanation'&&t.status==='completed'));
 assert.ok(['stopped','interrupted'].includes(corrected.turns.find(t=>t.id===slow)!.status));assert.equal(corrected.turns.filter(t=>t.chatId===branch.id&&t.prompt==='Use this correction and finish a short explanation').length,1);
 // A run finishing just before the send reaches main must not discard the follow-up.
 const afterFinished=crypto.randomUUID();await call('correctGroup',{id:afterFinished,chatId:branch.id,text:'A follow-up after completion'});await pollState(page,s=>s.turns.some(t=>t.id===afterFinished&&t.status==='completed'));
 // The ordinary chat window uses the same correction action and cannot interrupt another chat.
 await call('openChatWindow',{chatId:branch.id});let branchWindow;
 for(let n=0;n<100&&!branchWindow;n++){branchWindow=app.windows().find(p=>p.url().endsWith('#chat='+branch.id));if(!branchWindow)await page.waitForTimeout(100);}assert.ok(branchWindow);branchWindow.setDefaultTimeout(15000);
 const fromBranch=(method:string,args:any={})=>branchWindow!.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await assert.rejects(fromBranch('correctGroup',{id:crypto.randomUUID(),chatId:source,text:'Wrong owner'}),/another chat/);
 const blockedWrite=crypto.randomUUID(),cancelledFile=path.join(folder,'cancelled.txt');await fromBranch('submit',{id:blockedWrite,chatId:branch.id,models:['claude-code:haiku'],text:JSON.stringify({action:'write',path:cancelledFile})});
 const approvalState=await pollState(page,s=>s.approvals.some(a=>a.turnId===blockedWrite&&a.status==='pending')),approvalId=approvalState.approvals.find(a=>a.turnId===blockedWrite&&a.status==='pending')!.id;
 await branchWindow.evaluate(chatId=>window.desktop.invoke('attachmentAdd',{chatId,name:'correction.txt',bytes:new TextEncoder().encode('Keep the pending file absent')}),branch.id);
 await branchWindow.getByLabel('Message',{exact:true}).fill('Skip the pending file write and explain only');await branchWindow.getByRole('button',{name:'Stop and send',exact:true}).click();
 const windowCorrected=await pollState(page,s=>s.turns.some(t=>t.chatId===branch.id&&t.prompt==='Skip the pending file write and explain only'&&t.status==='completed'));
 assert.equal(windowCorrected.turns.find(t=>t.prompt==='Skip the pending file write and explain only')?.attachments?.[0].name,'correction.txt');
 assert.equal(windowCorrected.approvals.find(a=>a.id===approvalId)?.status,'expired');assert.equal(await fs.access(cancelledFile).then(()=>true,()=>false),false);assert.equal(windowCorrected.turns.filter(t=>t.chatId===source).length,3);
 await call('openMainChat',{chatId:branch.id});await page.getByRole('region',{name:'Main chat',exact:true}).locator('.branch-notice').waitFor();
 const png=await app.evaluate(async({BrowserWindow})=>Array.from((await BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG()));await fs.writeFile(path.join(data,'message-retry.png'),Buffer.from(png));
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({originalPreserved:true,attachmentDraft:true,noAutomaticReplay:true,earlierContext:true,laterEffectsRetained:true,laterConversationExcluded:true,freshEngine:true,appLink:true,restart:true,detached:true,crossChatRefusal:true,activeWorkRefusal:true,mainCorrection:true,enterQueues:true,duplicateSendGuard:true,queueForLater:true,finishedRace:true,correctionAttachment:true,windowCorrection:true,pendingApprovalCancelled:true,unrelatedChatPreserved:true},null,2));console.log('PASS message retry, corrections, effect context, restart and window ownership. '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
