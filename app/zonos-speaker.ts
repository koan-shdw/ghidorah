// Zonos 3 Mini on Zyphra Cloud (Koan 2026-11-16): the reply voice's online engine, on the user's own key. Zyphra's
// endpoint is OpenAI-style: POST {base}/audio/speech with model, voice and input, and the sound comes back as WAV.
// Zyphra lists 1 request at a time and 100 generations a day, so requests go one after another and a reply is sent in
// few pieces: its first sentence alone, for a quick first sound, then the rest joined. Each piece comes back to the
// asking window as 24 kHz mono 16-bit PCM, the shape Kokoro's worker sends, so the window adds the voice's effects the
// same way. No Electron in this file.
import type {SpokenEvent} from './voice-worker';

export const ZYPHRA_URL='https://api.zyphracloud.com/api/v1';
export const ZONOS_MODEL='zyphra/zonos3-mini';
export const RATE=24000;
const JOINED=1500;          // the most characters sent in one request after the first sentence
const TIMEOUT_MS=90000;     // one request: Zyphra makes up to 10 minutes of sound per generation; replies are short
type Fetch=typeof fetch;

/** The pieces of a reply as they are sent: the first alone, the rest joined up to JOINED characters. */
export function zonosChunks(pieces:string[],limit=JOINED){
 const chunks:string[]=[];if(!pieces.length)return chunks;
 chunks.push(pieces[0]);let held='';
 for(const piece of pieces.slice(1)){
  if(held&&held.length+1+piece.length>limit){chunks.push(held);held='';}
  held=held?held+' '+piece:piece;
 }
 if(held)chunks.push(held);
 return chunks;
}
/** A WAV file's sound as one channel: 8, 16, 24 or 32-bit PCM, or 32-bit float; channels are averaged. */
export function readWav(bytes:Uint8Array){
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),word=(at:number)=>String.fromCharCode(...bytes.subarray(at,at+4));
 if(bytes.length<12||word(0)!=='RIFF'||word(8)!=='WAVE')throw Error('Zyphra sent something other than a WAV file.');
 let format=0,channels=0,rate=0,bits=0,at=12,data:Uint8Array|null=null;
 while(at+8<=bytes.length){
  const id=word(at),size=view.getUint32(at+4,true),body=at+8;
  if(id==='fmt '){format=view.getUint16(body,true);channels=view.getUint16(body+2,true);rate=view.getUint32(body+4,true);bits=view.getUint16(body+14,true);if(format===0xfffe&&size>=26)format=view.getUint16(body+24,true);}
  // A streamed WAV may give its data a size it did not know yet: the sound is then the rest of the file.
  else if(id==='data'){data=bytes.subarray(body,size===0xffffffff||body+size>bytes.length?bytes.length:body+size);break;}
  at=body+size+(size&1);
 }
 const width=bits/8;
 if(!data||!channels||!rate||!(format===1&&[8,16,24,32].includes(bits)||format===3&&bits===32))throw Error('Zyphra sent a sound this app cannot read.');
 const frames=Math.floor(data.length/(width*channels)),samples=new Float32Array(frames),read=new DataView(data.buffer,data.byteOffset,data.byteLength);
 for(let n=0;n<frames;n++){
  let sum=0;
  for(let c=0;c<channels;c++){
   const p=(n*channels+c)*width;
   sum+=format===3?read.getFloat32(p,true):bits===8?(read.getUint8(p)-128)/128:bits===16?read.getInt16(p,true)/32768:bits===24?((read.getUint8(p)|read.getUint8(p+1)<<8|read.getInt8(p+2)<<16))/8388608:read.getInt32(p,true)/2147483648;
  }
  samples[n]=sum/channels;
 }
 return {rate,samples};
}
/** Sound at another sample rate: a windowed-sinc filter, low-passed below the lower rate's limit. */
export function resample(samples:Float32Array,from:number,to:number){
 if(from===to)return samples;
 const ratio=from/to,length=Math.floor(samples.length/ratio),out=new Float32Array(length),cutoff=Math.min(1,to/from)*0.95,half=16;
 for(let i=0;i<length;i++){
  const centre=i*ratio,first=Math.floor(centre)-half+1;let sum=0,weight=0;
  for(let k=first;k<first+half*2;k++){
   if(k<0||k>=samples.length)continue;
   const x=centre-k,sinc=x===0?1:Math.sin(Math.PI*cutoff*x)/(Math.PI*cutoff*x),window=0.5+0.5*Math.cos(Math.PI*x/half),tap=sinc*window;
   sum+=samples[k]*tap;weight+=tap;
  }
  out[i]=weight?sum/weight:0;
 }
 return out;
}
/** Samples between -1 and 1 as 16-bit little-endian PCM in base64. */
export function pcmBase64(samples:Float32Array){
 const pcm=Buffer.alloc(samples.length*2);
 for(let n=0;n<samples.length;n++)pcm.writeInt16LE(Math.round(Math.max(-1,Math.min(1,samples[n]))*32767),n*2);
 return pcm.toString('base64');
}
/** Why Zyphra said no, in the user's words. */
export function refusal(status:number){
 if(status===401||status===403)return 'Zyphra refused the key. Check it in Settings › Voice.';
 if(status===402)return 'Zyphra reports no credit left on this account.';
 if(status===429)return 'Zyphra is limiting this account. Zyphra lists 1 request at a time and 100 generations a day.';
 return 'Zyphra did not answer ('+status+').';
}
/** Whether Zyphra takes this key: the model list is read, so no sound is made and nothing is billed. */
export async function checkZyphraKey(key:string,base=ZYPHRA_URL,fetcher:Fetch=fetch){
 let response:Response;
 try{response=await fetcher(base.replace(/\/+$/,'')+'/models',{headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(15000)});}
 catch{throw Error('Zyphra did not answer. Check your connection and try again.');}
 await response.arrayBuffer().catch(()=>{});
 if(!response.ok)throw Error(refusal(response.status));
}

export type ZonosRequest={pieces:string[];voice:string};
type Job={owner:number;controller:AbortController};
export class ZonosSpeaker {
 private jobs=new Map<string,Job>();private line:Promise<void>=Promise.resolve();
 // key: the user's Zyphra key. send: an event for one window. base: Zyphra's address (a stand-in in tests).
 constructor(private key:()=>Promise<string>,private send:(owner:number,event:SpokenEvent)=>void,private base:()=>string=()=>ZYPHRA_URL,private fetcher:Fetch=fetch){}
 /** Speak for one window. Whatever that window was already having said stops. */
 async speak(id:string,owner:number,request:ZonosRequest){
  this.release(owner);
  const key=await this.key(),job:Job={owner,controller:new AbortController()};this.jobs.set(id,job);
  const chunks=zonosChunks(request.pieces);
  // One request at a time across every window: Zyphra lists one concurrent request for this model.
  const run=this.line.then(async()=>{
   for(const [index,text] of chunks.entries()){
    if(this.jobs.get(id)!==job)return;
    const sound=await this.ask(key,request.voice,text,job.controller.signal);
    if(this.jobs.get(id)!==job)return;
    this.send(owner,{id,type:'audio',index,rate:RATE,pcm:pcmBase64(resample(sound.samples,sound.rate,RATE))});
   }
   if(this.jobs.get(id)===job){this.jobs.delete(id);this.send(owner,{id,type:'end'});}
  }).catch(error=>{
   if(this.jobs.get(id)!==job)return;   // stopped: the window asked for it, nothing to say
   this.jobs.delete(id);this.send(owner,{id,type:'error',text:String(error?.message||error).slice(0,300)});
  });
  this.line=run;
 }
 private async ask(key:string,voice:string,input:string,signal:AbortSignal){
  let response:Response;
  try{
   response=await this.fetcher(this.base().replace(/\/+$/,'')+'/audio/speech',{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(TIMEOUT_MS)]),
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:ZONOS_MODEL,voice,input,response_format:'wav'})});
  }catch(error){if(signal.aborted)throw error;throw Error('Zyphra did not answer. Check your connection and try again.');}
  if(!response.ok){await response.arrayBuffer().catch(()=>{});throw Error(refusal(response.status));}
  return readWav(new Uint8Array(await response.arrayBuffer()));
 }
 cancel(id:string,owner:number){const job=this.jobs.get(id);if(job?.owner===owner){this.jobs.delete(id);job.controller.abort();}}
 // A window that closes or navigates away takes its speech with it.
 release(owner:number){for(const [id,job] of this.jobs)if(job.owner===owner)this.cancel(id,owner);}
 stop(reason='The voice stopped.'){for(const [id,job] of this.jobs){this.jobs.delete(id);job.controller.abort();this.send(job.owner,{id,type:'error',text:reason});}}
}
