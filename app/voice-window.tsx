import React,{useEffect,useRef,useState} from 'react';
import {microphoneFrames,pcmWave,SpeechSegment} from './voice-audio';
import {VoicePlayer} from './voice-player';
import type {VoiceState} from './voice-desk';
import type {LiveVoiceEvent} from './live-voice-desk';
import './voice.css';

const api=window.desktop;
const failure=(error:unknown)=>String(error).replace(/^Error: /,'').replace(/^Error invoking remote method 'app': (?:Error: )?/,'');
export function VoiceWindow(){
 const [state,setState]=useState<VoiceState|null>(null),[error,setError]=useState(''),[listening,setListening]=useState(false),[edit,setEdit]=useState<string|null>(null),[large,setLarge]=useState(false);
 const settings=useRef({autoListen:false,echoDelay:800,threshold:.015,silenceMs:640}),mic=useRef<AbortController|null>(null),player=useRef<VoicePlayer|null>(null),session=useRef(''),revision=useRef(0),alive=useRef(true);
 function stop(){revision.current++;session.current='';mic.current?.abort();mic.current=null;player.current?.close();player.current=null;if(alive.current)setListening(false);}
 function fail(error:unknown){if(alive.current)setError(failure(error));}
 function failed(error:unknown){stop();fail(error);void api.invoke('voiceInterrupt').catch(()=>{});}
 async function refresh(){const result=await api.invoke('voiceState');settings.current=result.settings;if(alive.current)setState(result.state);return result.state as VoiceState;}
 async function capture(id:string){
  const version=revision.current,controller=mic.current=new AbortController();let pending=0;
  try{await microphoneFrames(frame=>{if(controller.signal.aborted)return;if(pending>=8){failed(Error('The microphone connection fell behind. Press Listen to try again.'));return;}
   pending++;void api.invoke('voiceLiveFeed',{id,bytes:new Uint8Array(frame.buffer,frame.byteOffset,frame.byteLength)}).catch(error=>{if(version===revision.current)failed(error);}).finally(()=>pending--);
  },controller.signal,error=>{if(version===revision.current)failed(error);});if(version===revision.current&&!controller.signal.aborted)setListening(true);}catch(error){if(version===revision.current)failed(error);}
 }
 async function confirmation(){
  const version=revision.current;await new Promise(resolve=>setTimeout(resolve,settings.current.echoDelay));if(version!==revision.current||!alive.current)return;
  const controller=mic.current=new AbortController();let quiet=0,armed=false,done=false;
  try{
   const ticket=await api.invoke('voiceCaptureStart');if(version!==revision.current)return;
   const segment=new SpeechSegment(settings.current.threshold,Math.max(500,settings.current.silenceMs),15000);
   const timer=setTimeout(()=>{if(version===revision.current)failed(Error('No confirmation heard. Press Read back to try again.'));},30000);controller.signal.addEventListener('abort',()=>clearTimeout(timer),{once:true});
   await microphoneFrames(frame=>{
    if(done||controller.signal.aborted)return;
    if(!armed){let energy=0;for(const sample of frame)energy+=(sample/32768)**2;quiet=Math.sqrt(energy/frame.length)<settings.current.threshold?quiet+frame.length:0;if(quiet>=8000)armed=true;return;}
    const utterance=segment.push(frame);if(!utterance)return;done=true;controller.abort();setListening(false);
    if(!utterance.complete){failed(Error('Say a short yes or no. Read the draft again.'));return;}
    void api.invoke('voiceConfirm',{ticket,bytes:pcmWave(utterance.pcm)}).catch(error=>{if(version===revision.current)failed(error);});
   },controller.signal,error=>{if(version===revision.current)failed(error);});if(version===revision.current&&!controller.signal.aborted)setListening(true);
  }catch(error){controller.abort();if(version===revision.current)failed(error);}
 }
 function event(event:LiveVoiceEvent){
  if(!alive.current)return;
  if(event.kind==='state'){setState(event.state);return;}
  if(event.kind==='stop'){stop();return;}
  if(event.kind==='session'){stop();session.current=event.id;player.current=new VoicePlayer();const version=revision.current;void player.current.ready().catch(error=>{if(version===revision.current)failed(error);});if(event.microphone)void capture(event.id);return;}
  if(event.id!==session.current)return;
  if(event.kind==='clear'){player.current?.clear();return;}
  if(event.kind==='audio'){try{player.current?.push(new Uint8Array(event.bytes));}catch(error){failed(error);}return;}
  if(event.kind==='end'){
   const version=revision.current;void (player.current?.drain()||Promise.resolve(false)).then(async completed=>{
    if(version!==revision.current)return;
    const next=await api.invoke('voicePlaybackEnd',{id:event.id,ticket:event.ticket,completed});
    if(version!==revision.current)return;setState(next);if(next.phase==='confirm')void confirmation();
   }).catch(error=>{if(version===revision.current)failed(error);});
  }
 }
 async function saveEdit(){if(edit!==null){await api.invoke('voiceEdit',{identity:state?.draft,text:edit});setEdit(null);}}
 async function listen(){setError('');try{await saveEdit();await api.invoke('voiceLiveStart');}catch(error){fail(error);}}
 async function read(){setError('');try{await saveEdit();await api.invoke('voiceRead');}catch(error){fail(error);}}
 useEffect(()=>{alive.current=true;const unsubscribe=api.onVoice(event),reset=api.onSelectChat(()=>{stop();setEdit(null);void refresh().catch(fail);});void refresh().then(()=>{if(alive.current&&settings.current.autoListen)void listen();}).catch(fail);
  let polling=false;const timer=setInterval(()=>{if(polling||!alive.current)return;polling=true;void api.invoke('voicePoll').catch(fail).finally(()=>polling=false);},1000);
  return()=>{alive.current=false;unsubscribe();reset();clearInterval(timer);stop();};
 },[]);
 const busy=!!state&&['thinking','sending'].includes(state.phase);
 return <section className={'voice-window'+(large?' voice-large':'')} aria-label="Voice helper">
  <header><strong>Voice <small>Google · free tier</small></strong><div><button aria-label={large?'Small voice window':'Large voice window'} onClick={()=>void api.invoke('voiceSize',{large:!large}).then(()=>setLarge(!large)).catch(fail)}>{large?'Small':'Big'}</button><button aria-label="Close voice" onClick={()=>{stop();void api.invoke('voiceClose').catch(fail);}}>×</button></div></header>
  <label>Chat<select aria-label="Voice destination" value={state?.chatId||''} disabled={state?.phase==='sending'} onChange={event=>{const chatId=event.target.value;stop();void saveEdit().then(()=>api.invoke('voiceSelect',{chatId})).then(setState).catch(fail);}}>{state?.chats.map(chat=><option key={chat.id} value={chat.id}>{chat.title}</option>)}</select></label>
  <div className="voice-conversation" aria-live="polite"><span className={'voice-speaker '+(state?.speaker||'helper')}>{state?.speaker==='reply'?'Main model reply':'Voice helper'}</span>{listening&&<span className="voice-listening">{state?.phase==='confirm'?'Say yes or no':'Microphone on · you can interrupt'}</span>}<p role="status">{state?.message||'Opening…'}</p>{state?.transcript&&<p className="voice-transcript">You: {state.transcript}</p>}</div>
  {state?.draft&&<section className="voice-draft"><label>Message to the AI<textarea aria-label="Voice draft" value={edit??state.draft.text} disabled={state.phase==='sending'} onChange={event=>{setEdit(event.target.value);stop();void api.invoke('voiceInterrupt').catch(fail);}}/></label><button disabled={busy||edit!==null&&!edit.trim()} onClick={()=>void read()}>Read back</button></section>}
  <div className="voice-actions"><button className="primary" disabled={!state||busy||listening} onClick={()=>void listen()}>Listen</button><button disabled={!state||state.phase==='sending'} onClick={()=>{stop();void api.invoke('voiceInterrupt').catch(fail);}}>Stop speaking and listening</button></div>
  {error&&<p className="error" role="alert">{error}</p>}
 </section>;
}
