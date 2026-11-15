// What a window says aloud (Koan 2026-11-15). One thing plays at a time in a window: a reply (the Listen button or the
// Speak replies switch), an app's voice, or a voice being tried in the Voices window. The main process returns the
// plain voice piece by piece; this file adds the voice's effects and plays each piece as it arrives, so a long reply
// starts within about a second. No React in this file.
import {spokenPieces} from './spoken-text';
import {RATE,render} from './voice-effects';
import type {SpokenEvent} from './voice-worker';
import type {SavedVoice} from './voices';

/** What every voice says when it is tried out. */
export const SAMPLE='Done. The update is out, and all four checks passed. Two things are still open.';
const GAP=0.22;   // seconds of quiet between two pieces
type Job={key:string;id:string;voice:SavedVoice;raw:Float32Array[]|null;next:number;sources:Set<AudioBufferSourceNode>;heard:boolean;done:boolean;settle:(finished:boolean)=>void};
type Waiting={key:string;pieces:string[];voice:SavedVoice;auto:string};
let context:AudioContext|null=null,current:Job|null=null,connected=false,problem:{key:string;text:string}|null=null;
const waiting:Waiting[]=[],listeners=new Set<()=>void>();
const notify=()=>{for(const listener of listeners)listener();};
const reason=(error:unknown)=>String(error).replace(/^Error: /,'').replace(/^Error invoking remote method 'app': (?:Error: )?/,'');

/** The worker's 16-bit sound as samples between -1 and 1. */
export function pcmSamples(base64:string){
 const text=atob(base64),bytes=new Uint8Array(text.length);
 for(let i=0;i<text.length;i++)bytes[i]=text.charCodeAt(i);
 const pcm=new Int16Array(bytes.buffer,0,bytes.length>>1),samples=new Float32Array(pcm.length);
 for(let i=0;i<pcm.length;i++)samples[i]=pcm[i]/32767;
 return samples;
}
// advance: the next waiting reply starts; false when something else is about to start in its place.
function finish(job:Job,finished:boolean,advance=true){
 if(current!==job)return;
 current=null;for(const source of job.sources){source.onended=null;try{source.stop();}catch{/* already ended */}}job.sources.clear();
 job.settle(finished);notify();
 const next=advance?waiting.shift():undefined;if(next)void start(next.key,next.pieces,next.voice,false,next.auto);
}
function halt(){
 const job=current;if(!job)return;
 void window.desktop.invoke('speakStop',{id:job.id}).catch(()=>{});finish(job,false,false);
}
function receive(event:SpokenEvent){
 const job=current;if(!job||event.id!==job.id)return;
 if(event.type==='audio'&&event.pcm){
  const samples=pcmSamples(event.pcm);
  if(job.raw){job.raw.push(samples);return;}
  const audio=context!,shaped=render(samples,job.voice.fx),buffer=audio.createBuffer(1,shaped.length,RATE),source=audio.createBufferSource();
  buffer.getChannelData(0).set(shaped);source.buffer=buffer;source.connect(audio.destination);
  const at=Math.max(audio.currentTime+0.03,job.next);source.start(at);job.next=at+buffer.duration+GAP;
  job.sources.add(source);source.onended=()=>{job.sources.delete(source);if(job.done&&!job.sources.size)finish(job,true);};
  if(!job.heard){job.heard=true;notify();}
 }else if(event.type==='end'){job.done=true;if(job.raw||!job.sources.size)finish(job,true);}
 else if(event.type==='error'){problem={key:job.key,text:event.text||'The voice stopped.'};finish(job,false);}
}
function start(key:string,pieces:string[],voice:SavedVoice,raw:boolean,auto?:string){
 halt();
 if(!connected){connected=true;window.desktop.onSpeech(receive);}
 problem=null;
 if(!raw){context??=new AudioContext({sampleRate:RATE});void context.resume();}
 return new Promise<Float32Array[]|boolean>(resolve=>{
  const job:Job={key,id:crypto.randomUUID(),voice,raw:raw?[]:null,next:0,sources:new Set(),heard:false,done:false,settle:finished=>resolve(job.raw?(finished?job.raw:false):finished)};
  current=job;notify();
  window.desktop.invoke('speakStart',{id:job.id,pieces,voice,...(auto?{auto}:{})}).then(result=>{if(result?.started===false)finish(job,false);},error=>{if(current===job)problem={key,text:reason(error)};finish(job,false);});
 });
}
export const speaker={
 /** Read text aloud in a voice; whatever was playing stops. Settles true when it was heard to the end. */
 say(key:string,text:string,voice:SavedVoice){const pieces=spokenPieces(text);waiting.length=0;return pieces.length?start(key,pieces,voice,false) as Promise<boolean>:Promise.resolve(false);},
 /** A reply read aloud by the Speak replies switch: it waits for what is playing and is spoken once across windows. */
 after(key:string,text:string,voice:SavedVoice,auto:string){
  const pieces=spokenPieces(text);if(!pieces.length)return;
  if(current&&!current.raw){if(waiting.length<5&&!waiting.some(row=>row.auto===auto))waiting.push({key,pieces,voice,auto});}else void start(key,pieces,voice,false,auto);
 },
 /** The plain voice saying a short text in one go, without effects and without playing it, for the Voices window's
  * editor, which adds the effects itself as the sliders move. */
 async plain(key:string,text:string,voice:SavedVoice){
  waiting.length=0;const parts=await start(key,[text.trim()],voice,true);
  return Array.isArray(parts)&&parts.length?parts[0]:null;
 },
 stop(){waiting.length=0;halt();},
 /** What is speaking in this window now, or ''. */
 key(){return current?.key||'';},
 /** '' when this key is not speaking, 'loading' until its first sound, then 'playing'. */
 phase(key:string):''|'loading'|'playing'{return current?.key===key?(current.heard?'playing':'loading'):'';},
 /** What stopped this key's speech last, if anything did. */
 problem(key:string){return problem?.key===key?problem.text:'';},
 subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
};
