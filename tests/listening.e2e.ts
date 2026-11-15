// Listening (Koan 2026-11-15, his pick: version 2, the list): Settings › Voice lists Whisper on this PC, Deepgram and
// ElevenLabs. A row opens to its setup, a key is tried before it is saved, the round mark picks the engine in use, and
// dictation then runs through that engine: the start held, guesses as the words come, finished phrases locked, the
// last words waited for. The two services are stand-ins on this computer; the real ones are never called. The app is
// driven hidden. The setup wizard's Listening and Voice steps are the same two cards. The Waves choice saves.
import {_electron as electron} from 'playwright';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {WebSocketServer,type WebSocket} from 'ws';
import {Store} from '../app/store';
import type {Turn} from '../app/types';
import {pollState} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/listening-')),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-listening-'));
const store=new Store(path.join(data,'chat.sqlite')),project=store.project(folder),chat=store.chat(project.id),turn=store.accept(crypto.randomUUID(),chat.id,'Hello');
store.update<Turn>('turn',turn.id,{text:'Hello.',status:'completed'});store.db.close();
// A stand-in service: it takes a connection whose key starts with "synthetic-", records what it is sent, and says
// what the test tells it to.
async function standIn(header:string,started?:object){
 const seen={urls:[] as string[],keys:[] as string[],frames:[] as any[],sockets:[] as WebSocket[]},server=http.createServer(),wss=new WebSocketServer({noServer:true});
 server.on('upgrade',(request,socket,head)=>{
  const key=String(request.headers[header]||'').replace(/^Token /,'');seen.urls.push(request.url||'');seen.keys.push(key);
  if(!key.startsWith('synthetic-')){socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');socket.destroy();return;}
  wss.handleUpgrade(request,socket,head,ws=>{seen.sockets.push(ws);ws.on('message',(bytes,binary)=>seen.frames.push(binary?Buffer.from(bytes as Buffer):JSON.parse(bytes.toString())));if(started)ws.send(JSON.stringify(started));});
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 return {seen,url:'ws://127.0.0.1:'+(server.address() as any).port,close:()=>{for(const ws of seen.sockets)ws.terminate();server.close();}};
}
const deepgram=await standIn('authorization'),eleven=await standIn('xi-api-key',{message_type:'session_started',session_id:'s1'});
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_DEEPGRAM_WS:deepgram.url,TRISMEGISTUS_TEST_ELEVENLABS_WS:eleven.url}});
await instance.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
const capture=async(name:string)=>{const png=await instance.evaluate(async({BrowserWindow})=>{const view=BrowserWindow.getAllWindows().find(w=>/index\.html$/.test(w.webContents.getURL()))!;await view.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await new Promise(r=>setTimeout(r,150));return (await view.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64');});await fs.writeFile(path.join(data,name+'.png'),Buffer.from(png,'base64'));};
const size=(width:number,height:number)=>instance.evaluate(({BrowserWindow},[width,height])=>BrowserWindow.getAllWindows()[0].setSize(width,height),[width,height]);
try{
 const page=await instance.firstWindow();page.setDefaultTimeout(15000);await page.addStyleTag({content:'*,*::before,*::after{transition:none!important;animation-duration:0s!important;animation-delay:0s!important}'});
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await size(1280,940);await capture('wake');   // a hidden window draws no frames until it is captured once
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 let state=await pollState(page,s=>s.backend==='ready');
 assert.deepEqual(state.voice!.listening,{engine:'',hints:true,connected:{deepgram:false,elevenlabs:false},waves:'bars'});
 // With no supplier connected the app opens Settings by itself once setup is out of the way.
 await call('wizardFinish');const dialog=page.getByRole('dialog',{name:'Settings',exact:true});await dialog.waitFor();
 const dictate=crypto.randomUUID();
 await assert.rejects(call('dictationStart',{id:dictate,chatId:chat.id,language:'en'}),/Set up listening in Settings › Voice first/);

 // Settings › Voice opens with Listening, then Reply voice. Nothing is set up: no round mark can be picked.
 await dialog.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name:'Voice',exact:true}).click();
 const engines=dialog.getByRole('radiogroup',{name:'Listening engine',exact:true}),row=(id:string)=>engines.locator('[data-engine="'+id+'"]'),status=(id:string)=>row(id).locator('summary [role=status]').textContent(),shows=(id:string,text:string)=>row(id).locator('summary [role=status]').filter({hasText:text}).waitFor();
 await engines.waitFor();assert.deepEqual(await dialog.locator('.settings-card > h3').allTextContents(),['Listening','Reply voice','Google voice · free tier','Conversation voices','Wake word']);
 assert.deepEqual(await engines.locator('summary strong').allTextContents(),['Whisper Large v3 Turbo','Deepgram Nova-3','ElevenLabs Scribe v3 Live']);
 assert.deepEqual([await status('whisper'),await status('deepgram'),await status('elevenlabs')],['Not installed','Not connected','Not connected']);
 assert.equal(await engines.getByRole('radio').evaluateAll(marks=>marks.every(mark=>(mark as HTMLInputElement).disabled&&!(mark as HTMLInputElement).checked)),true);
 assert.equal(await row('whisper').evaluate(element=>(element as HTMLDetailsElement).open),true,'with nothing in use the local engine is the one shown open');
 await row('whisper').getByRole('button',{name:'Install · 1.6 GB',exact:true}).waitFor();await dialog.getByRole('button',{name:'Install · 337 MB',exact:true}).waitFor();
 await capture('voice-nothing-set-up');
 // Waves: bars by default; the choice saves and shows in the menu.
 const waves=dialog.locator('summary[aria-label="Waves"]'),wavesShown=async()=>(await waves.innerText()).replace(/\s*⌄$/,'');assert.equal(await wavesShown(),'Bars');
 await waves.click();await dialog.getByRole('radiogroup',{name:'Waves',exact:true}).getByRole('radio',{name:'Line',exact:true}).click();await pollState(page,s=>s.voice!.listening!.waves==='line');
 await dialog.locator('summary[aria-label="Waves"]',{hasText:'Line'}).waitFor();
 await waves.click();await dialog.getByRole('radiogroup',{name:'Waves',exact:true}).getByRole('radio',{name:'Bars',exact:true}).click();await pollState(page,s=>s.voice!.listening!.waves==='bars');
 await dialog.locator('summary[aria-label="Waves"]',{hasText:'Bars'}).waitFor();
 await assert.rejects(call('listeningWaves',{style:'dots'}),/Choose bars or a line/);

 // Deepgram: a refused key says so and saves nothing; a good key connects, and that engine is the one in use.
 await row('deepgram').locator('summary strong').click();const key=row('deepgram').getByLabel('Deepgram API key',{exact:true}),save=row('deepgram').getByRole('button',{name:'Save Deepgram connection',exact:true});
 await key.waitFor();assert.equal(await save.isDisabled(),true);assert.match(await row('deepgram').locator('.supplier-settings').innerText(),/\$0\.46 an hour of talking\. Hints for your own names add \$0\.08 an hour\./);
 await key.fill('refused-key-for-the-stand-in');await save.click();await dialog.getByRole('alert').filter({hasText:'Deepgram refused the key. Check it in Settings › Voice.'}).waitFor();
 assert.equal((await call('state')).voice.listening.connected.deepgram,false);
 await key.fill('synthetic-deepgram-regression-credential');await save.click();state=await pollState(page,s=>s.voice!.listening!.engine==='deepgram');
 await shows('deepgram','In use');assert.equal(await key.inputValue(),'','the key leaves the box once it is saved');assert.equal(await row('deepgram').getByRole('radio').isChecked(),true);
 assert.equal(deepgram.seen.frames.length,0,'trying a key sends no sound');
 await row('deepgram').getByRole('button',{name:'Disconnect',exact:true}).waitFor();

 // Dictation through Deepgram: the start is held, names go as hints, guesses appear, finished phrases stay.
 await page.evaluate(()=>{(window as any).heard=[];window.desktop.onDictation(event=>(window as any).heard.push([event.type,event.text]));});
 const heard=()=>page.evaluate(()=>(window as any).heard as [string,string][]),pcm=(value:number)=>new Uint8Array(new Int16Array(1600).fill(value).buffer);
 const before=deepgram.seen.sockets.length;assert.deepEqual(await call('dictationStart',{id:dictate,chatId:chat.id,language:'en'}),{device:'deepgram'});
 await page.evaluate(({id,first,second})=>Promise.all([window.desktop.invoke('dictationAudio',{id,bytes:new Uint8Array(first)}),window.desktop.invoke('dictationAudio',{id,bytes:new Uint8Array(second)})]),{id:dictate,first:[...pcm(1)],second:[...pcm(2)]});
 while(deepgram.seen.sockets.length===before||deepgram.seen.frames.length<2)await page.waitForTimeout(50);
 const socket=deepgram.seen.sockets.at(-1)!;assert.deepEqual(deepgram.seen.frames.map(frame=>frame.readInt16LE(0)),[1,2]);
 assert.match(deepgram.seen.urls.at(-1)!,/model=nova-3&language=en&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=300&utterance_end_ms=1000&smart_format=true&keyterm=Ghidorah/);
 socket.send(JSON.stringify({type:'Results',is_final:false,channel:{alternatives:[{transcript:'open the'}]}}));socket.send(JSON.stringify({type:'Results',is_final:true,channel:{alternatives:[{transcript:'Open the settings.'}]}}));
 socket.send(JSON.stringify({type:'Results',is_final:false,channel:{alternatives:[{transcript:'then clo'}]}}));while((await heard()).length<3)await page.waitForTimeout(50);
 assert.deepEqual(await heard(),[['partial','open the'],['partial','Open the settings.'],['partial','Open the settings. then clo']]);
 await call('dictationFinish',{id:dictate});while(!deepgram.seen.frames.some(frame=>frame.type==='CloseStream'))await page.waitForTimeout(50);
 socket.send(JSON.stringify({type:'Results',is_final:true,channel:{alternatives:[{transcript:'Then close it.'}]}}));socket.close();while((await heard()).at(-1)![0]!=='final')await page.waitForTimeout(50);
 assert.deepEqual((await heard()).at(-1),['final','Open the settings. Then close it.']);

 // Hints off: no names go with the sound. ElevenLabs set up becomes the engine in use; the round mark picks back.
 await row('deepgram').getByRole('switch',{name:'Send my app names as hints',exact:true}).click();await pollState(page,s=>s.voice!.listening!.hints===false);
 const second=crypto.randomUUID(),sockets=deepgram.seen.sockets.length;await call('dictationStart',{id:second,chatId:chat.id,language:'en'});while(deepgram.seen.sockets.length===sockets)await page.waitForTimeout(50);
 assert.doesNotMatch(deepgram.seen.urls.at(-1)!,/keyterm/);await call('dictationCancel',{id:second});
 await row('elevenlabs').locator('summary strong').click();await row('elevenlabs').getByLabel('ElevenLabs API key',{exact:true}).fill('synthetic-elevenlabs-regression-credential');await row('elevenlabs').getByRole('button',{name:'Save ElevenLabs connection',exact:true}).click();
 state=await pollState(page,s=>s.voice!.listening!.engine==='elevenlabs');await shows('elevenlabs','In use');assert.equal(await status('deepgram'),'Ready');
 const third=crypto.randomUUID();await page.evaluate(()=>{(window as any).heard=[];});await call('dictationStart',{id:third,chatId:chat.id,language:'en'});
 await page.evaluate(({id,bytes})=>window.desktop.invoke('dictationAudio',{id,bytes:new Uint8Array(bytes)}),{id:third,bytes:[...pcm(5)]});while(!eleven.seen.frames.length)await page.waitForTimeout(50);
 assert.match(eleven.seen.urls.at(-1)!,/model_id=scribe_v3_live&audio_format=pcm_16000&commit_strategy=vad&vad_silence_threshold_secs=0\.3&language_code=en$/);assert.equal(eleven.seen.frames[0].message_type,'input_audio_chunk');
 eleven.seen.sockets.at(-1)!.send(JSON.stringify({message_type:'committed_transcript',text:'Hello there.'}));await call('dictationFinish',{id:third});while(!eleven.seen.frames.at(-1)!.commit)await page.waitForTimeout(50);
 eleven.seen.sockets.at(-1)!.send(JSON.stringify({message_type:'committed_transcript',text:'How are you?'}));while((await heard()).at(-1)?.[0]!=='final')await page.waitForTimeout(50);
 assert.deepEqual((await heard()).at(-1),['final','Hello there. How are you?']);
 await row('deepgram').getByRole('radio').click();await pollState(page,s=>s.voice!.listening!.engine==='deepgram');await shows('deepgram','In use');assert.equal(await status('elevenlabs'),'Ready');
 await capture('voice-two-engines');await page.evaluate(()=>{document.documentElement.dataset.theme='light';});await capture('voice-light');await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
 await size(600,640);await page.waitForTimeout(200);const body=dialog.locator('.settings-body');assert.ok(await body.evaluate(element=>element.scrollWidth-element.clientWidth)<=1,'nothing runs off the side at the narrowest width');await capture('voice-narrow');await size(1280,940);
 // Disconnect: the key is gone and the engine in use falls to the next one that is set up.
 await row('deepgram').getByRole('button',{name:'Disconnect',exact:true}).click();state=await pollState(page,s=>s.voice!.listening!.engine==='elevenlabs');assert.equal(state.voice!.listening!.connected.deepgram,false);await shows('deepgram','Not connected');
 await assert.rejects(call('listeningEngine',{engine:'deepgram'}),/Set this engine up first/);await assert.rejects(call('listeningEngine',{engine:'whisper'}),/Set this engine up first/);await assert.rejects(call('listeningKey',{engine:'whisper',key:'synthetic-nothing'}),/Paste the API key/);

 // The setup wizard: the same two cards as its Listening and Voice steps, and their rows in the Summary.
 await page.getByRole('button',{name:'Close settings',exact:true}).click();await call('wizardOpen');const wizard=page.getByRole('dialog',{name:'Setup',exact:true});await wizard.waitFor();
 assert.deepEqual(await wizard.locator('.wizard-steps li').allTextContents(),['Suppliers','Claude Code','Jev','Listening','Voice','Start with Windows','Remote','Share with clients','Summary']);
 const at=(step:string)=>wizard.locator('.wizard-steps [aria-current]').filter({hasText:step}).waitFor(),press=(name:string)=>wizard.getByRole('button',{name,exact:true}).click();
 for(const step of ['Suppliers','Claude Code','Jev']){await at(step);await press('Skip');}
 await at('Listening');await wizard.getByRole('radiogroup',{name:'Listening engine',exact:true}).waitFor();await wizard.locator('[data-engine="elevenlabs"] summary [role=status]').filter({hasText:'In use'}).waitFor();await capture('wizard-listening');
 await press('Next');await at('Voice');await wizard.getByRole('button',{name:'Install · 337 MB',exact:true}).waitFor();await capture('wizard-voice');
 for(const step of ['Voice','Start with Windows','Remote','Share with clients']){await at(step);await press('Skip');}
 await at('Summary');
 const summary=await wizard.locator('.wizard-summary li').evaluateAll(items=>items.map(item=>[item.querySelector('strong')!.textContent,item.getAttribute('data-outcome'),item.querySelector('.hint')!.textContent]));
 assert.deepEqual(summary.filter(row=>['Listening','Voice'].includes(row[0]!)),[['Listening','connected','ElevenLabs Scribe v3 Live, online'],['Voice','skipped','Not installed. Listen and Speak replies need it.']]);
 await capture('wizard-summary');
 assert.deepEqual(errors,[]);assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 await call('listeningDisconnect',{engine:'elevenlabs'});
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({list:true,keyTriedBeforeSaved:true,refusedKey:true,engineInUse:true,heldStart:true,hints:true,lockedPhrases:true,lastWords:true,elevenlabs:true,disconnect:true,wizardSteps:true,waves:true},null,2));
 console.log('PASS listening: the engine list, keys, dictation through both stand-in services, and the two wizard steps');console.log(data);
}catch(error){await capture('failure').catch(()=>{});console.log(data);throw error;}
finally{
 await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});deepgram.close();eleven.close();
 for(const name of ['encryption','deepgram','elevenlabs'])try{execFileSync(path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",'Trismegistus/Test/'+path.basename(data)+'/'+name],{cwd:root,windowsHide:true,stdio:'ignore'});}catch{/* never saved */}
}
