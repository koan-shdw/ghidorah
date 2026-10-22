import {VoiceGate,type DraftIdentity,type VoiceDraft} from './voice-gate';
import {contextPages,helperAnswer,HELPER_INSTRUCTIONS} from './voice-helper';

export type VoicePhase='idle'|'thinking'|'speaking'|'confirm'|'sending'|'working'|'closed';
export type VoiceSpeaker='helper'|'reply';
export type VoicePlayback={ticket:string;text:string;audio:Uint8Array;mime:string;confirmation:boolean;speaker:VoiceSpeaker};
export type VoiceState={chatId:string;chats:{id:string;title:string}[];draft:VoiceDraft|null;phase:VoicePhase;message:string;transcript:string;turnId:string|null;turnStatus:string|null;speaker:VoiceSpeaker|null};

// Main owns one popup. Every awaited operation belongs to a revision; changing the
// destination or interrupting speech makes its late result unusable.
export class VoiceDesk {
 private gate=new VoiceGate();private revision=0;private operation:AbortController|null=null;private capture:string|null=null;
 private chatId='';private phase:VoicePhase='closed';private message='';private transcript='';private turnId:string|null=null;private turnStatus:string|null=null;
 private dialogue:{speaker:string;text:string}[]=[];private playback:VoicePlayback|null=null;private readAfter=0;
 constructor(private app:{
  chats:()=>{id:string;title:string}[];
  context:(chatId:string,signal:AbortSignal)=>Promise<string>;
  helper:(chatId:string,system:string,prompt:string,signal:AbortSignal)=>Promise<string>;
  decode:(bytes:Uint8Array,signal:AbortSignal)=>Promise<string>;
  speak:(text:string,signal:AbortSignal,speaker:VoiceSpeaker)=>Promise<{audio:Uint8Array;mime:string}>;
  submit:(draft:VoiceDraft)=>Promise<string>;
  result:(id:string)=>{status:string;text:string}|null;
  echoDelay:()=>number;
 }){}
 state():VoiceState{return {chatId:this.chatId,chats:this.app.chats(),draft:this.gate.draft,phase:this.phase,message:this.message,transcript:this.transcript,turnId:this.turnId,turnStatus:this.turnStatus,speaker:this.playback?.speaker||null};}
 private chat(id:string){const chat=this.app.chats().find(chat=>chat.id===id);if(!chat)throw Error('Choose an available chat.');return chat;}
 private cancel(){this.revision++;this.operation?.abort();this.operation=null;this.capture=null;this.gate.cancelCapture();if(this.playback)this.gate.finishPlayback(this.playback.ticket,false);this.playback=null;this.readAfter=0;}
 open(chatId:string){this.chat(chatId);this.cancel();this.gate.clear();this.chatId=chatId;this.phase='idle';this.message='Ready to listen.';this.transcript='';this.turnId=null;this.turnStatus=null;this.dialogue=[];return this.state();}
 close(){this.cancel();this.gate.clear();this.phase='closed';return this.state();}
 interrupt(){if(this.phase==='sending')throw Error('Wait for this message to be accepted.');this.cancel();if(this.phase!=='closed')this.phase=this.turnId?'working':'idle';this.message='Stopped listening and speaking.';return this.state();}
 select(chatId:string){if(this.phase==='sending')throw Error('Wait for this message to be accepted.');this.chat(chatId);if(chatId===this.chatId)return this.state();this.cancel();if(this.gate.draft)this.gate.edit(this.gate.draft,this.gate.draft.text,chatId);this.chatId=chatId;this.dialogue=[];this.turnId=null;this.turnStatus=null;this.phase='idle';this.message='Destination changed. Read the draft again before sending.';return this.state();}
 edit(identity:DraftIdentity,text:string){if(this.phase==='sending'||this.phase==='closed')throw Error('The voice draft is unavailable.');this.cancel();this.gate.edit(identity,text);this.phase='idle';this.message='Draft changed. Read it again before sending.';return this.state();}
 private async run<T>(phase:VoicePhase,work:(signal:AbortSignal,check:()=>void)=>Promise<T>){
  if(this.phase==='closed'||this.phase==='sending'||this.operation)throw Error('Wait for the current voice operation.');
  const revision=++this.revision,controller=this.operation=new AbortController();this.phase=phase;
  const check=()=>{controller.signal.throwIfAborted();if(revision!==this.revision||this.phase==='closed')throw Error('Voice operation cancelled.');this.chat(this.chatId);};
  try{const value=await work(controller.signal,check);check();return value;}catch(error){if(revision===this.revision){this.phase=this.turnId?'working':'idle';this.message=String(error).replace(/^Error: /,'');}throw error;}finally{if(this.operation===controller)this.operation=null;}
 }
 private async speech(text:string,confirmation:boolean,signal:AbortSignal,check:()=>void,speaker:VoiceSpeaker='helper'){
  const identity=confirmation?this.gate.draft:undefined;if(confirmation&&!identity)throw Error('There is no voice draft to read.');
  const ticket=this.gate.beginPlayback(identity||undefined);this.capture=null;this.readAfter=0;
  try{const audio=await this.app.speak(text,signal,speaker);check();this.playback={ticket,text,...audio,confirmation,speaker};this.phase='speaking';this.message=text;return this.playback;}catch(error){this.gate.finishPlayback(ticket,false);throw error;}
 }
 private readText(){const draft=this.gate.draft;if(!draft)throw Error('There is no voice draft to read.');return `To the AI in ${this.chat(draft.chatId).title}: ${draft.text}\nShall I send that?`;}
 read(){return this.run('thinking',(signal,check)=>this.speech(this.readText(),true,signal,check));}
 async input(bytes:Uint8Array){
  return this.run('thinking',async(signal,check)=>{
   this.gate.cancelCapture();this.capture=null;const text=(await this.app.decode(bytes,signal)).trim();check();
   if(!text)throw Error('No clear speech was heard. Try again.');
   this.transcript=text;this.dialogue.push({speaker:'user',text});
   const pages=contextPages(await this.app.context(this.chatId,signal));check();let page=pages.length-1;
   // ponytail: eight context lookups per spoken turn; ask for a narrower question if a long history needs more.
   for(let reads=0;reads<8;reads++){
    const prompt=JSON.stringify({chatId:this.chatId,chats:this.app.chats(),draft:this.gate.draft,context:{page,pages:pages.length,text:pages[page]},dialogue:this.dialogue.slice(-12)});
    if(prompt.length>60000)throw Error('This spoken exchange is too long. Open voice again to start a fresh exchange.');
    const answer=helperAnswer(await this.app.helper(this.chatId,HELPER_INSTRUCTIONS,prompt,signal),this.app.chats().map(chat=>chat.id),pages.length);check();
    if(answer.readPage!==null){page=answer.readPage;continue;}
    if(answer.chatId&&answer.chatId!==this.chatId){this.chat(answer.chatId);this.chatId=answer.chatId;this.turnId=null;this.turnStatus=null;if(this.gate.draft)this.gate.edit(this.gate.draft,this.gate.draft.text,this.chatId);this.dialogue=[];}
    if(answer.draft)this.gate.propose(answer.draft,this.chatId);
    this.dialogue.push({speaker:'helper',text:answer.reply});
    return this.speech(answer.draft?this.readText():answer.reply||'Destination changed.',!!answer.draft,signal,check);
   }
   throw Error('The helper needs a narrower question to check this history.');
  });
 }
 finished(ticket:string,completed:boolean){
  if(typeof completed!=='boolean'||!this.playback||this.playback.ticket!==ticket)throw Error('That playback is no longer current.');
  const confirmation=this.playback.confirmation;this.gate.finishPlayback(ticket,completed);this.playback=null;
  this.phase=completed&&confirmation?'confirm':this.turnId?'working':'idle';this.readAfter=performance.now()+this.app.echoDelay();
  this.message=completed&&confirmation?'Say yes to send, or no to keep the draft.':completed?'Ready to listen.':'Playback stopped. Read the draft again before sending.';return this.state();
 }
 begin(){if(this.phase!=='confirm'||this.readAfter>performance.now()||!this.gate.draft)throw Error('Wait until the draft has finished playing.');this.capture=this.gate.beginCapture(this.gate.draft);return this.capture;}
 async confirm(ticket:string,bytes:Uint8Array){
  if(this.phase!=='confirm'||!this.capture||ticket!==this.capture)throw Error('That confirmation is no longer current.');
  this.capture=null;
  return this.run('thinking',async(signal,check)=>{
   const text=(await this.app.decode(bytes,signal)).trim();check();this.transcript=text;
   const confirmed=this.gate.confirm(ticket,text);
   if(!confirmed.ok){this.phase='idle';this.message=confirmed.reason==='no'?'Kept the draft.':'No clear confirmation. Read the draft again before sending.';return this.state();}
   this.phase='sending';this.message='Sending to the AI…';
   // This consumes the immutable draft once. The normal dispatcher persists its ID
   // before starting work and can report that acceptance after a later failure.
   try{this.turnId=await this.app.submit(confirmed.draft);}catch(error){if(!signal.aborted)this.gate.propose(confirmed.draft.text,confirmed.draft.chatId);throw error;}
   check();this.turnStatus='queued';this.phase='working';this.message='Sent to the AI.';return this.state();
  });
 }
 poll(){
  if(!this.turnId||this.operation||this.phase==='closed'||this.phase==='speaking'||this.phase==='confirm')return Promise.resolve(null);
  const result=this.app.result(this.turnId);if(!result)return Promise.resolve(null);this.turnStatus=result.status;
  if(['queued','dispatching','running','waiting','stopping','needs-model'].includes(result.status)){this.message=result.status==='waiting'?'The AI is waiting for approval in the chat.':result.status==='needs-model'?'Choose a model in the chat.':'The AI is '+result.status+'.';return Promise.resolve(null);}
  const id=this.turnId;return this.run('thinking',async(signal,check)=>{
   const text=`The AI ${result.status==='completed'?'has finished':result.status==='failed'?'failed':result.status}. ${result.text||'Open the chat for details.'}`;
   const playback=await this.speech(text.length>6000?text.slice(0,5900)+' The rest is in the chat.':text,false,signal,check,'reply');if(this.turnId===id)this.turnId=null;return playback;
  });
 }
}
