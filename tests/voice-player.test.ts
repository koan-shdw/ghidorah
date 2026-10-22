import test from 'node:test';
import assert from 'node:assert/strict';
import {VoicePlayer} from '../app/voice-player';

test('streamed audio is scheduled without gaps, discarded on interruption, and bounded in memory',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'AudioContext'),sources:any[]=[];let closed=false;
 class Context {currentTime=0;destination={};resume=async()=>{};close=async()=>{closed=true;};
  createBuffer(_channels:number,samples:number){return {getChannelData:()=>new Float32Array(samples)};}
  createBufferSource(){const source={buffer:null as any,onended:null as (()=>void)|null,start:(at:number)=>source.at=at,stop:()=>source.stopped=true,disconnect:()=>source.disconnected=true,connect:()=>{},at:0,stopped:false,disconnected:false};sources.push(source);return source;}
 }
 Object.defineProperty(globalThis,'AudioContext',{value:Context,configurable:true});
 try{
  const player=new VoicePlayer();await player.ready();player.push(new Uint8Array(4800));player.push(new Uint8Array(4800));assert.equal(sources[1].at-sources[0].at,.1);
  let complete=false;const drain=player.drain().then(value=>complete=value);sources[0].onended!();assert.equal(sources[0].buffer,null);assert.equal(complete,false);sources[1].onended!();await drain;assert.equal(complete,true);
  player.push(new Uint8Array(4800));const cancelled=player.drain();player.clear();assert.equal(await cancelled,false);assert.ok(sources[2].stopped&&sources[2].disconnected);assert.equal(sources[2].buffer,null);
  assert.throws(()=>player.push(new Uint8Array(24000*2*61)),/fell behind/);player.close();assert.equal(closed,true);
 }finally{if(original)Object.defineProperty(globalThis,'AudioContext',original);else Reflect.deleteProperty(globalThis,'AudioContext');}
});
