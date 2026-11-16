// Zonos 3 Mini as a reply voice (Koan 2026-11-16): the engine list, how a reply is cut for Zyphra, the WAV that comes
// back, the sound made 24 kHz, the key check, and the speaker that sends it all to a window. Zyphra is a stand-in
// fetch here; the real service is never called.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readReplyEngine,REPLY_ENGINES,ZONOS_VOICES,isZonosVoice,zonosVoiceLabel} from '../app/reply-engines';
import {checkZyphraKey,pcmBase64,readWav,refusal,resample,zonosChunks,ZonosSpeaker,ZONOS_MODEL} from '../app/zonos-speaker';
import type {SpokenEvent} from '../app/voice-worker';

function wav(samples:number[],{rate=44100,channels=1,bits=16,float=false,streamed=false}={}){
 const width=bits/8,data=samples.length*width,bytes=Buffer.alloc(44+data);
 bytes.write('RIFF',0);bytes.writeUInt32LE(36+data,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(float?3:1,20);bytes.writeUInt16LE(channels,22);
 bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*channels*width,28);bytes.writeUInt16LE(channels*width,32);bytes.writeUInt16LE(bits,34);bytes.write('data',36);bytes.writeUInt32LE(streamed?0xffffffff:data,40);
 samples.forEach((value,n)=>{const at=44+n*width;if(float)bytes.writeFloatLE(value,at);else if(bits===16)bytes.writeInt16LE(Math.round(value*32767),at);else if(bits===24)bytes.writeIntLE(Math.round(value*8388607),at,3);});
 return new Uint8Array(bytes);
}
const tone=(hz:number,rate:number,seconds:number)=>Array.from({length:Math.round(rate*seconds)},(_,n)=>0.5*Math.sin(2*Math.PI*hz*n/rate));
const crossings=(samples:Float32Array)=>{let count=0;for(let n=1;n<samples.length;n++)if(samples[n-1]<0!==samples[n]<0)count++;return count;};

test('reply engines: Kokoro first, Zonos once its key is saved; the saved pick wins while it is ready',()=>{
 assert.deepEqual(readReplyEngine(undefined,false),{engine:'',zonos:{connected:false,voice:'Savannah'}});
 assert.equal(readReplyEngine({},true).engine,'kokoro');
 assert.equal(readReplyEngine({zyphraKeySaved:true},false).engine,'zonos');
 assert.equal(readReplyEngine({zyphraKeySaved:true,replyEngine:'zonos'},true).engine,'zonos');
 assert.equal(readReplyEngine({zyphraKeySaved:false,replyEngine:'zonos'},true).engine,'kokoro','a disconnected engine is not the one in use');
 assert.equal(readReplyEngine({zyphraKeySaved:true,zonosVoice:'Rupert'},false).zonos.voice,'Rupert');
 assert.equal(readReplyEngine({zonosVoice:'Somebody'},false).zonos.voice,'Savannah','an unknown voice falls back to the default');
 assert.deepEqual(Object.keys(REPLY_ENGINES),['kokoro','zonos']);assert.equal(ZONOS_VOICES.length,10);
 assert.equal(isZonosVoice('Willow'),true);assert.equal(isZonosVoice('willow'),false);assert.equal(zonosVoiceLabel('Imogen'),'Imogen · British woman');
});

test('a reply goes to Zyphra as its first sentence alone, then the rest joined up to the limit',()=>{
 assert.deepEqual(zonosChunks([]),[]);assert.deepEqual(zonosChunks(['One.']),['One.']);
 assert.deepEqual(zonosChunks(['One.','Two.','Three.']),['One.','Two. Three.']);
 assert.deepEqual(zonosChunks(['First.','aaaa','bbbb','cccc'],9),['First.','aaaa bbbb','cccc']);
 assert.deepEqual(zonosChunks(['First.','a long piece over the limit','b'],5),['First.','a long piece over the limit','b'],'a piece longer than the limit still goes, alone');
});

test('the WAV Zyphra sends is read: 16 and 24-bit, float, stereo averaged, a streamed size',()=>{
 const sixteen=readWav(wav([0,0.5,-0.5]));assert.equal(sixteen.rate,44100);assert.deepEqual([...sixteen.samples].map(v=>Math.round(v*100)/100),[0,0.5,-0.5]);
 assert.deepEqual([...readWav(wav([0.25,-1],{bits:24})).samples].map(v=>Math.round(v*100)/100),[0.25,-1]);
 assert.deepEqual([...readWav(wav([0.5,-0.25],{float:true,bits:32})).samples],[0.5,-0.25]);
 assert.deepEqual([...readWav(wav([1,0,0.5,0.5],{channels:2,float:true,bits:32})).samples],[0.5,0.5]);
 assert.equal(readWav(wav([0.1,0.2,0.3],{streamed:true})).samples.length,3);
 assert.throws(()=>readWav(new Uint8Array(Buffer.from('ID3 not a wav at all'))),/other than a WAV/);
});

test('the sound is made 24 kHz without changing its pitch, and goes as 16-bit PCM',()=>{
 const input=Float32Array.from(tone(440,44100,1)),out=resample(input,44100,24000);
 assert.equal(out.length,24000);
 assert.ok(Math.abs(crossings(out)-crossings(input))<=2,'a 440 Hz tone stays 440 Hz');
 assert.ok(Math.max(...out.slice(100,-100).map(Math.abs))<0.55,'nothing louder than the input');
 assert.equal(resample(input,24000,24000),input);
 const pcm=Buffer.from(pcmBase64(Float32Array.from([0,1,-1,2])),'base64');assert.deepEqual([0,2,4,6].map(at=>pcm.readInt16LE(at)),[0,32767,-32767,32767]);
});

test('a key is tried on the model list, so nothing is billed; a refused key says so',async()=>{
 const asked:[string,any][]=[];
 const fetcher=(async(url:string,init:any)=>{asked.push([url,init]);return new Response('{"data":[]}',{status:init.headers.Authorization==='Bearer good-key'?200:401});}) as typeof fetch;
 await checkZyphraKey('good-key','http://127.0.0.1:9/api/v1/',fetcher);
 assert.equal(asked[0][0],'http://127.0.0.1:9/api/v1/models');assert.equal(asked[0][1].method,undefined,'a read, not a generation');
 await assert.rejects(checkZyphraKey('bad-key','http://127.0.0.1:9/api/v1',fetcher),{message:'Zyphra refused the key. Check it in Settings › Voice.'});
 await assert.rejects(checkZyphraKey('k','http://127.0.0.1:9',(async()=>{throw Error('down');}) as any),/Zyphra did not answer/);
 assert.match(refusal(429),/100 generations a day/);assert.equal(refusal(500),'Zyphra did not answer (500).');
});

test('the speaker asks Zyphra one request at a time and sends each piece to the window, then the end',async()=>{
 const sent:[number,SpokenEvent][]=[],bodies:any[]=[];let open=0,most=0;
 const fetcher=(async(url:string,init:any)=>{
  open++;most=Math.max(most,open);bodies.push({url,auth:init.headers.Authorization,...JSON.parse(init.body)});
  await new Promise(resolve=>setTimeout(resolve,20));open--;
  return new Response(wav(tone(220,44100,0.1)),{status:200,headers:{'Content-Type':'audio/wav'}});
 }) as typeof fetch;
 const speaker=new ZonosSpeaker(async()=>'synthetic-zyphra-key',(owner,event)=>sent.push([owner,event]),()=>'http://127.0.0.1:9/api/v1',fetcher);
 const done=(id:string)=>new Promise<void>(resolve=>{const check=()=>sent.some(([,event])=>event.id===id&&event.type!=='audio')?resolve():setTimeout(check,5);check();});
 await speaker.speak('a',7,{pieces:['Hello there.','Second.','Third.'],voice:'Rupert'});
 await speaker.speak('b',8,{pieces:['Another window.'],voice:'Savannah'});
 await Promise.all([done('a'),done('b')]);
 assert.equal(most,1,'Zyphra lists one concurrent request');
 assert.deepEqual(bodies.map(body=>[body.url,body.auth,body.model,body.voice,body.input,body.response_format]),[
  ['http://127.0.0.1:9/api/v1/audio/speech','Bearer synthetic-zyphra-key',ZONOS_MODEL,'Rupert','Hello there.','wav'],
  ['http://127.0.0.1:9/api/v1/audio/speech','Bearer synthetic-zyphra-key',ZONOS_MODEL,'Rupert','Second. Third.','wav'],
  ['http://127.0.0.1:9/api/v1/audio/speech','Bearer synthetic-zyphra-key',ZONOS_MODEL,'Savannah','Another window.','wav']]);
 assert.deepEqual(sent.map(([owner,event])=>[owner,event.id,event.type,event.index,event.rate]),[[7,'a','audio',0,24000],[7,'a','audio',1,24000],[7,'a','end',undefined,undefined],[8,'b','audio',0,24000],[8,'b','end',undefined,undefined]]);
 assert.equal(Buffer.from(sent[0][1].pcm!,'base64').length,2400*2,'0.1 s at 24 kHz, 16-bit');
});

test('a stopped reply makes no more requests; a refusal reaches the window in words',async()=>{
 const sent:SpokenEvent[]=[];let calls=0;
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 const slow=(async(_url:string,init:any)=>{calls++;await held;if(init.signal.aborted)throw Object.assign(Error('aborted'),{name:'AbortError'});return new Response(wav([0]),{status:200});}) as typeof fetch;
 const speaker=new ZonosSpeaker(async()=>'k',(_owner,event)=>sent.push(event),()=>'http://127.0.0.1:9',slow);
 await speaker.speak('s',1,{pieces:['One.','Two.'],voice:'Willow'});await new Promise(resolve=>setTimeout(resolve,10));
 speaker.cancel('s',2);speaker.cancel('s',1);release();await new Promise(resolve=>setTimeout(resolve,30));
 assert.equal(calls,1,'the second piece was never asked for');assert.equal(sent.length,0,'a stop the window asked for says nothing');
 const refused=new ZonosSpeaker(async()=>'k',(_owner,event)=>sent.push(event),()=>'http://127.0.0.1:9',(async()=>new Response('{}',{status:429})) as any);
 await refused.speak('r',1,{pieces:['Hi.'],voice:'Willow'});while(!sent.length)await new Promise(resolve=>setTimeout(resolve,5));
 assert.deepEqual(sent,[{id:'r',type:'error',text:refusal(429)}]);
 const keyless=new ZonosSpeaker(async()=>{throw Error('Add your Zyphra key in Settings › Voice.');},()=>{},()=>'http://127.0.0.1:9',slow);
 await assert.rejects(keyless.speak('k',1,{pieces:['Hi.'],voice:'Willow'}),/Add your Zyphra key/);
});
