// Settings, Connections: who picks the model. Moved out of ui.tsx when the picker list grew (3a-1).
import React,{useEffect,useRef,useState} from 'react';
import type {Snapshot} from './types';
import {ChoiceMenu} from './kit';
import {modelLabel} from './models';
import {picker,pickers,type PickerId} from './pickers';
import {healthOf} from './availability';

type Call=(method:string,args?:any)=>Promise<any>;
const summaryModels=(state:Snapshot)=>Object.fromEntries((state.availableModels||[]).map(model=>[model,modelLabel(model,state.claude?.models)]));

export function DecisionSettings({state,call,open}:{state:Snapshot;call:Call;open?:PickerId}){
 const section=useRef<HTMLElement>(null);
 useEffect(()=>{if(open)section.current?.scrollIntoView({block:'start'});},[open]);
 const selected=state.decisionEngine?.selected||'jev',rows=state.decisionEngine?.pickers||[],[requested,setRequested]=useState(open),shown=requested||selected;
 return <section ref={section} className="decision-settings"><h3>Decision engine</h3>
  <div className="connection-field"><span>Choose models with</span><ChoiceMenu label="Decision engine" value={selected} options={Object.fromEntries(pickers.map(row=>[row.id,row.label]))} onChange={engine=>{setRequested(undefined);void call('decisionEngine',{engine}).catch(()=>{});}}/></div>
  <ul className="picker-list" aria-label="Pickers">{rows.map(row=><li key={row.id}><span className={'health-dot '+(row.connected?healthOf(row.status):'unknown')} aria-hidden="true"/><strong>{row.label}</strong><span>{row.status}</span></li>)}</ul>
  {shown==='jev'?<p className="hint">Connect Jev under TypeSafe. Without a connected engine, the app uses your selection or the previous available model.</p>:<PickerSettings key={shown} id={shown} state={state} call={call}/>}
 </section>;
}

// Kev, GLiDE, GLiNER and Not Diamond: their connection, then the routing settings every picker shares.
function PickerSettings({id,state,call}:{id:PickerId;state:Snapshot;call:Call}){
 const info=picker(id)!,row=state.decisionEngine?.pickers?.find(item=>item.id===id),saved=state.pickerSettings?.[id];
 const [summaryModel,setSummaryModel]=useState(saved?.summaryModel||'deepseek-flash'),[confidence,setConfidence]=useState(saved?.confidence??0.7),[timeoutMs,setTimeoutMs]=useState(saved?.timeoutMs??info.timeoutMs);
 return <details className="supplier-pill" open><summary><strong>{info.label}</strong><span>{row?.status||'Not set up'}</span><span className="supplier-chevron">⌄</span></summary><div className="supplier-settings">
   {info.connects==='address'&&<KevAddress saved={saved?.address||''} call={call}/>}
   {info.connects==='key'&&<PickerKey id={id} connected={!!row?.connected} call={call}/>}
   {id==='gliner'&&<GlinerInstall state={state} call={call}/>}
   <div className="connection-field"><span>Summary model</span><ChoiceMenu label={info.short+' summary model'} value={summaryModel} options={summaryModels(state)} onChange={setSummaryModel}/></div>
   <label>Ask below confidence<input aria-label={info.short+' confidence threshold'} type="number" min="0" max="1" step="0.05" value={confidence} onChange={event=>setConfidence(Number(event.target.value))}/></label>
   <label>Decision timeout (ms)<input aria-label={info.short+' timeout'} type="number" min="100" max={id==='glide'?300000:60000} step="100" value={timeoutMs} onChange={event=>setTimeoutMs(Number(event.target.value))}/></label>
   <div className="actions"><button onClick={()=>void call('pickerSave',{id,summaryModel,confidence,timeoutMs}).catch(()=>{})}>Save {info.short} settings</button></div>
   <p className="hint">Low confidence asks you to choose. If {info.short} is unavailable, your selection or the previous available model answers.</p>
  </div></details>;
}

// Kev runs as its own server on this computer (Kev's README: python -m kev.serve). Install is a waiting-list item.
function KevAddress({saved,call}:{saved:string;call:Call}){
 const [address,setAddress]=useState(saved||'http://127.0.0.1:8009/v1');
 return <><p>Kev runs on this computer as its own server. Start it, then save its address. Free and open source.</p>
  <label>Server address<input aria-label="Kev server address" value={address} onChange={event=>setAddress(event.target.value)} placeholder="http://127.0.0.1:8009/v1"/></label>
  <div className="actions"><button className="primary" disabled={!address.trim()} onClick={()=>void call('kevSave',{address:address.trim()}).catch(()=>{})}>Save Kev address</button>{saved&&<button onClick={()=>void call('kevCheck').catch(()=>{})}>Check Kev</button>}</div></>;
}

// Where each keyed picker's key is made, and what it charges (PLAN 3a).
const keyPages:Partial<Record<PickerId,{link:string;note:string}>>={glide:{link:'fastino',note:'Uses your Fastino API key. Routing requests are billed separately from answering models.'},notdiamond:{link:'notdiamond',note:'Uses your Not Diamond API key. Routing requests are billed separately from answering models. It picks one answering model; when you pick models yourself, your picks answer.'}};
function PickerKey({id,connected,call}:{id:PickerId;connected:boolean;call:Call}){
 const [key,setKey]=useState(''),info=picker(id)!,page=keyPages[id];
 return <><label>API key<input aria-label={info.short+' API key'} type="password" autoComplete="off" value={key} onChange={event=>setKey(event.target.value)} placeholder={connected?'Enter a replacement key':'Paste your '+info.short+' key'}/></label>
  <div className="actions"><button className="primary" disabled={!key.trim()} onClick={()=>void call('pickerKeySave',{id,key}).then(()=>setKey('')).catch(()=>{})}>Save {info.short} key</button>{page&&<button onClick={()=>void call('link',{kind:page.link}).catch(()=>{})}>Get key ↗</button>}{connected&&<button onClick={()=>void call('pickerKeyDelete',{id}).catch(()=>{})}>Remove key</button>}</div>
  {page&&<p className="hint">{page.note} Saved in Windows Credential Manager.</p>}</>;
}

// GLiNER2.5-Decide installs on his click into its own pinned environment (fastino, Apache 2.0, revision 5a7adf7).
function GlinerInstall({state,call}:{state:Snapshot;call:Call}){
 const local=state.gliner;
 return <><p>Runs on this computer. Your summary model prepares the task; GLiNER picks the model locally. English only.</p>
  <div className="actions">{local?.installing?<button onClick={()=>void call('glinerCancel')}>Cancel installation</button>:<><button disabled={local?.loading} onClick={()=>void call('glinerInstall').catch(()=>{})}>{local?.installed?'Repair installation':'Install GLiNER locally'}</button>{local?.installed&&<button disabled={local.loading} onClick={()=>void call('glinerCheck').catch(()=>{})}>Load and check GLiNER</button>}</>}</div>
  <p className="hint">Pinned GLiNER2.5-Decide · CPU · 2.0 GB model download plus its own dependencies. It picks one answering model; when you pick models yourself, your picks answer.{local?.elapsedMs!=null?' Last local decision · '+local.elapsedMs+' ms':''}</p></>;
}

// Side answers (FEATURE-SPECS 2): the model that answers quick questions about running work, every model listed.
export function SideAnswerSettings({state,call}:{state:Snapshot;call:Call}){
 const models=state.availableModels||[];
 return <section className="decision-settings side-answer-settings"><h3>Side answers</h3>
  <p className="hint">While a model works, start a message with ?? to ask a quick question about it (how is it going, what is it doing): this model answers from what Ghidorah can see, without interrupting.</p>
  <div className="connection-field"><span>Side answer model</span>{models.length?<ChoiceMenu label="Side answer model" value={state.sideAnswerModel||models[0]} options={Object.fromEntries(models.map(model=>[model,modelLabel(model)]))} onChange={model=>void call('sideAnswerModel',{model}).catch(()=>{})}/>:<span className="settings-status">Connect a model first</span>}</div>
 </section>;
}
