import {_electron as electron,type Page} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {WebSocketServer,type WebSocket} from 'ws';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';

// Hidden windows, synthetic keys and localhost-only providers; no live inference,
// speech downloads, production database changes, or audible output.
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work','google-voice-')),folder=await fs.mkdtemp(path.join(root,'work','google-voice-files-')),namespace='Trismegistus/Test/'+path.basename(data),host=new Backend(root,data,namespace,()=>{});
await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const provider=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'provider.jsonl')},windowsHide:true,stdio:'pipe'}),lines=createInterface({input:provider.stdout}),[line]=await once(lines,'line');
let heard='no',confirmationCalls=0;const http=createServer((request,response)=>{let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{confirmationCalls++;assert.equal(request.headers['x-goog-api-key'],'synthetic-google-free-voice-key');assert.ok(JSON.parse(body).contents[0].parts[0].inlineData.data);response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:heard}]}}]}));});}).listen(0,'127.0.0.1');await once(http,'listening');
const server=new WebSocketServer({port:0,host:'127.0.0.1'});await once(server,'listening');const wires:{socket:WebSocket;setup:any;frames:number}[]=[],audio=Buffer.alloc(24000/5*2).toString('base64');
const speak=(socket:WebSocket,text:string)=>socket.send(JSON.stringify({serverContent:{outputTranscription:{text},modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=24000',data:audio}}]},turnComplete:true}}));
server.on('connection',(socket,request)=>{assert.match(request.url||'',/key=synthetic-google-free-voice-key/);const wire={socket,setup:null as any,frames:0};wires.push(wire);socket.on('message',data=>{const value=JSON.parse(data.toString());if(value.setup){wire.setup=value.setup;socket.send(JSON.stringify({setupComplete:{}}));}else if(value.realtimeInput?.audio){wire.frames++;if(wire.frames===2)speak(socket,'Ready to help.');}else if(value.clientContent)speak(socket,value.clientContent.turns[0].parts[0].text);});});
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:[...(process.env.TRISMEGISTUS_EXE?[]:[root]),'--hidden','--disable-gpu','--disable-renderer-backgrounding','--mute-audio','--use-fake-device-for-media-stream'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_VOICE_WS:`ws://127.0.0.1:${(server.address() as any).port}`,TRISMEGISTUS_TEST_VOICE_HTTP:`http://127.0.0.1:${(http.address() as any).port}`}});
await app.evaluate(({app,BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.webContents.setBackgroundThrottling(false);app.on('browser-window-created',(_event,window)=>window.webContents.setBackgroundThrottling(false));BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
let popup:Page|undefined;
const capture=async(page:Page,name:string)=>{const png=await app.evaluate(async({BrowserWindow},url)=>{const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===url);if(!window)throw Error('Test window closed.');return (await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64');},page.url());await fs.writeFile(path.join(data,name+'.png'),Buffer.from(png,'base64'));};
try{
 const page=await mainWindow(app),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,state=>state.backend==='ready'&&!!state.availableModels?.includes('deepseek-flash'));await call('wizardFinish');await call('workingFolder',{folder});
 const a=await call('newChat'),b=await call('newChat');await call('sidebarChat',{action:'rename',chatId:a,name:'Voice alpha'});await call('sidebarChat',{action:'rename',chatId:b,name:'Voice beta'});await call('draft',{chatId:b,text:'Keep my typed message.'});await call('modelSelection',{chatId:b,model:'deepseek-flash',selected:true});
 await assert.rejects(call('voiceFreeKey',{key:'fake',freeTierConfirmed:false}),/Free tier/);assert.equal(wires.length,0);
 if(!await page.getByRole('dialog',{name:'Settings',exact:true}).count())await page.locator('.settings-link').click();await page.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name:'Voice',exact:true}).click();
 await page.getByLabel('Google voice API key',{exact:true}).fill('synthetic-google-free-voice-key');assert.equal(await page.getByRole('button',{name:'Save voice key',exact:true}).isDisabled(),true);
 await page.getByRole('checkbox',{name:'I checked that this key’s project is on Free tier with billing off.'}).check();await page.getByRole('button',{name:'Save voice key',exact:true}).click();await pollState(page,state=>state.voice?.freeKeySaved===true);
 assert.equal(await page.getByLabel('Google voice API key',{exact:true}).inputValue(),'');assert.equal((await call('state')).voice.ready,false,'Google voice needs no local speech download');assert.ok(!JSON.stringify(await call('state')).includes('synthetic-google-free-voice-key'));
 await capture(page,'settings');await page.getByRole('button',{name:'Close settings',exact:true}).click();await call('voiceSettings',{echoDelay:300});
 const opened=app.waitForEvent('window');await call('voiceOpen',{chatId:a});popup=await opened;await popup.getByRole('button',{name:'Listen',exact:true}).waitFor();
 const voice=(method:string,args:any={})=>popup!.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(ready:(value:any)=>boolean,timeout=30000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=(await voice('voiceState')).state;if(ready(value))return value;await popup!.waitForTimeout(80);}throw Error('Voice state: '+JSON.stringify(await voice('voiceState')));};
 await assert.rejects(voice('submit',{id:crypto.randomUUID(),chatId:b,text:'forged'}),/unavailable in voice/);await assert.rejects(call('voiceLiveStart'),/refused/);await assert.rejects(voice('voiceFreeKey',{key:'forged',freeTierConfirmed:true}),/unavailable in voice/);
 await popup.evaluate(()=>{
  const scope=window as any;scope.voiceStreams=[];
  navigator.mediaDevices.getUserMedia=async()=>{const context=new AudioContext({sampleRate:16000}),source=context.createBufferSource(),destination=context.createMediaStreamDestination(),buffer=context.createBuffer(1,16000*3,16000),data=buffer.getChannelData(0);for(let i=16000;i<24000;i++)data[i]=Math.sin(i/16000*220*Math.PI*2)*.2;source.buffer=buffer;source.connect(destination);await context.resume();const stream=destination.stream;scope.voiceStreams.push({context,stream});for(const track of stream.getTracks()){const stop=track.stop.bind(track);track.stop=()=>{stop();try{source.stop();}catch{}void context.close();};}source.start(context.currentTime+.2);return stream;};
 });
 await popup.getByRole('button',{name:'Listen',exact:true}).click();await wait(s=>s.message==='Ready to help.');assert.equal(wires.length,1);assert.ok(wires[0].frames>=2);assert.match(wires[0].setup.systemInstruction.parts[0].text,/memory/);
 wires[0].socket.send(JSON.stringify({serverContent:{interrupted:true}}));await wait(s=>s.message==='Listening…');
 wires[0].socket.send(JSON.stringify({toolCall:{functionCalls:[{id:'draft',name:'prepare_message',args:{text:'Explain this project.'}}]}}));
 await wait(s=>s.draft?.text==='Explain this project.'&&s.transcript==='no'&&s.phase==='idle');assert.equal(confirmationCalls,1);assert.equal((await call('state')).turns.filter((turn:any)=>turn.voice).length,0);
 await popup.getByLabel('Voice draft',{exact:true}).fill('Explain the code.');await popup.getByLabel('Voice destination').selectOption(b);await wait(s=>s.chatId===b&&s.draft?.text==='Explain the code.');heard='yes';await popup.getByRole('button',{name:'Read back',exact:true}).click();
 const sent=await pollState(page,s=>s.turns.some(turn=>!!turn.voice&&turn.status==='completed'));const accepted=sent.turns.filter(turn=>turn.voice&&!turn.parentTurnId);assert.equal(accepted.length,1);assert.equal(accepted[0].chatId,b);assert.equal(accepted[0].prompt,'Explain the code.');assert.equal(sent.chats.find(chat=>chat.id===b)?.draft,'Keep my typed message.');
 for(let i=0;i<100&&!wires.some(w=>w.setup?.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName==='Puck');i++)await popup.waitForTimeout(80);assert.ok(wires.some(w=>w.setup?.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName==='Puck'));
 await capture(popup,'voice');await popup.getByRole('button',{name:'Stop speaking and listening',exact:true}).click();await popup.getByRole('button',{name:'Listen',exact:true}).click();await wait(s=>s.message==='Ready to help.');
 wires.at(-1)!.socket.send(JSON.stringify({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'free allowance'}}));await wait(s=>s.message.includes('allowance'));const count=wires.length;await popup.waitForTimeout(600);assert.equal(wires.length,count);assert.equal(await popup.evaluate(()=>(window as any).voiceStreams.every((item:any)=>item.context.state==='closed'&&item.stream.getTracks().every((track:MediaStreamTrack)=>track.readyState==='ended'))),true);
 await capture(popup,'quota');assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(window=>window.isVisible())),false);
 await popup.getByRole('button',{name:'Close voice',exact:true}).click();await call('voiceFreeDisconnect');assert.equal((await call('state')).voice.freeKeySaved,false);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({hidden:true,streaming:true,interrupt:true,readback:true,separateConfirmation:true,oneSend:true,destinationEdit:true,twoVoices:true,quotaStops:true,noLocalSpeech:true,noPaidCalls:true},null,2));console.log('PASS Google voice: hidden streaming UI, free key, readback/refusal/one send, two voices, interruption, quota, microphone release. Evidence: '+data);
}catch(error){if(popup&&!popup.isClosed())await capture(popup,'failure').catch(()=>{});console.error('Evidence: '+data);throw error;}
finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});provider.kill();lines.close();for(const socket of server.clients)socket.terminate();server.close();http.close();http.closeAllConnections();for(const name of ['deepseek','gemini-voice-free'])await host.host('delete_key',{provider:name}).catch(()=>{});}
