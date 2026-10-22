// Schedule PCM chunks as they arrive and release each buffer after playback.
export class VoicePlayer {
 private context:AudioContext;private until=0;private sources=new Set<AudioBufferSourceNode>();private waiting:((completed:boolean)=>void)[]=[];
 constructor(){this.context=new AudioContext({sampleRate:24000});}
 async ready(){await this.context.resume();}
 push(bytes:Uint8Array){
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length%2)throw Error('Incomplete voice audio.');
  const duration=bytes.length/2/24000,start=Math.max(this.context.currentTime+.015,this.until);
  if(start+duration-this.context.currentTime>60)throw Error('Voice playback fell behind. Press Listen to reconnect.');
  const buffer=this.context.createBuffer(1,bytes.length/2,24000),samples=buffer.getChannelData(0),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(i*2,true)/32768;
  const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.context.destination);this.sources.add(source);
  source.onended=()=>{source.disconnect();source.buffer=null;this.sources.delete(source);if(!this.sources.size)this.resolve(true);};source.start(start);this.until=start+duration;
 }
 drain(){return this.sources.size?new Promise<boolean>(resolve=>this.waiting.push(resolve)):Promise.resolve(true);}
 private resolve(completed:boolean){for(const resolve of this.waiting.splice(0))resolve(completed);}
 clear(){for(const source of this.sources){source.onended=null;source.stop();source.disconnect();source.buffer=null;}this.sources.clear();this.until=0;this.resolve(false);}
 close(){this.clear();void this.context.close().catch(()=>{});}
}
