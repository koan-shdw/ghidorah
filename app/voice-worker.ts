// The voice that speaks replies: one Kokoro worker kept loaded while it is in use, like the dictation worker. A window
// asks for text in a voice; the sound comes back to that window only, piece by piece. No Electron in this file.
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';

export type SpokenEvent={id:string;type:'audio'|'end'|'error';index?:number;rate?:number;pcm?:string;text?:string};
export type SpeakRequest={pieces:string[];a:string;b:string;balance:number;speed:number};

export class VoiceWorker {
 private child:ChildProcessWithoutNullStreams|null=null;private starting:Promise<void>|null=null;private failStart?:(error:Error)=>void;private key='';private idle?:NodeJS.Timeout;
 private jobs=new Map<string,number>();
 // send: an event for one window. idleMs: the model is let go after this long without speaking.
 constructor(private launch:(key:string)=>ChildProcessWithoutNullStreams,private send:(owner:number,event:SpokenEvent)=>void,private idleMs=10*60*1000){}
 get loaded(){return !!this.child&&!this.starting;}
 // key: the runtime the model was loaded with; a different key starts a fresh worker.
 private start(key:string):Promise<void>{
  this.touch();
  if(this.child&&this.key===key)return this.starting||Promise.resolve();
  this.stop('The voice changed. Play it again.');
  this.key=key;let ready!:()=>void,failed!:(error:Error)=>void,errors='';
  const child=this.child=this.launch(key);
  this.starting=new Promise<void>((resolve,reject)=>{ready=resolve;failed=reject;});this.failStart=failed;
  this.starting.catch(()=>{});
  child.stdin.on('error',()=>{});child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-2000);});
  createInterface({input:child.stdout}).on('line',line=>{
   let event:any;try{event=JSON.parse(line);}catch{return;}
   if(event.type==='ready'){this.starting=null;ready();return;}
   const id=String(event.id||''),owner=this.jobs.get(id);if(owner===undefined)return;
   if(event.type==='audio'&&typeof event.pcm==='string')this.send(owner,{id,type:'audio',index:Number(event.index)||0,rate:Number(event.rate)||24000,pcm:event.pcm});
   else if(event.type==='end'||event.type==='error'){this.jobs.delete(id);this.send(owner,{id,type:event.type,text:String(event.text||'')});}
  });
  const ended=(error?:Error)=>{
   if(this.child!==child)return;
   const reason=(error?.message||errors.trim().split(/\r?\n/).filter(Boolean).at(-1)||'').slice(0,300);
   this.child=null;this.key='';
   if(this.starting){this.starting=null;failed(Error(reason||'The voice did not start.'));}
   for(const [id,owner] of this.jobs)this.send(owner,{id,type:'error',text:reason||'The voice stopped.'});
   this.jobs.clear();
  };
  child.once('error',ended);child.once('exit',()=>ended());
  return this.starting;
 }
 private write(message:object){this.child?.stdin.write(JSON.stringify(message)+'\n');}
 private touch(){clearTimeout(this.idle);this.idle=setTimeout(()=>{if(this.jobs.size)this.touch();else this.stop();},this.idleMs);this.idle.unref?.();}
 /** Speak for one window. Whatever that window was already having said stops. */
 async speak(key:string,id:string,owner:number,request:SpeakRequest){
  this.release(owner);
  const starting=this.start(key);this.jobs.set(id,owner);
  try{await starting;}catch(error){this.jobs.delete(id);throw error;}
  if(this.jobs.get(id)!==owner)return; // stopped while the model loaded
  this.write({op:'speak',id,...request});this.touch();
 }
 cancel(id:string,owner:number){if(this.jobs.get(id)===owner){this.jobs.delete(id);this.write({op:'cancel',id});}}
 // A window that closes or navigates away takes its speech with it.
 release(owner:number){for(const [id,other] of this.jobs)if(other===owner)this.cancel(id,owner);}
 stop(reason='The voice stopped.'){
  clearTimeout(this.idle);const child=this.child;this.child=null;this.key='';
  if(this.starting){this.starting=null;this.failStart?.(Error(reason));}
  for(const [id,owner] of this.jobs)this.send(owner,{id,type:'error',text:reason});
  this.jobs.clear();if(child){child.stdin.end();child.kill();}
 }
}
