import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {SpeechSegment,pcmWave,VOICE_RATE,microphoneFrames} from '../app/voice-audio';

test('microphone frames preserve samples and bounded complete utterances; silence and truncation never complete speech',()=>{
 const sent:ArrayBuffer[]=[],scope:any={AudioWorkletProcessor:class{port={postMessage:(frame:ArrayBuffer)=>sent.push(frame.slice(0))};},registerProcessor:(_name:string,processor:any)=>{scope.Processor=processor;}};
 vm.runInNewContext(fs.readFileSync(new URL('../app/voice-worklet.js',import.meta.url),'utf8'),scope);const processor=new scope.Processor();
 for(let i=0;i<10;i++)processor.process([[new Float32Array(128).fill(i<5?1:-1)]]);
 assert.equal(sent.length,1);assert.equal(new Int16Array(sent[0])[0],32767);assert.equal(new Int16Array(sent[0])[1279],-32768);
 const quiet=new Int16Array(1280),speech=new Int16Array(1280).fill(4000),segment=new SpeechSegment();
 for(let i=0;i<1000;i++)assert.equal(segment.push(quiet),null);
 assert.equal(segment.push(speech),null);assert.equal(segment.push(speech),null);
 for(let i=0;i<7;i++)assert.equal(segment.push(quiet),null);
 const finished=segment.push(quiet)!;assert.equal(finished.complete,true);assert.equal(finished.pcm.length,13*1280);assert.throws(()=>segment.push(speech),/finished/);
 const wav=pcmWave(finished.pcm),view=new DataView(wav.buffer);assert.equal(Buffer.from(wav.subarray(0,4)).toString(),'RIFF');assert.equal(view.getUint32(24,true),VOICE_RATE);assert.equal(view.getUint32(40,true),finished.pcm.length*2);
 const long=new SpeechSegment(.015,640,1000);let clipped:ReturnType<typeof long.push>=null;for(let i=0;i<13;i++)clipped=long.push(speech);assert.equal(clipped?.complete,false);
 for(const value of [NaN,Infinity,0,.5])assert.throws(()=>new SpeechSegment(value));
});

test('a late microphone grant is closed after cancellation without starting an audio graph',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'navigator');let resolve!:(stream:any)=>void,stops=0;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>new Promise(done=>{resolve=done;})}}});
 try{const controller=new AbortController(),pending=microphoneFrames(()=>assert.fail('cancelled capture emitted audio'),controller.signal,()=>{});controller.abort();resolve({getTracks:()=>[{stop:()=>stops++}]});await assert.rejects(pending,/cancelled/);assert.equal(stops,1);}
 finally{if(original)Object.defineProperty(globalThis,'navigator',original);else Reflect.deleteProperty(globalThis,'navigator');}
});
