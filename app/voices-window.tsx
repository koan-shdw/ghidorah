// The Voices window (Koan 2026-11-15, his pick: version 2 of the voice menu). The saved voices are down the side, each
// with a play button. The voice picked there is edited on the right: its name, the two Kokoro voices either side of
// the balance slider, the speed, and the six effects as a rack, each with an amount and one character slider. Play
// loops the sample; a slider moved while it plays changes the sound under the play head. Changes save as they are made.
import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {Button,Chip,Icon,Notice} from './kit';
import {SAMPLE,speaker} from './speaker';
import {RATE,render} from './voice-effects';
import {EFFECTS,SPEED,VOICE_GROUPS,VOICE_IDS,VOICE_SIZE,balanceWords,blended,newVoice,speedWords,voiceLabel,voiceSummary,type Effect,type SavedVoice,type VoicesView} from './voices';
import './voices.css';

const api=window.desktop;
const failure=(error:unknown)=>String(error).replace(/^Error: /,'').replace(/^Error invoking remote method 'app': (?:Error: )?/,'');
// What the engine is asked for: the voice without its effects. Two voices with the same key share one plain take.
const plainKey=(voice:SavedVoice)=>[voice.a,blended(voice)?voice.b:'',blended(voice)?voice.balance:0,voice.speed].join('|');

function wavUrl(samples:Float32Array){
 const bytes=new Uint8Array(44+samples.length*2),view=new DataView(bytes.buffer);
 const text=(at:number,word:string)=>{for(let i=0;i<word.length;i++)bytes[at+i]=word.charCodeAt(i);};
 text(0,'RIFF');view.setUint32(4,36+samples.length*2,true);text(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
 view.setUint32(24,RATE,true);view.setUint32(28,RATE*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,samples.length*2,true);
 for(let n=0;n<samples.length;n++)view.setInt16(44+n*2,Math.max(-1,Math.min(1,samples[n]))*32767,true);
 return URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
}
/** The picture of the sound: its loudest reach up and down across each pixel. */
function paint(canvas:HTMLCanvasElement|null,samples:Float32Array|null){
 if(!canvas)return;
 const ratio=window.devicePixelRatio||1,width=Math.max(1,Math.round(canvas.clientWidth*ratio)),height=Math.max(1,Math.round(canvas.clientHeight*ratio));
 if(canvas.width!==width)canvas.width=width;
 if(canvas.height!==height)canvas.height=height;
 const pen=canvas.getContext('2d')!;pen.clearRect(0,0,width,height);
 if(!samples)return;
 const middle=height/2,per=samples.length/width;
 pen.fillStyle=getComputedStyle(canvas).color;
 for(let x=0;x<width;x++){
  let low=0,high=0;
  for(let n=Math.floor(x*per),end=Math.min(samples.length,Math.floor((x+1)*per)+1);n<end;n++){const s=samples[n];if(s<low)low=s;if(s>high)high=s;}
  pen.fillRect(x,middle-high*middle*0.95,1,Math.max(1,(high-low)*middle*0.95));
 }
}
function VoiceOptions({except}:{except?:string}){
 return <>{Object.entries(VOICE_GROUPS).map(([prefix,label])=><optgroup key={prefix} label={label}>{VOICE_IDS.filter(id=>id.startsWith(prefix)&&id!==except).map(id=><option key={id} value={id}>{voiceLabel(id)}</option>)}</optgroup>)}</>;
}
function Slide({label,value,min,max,step,words,disabled,change}:{label:string;value:number;min:number;max:number;step:number;words:string;disabled?:boolean;change:(value:number)=>void}){
 return <label className="voices-slide"><span>{label}</span><input type="range" aria-label={label} min={min} max={max} step={step} value={value} disabled={disabled} onChange={event=>change(Number(event.target.value))}/><output>{words}</output></label>;
}
function Module({effect,voice,change}:{effect:Effect;voice:SavedVoice;change:(patch:Partial<SavedVoice>)=>void}){
 const setting=voice.fx[effect.id],set=(part:'amount'|'value',value:number)=>change({fx:{...voice.fx,[effect.id]:{...setting,[part]:value}}});
 return <section className={'voices-module'+(setting.amount>0?' is-on':'')} aria-label={effect.name}><header><h4>{effect.name}</h4><i className="voices-module-dot" aria-hidden="true"/></header><p>{effect.note}</p>
  <Slide label="Amount" value={setting.amount} min={0} max={100} step={5} words={setting.amount+'%'} change={value=>set('amount',value)}/>
  <Slide label={effect.label} value={setting.value} min={effect.min} max={effect.max} step={effect.step} words={effect.format(setting.value)} change={value=>set('value',value)}/>
 </section>;
}

export function VoicesWindow(){
 const [view,setView]=useState<VoicesView|null>(null),[currentId,setCurrentId]=useState(''),[draft,setDraft]=useState<SavedVoice|null>(null),[error,setError]=useState(''),[playing,setPlaying]=useState(false),[loading,setLoading]=useState(false),[drawn,setDrawn]=useState(false);
 const speaking=useSyncExternalStore(speaker.subscribe,()=>speaker.key());
 const player=useRef<HTMLAudioElement|null>(null),plain=useRef<{key:string;samples:Float32Array}|null>(null),shaped=useRef<Float32Array|null>(null),turn=useRef(0),canvas=useRef<HTMLCanvasElement>(null),head=useRef<HTMLElement>(null),source=useRef(''),saving=useRef<{timer:ReturnType<typeof setTimeout>;voice:SavedVoice}|null>(null);
 const fail=(problem:unknown)=>setError(failure(problem));
 const call=(method:string,args?:any)=>api.invoke(method,args);

 useEffect(()=>{
  document.documentElement.dataset.theme=localStorage.getItem('theme')||'dark';
  player.current=new Audio();
  void call('voicesState').then(state=>setView(state.voices)).catch(fail);
  const stop=api.subscribe(next=>{if(next.voices)setView(next.voices);});
  return()=>{stop();player.current?.pause();speaker.stop();if(source.current)URL.revokeObjectURL(source.current);};
 },[]);
 // The voice being edited is the window's own copy, so what comes back from a save never jumps a slider under the hand.
 useEffect(()=>{
  if(!view)return;
  const id=view.list.some(voice=>voice.id===currentId)?currentId:view.defaultId;
  if(id!==currentId)setCurrentId(id);
  setDraft(held=>held?.id===id?held:view.list.find(voice=>voice.id===id)!);
 },[view,currentId]);

 function flush(){const pending=saving.current;if(!pending)return;clearTimeout(pending.timer);saving.current=null;void call('voicesSave',{voice:pending.voice}).catch(fail);}
 function change(patch:Partial<SavedVoice>){
  if(!draft)return;
  const next={...draft,...patch};setDraft(next);setError('');
  if(saving.current)clearTimeout(saving.current.timer);
  saving.current=next.name.trim()?{voice:next,timer:setTimeout(flush,250)}:null;   // a name being retyped is saved once it has letters
 }
 function setSource(samples:Float32Array){if(source.current)URL.revokeObjectURL(source.current);player.current!.src=source.current=wavUrl(samples);}
 // The picture of the sound, or none when the voice shown has not been heard yet.
 function show(samples:Float32Array|null){shaped.current=samples;paint(canvas.current,samples);setDrawn(!!samples);}
 // The voice's sound with its effects: the plain take from the engine (asked for only when ask is set), then the effects here.
 async function sound(voice:SavedVoice,ask:boolean){
  if(plain.current?.key!==plainKey(voice)){
   if(!ask)return null;
   setLoading(true);const samples=await speaker.plain('editor',SAMPLE,voice).finally(()=>setLoading(false));
   if(!samples)return null;
   plain.current={key:plainKey(voice),samples};
  }
  return render(plain.current.samples,voice.fx);
 }
 function halt(){turn.current++;player.current?.pause();setPlaying(false);setLoading(false);if(speaker.key()==='editor')speaker.stop();}
 async function toggle(){
  if(!draft)return;
  if(playing||loading){halt();return;}
  const mine=++turn.current;speaker.stop();setError('');
  try{
   const out=await sound(draft,true);
   if(mine!==turn.current)return;
   if(!out){fail(speaker.problem('editor')||'The voice did not answer. Try again.');return;}
   show(out);player.current!.loop=true;setSource(out);await player.current!.play();
   if(mine===turn.current)setPlaying(true);
  }catch(problem){if(mine===turn.current&&(problem as any)?.name!=='AbortError'){fail(problem);halt();}}   // a change made while the sound loads swaps it; that is no failure
 }
 // A change to the voice: its picture is drawn again, and while it plays the sound changes under the play head.
 useEffect(()=>{
  if(!draft)return;
  const timer=setTimeout(()=>{
   const mine=turn.current;
   void sound(draft,playing).then(out=>{
    if(mine!==turn.current)return;
    if(!out){if(!playing)show(null);return;}   // another voice or speed, not heard yet: its picture comes with Play
    show(out);
    if(!playing)return;
    const audio=player.current!,at=audio.currentTime;setSource(out);
    audio.addEventListener('loadedmetadata',()=>{if(mine!==turn.current)return;audio.currentTime=Math.min(at,Math.max(0,audio.duration-0.05));void audio.play().catch(()=>{});},{once:true});
   }).catch(()=>{});
  },plain.current?.key===plainKey(draft)?90:250);
  return()=>clearTimeout(timer);
 },[draft]);
 useEffect(()=>{
  if(!playing)return;
  let frame=0;const tick=()=>{const audio=player.current;if(audio?.duration&&head.current)head.current.style.left=(audio.currentTime/audio.duration*100)+'%';frame=requestAnimationFrame(tick);};
  frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
 },[playing]);
 const open=!!view&&!!draft;
 useEffect(()=>{const element=canvas.current;if(!element)return;const watch=new ResizeObserver(()=>paint(element,shaped.current));watch.observe(element);return()=>watch.disconnect();},[open]);

 if(!view||!draft)return <p className="voices-opening" role={error?'alert':'status'}>{error||'Opening Voices…'}</p>;
 const rows=view.list.map(voice=>voice.id===draft.id?draft:voice),ready=view.installed;
 function pick(id:string){if(id===currentId)return;flush();halt();setCurrentId(id);setDraft(view!.list.find(voice=>voice.id===id)!);}
 function playRow(voice:SavedVoice){
  const key='row:'+voice.id;
  if(speaker.key()===key){speaker.stop();return;}
  halt();setError('');void speaker.say(key,SAMPLE,voice).then(()=>{const problem=speaker.problem(key);if(problem)setError(problem);});
 }
 async function add(voice:SavedVoice){flush();halt();try{await call('voicesSave',{voice});setView(held=>held&&!held.list.some(row=>row.id===voice.id)?{...held,list:[...held.list,voice]}:held);setCurrentId(voice.id);setDraft(voice);}catch(problem){fail(problem);}}
 const free=(name:string)=>{const taken=new Set(rows.map(voice=>voice.name.toLowerCase()));if(!taken.has(name.toLowerCase()))return name;for(let n=2;;n++){const next=name.slice(0,36)+' '+n;if(!taken.has(next.toLowerCase()))return next;}};
 const percent=view.progress!==null?' '+Math.round(view.progress*100)+'%':'';
 return <div className="voices-window">
  <header className="titlebar"><span>Voices</span><div className="window-actions"><button aria-label="Minimize" onClick={()=>void call('window',{action:'minimize'}).catch(fail)}>—</button><button aria-label="Close window" onClick={()=>{flush();void call('window',{action:'close'}).catch(fail);}}>×</button></div></header>
  <div className="voices-mixer">
   <nav className="voices-list" aria-label="Your voices">
    <ul>{rows.map(voice=><li key={voice.id} className={'voices-item'+(voice.id===draft.id?' is-current':'')}>
     <button className="voices-play" aria-pressed={speaking==='row:'+voice.id} aria-label={(speaking==='row:'+voice.id?'Stop ':'Play ')+voice.name} disabled={!ready} onClick={()=>playRow(voice)}><Icon name={speaking==='row:'+voice.id?'stop':'play'}/></button>
     <button className="voices-pick" aria-current={voice.id===draft.id||undefined} onClick={()=>pick(voice.id)}><span className="voices-name"><span>{voice.name||'Unnamed'}</span>{voice.id===view.defaultId&&<span className="voices-default">default</span>}</span><small>{voiceSummary(voice)}</small></button>
    </li>)}</ul>
    <Button variant="outline" icon="plus" disabled={rows.length>=60} onClick={()=>void add(newVoice(crypto.randomUUID(),free('New voice')))}>New voice</Button>
   </nav>
   <main className="voices-main">
    {!ready&&<Notice tone="info" className="voices-install"><strong>The voice is a one-time download</strong><p>Kokoro, the voice that speaks replies, is {VOICE_SIZE}. It is fetched once and then runs on this computer, with no service. Nothing is downloaded until you press Install.</p>
     <div className="actions">{view.installing?<><span role="status">Installing…{percent}</span><Button variant="outline" onClick={()=>void call('voicesInstallCancel').catch(fail)}>Cancel</Button></>:<Button variant="primary" onClick={()=>{setError('');void call('voicesInstall').catch(fail);}}>Install · {VOICE_SIZE}</Button>}</div></Notice>}
    <div className="voices-head"><input type="text" aria-label="Voice name" maxLength={40} value={draft.name} onChange={event=>change({name:event.target.value})} onBlur={()=>{if(!draft.name.trim())change({name:view.list.find(voice=>voice.id===draft.id)?.name||'Voice'});}}/>
     {draft.id===view.defaultId?<Chip tone="accent">Default voice</Chip>:<Button variant="outline" title="New chats and apps without their own voice speak in the default voice" onClick={()=>{flush();void call('voicesDefault',{id:draft.id}).catch(fail);}}>Make default</Button>}
     <Button variant="outline" icon="copy" disabled={rows.length>=60} onClick={()=>void add({...draft,id:crypto.randomUUID(),name:free((draft.name.trim()||'Voice').slice(0,35)+' copy')})}>Duplicate</Button>
     <Button variant="outline" icon="trash" disabled={rows.length<2} onClick={()=>{if(saving.current){clearTimeout(saving.current.timer);saving.current=null;}halt();void call('voicesRemove',{id:draft.id}).catch(fail);}}>Delete</Button></div>
    <div className="voices-listen"><button className="voices-round" aria-pressed={playing||loading} aria-label={playing||loading?'Stop':'Play this voice'} title={ready?SAMPLE:'Install the voice to hear it'} disabled={!ready} onClick={()=>void toggle()}><Icon name={playing||loading?'stop':'play'}/></button>
     <div className={'voices-wave'+(playing?' is-live':'')}><canvas ref={canvas} aria-hidden="true"/><i ref={head} className="voices-wave-head"/>{!drawn&&<span className="voices-wave-hint">{loading?'Making the sound…':ready?'Press play to hear this voice':'Not installed yet'}</span>}</div></div>
    <div className="voices-blend">
     <label><span>Voice</span><select aria-label="Voice" value={draft.a} onChange={event=>change({a:event.target.value,b:draft.b===event.target.value?'':draft.b})}><VoiceOptions/></select></label>
     <div className="voices-fader"><input type="range" aria-label="Balance between the two voices" min={0} max={100} step={1} value={draft.balance} disabled={!draft.b} onChange={event=>change({balance:Number(event.target.value)})}/><output>{balanceWords(draft)}</output></div>
     <label><span>Blend with</span><select aria-label="Blend with" value={draft.b} onChange={event=>change({b:event.target.value})}><option value="">None</option><VoiceOptions except={draft.a}/></select></label>
    </div>
    <div className="voices-speed"><Slide label="Speed" value={draft.speed} min={SPEED.min} max={SPEED.max} step={SPEED.step} words={speedWords(draft)} change={speed=>change({speed})}/></div>
    <div className="voices-rack">{EFFECTS.map(effect=><Module key={effect.id} effect={effect} voice={draft} change={change}/>)}</div>
    {error&&<Notice tone="danger" role="alert" className="error" onDismiss={()=>setError('')}>{error}</Notice>}
   </main>
  </div>
 </div>;
}
