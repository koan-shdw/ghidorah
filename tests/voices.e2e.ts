// Voices (Koan 2026-11-15): the Voices window, Listen under a reply, the Speak replies switch and an app's own voice.
// The app is driven hidden and muted. Without TRISMEGISTUS_TEST_KOKORO the voice stays uninstalled and every place
// must lead to the Voices window instead of failing. With it (a folder holding kokoro-v1.0.onnx and voices-v1.0.bin)
// the pinned packages are installed from PyPI into the test's own folder and the real voice is made to speak.
import {_electron as electron,type Page,type Locator} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import type {Snapshot,Turn} from '../app/types';
import {pollState} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/voices-')),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-voices-')),kokoro=process.env.TRISMEGISTUS_TEST_KOKORO;
const store=new Store(path.join(data,'chat.sqlite')),project=store.project(folder),chat=store.chat(project.id),turn=store.accept(crypto.randomUUID(),chat.id,'How did the update go?');
store.update<Turn>('turn',turn.id,{text:'Done. The update is out, and all four checks passed.\n\n```ts\nconst never=\'spoken\';\n```\n\nTwo things are still open.',status:'completed'});store.db.close();
if(kokoro){
 const model=JSON.parse(await fs.readFile(path.join(root,'backend/kokoro-voice.json'),'utf8')),target=path.join(data,'models','kokoro',model.release);
 await fs.mkdir(target,{recursive:true});for(const file of Object.keys(model.files))await fs.copyFile(path.join(kokoro,file),path.join(target,file));
}
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath}});
// Nothing shows on the screen and nothing comes out of the speakers.
await instance.evaluate(({app,BrowserWindow,webContents})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};for(const contents of webContents.getAllWebContents())contents.setAudioMuted(true);app.on('web-contents-created',(_event,contents)=>contents.setAudioMuted(true));});
const capture=async(hash:string,name:string)=>{const png=await instance.evaluate(async({BrowserWindow},hash)=>{const view=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith(hash))!;await view.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await new Promise(r=>setTimeout(r,150));return (await view.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64');},hash);await fs.writeFile(path.join(data,name+'.png'),Buffer.from(png,'base64'));};
const NO_TRANSITIONS='*,*::before,*::after{transition:none!important;animation-duration:0s!important;animation-delay:0s!important}';
const slide=(input:Locator,value:number)=>input.evaluate((element,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,String(value));element.dispatchEvent(new Event('input',{bubbles:true}));},value);
try{
 const page=await instance.firstWindow();page.setDefaultTimeout(15000);await page.addStyleTag({content:NO_TRANSITIONS});const errors:string[]=[];page.on('pageerror',error=>errors.push('main: '+error.message));
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1450,950));
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const voicesWindow=async(open:()=>Promise<unknown>)=>{const opened=instance.waitForEvent('window'),[view]=await Promise.all([opened,open()]);await view.waitForLoadState('domcontentloaded');assert.match(view.url(),/#voices$/);view.setDefaultTimeout(15000);await view.addStyleTag({content:NO_TRANSITIONS});view.on('pageerror',error=>errors.push('voices: '+error.message));return view;};
 const closeVoices=async(view:Page)=>{const closed=view.waitForEvent('close');await view.getByLabel('Close window',{exact:true}).click();await closed;};
 let state=await pollState(page,s=>s.backend==='ready');
 assert.deepEqual(state.voices!.list.map(voice=>voice.name),['Heart','Flat robot, low','Flat robot, high','Ring machine','Metal pipe','Old computer','Intercom','Whisper','Flat robot, old computer']);
 assert.equal(state.voices!.defaultId,'heart');assert.equal(state.voices!.installed,false);assert.equal(state.voices!.speakReplies,false);
 await call('wizardFinish');if(await page.getByLabel('Close settings',{exact:true}).isVisible())await page.getByLabel('Close settings',{exact:true}).click();
 await page.locator('[data-chat-id="'+chat.id+'"] .chat-link').click();

 // Not installed yet: Listen and the switch lead to the Voices window; nothing fails and the switch stays off.
 const listen=page.getByRole('button',{name:'Listen to this reply',exact:true});await listen.waitFor();assert.equal(await listen.textContent(),'Listen');
 let voices=await voicesWindow(()=>listen.click());
 await voices.getByText('The voice is a one-time download').waitFor();await voices.getByRole('button',{name:'Install · 337 MB',exact:true}).waitFor();
 assert.equal(await voices.locator('.voices-item').count(),9);assert.equal(await voices.locator('.voices-play:disabled').count(),9);assert.equal(await voices.getByLabel('Play this voice',{exact:true}).isDisabled(),true);
 await assert.rejects(voices.evaluate(()=>window.desktop.invoke('state')),/Request refused/,'the Voices window may ask only for its own actions');
 await assert.rejects(voices.evaluate(()=>window.desktop.invoke('submit',{})),/Request refused/);
 await closeVoices(voices);
 voices=await voicesWindow(()=>page.getByRole('switch',{name:'Speak replies',exact:true}).click());
 assert.equal((await call('state')).voices.speakReplies,false);
 await assert.rejects(call('speakStart',{id:'early',pieces:['Hello.'],voice:state.voices!.list[0]}),/Install the voice in Voices first/);

 // Making voices: the list, the name, the two voices and their balance, the speed, the rack. Every change saves.
 const named=(name:string)=>voices.getByLabel('Voice name',{exact:true}).and(voices.locator('[value="'+name+'"]')).waitFor();   // the voice being edited
 await named('Heart');
 await voices.locator('.voices-pick',{hasText:'Ring machine'}).click();await named('Ring machine');
 assert.equal(await voices.locator('.voices-module.is-on').count(),1);
 await voices.getByLabel('Voice name',{exact:true}).fill('Ring bell');
 await voices.getByLabel('Blend with',{exact:true}).selectOption('bf_emma');await slide(voices.getByLabel('Balance between the two voices',{exact:true}),37);await slide(voices.getByLabel('Speed',{exact:true}),1.2);
 await slide(voices.locator('section[aria-label="Ring machine"]').getByLabel('Amount',{exact:true}),50);await slide(voices.locator('section[aria-label="Metal pipe"]').getByLabel('Amount',{exact:true}),25);await slide(voices.locator('section[aria-label="Metal pipe"]').getByLabel('Tuning',{exact:true}),330);
 state=await pollState(page,s=>s.voices!.list.some(voice=>voice.name==='Ring bell'&&voice.fx.pipe.value===330));
 const bell=state.voices!.list.find(voice=>voice.name==='Ring bell')!;
 assert.deepEqual({id:bell.id,a:bell.a,b:bell.b,balance:bell.balance,speed:bell.speed,ring:bell.fx.ring,pipe:bell.fx.pipe},{id:'ring',a:'am_onyx',b:'bf_emma',balance:37,speed:1.2,ring:{amount:50,value:50},pipe:{amount:25,value:330}});
 assert.equal(await voices.locator('.voices-item.is-current small').textContent(),'Onyx + Emma · Ring machine 50% · Metal pipe 25% · 1.20×');
 assert.equal(await voices.locator('.voices-fader output').textContent(),'Onyx 63% · Emma 37%');assert.equal(await voices.locator('.voices-module.is-on').count(),2);
 await capture('#voices','voices-dark');await voices.evaluate(()=>{document.documentElement.dataset.theme='light';});await capture('#voices','voices-light');await voices.evaluate(()=>{document.documentElement.dataset.theme='dark';});
 await voices.getByRole('button',{name:'Duplicate',exact:true}).click();state=await pollState(page,s=>s.voices!.list.length===10);
 await named('Ring bell copy');const copy=state.voices!.list.find(voice=>voice.name==='Ring bell copy')!;assert.deepEqual({...copy,id:'',name:''},{...bell,id:'',name:''});
 await voices.getByRole('button',{name:'Make default',exact:true}).click();state=await pollState(page,s=>s.voices!.defaultId===copy.id);await voices.getByText('Default voice',{exact:true}).waitFor();
 await voices.getByRole('button',{name:'Delete',exact:true}).click();state=await pollState(page,s=>s.voices!.list.length===9);assert.equal(state.voices!.defaultId,'heart','the default falls back when its voice is deleted');
 await named('Heart');
 await voices.getByRole('button',{name:'New voice',exact:true}).click();state=await pollState(page,s=>s.voices!.list.length===10);await named('New voice');
 const fresh=state.voices!.list.at(-1)!;assert.equal(fresh.a,'af_heart');assert.ok(Object.values(fresh.fx).every(setting=>setting.amount===0));
 await voices.getByLabel('Voice name',{exact:true}).fill('');await voices.getByLabel('Voice name',{exact:true}).blur();assert.equal(await voices.getByLabel('Voice name',{exact:true}).inputValue(),'New voice','an emptied name comes back');
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('#voices'))!.setSize(560,700));await voices.waitForTimeout(200);
 assert.equal(await voices.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true,'nothing runs off the side at the narrowest width');await capture('#voices','voices-narrow');

 // An app's own voice: picked on its page, it is the voice of the app's chats until that voice is deleted.
 const saved=await call('savedAppSave',{name:'Voice test',chatIds:[chat.id]});
 await page.getByLabel('Show chats for Voice test',{exact:true}).click();await page.locator('.app-voice summary').click();await page.locator('.app-voice .choice-options label',{hasText:'Ring bell'}).click();
 state=await pollState(page,s=>s.savedApps!.find(app=>app.id===saved.id)?.voice==='ring');assert.deepEqual(state.voices!.byChat,{[chat.id]:'ring'});
 assert.equal((await call('savedAppSave',{id:saved.id,stage:'Beta'})).voice,'ring','other saves keep the app\'s voice');
 await capture('index.html','app-voice');
 await call('voicesRemove',{id:'ring'});state=await pollState(page,s=>!s.voices!.list.some(voice=>voice.id==='ring'));assert.deepEqual(state.voices!.byChat,{});assert.equal(state.savedApps!.find(app=>app.id===saved.id)!.voice,'');
 await assert.rejects(call('voicesSave',{voice:{...fresh,a:'zf_xiaobei'}}),/Choose a voice from the list/);await assert.rejects(call('savedAppSave',{id:saved.id,voice:'../x'}),/Choose a voice/);

 const heard=(view:Page)=>view.evaluate(()=>{(window as any).heard=[];window.desktop.onSpeech(event=>(window as any).heard.push(event.type));}),events=(view:Page)=>view.evaluate(()=>(window as any).heard as string[]);
 if(kokoro){
  // The real voice. Installing fetches only the pinned packages; the model is already in place and passes its check.
  await voices.getByRole('button',{name:'Install · 337 MB',exact:true}).click();
  state=await pollState(page,s=>!!s.voices!.installed||!s.voices!.installing,6*60*1000);
  assert.equal(state.voices!.installed,true,'the install failed: '+await voices.locator('.error').allTextContents());
  await voices.getByText('The voice is a one-time download').waitFor({state:'detached'});await heard(voices);await heard(page);
  // A row's play button: the sample in that voice, to its end.
  await voices.getByLabel('Play Flat robot, low',{exact:true}).click();await voices.getByLabel('Stop Flat robot, low',{exact:true}).waitFor({timeout:60000});await voices.getByLabel('Play Flat robot, low',{exact:true}).waitFor({timeout:60000});
  assert.deepEqual([...new Set(await events(voices))].sort(),['audio','end']);
  // The editor's Play loops the sample; a slider moved while it plays keeps it playing, and Stop stops it.
  await voices.locator('.voices-pick',{hasText:'Flat robot, high'}).click();await voices.getByLabel('Play this voice',{exact:true}).click();await voices.locator('.voices-wave.is-live').waitFor({timeout:60000});assert.equal(await voices.locator('.voices-wave-hint').count(),0);
  const drawn=()=>voices.locator('.voices-wave canvas').evaluate((canvas:HTMLCanvasElement)=>{const pixels=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;let inked=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i])inked++;return inked;});
  const before=await drawn();assert.ok(before>200,'the sound is drawn');
  await slide(voices.locator('section[aria-label="Flat robot"]').getByLabel('Note',{exact:true}),200);await slide(voices.locator('section[aria-label="Whisper"]').getByLabel('Amount',{exact:true}),60);await voices.waitForTimeout(700);
  assert.equal(await voices.locator('.voices-wave.is-live').count(),1);assert.notEqual(await drawn(),before,'the picture follows the sliders');
  await slide(voices.getByLabel('Speed',{exact:true}),1.3);await voices.waitForTimeout(2500);assert.equal(await voices.locator('.voices-wave.is-live').count(),1,'a new speed is made again and swapped in');
  await capture('#voices','voices-playing');
  await voices.getByLabel('Stop',{exact:true}).click();assert.equal(await voices.locator('.voices-wave.is-live').count(),0);
  // Listen under a reply reads it to the end in the chat's voice, without the code block.
  await page.locator('[data-chat-id="'+chat.id+'"] .chat-link').click();await listen.click();await page.getByRole('button',{name:'Stop reading',exact:true}).waitFor({timeout:60000});await capture('index.html','listen-playing');
  await listen.waitFor({timeout:90000});assert.deepEqual([...new Set(await events(page))].sort(),['audio','end']);assert.equal((await events(page)).filter(type=>type==='audio').length,2,'two pieces: the first sentence, then the rest');
  await listen.click();await page.getByRole('button',{name:'Stop reading',exact:true}).click();await listen.waitFor();
  // Speak replies: a reply that finishes while its chat is on screen is read aloud by itself, once.
  await page.getByRole('switch',{name:'Speak replies',exact:true}).click();state=await pollState(page,s=>!!s.voices!.speakReplies&&!!s.claude?.models?.length);
  await page.evaluate(()=>{(window as any).heard=[];});const next=crypto.randomUUID();await call('addModel',{chatId:chat.id,model:'claude-code:haiku'});await call('submit',{id:next,chatId:chat.id,text:'Say one short sentence.',models:['claude-code:haiku']});
  await pollState(page,s=>s.turns.some(row=>row.id===next&&row.status==='completed'));
  await page.locator('[data-turn-id="'+next+'"]').getByRole('button',{name:'Stop reading',exact:true}).waitFor({timeout:60000});await page.locator('[data-turn-id="'+next+'"]').getByRole('button',{name:'Listen to this reply',exact:true}).waitFor({timeout:90000});
  assert.ok((await events(page)).includes('end'));
  assert.deepEqual(await call('speakStart',{id:'again',pieces:['Hello.'],voice:state.voices!.list[0],auto:next}),{started:false},'a reply the switch has read is not read by another window');
 }
 // A chat in its own window has the same chat bar, so the same switch and the same Listen. The switch is one for
 // every chat: what one window sets, the other shows. A reply that finishes there is read there, not in the main
 // window, which still shows the chat but leaves it to its window.
 const opening=instance.waitForEvent('window');await call('openChatWindow',{chatId:chat.id});const chatView=await opening;await chatView.waitForLoadState('domcontentloaded');chatView.setDefaultTimeout(15000);await chatView.addStyleTag({content:NO_TRANSITIONS});chatView.on('pageerror',error=>errors.push('chat window: '+error.message));
 const windowSwitch=chatView.getByRole('switch',{name:'Speak replies',exact:true}),mainSwitch=page.getByRole('switch',{name:'Speak replies',exact:true});
 await windowSwitch.waitFor();assert.equal(await windowSwitch.getAttribute('aria-checked'),String(!!kokoro));await chatView.getByRole('button',{name:'Listen to this reply',exact:true}).first().waitFor();
 await capture('#chat='+chat.id,'chat-window');
 if(kokoro){
  await heard(chatView);await page.evaluate(()=>{(window as any).heard=[];});const inWindow=crypto.randomUUID();
  await chatView.evaluate(({id,chatId})=>window.desktop.invoke('submit',{id,chatId,text:'Say one short sentence.',models:['claude-code:haiku']}),{id:inWindow,chatId:chat.id});
  await pollState(page,s=>s.turns.some(row=>row.id===inWindow&&row.status==='completed'));
  await chatView.locator('[data-turn-id="'+inWindow+'"]').getByRole('button',{name:'Stop reading',exact:true}).waitFor({timeout:60000});await chatView.locator('[data-turn-id="'+inWindow+'"]').getByRole('button',{name:'Listen to this reply',exact:true}).waitFor({timeout:90000});
  assert.ok((await events(chatView)).includes('end'),'the chat window read its own reply');assert.deepEqual(await events(page),[],'the main window left it to the chat window');
  await windowSwitch.click();await pollState(page,s=>!s.voices!.speakReplies);
  for(let n=0;n<50&&await mainSwitch.getAttribute('aria-checked')!=='false';n++)await page.waitForTimeout(100);
  assert.equal(await mainSwitch.getAttribute('aria-checked'),'false','switched off in the chat window, off in the main window');assert.equal(await windowSwitch.getAttribute('aria-checked'),'false');
 }else{
  // Not installed: the switch leads to the Voices window (already open) and stays off.
  await windowSwitch.click();await chatView.waitForTimeout(300);assert.equal((await call('state')).voices.speakReplies,false);assert.equal(await windowSwitch.getAttribute('aria-checked'),'false');
 }
 assert.deepEqual(errors,[]);assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({starters:true,listenOpensVoicesBeforeInstall:true,switchStaysOff:true,windowOwnActionsOnly:true,editing:true,duplicateDefaultDelete:true,narrow:true,appVoice:true,chatWindowSwitch:true,realVoice:!!kokoro},null,2));
 console.log('PASS voices: the window, Listen, the switch and an app\'s voice'+(kokoro?', with the real voice installed and heard':' (the real voice was not installed: set TRISMEGISTUS_TEST_KOKORO)'));console.log(data);
}catch(error){await capture('index.html','failure-main').catch(()=>{});await capture('#voices','failure-voices').catch(()=>{});console.log(data);throw error;}
finally{await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});execFileSync(path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",'Trismegistus/Test/'+path.basename(data)+'/encryption'],{cwd:root,windowsHide:true});}
