import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {WebSocketServer,type WebSocket} from 'ws';
import {ENGINES,WAVE_STYLES,readListening} from '../app/listening';
import {drawBars,drawLine} from '../app/dictation-waves';
import {LAST_WORDS_MS,OnlineDictation,checkKey,joinWords,listenHeaders,listenUrl,readMessage,refusal} from '../app/online-dictation';
import type {SpeechEvent} from '../app/speech-worker';

// Koan 2026-11-15: the listening engine is the user's choice, Whisper first, Deepgram and ElevenLabs online.
test('the engine in use is the saved one while it is ready, else the first that is',()=>{
 assert.deepEqual(readListening(undefined,false),{engine:'',hints:true,connected:{deepgram:false,elevenlabs:false},waves:'bars'});
 assert.equal(readListening({},true).engine,'whisper');
 assert.equal(readListening({sttEngine:'deepgram',deepgramKeySaved:true},true).engine,'deepgram');
 assert.equal(readListening({sttEngine:'deepgram'},true).engine,'whisper','a saved engine whose key is gone falls back');
 assert.equal(readListening({elevenlabsKeySaved:true},false).engine,'elevenlabs');
 assert.equal(readListening({sttEngine:'nobody',sttHints:false},true).hints,false);
 assert.deepEqual(Object.keys(ENGINES),['whisper','deepgram','elevenlabs']);
});

test('the waves are bars unless a line is saved',()=>{
 assert.equal(readListening({sttWaves:'line'},true).waves,'line');
 assert.equal(readListening({sttWaves:'bars'},true).waves,'bars');
 assert.equal(readListening({sttWaves:'zigzag'},true).waves,'bars','an unknown style falls back to bars');
 assert.deepEqual(WAVE_STYLES,{bars:'Bars',line:'Line'});
});

test('the waves draw newest on the right, louder taller, and a line that follows the level',()=>{
 const calls:string[]=[],context:any=new Proxy({globalAlpha:1},{get:(target,key)=>key in target?target[key as keyof typeof target]:(...args:number[])=>calls.push(String(key)+':'+args.map(n=>Math.round(n)).join(',')),set:(target:any,key,value)=>{target[key]=value;return true;}});
 drawBars(context,20,30,[0.1,1]);
 // Four 5 px columns, two values: the loudest (1) is the rightmost bar at full height, the quiet one beside it is short.
 const moves=calls.filter(call=>call.startsWith('moveTo'));assert.equal(moves.length,2);
 assert.match(moves[0],/^moveTo:18,0$/,'newest bar on the right, as tall as the box');assert.match(moves[1],/^moveTo:13,13$/,'the quiet one beside it, short and centred');
 assert.equal(context.globalAlpha,1,'the fade is put back after drawing');
 calls.length=0;drawLine(context,20,30,new Array(20).fill(0),0);
 assert.ok(calls.filter(call=>call.startsWith('lineTo')).every(call=>call.endsWith(',15')),'silence is a flat line through the middle');
});

test('each service is asked the way its own documents say',()=>{
 const deepgram=new URL(listenUrl('deepgram','',['Ghidorah','Video Dancer']));
 assert.equal(deepgram.origin+deepgram.pathname,'wss://api.deepgram.com/v1/listen');
 assert.deepEqual(Object.fromEntries([...deepgram.searchParams].filter(([key])=>key!=='keyterm')),{model:'nova-3',language:'en',encoding:'linear16',sample_rate:'16000',channels:'1',interim_results:'true',endpointing:'300',utterance_end_ms:'1000',smart_format:'true'});
 assert.deepEqual(deepgram.searchParams.getAll('keyterm'),['Ghidorah','Video Dancer']);
 assert.deepEqual(listenHeaders('deepgram','k1'),{Authorization:'Token k1'});
 const eleven=new URL(listenUrl('elevenlabs','en',['Ghidorah','A name far too long for a live key term']));
 assert.equal(eleven.origin+eleven.pathname,'wss://api.elevenlabs.io/v1/speech-to-text/realtime');
 assert.deepEqual(Object.fromEntries(eleven.searchParams),{model_id:'scribe_v3_live',audio_format:'pcm_16000',commit_strategy:'vad',vad_silence_threshold_secs:'0.3',language_code:'en',keyterms:'Ghidorah'});
 assert.equal(new URL(listenUrl('elevenlabs','',[])).searchParams.has('language_code'),false,'no language: the service finds it');
 assert.deepEqual(listenHeaders('elevenlabs','k2'),{'xi-api-key':'k2'});
 assert.equal(new URL(listenUrl('deepgram','en',[])).searchParams.has('keyterm'),false,'hints off: no key terms, no extra charge');
});

test('a service message is a changing guess, a finished phrase, an error or nothing',()=>{
 assert.deepEqual(readMessage('deepgram',JSON.stringify({type:'Results',is_final:false,channel:{alternatives:[{transcript:'hello wor'}]}})),{kind:'interim',text:'hello wor'});
 assert.deepEqual(readMessage('deepgram',JSON.stringify({type:'Results',is_final:true,speech_final:true,channel:{alternatives:[{transcript:'Hello world.'}]}})),{kind:'final',text:'Hello world.'});
 assert.equal(readMessage('deepgram',JSON.stringify({type:'UtteranceEnd'})).kind,'none');
 assert.deepEqual(readMessage('deepgram',JSON.stringify({type:'Error',description:'Bad audio.'})),{kind:'error',text:'Bad audio.'});
 assert.equal(readMessage('elevenlabs',JSON.stringify({message_type:'session_started',session_id:'s'})).kind,'ready');
 assert.deepEqual(readMessage('elevenlabs',JSON.stringify({message_type:'partial_transcript',text:'hello wor'})),{kind:'interim',text:'hello wor'});
 assert.deepEqual(readMessage('elevenlabs',JSON.stringify({message_type:'committed_transcript',text:'hello world'})),{kind:'final',text:'hello world'});
 assert.equal(readMessage('elevenlabs',JSON.stringify({message_type:'auth_error',error:'Invalid key'})).text,refusal('elevenlabs',401));
 assert.deepEqual(readMessage('elevenlabs',JSON.stringify({message_type:'rate_limited',error:'You have reached your rate limit.'})),{kind:'error',text:'You have reached your rate limit.'});
 assert.equal(readMessage('elevenlabs','not json').kind,'none');
 assert.equal(joinWords('Hello','world.'),'Hello world.');assert.equal(joinWords('Hello',', world'),'Hello, world');assert.equal(joinWords('',' x '),'x');
});

// A stand-in for a service: it records what it is sent and says what the test tells it to.
async function standIn(refuse=0){
 const seen:{headers:http.IncomingHttpHeaders[];urls:string[];frames:(Buffer|any)[];sockets:WebSocket[]}={headers:[],urls:[],frames:[],sockets:[]};
 const server=http.createServer(),wss=new WebSocketServer({noServer:true});
 server.on('upgrade',(request,socket,head)=>{
  seen.headers.push(request.headers);seen.urls.push(request.url||'');
  if(refuse){socket.write('HTTP/1.1 '+refuse+' Refused\r\nConnection: close\r\n\r\n');socket.destroy();return;}
  wss.handleUpgrade(request,socket,head,ws=>{seen.sockets.push(ws);ws.on('message',(data,binary)=>seen.frames.push(binary?Buffer.from(data as Buffer):JSON.parse(data.toString())));wss.emit('connection',ws);});
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const url='ws://127.0.0.1:'+(server.address() as any).port;
 return {seen,url,wss,close:()=>new Promise(resolve=>{for(const ws of seen.sockets)ws.terminate();server.close(()=>resolve(null));})};
}
const settle=(ms=60)=>new Promise(resolve=>setTimeout(resolve,ms));
const pcm=(value:number,samples=1600)=>new Uint8Array(new Int16Array(samples).fill(value).buffer);

test('Deepgram: the start is held, guesses appear, a finished phrase stays, Done waits for the last words',async()=>{
 const service=await standIn(),heard:[number,SpeechEvent][]=[],dictation=new OnlineDictation((owner,event)=>heard.push([owner,event]));
 try{
  dictation.open('d1',7,'deepgram','key-123','en',['Ghidorah'],service.url);
  dictation.audio('d1',7,pcm(1));dictation.audio('d1',7,pcm(2));   // said before the connection is open
  dictation.audio('d1',8,pcm(9));                                   // another window's sound is not taken
  const [socket]=await once(service.wss,'connection') as [WebSocket];await settle();
  assert.equal(service.seen.headers[0].authorization,'Token key-123');assert.match(service.seen.urls[0],/model=nova-3.*keyterm=Ghidorah/);
  assert.deepEqual(service.seen.frames.map(frame=>(frame as Buffer).readInt16LE(0)),[1,2],'what was held goes first, in order');
  dictation.audio('d1',7,pcm(3));await settle();assert.equal((service.seen.frames[2] as Buffer).readInt16LE(0),3);
  socket.send(JSON.stringify({type:'Results',is_final:false,channel:{alternatives:[{transcript:'open the'}]}}));
  socket.send(JSON.stringify({type:'Results',is_final:true,channel:{alternatives:[{transcript:'Open the settings.'}]}}));
  socket.send(JSON.stringify({type:'Results',is_final:false,channel:{alternatives:[{transcript:'then clo'}]}}));await settle();
  assert.deepEqual(heard.map(([owner,event])=>[owner,event.type,event.text]),[[7,'partial','open the'],[7,'partial','Open the settings.'],[7,'partial','Open the settings. then clo']]);
  dictation.finish('d1',7);await settle();
  assert.deepEqual(service.seen.frames.at(-1),{type:'CloseStream'});
  dictation.audio('d1',7,pcm(4));await settle();assert.deepEqual(service.seen.frames.at(-1),{type:'CloseStream'},'nothing is sent after Done');
  socket.send(JSON.stringify({type:'Results',is_final:true,channel:{alternatives:[{transcript:'Then close it.'}]}}));socket.close();await settle();
  assert.deepEqual(heard.at(-1),[7,{id:'d1',type:'final',text:'Open the settings. Then close it.'}]);assert.equal(dictation.has('d1'),false);
  // A service that never answers Done: the text is final after two seconds with what was heard.
  heard.length=0;dictation.open('d2',7,'deepgram','key-123','en',[],service.url);const [quiet]=await once(service.wss,'connection') as [WebSocket];await settle();
  quiet.send(JSON.stringify({type:'Results',is_final:false,channel:{alternatives:[{transcript:'last words'}]}}));await settle();
  const asked=Date.now();dictation.finish('d2',7);while(!heard.some(([,event])=>event.type==='final'))await settle(100);
  assert.ok(Date.now()-asked>=LAST_WORDS_MS-100&&Date.now()-asked<LAST_WORDS_MS+1500);assert.equal(heard.at(-1)![1].text,'last words');
  // Cancel and a closed window leave nothing behind.
  heard.length=0;dictation.open('d3',7,'deepgram','key-123','en',[],service.url);const [gone]=await once(service.wss,'connection') as [WebSocket];await settle();
  dictation.cancel('d3',7);gone.send(JSON.stringify({type:'Results',is_final:true,channel:{alternatives:[{transcript:'late'}]}}));await settle();assert.deepEqual(heard,[]);
  dictation.open('d4',7,'deepgram','key-123','en',[],service.url);await once(service.wss,'connection');dictation.release(7);await settle();assert.equal(dictation.has('d4'),false);assert.deepEqual(heard,[]);
 }finally{dictation.stop();await service.close();}
});

test('ElevenLabs: sound goes after the session starts, committed phrases stay, Done commits what is left',async()=>{
 const service=await standIn(),heard:[number,SpeechEvent][]=[],dictation=new OnlineDictation((owner,event)=>heard.push([owner,event]));
 try{
  dictation.open('e1',3,'elevenlabs','xi-456','',['Ghidorah'],service.url);dictation.audio('e1',3,pcm(5));
  const [socket]=await once(service.wss,'connection') as [WebSocket];await settle();
  assert.equal(service.seen.headers[0]['xi-api-key'],'xi-456');assert.match(service.seen.urls[0],/model_id=scribe_v3_live.*commit_strategy=vad.*keyterms=Ghidorah/);
  assert.equal(service.seen.frames.length,0,'nothing is sent before the service says the session started');
  socket.send(JSON.stringify({message_type:'session_started',session_id:'s1'}));await settle();
  assert.equal(service.seen.frames.length,1);assert.equal(service.seen.frames[0].message_type,'input_audio_chunk');assert.equal(service.seen.frames[0].commit,false);
  assert.equal(Buffer.from(service.seen.frames[0].audio_base_64,'base64').readInt16LE(0),5);
  socket.send(JSON.stringify({message_type:'partial_transcript',text:'hello'}));socket.send(JSON.stringify({message_type:'committed_transcript',text:'Hello there.'}));socket.send(JSON.stringify({message_type:'partial_transcript',text:'how are'}));await settle();
  assert.deepEqual(heard.map(([,event])=>event.text),['hello','Hello there.','Hello there. how are']);
  dictation.finish('e1',3);await settle();assert.equal(service.seen.frames.at(-1)!.commit,true,'Done asks the service to finish the phrase it holds');
  socket.send(JSON.stringify({message_type:'committed_transcript',text:'How are you?'}));await settle();
  assert.deepEqual(heard.at(-1),[3,{id:'e1',type:'final',text:'Hello there. How are you?'}]);
  // An error from the service reaches the window, and the dictation is over.
  heard.length=0;dictation.open('e2',3,'elevenlabs','xi-456','en',[],service.url);const [failing]=await once(service.wss,'connection') as [WebSocket];
  failing.send(JSON.stringify({message_type:'quota_exceeded',error:'Quota exceeded'}));await settle();
  assert.deepEqual(heard,[[3,{id:'e2',type:'error',text:refusal('elevenlabs',402)}]]);assert.equal(dictation.has('e2'),false);
 }finally{dictation.stop();await service.close();}
});

test('a key is tried on one connection with no sound sent; a refused key says so',async()=>{
 const good=await standIn(),refused=await standIn(401);
 try{
  await checkKey('deepgram','key-123',good.url);assert.equal(good.seen.headers[0].authorization,'Token key-123');assert.equal(good.seen.frames.length,0,'no sound, nothing billed');
  good.wss.once('connection',(ws:WebSocket)=>ws.send(JSON.stringify({message_type:'session_started',session_id:'s'})));
  await checkKey('elevenlabs','xi-456',good.url);
  await assert.rejects(checkKey('deepgram','bad',refused.url),{message:refusal('deepgram',401)});
  await assert.rejects(checkKey('elevenlabs','bad',refused.url),{message:'ElevenLabs refused the key. Check it in Settings › Voice.'});
  good.wss.once('connection',(ws:WebSocket)=>ws.send(JSON.stringify({message_type:'auth_error',error:'no'})));
  await assert.rejects(checkKey('elevenlabs','bad',good.url),/refused the key/);
  // A dictation on a refused key ends with the same words.
  const heard:SpeechEvent[]=[],dictation=new OnlineDictation((_owner,event)=>heard.push(event));
  dictation.open('r1',1,'deepgram','bad','en',[],refused.url);await settle(200);
  assert.deepEqual(heard,[{id:'r1',type:'error',text:refusal('deepgram',401)}]);
 }finally{await good.close();await refused.close();}
});
