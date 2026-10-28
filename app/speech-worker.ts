// Dictation (R4): one speech worker keeps the Whisper model loaded while dictation is in use, the way Claude's
// dictation keeps a stream open, so a press costs a pass of the model and not a load of it. Sessions belong to the
// window that started them; the worker's text goes back to that window only. No Electron in this file.
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';

export type SpeechEvent={id?:string;type:'ready'|'partial'|'final'|'error';text?:string;device?:string;cards?:number;problem?:string};
export interface DictationSession {owner:number;chatId:string;bytes:number}
const SECOND=16000*2,LIMIT=10*60*SECOND+30*SECOND; // Claude's 10-minute limit, with room for the last chunk

export class SpeechWorker {
 device='';cards=0;problem='';
 sessions=new Map<string,DictationSession>();
 private child:ChildProcessWithoutNullStreams|null=null;private starting:Promise<void>|null=null;private failStart?:(error:Error)=>void;private key='';private idle?:NodeJS.Timeout;
 // send: an event for one window. idleMs: the model is let go after this long without dictation.
 constructor(private launch:(key:string)=>ChildProcessWithoutNullStreams,private send:(owner:number,event:SpeechEvent)=>void,private changed:()=>void=()=>{},private idleMs=20*60*1000){}
 get ready(){return !!this.child&&!this.starting;}
 // key: the model and runtime it was loaded with; a different key starts a fresh worker.
 start(key:string):Promise<void>{
  this.touch();
  if(this.child&&this.key===key)return this.starting||Promise.resolve();
  this.stop('The speech model changed. Dictate again.');
  this.key=key;let ready!:()=>void,failed!:(error:Error)=>void,errors='';
  const child=this.child=this.launch(key);
  this.starting=new Promise<void>((resolve,reject)=>{ready=resolve;failed=reject;});this.failStart=failed;
  this.starting.catch(()=>{});
  child.stdin.on('error',()=>{});child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-2000);});
  createInterface({input:child.stdout}).on('line',line=>{
   let event:SpeechEvent;try{event=JSON.parse(line);}catch{return;}
   if(event.type==='ready'){this.device=String(event.device||'');this.cards=Number(event.cards)||0;this.problem=String(event.problem||'');this.starting=null;ready();this.changed();return;}
   const session=event.id?this.sessions.get(event.id):undefined;if(!session)return;
   if(event.type==='final'||event.type==='error')this.sessions.delete(event.id!);
   this.send(session.owner,{id:event.id,type:event.type,text:String(event.text||'')});
  });
  const ended=(error?:Error)=>{
   if(this.child!==child)return;
   const reason=(error?.message||errors.trim().split(/\r?\n/).filter(Boolean).at(-1)||'').slice(0,300);
   this.child=null;this.key='';
   if(this.starting){this.starting=null;failed(Error(reason||'The speech worker did not start.'));}
   for(const [id,session] of this.sessions)this.send(session.owner,{id,type:'error',text:'Dictation lost its connection.'});
   this.sessions.clear();this.changed();
  };
  child.once('error',ended);child.once('exit',()=>ended());
  return this.starting;
 }
 private write(message:object){this.child?.stdin.write(JSON.stringify(message)+'\n');}
 private touch(){clearTimeout(this.idle);this.idle=setTimeout(()=>{if(!this.sessions.size)this.stop();},this.idleMs);this.idle.unref?.();}
 open(id:string,owner:number,chatId:string,language:string){
  if(!this.ready)throw Error('Dictation is still starting.');
  for(const [other,session] of this.sessions)if(session.owner===owner)this.cancel(other,owner);
  this.sessions.set(id,{owner,chatId,bytes:0});this.write({op:'start',id,language});this.touch();
 }
 // 16 kHz mono 16-bit PCM from the owner's window.
 audio(id:string,owner:number,bytes:Uint8Array){
  const session=this.own(id,owner);if(!session)return;
  if(!bytes.length||bytes.length%2||bytes.length>64*1024)throw Error('Invalid dictation audio.');
  session.bytes+=bytes.length;if(session.bytes>LIMIT){this.finish(id,owner);return;}
  this.write({op:'audio',id,pcm:Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).toString('base64')});this.touch();
 }
 finish(id:string,owner:number){if(this.own(id,owner))this.write({op:'finish',id});}
 cancel(id:string,owner:number){if(this.own(id,owner)){this.sessions.delete(id);this.write({op:'cancel',id});}}
 // A window that closes or navigates away takes its dictation with it.
 release(owner:number){for(const [id,session] of this.sessions)if(session.owner===owner)this.cancel(id,owner);}
 private own(id:string,owner:number){const session=this.sessions.get(id);return session?.owner===owner?session:undefined;}
 stop(reason='Dictation stopped.'){
  clearTimeout(this.idle);const child=this.child;this.child=null;this.key='';
  if(this.starting){this.starting=null;this.failStart?.(Error(reason));}
  for(const [id,session] of this.sessions)this.send(session.owner,{id,type:'error',text:reason});
  this.sessions.clear();if(child){child.stdin.end();child.kill();}
 }
}
