// Dictation (R4), Claude's one for one: tap the mic or Ctrl+D to start and again to finish, or hold either for half a
// second and let go to finish. While dictating the message box says Connecting... then Listening..., your words appear
// live where the cursor was, X or Esc cancels and puts the box back, ✓ or Enter finishes without sending. It stops by
// itself after a minute without words or ten minutes in all. Audio streams as 16 kHz mono PCM to the local speech
// worker (Claude streams the same to its server). Right-click the mic for the microphone, language and hold setting.
import React,{useEffect,useRef,useState} from 'react';
import {SidebarIcon} from './kit';

export const HOLD_MS=500,SILENCE_MS=60000,LIMIT_MS=10*60*1000;
export const DICTATION_LANGUAGES:Record<string,string>={'':'Auto',en:'English',ja:'Japanese',zh:'Chinese',ko:'Korean',es:'Spanish',fr:'French',de:'German',it:'Italian',pt:'Portuguese',nl:'Dutch',ru:'Russian',hi:'Hindi',ar:'Arabic'};
const NO_SPACE_BEFORE=/^[.,!?;:)\]}%'"…、。，！？]/,CJK=/[　-ヿ㐀-鿿가-힯＀-￯]/;

// The box with the dictated words put where the cursor was, spaced the way Claude spaces them.
export function spliceDictation(before:string,after:string,text:string){
 const words=text.trim();if(!words)return {value:before+after,caret:before.length};
 const left=before&&!/\s$/.test(before)&&!NO_SPACE_BEFORE.test(words)&&!(CJK.test(before.slice(-1))&&CJK.test(words[0]))?' ':'';
 const right=after&&!/^\s/.test(after)&&!NO_SPACE_BEFORE.test(after)&&!(CJK.test(words.slice(-1))&&CJK.test(after[0]))?' ':'';
 return {value:before+left+words+right+after,caret:(before+left+words).length};
}
// Microphone samples at the context's rate to 16 kHz 16-bit PCM.
export function toPcm16(input:Float32Array,rate:number){
 const ratio=rate/16000,length=Math.floor(input.length/ratio),out=new Int16Array(length);
 for(let i=0;i<length;i++){const at=i*ratio,low=Math.floor(at),high=Math.min(low+1,input.length-1),sample=input[low]+(input[high]-input[low])*(at-low);out[i]=Math.max(-32768,Math.min(32767,Math.round(sample*32767)));}
 return out;
}
// Auto follows the app's language, else English, as Claude's does.
export function dictationLanguage(saved:string,ui=navigator.language){const code=ui.slice(0,2).toLowerCase();return saved||(code&&Object.hasOwn(DICTATION_LANGUAGES,code)?code:'en');}

type Problem={title:string;detail:string};
// Saved in this window like Claude's; a window without storage dictates with the defaults.
const saved=(key:string)=>{try{return localStorage.getItem(key)||'';}catch{return '';}};
const settings={get mic(){return saved('dictation-mic');},get language(){return saved('dictation-language');},get hold(){return saved('dictation-hold')!=='off';}};
const LOST='Dictation lost its connection.',KEPT='Your words so far are in the message box.';
export function micProblem(failure:unknown):Problem{
 const name=(failure as any)?.name||'';
 if(name==='NotAllowedError'||name==='SecurityError')return {title:'Microphone access is blocked',detail:'To use dictation, open Windows Settings, go to Privacy and security, select Microphone, and allow Ghidorah.'};
 if(name==='NotFoundError'||name==='OverconstrainedError')return {title:'No microphone found',detail:'Connect a microphone and try again.'};
 if(name==='NotReadableError'||name==='AbortError')return {title:'Your microphone isn\'t available',detail:'Another app or a system setting may be blocking it. Close other apps using the microphone and try again.'};
 if(name==='Dead')return {title:'Your microphone stopped working.',detail:'Ghidorah isn\'t getting any sound from your microphone. Check that it\'s connected and not muted.'};
 const message=String((failure as any)?.message||failure).replace(/^Error invoking remote method 'app': (?:Error: )?/,'').replace(/^Error: /,'');
 return {title:'Couldn\'t start dictation.',detail:message||'Nothing was added to the message box.'};
}
let warmed=false,activeComposer:symbol|null=null;
type Phase='idle'|'connecting'|'recording'|'finishing';
type Run={id:string;before:string;after:string;stop:()=>void;send:()=>void;lastWords:number;started:number;notice:Problem|null;timer?:ReturnType<typeof setInterval>;finishTimer?:ReturnType<typeof setTimeout>};

export function useDictation({chatId,draft,change,input}:{chatId:string;draft:string;change:(value:string)=>void;input:React.RefObject<HTMLTextAreaElement|null>}){
 const [phase,setPhaseState]=useState<Phase>('idle'),[problem,setProblem]=useState<Problem|null>(null),[level,setLevel]=useState(0);
 const self=useRef(Symbol('composer')),live=useRef({draft,change,chatId}),phaseRef=useRef<Phase>('idle'),run=useRef<Run|null>(null),press=useRef<{at:number}|null>(null);
 live.current={draft,change,chatId};
 const setPhase=(next:Phase)=>{phaseRef.current=next;setPhaseState(next);};
 const invoke=(method:string,args:any)=>window.desktop.invoke(method,args);
 function end(next:Problem|null=null){const current=run.current;run.current=null;if(current){current.stop();clearInterval(current.timer);clearTimeout(current.finishTimer);}setPhase('idle');setLevel(0);setProblem(next);}
 function put(current:Run,text:string){const spliced=spliceDictation(current.before,current.after,text);live.current.change(spliced.value);requestAnimationFrame(()=>{const box=input.current;if(box&&document.activeElement===box)box.setSelectionRange(spliced.caret,spliced.caret);});}
 async function start(){
  if(run.current)return;
  const box=input.current,value=live.current.draft,focused=!!box&&document.activeElement===box,from=focused?box!.selectionStart:value.length,to=focused?box!.selectionEnd:value.length;
  const id=crypto.randomUUID(),pcm:Int16Array[]=[];let queued=0,silentSince=0,stream:MediaStream|null=null,context:AudioContext|null=null,closed=false;
  const stop=()=>{closed=true;stream?.getTracks().forEach(track=>track.stop());void context?.close().catch(()=>{});};
  const send=()=>{if(!queued)return;const chunk=new Int16Array(queued);let at=0;for(const part of pcm.splice(0)){chunk.set(part,at);at+=part.length;}queued=0;void invoke('dictationAudio',{id,bytes:new Uint8Array(chunk.buffer)}).catch(()=>{});};
  const current:Run={id,before:value.slice(0,from),after:value.slice(to),stop,send,lastWords:Date.now(),started:Date.now(),notice:null};
  run.current=current;setProblem(null);setPhase('connecting');
  const fail=(failure:unknown)=>{if(run.current!==current)return;void invoke('dictationCancel',{id}).catch(()=>{});live.current.change(current.before+current.after);end(micProblem(failure));};
  try{
   const constraints=(mic:string):MediaStreamConstraints=>({audio:{...(mic?{deviceId:{exact:mic}}:{}),channelCount:1,sampleRate:48000,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
   const saved=settings.mic,[media]=await Promise.all([navigator.mediaDevices.getUserMedia(constraints(saved)).catch(failure=>saved?navigator.mediaDevices.getUserMedia(constraints('')):Promise.reject(failure)),invoke('dictationStart',{id,chatId:live.current.chatId,language:dictationLanguage(settings.language)})]);
   stream=media;if(closed||run.current!==current){stop();return;}
   media.getAudioTracks()[0].onended=()=>fail({name:'Dead'});
   context=new AudioContext();const source=context.createMediaStreamSource(media),processor=context.createScriptProcessor(4096,1,1),mute=context.createGain();mute.gain.value=0;
   processor.onaudioprocess=event=>{
    if(closed)return;const samples=event.inputBuffer.getChannelData(0);let sum=0,zero=true;
    for(let i=0;i<samples.length;i++){sum+=samples[i]*samples[i];if(samples[i]!==0)zero=false;}
    setLevel(Math.min(1,Math.sqrt(sum/samples.length)*8));
    // Two seconds of pure zeros: the microphone is not sending sound (Claude's check).
    if(zero){silentSince||=Date.now();if(Date.now()-silentSince>2000){fail({name:'Dead'});return;}}else silentSince=0;
    const chunk=toPcm16(samples,context!.sampleRate);pcm.push(chunk);queued+=chunk.length;if(queued>=4000)send();
   };
   source.connect(processor);processor.connect(mute);mute.connect(context.destination);
   setPhase('recording');
   current.timer=setInterval(()=>{
    if(run.current!==current||phaseRef.current!=='recording')return;
    if(Date.now()-current.started>LIMIT_MS)finish({title:'Dictation stopped at its time limit.',detail:KEPT});
    else if(!press.current&&Date.now()-current.lastWords>SILENCE_MS)finish({title:'Dictation stopped because it heard no words for 1 minute.',detail:KEPT});
   },1000);
  }catch(failure){fail(failure);}
 }
 function finish(notice:Problem|null=null){
  const current=run.current;if(!current||phaseRef.current==='finishing')return;
  if(phaseRef.current==='connecting'){cancel();return;}
  current.send();current.stop();current.notice=notice;setPhase('finishing');setLevel(0);
  current.finishTimer=setTimeout(()=>{if(run.current===current)end({title:LOST,detail:KEPT});},30000);
  void invoke('dictationFinish',{id:current.id}).catch(()=>{});
 }
 function cancel(){const current=run.current;if(!current)return;void invoke('dictationCancel',{id:current.id}).catch(()=>{});live.current.change(current.before+current.after);end();}
 useEffect(()=>window.desktop.onDictation(event=>{
  const current=run.current;if(!current||event.id!==current.id)return;
  if(event.type==='partial'){current.lastWords=Date.now();put(current,event.text||'');}
  else if(event.type==='final'){put(current,event.text||'');end(current.notice);}
  else end(event.text===LOST?{title:LOST,detail:KEPT}:{title:'Couldn\'t finish dictation.',detail:event.text||'Nothing was added to the message box.'});
 }),[]);
 useEffect(()=>()=>{const current=run.current;run.current=null;if(current){void invoke('dictationCancel',{id:current.id}).catch(()=>{});current.stop();clearInterval(current.timer);clearTimeout(current.finishTimer);}},[]);
 useEffect(()=>{if(run.current)cancel();},[chatId]);
 // A press starts, or finishes when dictating; letting go of a press held half a second finishes (hold to talk).
 function down(){if(phaseRef.current==='idle'){press.current={at:Date.now()};void start();}else{press.current=null;finish();}}
 function up(){const held=press.current;press.current=null;if(held&&settings.hold&&Date.now()-held.at>=HOLD_MS)finish();}
 useEffect(()=>{
  const key=(event:KeyboardEvent)=>{
   if(activeComposer!==self.current||!(event.ctrlKey||event.metaKey)||event.altKey||event.shiftKey||event.key.toLowerCase()!=='d')return;
   event.preventDefault();if(event.type==='keydown'&&!event.repeat)down();else if(event.type==='keyup')up();
  };
  const release=(event:KeyboardEvent)=>{if(press.current&&(event.key==='Control'||event.key==='Meta'))up();};
  window.addEventListener('keydown',key);window.addEventListener('keyup',key);window.addEventListener('keyup',release);
  return ()=>{window.removeEventListener('keydown',key);window.removeEventListener('keyup',key);window.removeEventListener('keyup',release);};
 },[]);
 useEffect(()=>()=>{if(activeComposer===self.current)activeComposer=null;},[]);
 return {phase,problem,level,start,finish,cancel,down,up,
  // The composer you last typed in owns Ctrl+D. Its first focus loads the speech model so the first press is quick.
  focus(){activeComposer=self.current;if(!warmed){warmed=true;void invoke('dictationWarm',{}).catch(()=>{});}},
  dismiss(){setProblem(null);},
  placeholder:phase==='connecting'?'Connecting...':phase==='recording'||phase==='finishing'?'Listening...':'',
  // Esc cancels and Enter finishes while dictating; neither sends.
  key(event:React.KeyboardEvent){if(phaseRef.current==='idle')return false;if(event.key==='Escape'){event.preventDefault();cancel();return true;}if(event.key==='Enter'){event.preventDefault();finish();return true;}return false;}};
}
export type Dictation=ReturnType<typeof useDictation>;

export function DictationControls({dictation,disabled}:{dictation:Dictation;disabled:boolean}){
 const {phase,problem,level}=dictation,[menu,setMenu]=useState(false),active=phase!=='idle';
 const label=phase==='recording'?'Stop dictation':phase==='finishing'?'Finishing dictation…':phase==='connecting'?'Connecting…':'Dictate';
 return <>
  <button type="button" className={'dictation-trigger '+phase} aria-label={active?'Stop dictation':'Dictate'} aria-pressed={active} title={label+' · Ctrl+D · Right-click for microphone settings'} disabled={(disabled&&!active)||phase==='finishing'} style={{'--level':level} as React.CSSProperties}
   onPointerDown={event=>{if(event.button===0){event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);dictation.down();}}} onPointerUp={event=>{if(event.button===0)dictation.up();}} onPointerCancel={()=>dictation.up()}
   onClick={event=>{if(event.detail===0)dictation.down();}} onContextMenu={event=>{event.preventDefault();setMenu(true);}} onKeyDown={event=>{if(event.shiftKey&&event.key==='F10'){event.preventDefault();setMenu(true);}}}>
   <SidebarIcon name={active?'stop':'microphone'}/>
  </button>
  {active&&<><button type="button" className="dictation-cancel" aria-label="Cancel dictation" title="Cancel · Esc" onClick={()=>dictation.cancel()}>✕</button><button type="button" className="dictation-done" aria-label="Finish dictation" title="Done · Enter" disabled={phase!=='recording'} onClick={()=>dictation.finish()}>✓</button></>}
  {problem&&<span className="dictation-error" role="alert"><strong>{problem.title}</strong> {problem.detail} <button type="button" onClick={()=>{dictation.dismiss();void dictation.start();}}>Dictate again</button></span>}
  {menu&&<DictationMenu close={()=>setMenu(false)}/>}
 </>;
}

function DictationMenu({close}:{close:()=>void}){
 const [mics,setMics]=useState<MediaDeviceInfo[]>([]),[,redraw]=useState(0),ref=useRef<HTMLDivElement>(null);
 useEffect(()=>{void navigator.mediaDevices.enumerateDevices().then(all=>setMics(all.filter(device=>device.kind==='audioinput'&&device.deviceId!=='default'&&device.deviceId!=='communications'))).catch(()=>{});
  const away=(event:PointerEvent)=>{if(ref.current&&!ref.current.contains(event.target as Node))close();},escape=(event:KeyboardEvent)=>{if(event.key==='Escape')close();};
  document.addEventListener('pointerdown',away);document.addEventListener('keydown',escape);ref.current?.querySelector('select')?.focus();
  return ()=>{document.removeEventListener('pointerdown',away);document.removeEventListener('keydown',escape);};},[]);
 const save=(key:string,value:string)=>{try{if(value)localStorage.setItem(key,value);else localStorage.removeItem(key);}catch{}redraw(n=>n+1);};
 return <div ref={ref} className="dictation-menu" role="dialog" aria-label="Dictation settings">
  <label>Microphone<select aria-label="Microphone" value={settings.mic} onChange={event=>save('dictation-mic',event.target.value)}><option value="">System default</option>{mics.map((mic,index)=><option key={mic.deviceId} value={mic.deviceId}>{mic.label||'Microphone '+(index+1)}</option>)}</select></label>
  <label>Language<select aria-label="Dictation language" value={settings.language} onChange={event=>save('dictation-language',event.target.value)}>{Object.entries(DICTATION_LANGUAGES).map(([code,name])=><option key={code} value={code}>{name}</option>)}</select></label>
  <label className="dictation-hold"><input type="checkbox" checked={settings.hold} onChange={event=>save('dictation-hold',event.target.checked?'':'off')}/>Hold to record</label>
 </div>;
}
