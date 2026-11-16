// First-launch setup (W, PLAN 1b): one step at a time, made of the Settings pages, so every step opens again from
// Settings. A step can be skipped; what is finished stays finished if a later step fails; finishing stops it coming
// back. The live state decides what the Summary says, so it cannot claim a connection that is not there.
import React,{useState,useEffect,useRef} from 'react';
import type {Snapshot} from './types';
import {ClaudeConnection,AlwaysOnSettings,RemoteSettings} from './settings-pages';
import {apiSuppliers,type ApiProvider} from './api-catalog';
import {healthOf} from './availability';
import {ShareSetup} from './share-ui';
import {ENGINES} from './listening';
import {ListeningSettings,ReplyVoiceSettings} from './listening-ui';

type Call=(method:string,args?:any)=>Promise<any>;
// Listening and Voice (Koan 2026-11-15) are the Voice page's first two cards: the engine that hears dictation, and
// the download of the voice that reads replies aloud.
export type WizardStep='suppliers'|'claude'|'jev'|'listening'|'voice'|'always-on'|'remote'|'sharing';
export const STEPS:{id:WizardStep;label:string;page:string}[]=[
 {id:'suppliers',label:'Suppliers',page:'connections'},{id:'claude',label:'Claude Code',page:'connections:anthropic'},{id:'jev',label:'Jev',page:'connections'},
 {id:'listening',label:'Listening',page:'voice'},{id:'voice',label:'Voice',page:'voice'},
 {id:'always-on',label:'Start with Windows',page:'always-on'},{id:'remote',label:'Remote',page:'remote'},{id:'sharing',label:'Share with clients',page:'sharing'},
];
export type Outcome='connected'|'unverified'|'failed'|'skipped';
export interface SummaryRow {name:string;outcome:Outcome;detail:string;page:string;action:string}
const outcomeOf=(status?:string):Outcome=>/failed|denied|sign in again|expired|rejected/i.test(status||'')?'failed':({ok:'connected',unknown:'unverified',limited:'failed',down:'failed'} as const)[healthOf(status)];

export function wizardSummary(state:Snapshot):SummaryRow[]{
 const rows:SummaryRow[]=[];
 const suppliers=[{name:'DeepSeek',connected:state.connected,status:state.providerStatus},{name:'OpenAI',connected:state.codex?.connected,status:state.codex?.status||'Not connected'},...(state.apiProviders||[]).map(row=>({name:apiSuppliers[row.provider as ApiProvider].name,connected:row.connected,status:row.status}))].filter(row=>row.connected||/failed|denied|sign in again|expired|rejected|unavailable/i.test(row.status));
 for(const row of suppliers)rows.push({name:row.name,outcome:outcomeOf(row.status),detail:row.status,page:'connections',action:'Open Connections'});
 if(!suppliers.length)rows.push({name:'Suppliers',outcome:'skipped',detail:'No supplier connected. Chats need one.',page:'connections',action:'Connect a supplier'});
 const claude=state.claude?.status||'Not checked';
 rows.push({name:'Claude Code',outcome:state.claude?.connected?outcomeOf(claude):/not installed|Not checked/i.test(claude)?'skipped':'unverified',detail:claude,page:'connections:anthropic',action:'Open Connections'});
 rows.push({name:'Jev',outcome:state.jev?.connected?outcomeOf(state.jev.status):'skipped',detail:state.jev?.connected?state.jev.status:'Not connected. The other pickers work without it.',page:'connections',action:'Open Connections'});
 const engine=state.voice?.listening?.engine,voices=state.voices;
 rows.push({name:'Listening',outcome:engine?'connected':'skipped',detail:engine?ENGINES[engine].name+(ENGINES[engine].model?' '+ENGINES[engine].model:'')+(engine==='whisper'?', on this PC':', online'):'No listening engine set up. Dictation needs one.',page:'voice',action:'Open Voice'});
 rows.push({name:'Voice',outcome:voices?.ready?'connected':'skipped',detail:voices?.engine==='zonos'?'Zonos 3 Mini, online · '+voices.zonos.voice:voices?.ready?'Kokoro installed · '+(voices.list.find(voice=>voice.id===voices.defaultId)?.name||''):'Not installed. Listen and Speak replies need it.',page:'voice',action:'Open Voice'});
 rows.push({name:'Start with Windows',outcome:state.alwaysOn?.startWithWindows?'connected':'skipped',detail:state.alwaysOn?.startWithWindows?'On':'Off',page:'always-on',action:'Open Always on'});
 const remote=state.remote;
 rows.push({name:'Remote',outcome:!remote?.enabled?'skipped':remote.status==='running'?'connected':remote.status==='failed'?'failed':'unverified',detail:!remote?.enabled?'Off':remote.status==='running'?'Connected to Telegram':remote.message||'Connecting',page:'remote',action:'Open Remote'});
 rows.push({name:'Share with clients',outcome:state.share?.ready?'connected':'skipped',detail:state.share?.ready?state.share.site:'Not set up. You can set it up any time in Settings.',page:'sharing',action:'Open Share with clients'});
 return rows;
}

const OUTCOMES:Record<Outcome,string>={connected:'Connected',unverified:'Not verified yet',failed:'Failed',skipped:'Skipped'};
export function Wizard({state,call,suppliers,jev,openSettings,appError}:{state:Snapshot;call:Call;suppliers:React.ReactNode;jev:React.ReactNode;openSettings:(page:string)=>void;appError:string}){
 const done=state.wizard?.steps||{};
 // A restart mid-way resumes at the first step not yet finished or skipped.
 // Opened from an empty chat it starts at Suppliers.
 const [index,setIndex]=useState(()=>{const start=STEPS.findIndex(step=>step.id===state.wizard?.start);if(start>=0)return start;const first=STEPS.findIndex(step=>!done[step.id]);return first<0?STEPS.length:first;}),[error,setError]=useState('');
 const step=STEPS[index],dialog=useRef<HTMLDialogElement>(null),[busy,setBusy]=useState(false),visibleError=error||(step?.id==='remote'?'':appError);
 useEffect(()=>{const view=dialog.current!;view.showModal();return ()=>view.close();},[]);
 useEffect(()=>{dialog.current?.querySelector('h2')?.focus();},[index]);
 const fail=(failure:unknown)=>setError(String(failure).replace(/^Error: /,'').replace(/^Error invoking remote method 'app': (?:Error: )?/,''));
 const mark=(status:'done'|'skipped')=>{if(busy)return;setBusy(true);void call('wizardStep',{step:step.id,status}).then(()=>{setError('');setIndex(index+1);},fail).finally(()=>setBusy(false));};
 return <dialog ref={dialog} className="wizard" aria-modal="true" aria-label="Setup" onCancel={event=>{event.preventDefault();void call('wizardClose').catch(fail);}}>
  <header className="wizard-header"><h2 tabIndex={-1}>Set up Ghidorah</h2><ol className="wizard-steps">{[...STEPS.map(item=>item.label),'Summary'].map((label,position)=><li key={label} aria-current={position===index?'step':undefined} className={position<index?'past':''}>{label}</li>)}</ol></header>
  <div className="wizard-body">
   {step?.id==='suppliers'&&<>{suppliers}<p className="hint">Connect at least one supplier so chats have a model. You can add more later in Settings.</p></>}
   {step?.id==='claude'&&<section className="connections"><h3>Claude Code</h3><ClaudeConnection state={state} call={call}/></section>}
   {step?.id==='jev'&&jev}
   {step?.id==='listening'&&<><ListeningSettings state={state} call={call}/><p className="hint">Skip this and dictation stays off until you set it up in Settings › Voice.</p></>}
   {step?.id==='voice'&&<><ReplyVoiceSettings state={state} call={call}/><p className="hint">Skip this and replies are not read aloud until you set up a reply voice in Settings › Voice.</p></>}
   {step?.id==='always-on'&&<AlwaysOnSettings state={state} call={call}/>}
   {step?.id==='remote'&&<RemoteSettings state={state} call={call}/>}
   {step?.id==='sharing'&&<ShareSetup state={state} call={call}/>}
   {!step&&<section className="wizard-summary" aria-label="Setup summary"><h3>Summary</h3><ul>{wizardSummary(state).map(row=><li key={row.name} data-outcome={row.outcome}>
    <strong>{row.name}</strong><span className={'wizard-outcome '+row.outcome}>{OUTCOMES[row.outcome]}</span><span className="hint">{row.detail}</span>
    {row.outcome!=='connected'&&<button onClick={()=>void call('wizardClose').then(()=>openSettings(row.page),fail)}>{row.action}</button>}
   </li>)}</ul></section>}
   {visibleError&&<p className="error" role="alert">{visibleError}</p>}
  </div>
  <footer className="wizard-footer">{index>0&&<button disabled={busy} onClick={()=>setIndex(index-1)}>Back</button>}
   {step?<><button disabled={busy} onClick={()=>mark('skipped')}>Skip</button><button disabled={busy} className="primary" onClick={()=>mark('done')}>Next</button></>:<button className="primary" onClick={()=>void call('wizardFinish').catch(fail)}>Finish</button>}
  </footer>
 </dialog>;
}
