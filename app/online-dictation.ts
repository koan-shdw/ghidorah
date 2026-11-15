// Dictation through an online engine (Koan 2026-11-15): Deepgram Nova-3 or ElevenLabs Scribe v3 Live, each on the
// user's own key, connected the way the service's own documents say. It works the way Claude's dictation does: the
// sound is held while the connection opens so the first words are never lost, changing guesses come back for the
// phrase being said, a pause of 0.3 s makes the phrase final, and after Done it waits up to 2 s for the last words.
// The window that started a dictation gets its text, as with the local engine. No Electron in this file.
import WebSocket from 'ws';
import type {OnlineEngine} from './listening';
import type {SpeechEvent} from './speech-worker';

export const LISTEN_URLS:Record<OnlineEngine,string>={deepgram:'wss://api.deepgram.com/v1/listen',elevenlabs:'wss://api.elevenlabs.io/v1/speech-to-text/realtime'};
export const LAST_WORDS_MS=2000,PAUSE_MS=300;
const HELD=30*16000*2;   // the most sound held while the connection opens: 30 s
const NO_SPACE_BEFORE=/^[.,!?;:)\]}%'"…]/;
const NAMES:Record<OnlineEngine,string>={deepgram:'Deepgram',elevenlabs:'ElevenLabs'};

/** Two stretches of text as one, spaced as speech is written. */
export function joinWords(left:string,right:string){
 left=left.trim();right=right.trim();
 if(!left||!right)return left||right;
 return NO_SPACE_BEFORE.test(right)?left+right:left+' '+right;
}
/** The address a dictation connects to. hints: the user's own names, sent as key terms when there are any. */
export function listenUrl(engine:OnlineEngine,language:string,hints:string[],base=LISTEN_URLS[engine]){
 const url=new URL(base);
 if(engine==='deepgram'){
  for(const [key,value] of Object.entries({model:'nova-3',language:language||'en',encoding:'linear16',sample_rate:'16000',channels:'1',interim_results:'true',endpointing:String(PAUSE_MS),utterance_end_ms:'1000',smart_format:'true'}))url.searchParams.set(key,value);
  for(const hint of hints.slice(0,40))url.searchParams.append('keyterm',hint);
 }else{
  for(const [key,value] of Object.entries({model_id:'scribe_v3_live',audio_format:'pcm_16000',commit_strategy:'vad',vad_silence_threshold_secs:String(PAUSE_MS/1000)}))url.searchParams.set(key,value);
  if(language)url.searchParams.set('language_code',language);
  // ElevenLabs takes at most 50 key terms of 20 characters each on a live connection.
  for(const hint of hints.filter(hint=>hint.length<=20).slice(0,50))url.searchParams.append('keyterms',hint);
 }
 return url.toString();
}
export const listenHeaders=(engine:OnlineEngine,key:string):Record<string,string>=>engine==='deepgram'?{Authorization:'Token '+key}:{'xi-api-key':key};
/** Why a connection was refused, in the user's words. */
export function refusal(engine:OnlineEngine,status:number){
 if(status===401||status===403)return NAMES[engine]+' refused the key. Check it in Settings › Voice.';
 if(status===402)return NAMES[engine]+' reports no credit left on this account.';
 if(status===429)return NAMES[engine]+' is limiting this account. Try again in a moment.';
 return NAMES[engine]+' did not connect ('+status+').';
}
export type Heard={kind:'interim'|'final'|'error'|'ready'|'none';text:string};
/** What one message from the service means: a changing guess, a finished phrase, an error, or nothing to show. */
export function readMessage(engine:OnlineEngine,data:string):Heard{
 let value:any;try{value=JSON.parse(data);}catch{return {kind:'none',text:''};}
 if(engine==='deepgram'){
  if(value?.type==='Results'){const text=String(value.channel?.alternatives?.[0]?.transcript||'');return {kind:value.is_final?'final':'interim',text};}
  if(value?.type==='Error')return {kind:'error',text:String(value.description||value.variant||'Deepgram reported an error.').slice(0,300)};
  return {kind:'none',text:''};
 }
 const type=String(value?.message_type||'');
 if(type==='session_started')return {kind:'ready',text:''};
 if(type==='partial_transcript')return {kind:'interim',text:String(value.text||'')};
 if(type==='committed_transcript')return {kind:'final',text:String(value.text||'')};
 if(type==='auth_error')return {kind:'error',text:refusal('elevenlabs',401)};
 if(type==='quota_exceeded')return {kind:'error',text:refusal('elevenlabs',402)};
 if(/error|exceeded|limited|throttled|overflow|exhausted|unaccepted/.test(type)||type==='invalid_request')return {kind:'error',text:String(value.error||'ElevenLabs reported an error.').slice(0,300)};
 return {kind:'none',text:''};
}
type Connect=(url:string,headers:Record<string,string>)=>WebSocket;
const dial:Connect=(url,headers)=>new WebSocket(url,{headers,handshakeTimeout:12000,maxPayload:2*1024*1024,perMessageDeflate:false});

/** Whether the service takes this key: one connection opened and closed, with no sound sent, so nothing is billed. */
export function checkKey(engine:OnlineEngine,key:string,base?:string,connect:Connect=dial){
 return new Promise<void>((resolve,reject)=>{
  const socket=connect(listenUrl(engine,'en',[],base),listenHeaders(engine,key));let settled=false;
  const end=(error?:string)=>{if(settled)return;settled=true;clearTimeout(timer);try{socket.close();}catch{/* never opened */}if(error)reject(Error(error));else resolve();};
  const timer=setTimeout(()=>end(NAMES[engine]+' did not answer. Check your connection and try again.'),15000);
  socket.on('open',()=>{if(engine==='deepgram')end();});
  socket.on('message',data=>{const heard=readMessage(engine,data.toString());if(heard.kind==='ready')end();else if(heard.kind==='error')end(heard.text);});
  socket.on('unexpected-response',(_request,response)=>{response.resume();end(refusal(engine,response.statusCode||0));});
  socket.on('error',()=>end(NAMES[engine]+' did not connect. Check your connection and try again.'));
  socket.on('close',()=>end(NAMES[engine]+' closed the connection before it was ready.'));
 });
}

type Session={owner:number;engine:OnlineEngine;socket:WebSocket;open:boolean;held:Buffer[];heldBytes:number;locked:string;interim:string;shown:string;finishing:boolean;timer?:ReturnType<typeof setTimeout>};
export class OnlineDictation {
 private sessions=new Map<string,Session>();
 // send: an event for one window, in the local engine's own shape.
 constructor(private send:(owner:number,event:SpeechEvent)=>void,private connect:Connect=dial){}
 has(id:string){return this.sessions.has(id);}
 /** Start a dictation. Sound sent before the connection is open is held and goes first. */
 open(id:string,owner:number,engine:OnlineEngine,key:string,language:string,hints:string[],base?:string){
  this.release(owner);
  const socket=this.connect(listenUrl(engine,language,hints,base),listenHeaders(engine,key));
  const session:Session={owner,engine,socket,open:false,held:[],heldBytes:0,locked:'',interim:'',shown:'',finishing:false};
  this.sessions.set(id,session);
  const ready=()=>{if(session.open||this.sessions.get(id)!==session)return;session.open=true;for(const bytes of session.held.splice(0))this.write(session,bytes);session.heldBytes=0;if(session.finishing)this.flush(id,session);};
  socket.on('open',()=>{if(engine==='deepgram')ready();});
  socket.on('message',data=>{
   if(this.sessions.get(id)!==session)return;
   const heard=readMessage(engine,data.toString());
   if(heard.kind==='ready'){ready();return;}
   if(heard.kind==='error'){this.fail(id,session,heard.text);return;}
   if(heard.kind==='none')return;
   if(heard.kind==='final'){session.locked=joinWords(session.locked,heard.text);session.interim='';}else session.interim=heard.text;
   const shown=joinWords(session.locked,session.interim);
   if(shown!==session.shown&&!session.finishing){session.shown=shown;this.send(owner,{id,type:'partial',text:shown});}
   // ElevenLabs answers the closing commit with the last phrase; Deepgram closes the connection when it has sent all.
   if(session.finishing&&heard.kind==='final'&&engine==='elevenlabs')this.done(id,session);
  });
  socket.on('unexpected-response',(_request,response)=>{response.resume();this.fail(id,session,refusal(engine,response.statusCode||0));});
  socket.on('error',()=>this.fail(id,session,session.open?'Dictation lost its connection.':NAMES[engine]+' did not connect. Check your connection and try again.'));
  socket.on('close',()=>{if(this.sessions.get(id)!==session)return;if(session.finishing)this.done(id,session);else this.fail(id,session,'Dictation lost its connection.');});
 }
 private write(session:Session,bytes:Buffer){
  if(session.socket.readyState!==WebSocket.OPEN)return;
  if(session.engine==='deepgram')session.socket.send(bytes);
  else session.socket.send(JSON.stringify({message_type:'input_audio_chunk',audio_base_64:bytes.toString('base64'),commit:false,sample_rate:16000}));
 }
 // 16 kHz mono 16-bit PCM from the owner's window.
 audio(id:string,owner:number,bytes:Uint8Array){
  const session=this.own(id,owner);if(!session||session.finishing)return;
  if(!bytes.length||bytes.length%2||bytes.length>64*1024)throw Error('Invalid dictation audio.');
  const chunk=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(session.open){this.write(session,chunk);return;}
  if(session.heldBytes+chunk.length>HELD){this.fail(id,session,NAMES[session.engine]+' did not connect. Check your connection and try again.');return;}
  session.held.push(Buffer.from(chunk));session.heldBytes+=chunk.length;
 }
 /** Done: the service is asked for what it still holds, and the text is final when it answers or after 2 s. */
 finish(id:string,owner:number){
  const session=this.own(id,owner);if(!session||session.finishing)return;
  session.finishing=true;
  if(session.open)this.flush(id,session);else session.timer=setTimeout(()=>this.done(id,session),LAST_WORDS_MS+12000);
 }
 private flush(id:string,session:Session){
  clearTimeout(session.timer);
  if(session.socket.readyState===WebSocket.OPEN){
   if(session.engine==='deepgram')session.socket.send(JSON.stringify({type:'CloseStream'}));
   // A tenth of a second of silence carries the commit: the service finishes the phrase it is holding.
   else session.socket.send(JSON.stringify({message_type:'input_audio_chunk',audio_base_64:Buffer.alloc(3200).toString('base64'),commit:true,sample_rate:16000}));
  }
  session.timer=setTimeout(()=>this.done(id,session),LAST_WORDS_MS);
 }
 private done(id:string,session:Session){
  if(this.sessions.get(id)!==session)return;
  this.drop(id,session);this.send(session.owner,{id,type:'final',text:joinWords(session.locked,session.interim)});
 }
 private fail(id:string,session:Session,text:string){
  if(this.sessions.get(id)!==session)return;
  // Words already heard are not lost with the connection: Done with what there is.
  if(session.finishing&&(session.locked||session.interim)){this.done(id,session);return;}
  this.drop(id,session);this.send(session.owner,{id,type:'error',text});
 }
 private drop(id:string,session:Session){
  this.sessions.delete(id);clearTimeout(session.timer);
  try{session.socket.removeAllListeners();session.socket.on('error',()=>{});if(session.socket.readyState===WebSocket.CONNECTING)session.socket.terminate();else session.socket.close();}catch{/* already gone */}
 }
 cancel(id:string,owner:number){const session=this.own(id,owner);if(session)this.drop(id,session);}
 // A window that closes or navigates away takes its dictation with it.
 release(owner:number){for(const [id,session] of this.sessions)if(session.owner===owner)this.drop(id,session);}
 private own(id:string,owner:number){const session=this.sessions.get(id);return session?.owner===owner?session:undefined;}
 stop(){for(const [id,session] of this.sessions){this.drop(id,session);this.send(session.owner,{id,type:'error',text:'Dictation stopped.'});}}
}
