import React,{useEffect,useRef,useState} from 'react';
import {SidebarIcon} from './kit';

const message=(failure:unknown)=>String(failure instanceof Error?failure.message:failure).replace(/^Error invoking remote method 'app': (?:Error: )?/,'').replace(/^Error: /,'');
export function DictationButton({disabled,dictate,insert}:{disabled:boolean;dictate:(bytes:Uint8Array,mime:string,signal:AbortSignal)=>Promise<string>;insert:(text:string)=>void}){
 const [phase,setPhase]=useState<'idle'|'requesting'|'recording'|'writing'>('idle'),[error,setError]=useState('');
 const active=useRef<AbortController|null>(null),stream=useRef<MediaStream|null>(null),recorder=useRef<MediaRecorder|null>(null),latest=useRef({dictate,insert});
 latest.current={dictate,insert};
 function release(){const media=recorder.current;recorder.current=null;try{if(media){media.onstop=null;media.ondataavailable=null;media.onerror=null;if(media.state!=='inactive')media.stop();}}finally{stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;}}
 function cancel(){active.current?.abort();active.current=null;release();}
 useEffect(()=>cancel,[]);
 async function start(){
  if(active.current||disabled)return;
  const controller=new AbortController();active.current=controller;setPhase('requesting');setError('');
  const current=()=>active.current===controller&&!controller.signal.aborted;
  try{
   const acquired=await navigator.mediaDevices.getUserMedia({audio:true});
   if(!current()){acquired.getTracks().forEach(track=>track.stop());return;}
   stream.current=acquired;
   const mime=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'].find(type=>MediaRecorder.isTypeSupported(type));
   if(!mime)throw Error('This window cannot record audio.');
   const media=new MediaRecorder(acquired,{mimeType:mime}),chunks:Blob[]=[];let size=0;recorder.current=media;
   media.ondataavailable=event=>{
    if(!current()||!event.data.size)return;
    size+=event.data.size;
    if(size>50*1024*1024){cancel();setPhase('idle');setError('That recording is too long. Record a shorter message.');return;}
    chunks.push(event.data);
   };
   media.onerror=()=>{if(current()){cancel();setPhase('idle');setError('Microphone recording failed. Try again.');}};
   media.onstop=async()=>{
    if(!current())return;
    release();setPhase('writing');
    try{
     const blob=new Blob(chunks,{type:mime}),bytes=new Uint8Array(await blob.arrayBuffer());
     if(!current())return;
     const text=(await latest.current.dictate(bytes,mime,controller.signal)).trim();
     if(current()&&text)latest.current.insert(text);
    }catch(failure){if(current())setError(message(failure));}
    finally{if(current()){active.current=null;setPhase('idle');}}
   };
   media.start(1000);setPhase('recording');
  }catch(failure){if(current()){cancel();setPhase('idle');setError(message(failure));}}
 }
 const label=phase==='recording'?'Stop dictation':phase==='writing'?'Cancel dictation':phase==='requesting'?'Cancel microphone request':'Dictate';
 return <><button type="button" className={'dictation-trigger '+phase} aria-label={label} aria-pressed={phase==='recording'} title={label} disabled={disabled&&phase==='idle'} onClick={()=>{if(phase==='recording'){if(recorder.current?.state==='recording')recorder.current.stop();}else if(phase==='idle')void start();else{cancel();setPhase('idle');}}}><SidebarIcon name={phase==='idle'?'microphone':'stop'}/></button>
  {phase==='writing'&&<span role="status">Writing what you said…</span>}{error&&<span className="dictation-error" role="alert">{error}</span>}</>;
}

export async function transcribeForChat(call:(method:string,args?:any)=>Promise<any>,chatId:string,bytes:Uint8Array,mime:string,signal:AbortSignal){
 if(signal.aborted)throw Error('Dictation cancelled.');
 const id=crypto.randomUUID(),cancel=()=>{void call('dictationCancel',{id,chatId}).catch(()=>{});};
 signal.addEventListener('abort',cancel,{once:true});
 try{return await call('dictate',{id,chatId,bytes,mime});}finally{signal.removeEventListener('abort',cancel);}
}
