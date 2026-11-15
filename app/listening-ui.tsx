// Settings › Voice: the Listening card and the Reply voice card (Koan 2026-11-15, his pick: version 2 of the
// listening setup, the list). The setup wizard shows the same two cards as its Listening and Voice steps.
// Listening: one row per engine, drawn as Connections draws a supplier. The round mark picks the engine in use among
// those that are set up; a row opens to what the engine needs, a download for Whisper or a key for an online engine.
import React,{useState} from 'react';
import {ChoiceMenu,Switch} from './kit';
import {ENGINES,ENGINE_IDS,HINT_COST,WAVE_STYLES,type EngineId,type OnlineEngine} from './listening';
import {SettingsCard} from './settings-dialog';
import type {Snapshot} from './types';
import {VOICE_SIZE} from './voices';
// Styles: voices.css, loaded with the Voices window. No stylesheet import here: the unit tests load this file in Node.

type Call=(method:string,args?:any)=>Promise<any>;
const SPEECH_MODELS:Record<string,string>={'large-v3-turbo':'Large v3 Turbo · 1.6 GB · recommended','large-v3':'Large v3 · 3.1 GB · slower','small':'Small · 0.5 GB',tiny:'Tiny · 78 MB · tests only'};
// A command that fails is shown once, by the error line of the window it is in: Settings and the wizard each have one.
const fail=()=>{};
const percent=(progress:number|null|undefined)=>progress!=null?' '+Math.round(progress*100)+'%':'';
function Meter({progress}:{progress:number|null|undefined}){return <div className="install-meter" role="progressbar" aria-label="Download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress||0)*100)}><i style={{width:Math.round((progress||0)*100)+'%'}}/></div>;}

/** Whisper on this PC: the model, its download, where it runs. */
function WhisperSetup({state,call}:{state:Snapshot;call:Call}){
 const voice=state.voice,model=voice?.sttModel||'large-v3-turbo',size=(SPEECH_MODELS[model]||'').split(' · ')[1]||'';
 return <>
  <p>{ENGINES.whisper.facts}</p>
  <div className="connection-field"><span>Speech model</span><ChoiceMenu label="Speech model" value={model} options={Object.fromEntries((voice?.models||['large-v3-turbo','large-v3','small']).map(id=>[id,SPEECH_MODELS[id]||id]))} onChange={sttModel=>void call('voiceSettings',{sttModel}).catch(fail)}/><small>The download happens once, only when you press Install.</small></div>
  <div className="connection-field"><span>Status</span><span className="settings-status" role="status">{voice?.installing?'Installing…'+percent(voice.progress):voice?.ready?'Installed':'Not installed'}</span></div>
  {voice?.installing&&<Meter progress={voice.progress}/>}
  {voice?.ready&&voice.dictation&&<div className="connection-field"><span>Runs on</span><span className="settings-status">{voice.dictation.device==='cuda'?'Graphics card':voice.dictation.device==='cpu'?'Processor':'Starts with your first dictation'}</span></div>}
  <div className="actions">{voice?.installing?<button onClick={()=>void call('speechInstallCancel').catch(fail)}>Cancel</button>:<button className={voice?.ready?'':'primary'} onClick={()=>void call('speechInstall').catch(fail)}>{voice?.ready?'Repair':'Install'+(size?' · '+size:'')}</button>}</div>
  {voice?.ready&&voice.dictation&&voice.dictation.cards>0&&!voice.dictation.gpu&&!voice.installing&&<><p className="hint">Your NVIDIA graphics card can write your words many times faster. It needs NVIDIA's CUDA libraries, a one-time 1.3 GB download.</p><div className="actions"><button onClick={()=>void call('speechGpuInstall').catch(fail)}>Use graphics card · 1.3 GB</button></div></>}
  {voice?.ready&&voice.dictation?.gpu&&voice.dictation.device==='cpu'&&voice.dictation.problem&&<p className="hint">The graphics card did not start, so dictation uses the processor: {voice.dictation.problem}</p>}
 </>;
}
/** An online engine: what it costs, its key, and whether the user's own names go with the sound as hints. */
function OnlineSetup({id,state,call}:{id:OnlineEngine;state:Snapshot;call:Call}){
 const engine=ENGINES[id],listening=state.voice?.listening,connected=!!listening?.connected[id],[key,setKey]=useState(''),[busy,setBusy]=useState(false);
 const save=()=>{setBusy(true);void call('listeningKey',{engine:id,key}).then(()=>setKey(''),fail).finally(()=>setBusy(false));};
 return <>
  <p>{engine.facts}</p>
  <div className="connection-field"><span>{engine.name} {engine.model}</span><span className="settings-status" role="status">{connected?'Connected':'Not connected'}</span></div>
  <p className="hint">{engine.price} of talking. Hints for your own names add {HINT_COST}.</p>
  <label>API key<input aria-label={engine.name+' API key'} type="password" autoComplete="off" value={key} onChange={event=>setKey(event.target.value)} placeholder={connected?'Enter a replacement key':'Paste API key'}/></label>
  <div className="actions"><button className="primary" disabled={busy||!key.trim()} onClick={save}>{busy?'Checking…':'Save '+engine.name+' connection'}</button>{connected&&<button disabled={busy} onClick={()=>void call('listeningDisconnect',{engine:id}).catch(fail)}>Disconnect</button>}<button onClick={()=>void call('link',{url:engine.keys}).catch(fail)}>Get API key ↗</button></div>
  <div className="connection-field"><Switch checked={listening?.hints!==false} ariaLabel="Send my app names as hints" label={'Send my app and model names as hints · '+HINT_COST} title="Names come out spelled right. Both online engines charge for it." onChange={on=>void call('listeningHints',{on}).catch(fail)}/></div>
  <p className="hint">Encrypted in Windows Credential Manager.</p>
 </>;
}
export function ListeningSettings({state,call}:{state:Snapshot;call:Call}){
 const voice=state.voice,listening=voice?.listening,[open,setOpen]=useState<Partial<Record<EngineId,boolean>>>(()=>({[listening?.engine||'whisper']:true}));
 const ready=(id:EngineId)=>id==='whisper'?!!voice?.ready:!!listening?.connected[id];
 const status=(id:EngineId)=>listening?.engine===id?'In use':ready(id)?'Ready':id==='whisper'?(voice?.installing?'Installing…'+percent(voice.progress):'Not installed'):'Not connected';
 return <SettingsCard title="Listening" className="listening-settings">
  <p className="hint">Dictation writes your words as you talk. Set up as many engines as you like and pick the one in use.</p>
  <div role="radiogroup" aria-label="Listening engine">{ENGINE_IDS.map(id=>{
   const engine=ENGINES[id],name=engine.name+' '+(id==='whisper'?(SPEECH_MODELS[voice?.sttModel||'large-v3-turbo']||'').split(' · ')[0]:engine.model),active=listening?.engine===id;
   return <details key={id} className={'supplier-pill listening-engine'+(active?' is-active':'')} data-engine={id} open={!!open[id]} onToggle={event=>{const shown=event.currentTarget.open;setOpen(held=>held[id]===shown?held:{...held,[id]:shown});}}>
    <summary>
     <input type="radio" name="listening-engine" className="engine-use" aria-label={'Use '+engine.name} checked={active} disabled={!ready(id)} title={ready(id)?'Use this engine':'Set it up first'} onClick={event=>event.stopPropagation()} onChange={()=>void call('listeningEngine',{engine:id}).catch(fail)}/>
     <strong>{name}</strong><span>{engine.where} · {engine.price}</span><span className={active?'engine-in-use':undefined} role="status">{status(id)}</span><span className="supplier-chevron">⌄</span>
    </summary>
    <div className="supplier-settings">{id==='whisper'?<WhisperSetup state={state} call={call}/>:<OnlineSetup id={id} state={state} call={call}/>}</div>
   </details>;
  })}</div>
  <div className="connection-field listening-waves"><span>Waves</span><ChoiceMenu label="Waves" value={listening?.waves||'bars'} options={WAVE_STYLES} onChange={style=>void call('listeningWaves',{style}).catch(fail)}/><small>What moves in the message box while you dictate: bars beside the buttons, or a line across the box.</small></div>
 </SettingsCard>;
}

/** The voice that reads replies aloud: its one download, then the default voice and the Voices window. */
export function ReplyVoiceSettings({state,call}:{state:Snapshot;call:Call}){
 const voices=state.voices;
 if(!voices)return null;
 return <SettingsCard title="Reply voice" className="reply-voice-settings">{voices.installed?<>
   <div className="connection-field"><span>Default voice</span><ChoiceMenu label="Default voice" value={voices.defaultId} options={Object.fromEntries(voices.list.map(voice=>[voice.id,voice.name]))} onChange={id=>void call('voicesDefault',{id}).catch(fail)}/><small>An app can be given its own on its page.</small></div>
   <div className="connection-field"><span>Status</span><span className="settings-status" role="status">Installed</span></div>
   <div className="actions"><button onClick={()=>void call('voicesOpen').catch(fail)}>Open Voices</button></div>
  </>:<>
   <p className="hint">Kokoro reads replies aloud on this computer, with no service. It is a one-time {VOICE_SIZE} download and nothing is fetched until you press Install.</p>
   {voices.installing&&<><div className="connection-field"><span>Status</span><span className="settings-status" role="status">Installing…{percent(voices.progress)}</span></div><Meter progress={voices.progress}/></>}
   <div className="actions">{voices.installing?<button onClick={()=>void call('voicesInstallCancel').catch(fail)}>Cancel</button>:<button className="primary" onClick={()=>void call('voicesInstall').catch(fail)}>Install · {VOICE_SIZE}</button>}</div>
  </>}
 </SettingsCard>;
}
