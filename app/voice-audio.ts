export const VOICE_RATE=16000;

export function pcmWave(pcm:Int16Array){
 const bytes=new Uint8Array(44+pcm.length*2),view=new DataView(bytes.buffer);
 const text=(offset:number,value:string)=>{for(let i=0;i<value.length;i++)bytes[offset+i]=value.charCodeAt(i);};
 text(0,'RIFF');view.setUint32(4,bytes.length-8,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,VOICE_RATE,true);view.setUint32(28,VOICE_RATE*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,pcm.length*2,true);
 for(let i=0;i<pcm.length;i++)view.setInt16(44+i*2,pcm[i],true);
 return bytes;
}

// Keep the threshold and quiet interval adjustable for the user's microphone and room.
// ponytail: RMS detects speech boundaries, not words; add a trained VAD only if room calibration is insufficient.
export class SpeechSegment {
 private frames:Int16Array[]=[];private prefix:Int16Array[]=[];private quiet=0;private samples=0;private voiced=0;private finished=false;
 constructor(private threshold=.015,private silenceMs=640,private maxMs=30000){
  if(!Number.isFinite(threshold)||threshold<.001||threshold>.2||!Number.isFinite(silenceMs)||silenceMs<240||silenceMs>2000||!Number.isFinite(maxMs)||maxMs<1000||maxMs>60000)throw Error('Invalid microphone settings.');
 }
 push(frame:Int16Array):{pcm:Int16Array;complete:boolean}|null{
  if(this.finished)throw Error('This microphone capture has finished.');
  if(!(frame instanceof Int16Array)||!frame.length||frame.length>2560)throw Error('Invalid microphone frame.');
  let energy=0;for(const value of frame)energy+=(value/32768)**2;
  const voice=Math.sqrt(energy/frame.length)>=this.threshold;
  if(!this.frames.length&&!voice){this.prefix.push(frame.slice());while(this.prefix.reduce((n,row)=>n+row.length,0)>VOICE_RATE*.24)this.prefix.shift();return null;}
  if(!this.frames.length){this.frames=this.prefix;this.prefix=[];this.samples=this.frames.reduce((n,row)=>n+row.length,0);}
  this.frames.push(frame.slice());this.samples+=frame.length;this.quiet=voice?0:this.quiet+frame.length;if(voice)this.voiced+=frame.length;
  const complete=this.quiet>=VOICE_RATE*this.silenceMs/1000;
  if(!complete&&this.samples<VOICE_RATE*this.maxMs/1000)return null;
  this.finished=true;const pcm=new Int16Array(this.samples);let at=0;for(const row of this.frames){pcm.set(row,at);at+=row.length;}
  return {pcm,complete:complete&&this.voiced>=VOICE_RATE*.08};
 }
}

export async function microphoneFrames(onFrame:(pcm:Int16Array)=>void,signal:AbortSignal,onError:(error:Error)=>void){
 let stream:MediaStream|null=null,context:AudioContext|null=null,node:AudioWorkletNode|null=null,stopped=false;
 const ended=()=>{if(!stopped){stop();onError(Error('The microphone disconnected. Start listening again.'));}};
 const stop=()=>{if(stopped)return;stopped=true;signal.removeEventListener('abort',stop);if(node){node.port.onmessage=null;node.onprocessorerror=null;node.disconnect();node.port.close();}stream?.getTracks().forEach(track=>{track.removeEventListener('ended',ended);track.stop();});if(context)void context.close().catch(()=>{});};
 signal.addEventListener('abort',stop,{once:true});
 try{
  signal.throwIfAborted();stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
  if(stopped||signal.aborted){stream.getTracks().forEach(track=>track.stop());throw Error('Microphone capture cancelled.');}
  for(const track of stream.getTracks())track.addEventListener('ended',ended,{once:true});
  context=new AudioContext({sampleRate:VOICE_RATE});if(context.sampleRate!==VOICE_RATE)throw Error('The microphone could not use 16 kHz audio.');
  await context.audioWorklet.addModule(new URL('voice-worklet.js',import.meta.url));signal.throwIfAborted();
  node=new AudioWorkletNode(context,'trismegistus-microphone');node.port.onmessage=event=>{if(!stopped&&event.data instanceof ArrayBuffer)try{onFrame(new Int16Array(event.data));}catch(error){stop();onError(error instanceof Error?error:Error(String(error)));}};
  node.onprocessorerror=()=>{stop();onError(Error('Microphone processing stopped. Start listening again.'));};
  const source=context.createMediaStreamSource(stream),mute=context.createGain();mute.gain.value=0;source.connect(node);node.connect(mute);mute.connect(context.destination);await context.resume();signal.throwIfAborted();
  return stop;
 }catch(error){stop();throw error;}
}
