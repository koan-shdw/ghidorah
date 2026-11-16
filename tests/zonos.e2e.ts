// Zonos 3 Mini as a reply voice (Koan 2026-11-16): Settings › Voice lists Kokoro and Zonos 3 Mini the way Listening
// lists its engines. A Zyphra key is tried on the model list before it is saved, the round mark picks the voice in
// use, a Zonos voice is chosen, and replies are then read through Zyphra: Listen under a reply, the Voices window's
// Play (asked once; the effects are added here), a refusal in words. Zyphra is a stand-in on this computer; the real
// service is never called. The app is driven hidden and muted. The setup wizard's Voice step is the same card.
import {_electron as electron,type Page,type Locator} from 'playwright';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import type {Turn} from '../app/types';
import {pollState} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/zonos-')),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-zonos-'));
const store=new Store(path.join(data,'chat.sqlite')),project=store.project(folder),chat=store.chat(project.id),turn=store.accept(crypto.randomUUID(),chat.id,'How did it go?');
store.update<Turn>('turn',turn.id,{text:'Done. The update is out.\n\nTwo things are still open.',status:'completed'});store.db.close();
const KEY='synthetic-zyphra-regression-credential';
function wav(seconds:number){
 const rate=44100,count=Math.round(rate*seconds),bytes=Buffer.alloc(44+count*2);
 bytes.write('RIFF',0);bytes.writeUInt32LE(36+count*2,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
 bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(count*2,40);
 for(let n=0;n<count;n++)bytes.writeInt16LE(Math.round(12000*Math.sin(2*Math.PI*220*n/rate)),44+n*2);
 return bytes;
}
// The stand-in: a key starting "synthetic-" is taken; it lists models, makes 44.1 kHz WAV sound, and refuses the
// text "Too many." as Zyphra refuses a busy account.
const seen:{method:string;url:string;auth:string;body?:any}[]=[];
const zyphra=http.createServer((request,response)=>{
 const auth=String(request.headers.authorization||''),row:{method:string;url:string;auth:string;body?:any}={method:request.method||'',url:request.url||'',auth};
 let text='';request.on('data',chunk=>text+=chunk);request.on('end',()=>{
  if(text)row.body=JSON.parse(text);seen.push(row);
  if(!auth.startsWith('Bearer synthetic-')){response.writeHead(401,{'Content-Type':'application/json'});response.end('{"error":"invalid api key"}');return;}
  if(row.method==='GET'&&row.url==='/api/v1/models'){response.writeHead(200,{'Content-Type':'application/json'});response.end('{"data":[{"id":"zyphra/zonos3-mini"}]}');return;}
  if(row.method==='POST'&&row.url==='/api/v1/audio/speech'){
   if(row.body?.input==='Too many.'){response.writeHead(429,{'Content-Type':'application/json'});response.end('{"error":"rate limited"}');return;}
   response.writeHead(200,{'Content-Type':'audio/wav'});response.end(wav(0.4));return;
  }
  response.writeHead(404);response.end();
 });
});
zyphra.listen(0,'127.0.0.1');await once(zyphra,'listening');
const speech=()=>seen.filter(row=>row.url==='/api/v1/audio/speech');
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_ZYPHRA_URL:'http://127.0.0.1:'+(zyphra.address() as any).port+'/api/v1'}});
// Nothing shows on the screen and nothing comes out of the speakers.
await instance.evaluate(({app,BrowserWindow,webContents})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};for(const contents of webContents.getAllWebContents())contents.setAudioMuted(true);app.on('web-contents-created',(_event,contents)=>contents.setAudioMuted(true));});
const capture=async(ending:string,name:string)=>{const png=await instance.evaluate(async({BrowserWindow},ending)=>{const view=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith(ending))!;await view.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await new Promise(r=>setTimeout(r,150));return (await view.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64');},ending);await fs.writeFile(path.join(data,name+'.png'),Buffer.from(png,'base64'));};
const size=(width:number,height:number)=>instance.evaluate(({BrowserWindow},[width,height])=>BrowserWindow.getAllWindows()[0].setSize(width,height),[width,height]);
const NO_TRANSITIONS='*,*::before,*::after{transition:none!important;animation-duration:0s!important;animation-delay:0s!important}';
const slide=(input:Locator,value:number)=>input.evaluate((element,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,String(value));element.dispatchEvent(new Event('input',{bubbles:true}));},value);
try{
 const page=await instance.firstWindow();page.setDefaultTimeout(15000);await page.addStyleTag({content:NO_TRANSITIONS});
 const errors:string[]=[];page.on('pageerror',error=>errors.push('main: '+error.message));
 await size(1280,940);await capture('index.html','wake');   // a hidden window draws no frames until it is captured once
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 let state=await pollState(page,s=>s.backend==='ready');
 assert.deepEqual({engine:state.voices!.engine,ready:state.voices!.ready,zonos:state.voices!.zonos},{engine:'',ready:false,zonos:{connected:false,voice:'Savannah'}});
 await call('wizardFinish');const dialog=page.getByRole('dialog',{name:'Settings',exact:true});await dialog.waitFor();

 // Settings › Voice: Reply voice lists Kokoro on this PC and Zonos 3 Mini online. Nothing is set up: no round mark.
 await dialog.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name:'Voice',exact:true}).click();
 const group=dialog.getByRole('radiogroup',{name:'Reply voice engine',exact:true}),row=(id:string)=>group.locator('[data-reply-engine="'+id+'"]'),status=(id:string)=>row(id).locator('summary [role=status]').textContent(),shows=(id:string,text:string)=>row(id).locator('summary [role=status]').filter({hasText:text}).waitFor();
 await group.waitFor();assert.deepEqual(await dialog.locator('.settings-card > h3').allTextContents(),['Listening','Reply voice','Google voice · free tier','Conversation voices','Wake word']);
 assert.deepEqual(await group.locator('summary strong').allTextContents(),['Kokoro','Zonos 3 Mini']);
 assert.deepEqual(await group.locator('summary strong + span').allTextContents(),['On this PC · Free','Online · $10 per 1M bytes of text']);
 assert.deepEqual([await status('kokoro'),await status('zonos')],['Not installed','Not connected']);
 assert.equal(await group.getByRole('radio').evaluateAll(marks=>marks.every(mark=>(mark as HTMLInputElement).disabled&&!(mark as HTMLInputElement).checked)),true);
 assert.equal(await row('kokoro').evaluate(element=>(element as HTMLDetailsElement).open),true,'with nothing in use Kokoro is the one shown open');
 await row('kokoro').getByRole('button',{name:'Install · 337 MB',exact:true}).waitFor();
 await assert.rejects(call('speakStart',{id:'early',pieces:['Hello.'],voice:state.voices!.list[0]}),/Install the voice in Voices first/);

 // A refused key says so and saves nothing; trying it makes no sound. A good key connects, and Zonos is in use.
 await row('zonos').locator('summary strong').click();const key=row('zonos').getByLabel('Zyphra API key',{exact:true}),save=row('zonos').getByRole('button',{name:'Save Zyphra connection',exact:true});
 await key.waitFor();assert.equal(await save.isDisabled(),true);
 assert.match(await row('zonos').locator('.supplier-settings').innerText(),/Zyphra lists 1 request at a time and 100 generations a day for this model\. The text of each reply is sent to Zyphra and its sound comes back\./);
 await key.fill('refused-key-for-the-stand-in');await save.click();await dialog.getByRole('alert').filter({hasText:'Zyphra refused the key. Check it in Settings › Voice.'}).waitFor();
 assert.equal((await call('state')).voices.zonos.connected,false);
 await key.fill(KEY);await save.click();state=await pollState(page,s=>s.voices!.engine==='zonos');
 await shows('zonos','In use');assert.equal(await key.inputValue(),'','the key leaves the box once it is saved');assert.equal(await row('zonos').getByRole('radio').isChecked(),true);
 assert.equal(await status('kokoro'),'Not installed');assert.equal(await row('kokoro').getByRole('radio').isDisabled(),true);
 assert.deepEqual(seen.map(request=>[request.method,request.url,request.auth]),[['GET','/api/v1/models','Bearer refused-key-for-the-stand-in'],['GET','/api/v1/models','Bearer '+KEY]],'trying a key reads the model list and makes no sound');
 assert.equal(JSON.stringify(await call('state')).includes(KEY),false,'the key never reaches the window');
 await assert.rejects(call('voicesEngine',{engine:'kokoro'}),/Set this voice up first/);await assert.rejects(call('voicesEngine',{engine:'piper'}),/Choose a reply voice from the list/);
 await assert.rejects(call('voicesZonosKey',{key:'short'}),/Paste the API key/);await assert.rejects(call('voicesZonosVoice',{voice:'Nobody'}),/Choose a Zonos voice/);
 // Disconnect: the key is gone and nothing reads replies; connecting again brings Zonos back in use.
 await row('zonos').getByRole('button',{name:'Disconnect',exact:true}).click();state=await pollState(page,s=>s.voices!.engine==='');await shows('zonos','Not connected');
 await assert.rejects(call('speakStart',{id:'gone',pieces:['Hello.'],voice:state.voices!.list[0]}),/Install the voice in Voices first/);
 await key.fill(KEY);await save.click();state=await pollState(page,s=>s.voices!.engine==='zonos');await shows('zonos','In use');
 // The Zonos voice: Savannah first, the choice saves and shows in the menu.
 const menu=row('zonos').locator('summary[aria-label="Zonos voice"]');assert.equal((await menu.innerText()).replace(/\s*⌄$/,''),'Savannah · American woman');
 await menu.click();await row('zonos').getByRole('radiogroup',{name:'Zonos voice',exact:true}).getByRole('radio',{name:'Rupert · British man',exact:true}).click();
 state=await pollState(page,s=>s.voices!.zonos.voice==='Rupert');await row('zonos').locator('summary[aria-label="Zonos voice"]',{hasText:'Rupert'}).waitFor();
 await capture('index.html','voice-zonos');await page.evaluate(()=>{document.documentElement.dataset.theme='light';});await capture('index.html','voice-zonos-light');await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
 await size(600,640);await page.waitForTimeout(200);assert.ok(await dialog.locator('.settings-body').evaluate(element=>element.scrollWidth-element.clientWidth)<=1,'nothing runs off the side at the narrowest width');await capture('index.html','voice-zonos-narrow');await size(1280,940);

 // A reply read through Zyphra: one request at a time, the first sentence alone, then the rest; each piece comes back
 // to the window at 24 kHz, then the end.
 await page.evaluate(()=>{(window as any).heard=[];window.desktop.onSpeech(event=>(window as any).heard.push({type:event.type,id:event.id,rate:event.rate,text:event.text}));});
 const heard=(id:string)=>page.evaluate(id=>((window as any).heard as any[]).filter(event=>event.id===id),id),ended=async(id:string)=>{while(!(await heard(id)).some(event=>event.type!=='audio'))await page.waitForTimeout(50);return heard(id);};
 const asked=speech().length;
 assert.deepEqual(await call('speakStart',{id:'zonos-one',pieces:['Hello there.','Second.','Third.'],voice:state.voices!.list[0]}),{started:true});
 assert.deepEqual((await ended('zonos-one')).map(event=>[event.type,event.rate]),[['audio',24000],['audio',24000],['end',undefined]]);
 assert.deepEqual(speech().slice(asked).map(request=>[request.auth,request.body.model,request.body.voice,request.body.input,request.body.response_format]),[
  ['Bearer '+KEY,'zyphra/zonos3-mini','Rupert','Hello there.','wav'],['Bearer '+KEY,'zyphra/zonos3-mini','Rupert','Second. Third.','wav']]);
 // A refusal reaches the window in words.
 assert.deepEqual(await call('speakStart',{id:'zonos-busy',pieces:['Too many.'],voice:state.voices!.list[0]}),{started:true});
 assert.deepEqual((await ended('zonos-busy')).map(event=>[event.type,event.text]),[['error','Zyphra is limiting this account. Zyphra lists 1 request at a time and 100 generations a day.']]);

 // Listen under the reply: read through Zyphra to its end.
 await page.getByRole('button',{name:'Close settings',exact:true}).click();await page.locator('[data-chat-id="'+chat.id+'"] .chat-link').click();
 const listen=page.getByRole('button',{name:'Listen to this reply',exact:true});await listen.waitFor();assert.equal(await listen.getAttribute('title'),'Read this reply aloud · Heart');
 const beforeListen=speech().length;await listen.click();
 while(speech().length===beforeListen)await page.waitForTimeout(50);await listen.waitFor({timeout:30000});
 const read=speech().slice(beforeListen);assert.equal(read[0].body.input,'Done.','the first sentence goes alone');assert.match(read.map(request=>request.body.input).join(' '),/The update is out\. Two things are still open\./);
 assert.ok(read.every(request=>request.body.voice==='Rupert'));assert.equal(await page.locator('.speak-problem').count(),0);

 // The Voices window: Play asks Zyphra once; an effect moved while it plays changes the sound without asking again.
 const errorsIn=(view:Page,name:string)=>view.on('pageerror',error=>errors.push(name+': '+error.message));
 const opened=instance.waitForEvent('window'),[voices]=await Promise.all([opened,call('voicesOpen')]);await voices.waitForLoadState('domcontentloaded');voices.setDefaultTimeout(15000);await voices.addStyleTag({content:NO_TRANSITIONS});errorsIn(voices,'voices');
 const play=voices.getByLabel('Play this voice',{exact:true});await play.waitFor();assert.equal(await play.isDisabled(),false);assert.equal(await voices.getByText('The voice is a one-time download').count(),0);
 const beforePlay=speech().length;await play.click();await voices.locator('.voices-wave.is-live').waitFor({timeout:30000});
 assert.equal(speech().length,beforePlay+1,'the sample is one piece');assert.equal(speech().at(-1)!.body.voice,'Rupert');
 await slide(voices.locator('section[aria-label="Ring machine"]').getByLabel('Amount',{exact:true}),40);await voices.waitForTimeout(700);
 assert.equal(await voices.locator('.voices-wave.is-live').count(),1);assert.equal(speech().length,beforePlay+1,'an effect is added here, so Zyphra is not asked again');
 await capture('#voices','voices-zonos');
 await voices.getByLabel('Stop',{exact:true}).click();assert.equal(await voices.locator('.voices-wave.is-live').count(),0);
 const closed=voices.waitForEvent('close');await voices.getByLabel('Close window',{exact:true}).click();await closed;

 // The setup wizard: the same card as its Voice step, and its row in the Summary.
 await call('wizardOpen');const wizard=page.getByRole('dialog',{name:'Setup',exact:true});await wizard.waitFor();
 const at=(step:string)=>wizard.locator('.wizard-steps [aria-current]').filter({hasText:step}).waitFor(),press=(name:string)=>wizard.getByRole('button',{name,exact:true}).click();
 for(const step of ['Suppliers','Claude Code','Jev','Listening']){await at(step);await press('Skip');}
 await at('Voice');await wizard.locator('[data-reply-engine="zonos"] summary [role=status]').filter({hasText:'In use'}).waitFor();await capture('index.html','wizard-voice-zonos');
 for(const step of ['Voice','Start with Windows','Remote','Share with clients']){await at(step);await press('Skip');}
 await at('Summary');
 const summary=await wizard.locator('.wizard-summary li').evaluateAll(items=>items.map(item=>[item.querySelector('strong')!.textContent,item.getAttribute('data-outcome'),item.querySelector('.hint')!.textContent]));
 assert.deepEqual(summary.find(row=>row[0]==='Voice'),['Voice','connected','Zonos 3 Mini, online · Rupert']);
 await press('Finish');

 assert.deepEqual(errors,[]);assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 assert.ok(seen.every(request=>request.method==='GET'?request.url==='/api/v1/models':request.url==='/api/v1/audio/speech'),'nothing else was asked of Zyphra');
 await call('voicesZonosDisconnect');assert.equal((await call('state')).voices.engine,'');
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({list:true,keyTriedOnModelList:true,refusedKey:true,keyNotInWindow:true,engineInUse:true,disconnect:true,zonosVoice:true,onePieceAtATime:true,firstSentenceAlone:true,rate24k:true,refusalInWords:true,listen:true,voicesWindowAsksOnce:true,wizardStep:true,narrow:true},null,2));
 console.log('PASS zonos: the Reply voice list, the Zyphra key, the Zonos voice, replies read through the stand-in, the Voices window and the wizard step');console.log(data);
}catch(error){await capture('index.html','failure').catch(()=>{});await capture('#voices','failure-voices').catch(()=>{});console.log(data);throw error;}
finally{
 await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});zyphra.close();
 for(const name of ['encryption','zyphra'])try{execFileSync(path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",'Trismegistus/Test/'+path.basename(data)+'/'+name],{cwd:root,windowsHide:true,stdio:'ignore'});}catch{/* never saved */}
}
