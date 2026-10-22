import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {GeminiLive,FREE_VOICE_LIMIT,transcribeConfirmation} from '../app/gemini-live';
import {LiveVoiceDesk,type LiveVoiceEvent} from '../app/live-voice-desk';
import {pcmWave} from '../app/voice-audio';
import {liveVoiceSettings} from '../app/gemini-voice-settings';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const events:LiveVoiceEvent[]=[],wires:any[]=[],sent:any[]=[];let heard='yes',result={status:'running',text:''},key='fake-key',decode:((bytes:Uint8Array,signal:AbortSignal)=>Promise<string>)|null=null;
 const desk=new LiveVoiceDesk({chats:()=>[{id:'a',title:'Alpha'},{id:'b',title:'Beta'}],context:()=>JSON.stringify({text:'Already decided: no PDMD without reference input.'}),key:async()=>{if(!key)throw Error('Add a Google Free tier key in Settings → Voice.');return key;},settings:()=>({liveVoice:'Kore',liveReplyVoice:'Puck',silenceMs:640,echoDelay:0,threshold:.015}),emit:event=>events.push(event),decode:(bytes,signal)=>decode?decode(bytes,signal):Promise.resolve(heard),submit:async draft=>{sent.push(draft);return draft.id;},result:()=>result,
 connect:options=>{const wire={options,closed:false,messages:[] as any[],connect:async()=>{},close(){this.closed=true;},send(value:any){this.messages.push(value);},audio(bytes:Uint8Array){this.messages.push(bytes);},text(text:string){this.messages.push(text);}};wires.push(wire);return wire as unknown as GeminiLive;}});
 const current=()=>wires.at(-1),receive=(value:any)=>current().options.onMessage(value),last=(kind:string)=>events.findLast(event=>event.kind===kind) as any;
 const finishRead=async(text?:string)=>{const wire=current();receive({serverContent:{outputTranscription:{text:text??wire.messages[0]},modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=24000',data:'AAA='}}]},turnComplete:true}});const end=last('end');desk.finished(end.id,end.ticket,true);};
 return {desk,events,wires,sent,current,receive,last,finishRead,setHeard:(value:string)=>heard=value,setResult:(value:typeof result)=>result=value,noKey:()=>key='',holdDecode:(value:typeof decode)=>decode=value};
}

test('Google voice streams before turn completion, stays connected, interrupts and cannot send from model output',async()=>{
 const f=fixture();try{
  f.desk.open('a');await f.desk.start();const session=f.last('session');assert.equal(session.microphone,true);
  f.desk.feed(session.id,new Uint8Array([0,10]));assert.equal(f.current().messages.length,1);
  f.receive({serverContent:{inputTranscription:{text:'Hello'},modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=24000',data:'AAA='}}]},outputTranscription:{text:'Hi.'}}});assert.equal(f.last('audio').id,session.id);assert.equal(f.desk.state().message,'Hi.');assert.equal(f.wires.length,1);
  f.receive({serverContent:{interrupted:true}});assert.equal(f.last('clear').id,session.id);
  f.receive({toolCall:{functionCalls:[{id:'forged',name:'send_message',args:{text:'Run it',yes:true}}]}});assert.equal(f.sent.length,0);assert.ok(f.current().messages.at(-1).toolResponse.functionResponses[0].response.error);
  f.receive({toolCall:{functionCalls:[{id:'read',name:'read_chat',args:{}}]}});await tick();assert.match(f.current().messages.at(-1).toolResponse.functionResponses[0].response.text,/no PDMD/);
  f.desk.interrupt();const count=f.events.length;f.receive({serverContent:{outputTranscription:{text:'late'}}});assert.equal(f.events.length,count);assert.ok(f.current().closed);assert.match(f.desk.state().message,/stopped/);
 }finally{f.desk.close();}
});

test('fresh complete confirmation follows exact readback, sends once, then uses a distinct main reply voice',async()=>{
 const f=fixture();try{
  f.desk.open('a');await f.desk.start();f.receive({toolCall:{functionCalls:[{id:'draft',name:'prepare_message',args:{text:'Fix calc.py'}}]}});await tick();assert.equal(f.current().options.voice,'Kore');assert.equal(f.desk.state().draft?.text,'Fix calc.py');assert.throws(()=>f.desk.begin(),/readback/);
  // A voice model cannot approve its own draft, even if it produces a user's yes.
  f.receive({serverContent:{inputTranscription:{text:'yes'}}});assert.equal(f.sent.length,0);
  await f.finishRead('A different draft.');assert.throws(()=>f.desk.begin(),/readback/);assert.equal(f.sent.length,0);
  await f.desk.read();await f.finishRead();f.setHeard('yes, but do not send it');await f.desk.confirm(f.desk.begin(),new Uint8Array());assert.equal(f.sent.length,0);
  await f.desk.read();await f.finishRead();const ticket=f.desk.begin();f.setHeard('yes');await f.desk.confirm(ticket,new Uint8Array());assert.equal(f.sent.length,1);assert.equal(f.sent[0].chatId,'a');assert.equal(f.sent[0].text,'Fix calc.py');await assert.rejects(()=>f.desk.confirm(ticket,new Uint8Array()),/no longer current/);
  f.setResult({status:'completed',text:'Fixed and checked.'});await f.desk.poll();assert.equal(f.current().options.voice,'Puck');assert.match(f.current().messages[0],/AI has finished/);await f.finishRead();await tick();assert.equal(f.current().options.voice,'Kore');
 }finally{f.desk.close();}
});

test('chat changes, edits and Stop invalidate confirmations and pending key or transcription requests',async()=>{
 const f=fixture();try{
  f.desk.open('a');await f.desk.start();f.receive({toolCall:{functionCalls:[{id:'draft',name:'prepare_message',args:{text:'Fix calc.py'}}]}});await tick();await f.finishRead();const ticket=f.desk.begin();
  let complete!:(text:string)=>void;f.holdDecode(()=>new Promise(resolve=>complete=resolve));const pending=f.desk.confirm(ticket,new Uint8Array());f.desk.select('b');complete('yes');await pending;assert.equal(f.sent.length,0);assert.equal(f.desk.state().chatId,'b');assert.throws(()=>f.desk.begin(),/readback/);
  const before=f.wires.length;const opening=f.desk.start();f.desk.interrupt();await opening;assert.equal(f.wires.length,before);
  f.noKey();await f.desk.start();assert.match(f.desk.state().message,/Free tier key/);assert.equal(f.wires.length,before);
 }finally{f.desk.close();}
});

test('idle and quota close Google voice with no reconnection or other model',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();try{
  f.desk.open('a');await f.desk.start();t.mock.timers.tick(90001);assert.equal(f.current().closed,true);assert.match(f.desk.state().message,/90 seconds/);assert.equal(f.wires.length,1);
  await f.desk.start();f.current().options.onError(FREE_VOICE_LIMIT);assert.equal(f.current().closed,true);assert.equal(f.desk.state().message,FREE_VOICE_LIMIT);t.mock.timers.tick(15*60*1000);assert.equal(f.wires.length,2);
 }finally{f.desk.close();}
});

test('actual WebSocket protocol sends setup before PCM and surfaces quota without retry',async()=>{
 const server=new WebSocketServer({port:0,host:'127.0.0.1'});await once(server,'listening');const address=server.address() as {port:number},requests:any[]=[],failures:string[]=[];let connections=0;
 server.on('connection',socket=>{connections++;socket.on('message',data=>{const value=JSON.parse(data.toString());requests.push(value);if(value.setup)socket.send(JSON.stringify({setupComplete:{}}));else socket.send(JSON.stringify({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'quota'}}));});});
 const client=new GeminiLive({key:'fake-test-key',voice:'Kore',system:'Voice test',silenceMs:640,onMessage:()=>{},onError:message=>failures.push(message),url:`ws://127.0.0.1:${address.port}`});
 try{await client.connect();client.audio(new Uint8Array([1,2]));for(let i=0;i<30&&!failures.length;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(requests[0].setup.model,'models/gemini-3.8-live');assert.deepEqual(requests[0].setup.generationConfig.responseModalities,['AUDIO']);assert.equal(requests[1].realtimeInput.audio.data,'AQI=');assert.deepEqual(failures,[FREE_VOICE_LIMIT]);assert.equal(connections,1);}finally{client.close();server.close();}
});

test('confirmation uses only a complete captured clip and rejects truncation and quota without retry',async()=>{
 let calls=0,status=200,finish='STOP';const server=createServer((request,response)=>{calls++;assert.equal(request.headers['x-goog-api-key'],'fake-key');let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{const payload=JSON.parse(body);assert.equal(payload.contents[0].parts[0].inlineData.mimeType,'audio/wav');assert.equal(payload.contents[0].parts.length,1);assert.equal(payload.generationConfig.thinkingConfig.thinkingLevel,'LOW');response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify({candidates:[{finishReason:finish,content:{parts:[{text:'yes'}]}}]}));});}).listen(0,'127.0.0.1');await once(server,'listening');
 try{const url=`http://127.0.0.1:${(server.address() as any).port}`,wave=pcmWave(new Int16Array(1600));assert.equal(await transcribeConfirmation('fake-key',wave,new AbortController().signal,url),'yes');finish='MAX_TOKENS';await assert.rejects(()=>transcribeConfirmation('fake-key',wave,new AbortController().signal,url),/complete confirmation/);status=429;await assert.rejects(()=>transcribeConfirmation('fake-key',wave,new AbortController().signal,url),/allowance/);assert.equal(calls,3);await assert.rejects(()=>transcribeConfirmation('fake-key',new Uint8Array([0]),new AbortController().signal,url));assert.equal(calls,3);}finally{server.close();server.closeAllConnections();}
});

test('voice settings require a separately confirmed free key and distinct voices',()=>{
 assert.deepEqual(liveVoiceSettings({}),{liveVoice:'Kore',liveReplyVoice:'Puck',freeKeySaved:false,freeTierConfirmed:false});assert.notEqual(liveVoiceSettings({liveVoice:'Puck',liveReplyVoice:'Puck'}).liveReplyVoice,'Puck');
});
