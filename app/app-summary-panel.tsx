import React,{useEffect,useRef,useState} from 'react';
import type {SavedApp} from './saved-apps';
import type {Snapshot} from './types';
import type {SummaryKind} from './app-summary';
import {modelLabel} from './models';

export function SummaryControls({app,state,working,call}:{app:SavedApp;state:Snapshot;working:boolean;call:(method:string,args?:any)=>Promise<any>}){
 const [model,setModel]=useState(()=>localStorage.getItem('app-summary-model:'+app.id)||app.summary?.model||(state.pickerSettings?.[state.decisionEngine?.selected||'jev']?.summaryModel||state.jev?.summaryModel)||'deepseek-flash');
 const [automatic,setAutomatic]=useState(()=>localStorage.getItem('app-summary-auto:'+app.id)!=='false'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const attempted=useRef(''),models=state.availableModels||[],available=models.includes(model),running=busy||app.summaryRunning;
 async function update(){attempted.current=app.summaryRevision+':'+model;setBusy(true);setError('');try{await call('savedAppSummarize',{id:app.id,model});}catch(e){setError(String(e).replace(/^Error invoking remote method 'app': (?:Error: )?/,''));}finally{setBusy(false);}}
 useEffect(()=>{
  if(!automatic||!available||working||running||app.summaryError||!(app.todos?.length||state.turns.some(t=>app.chatIds.includes(t.chatId)))||app.summary?.revision===app.summaryRevision&&app.summary?.model===model||attempted.current===app.summaryRevision+':'+model)return;
  const timer=setTimeout(()=>void update(),1200);return()=>clearTimeout(timer);
 },[app.summaryRevision,app.summary?.revision,app.summary?.model,app.summaryRunning,app.summaryError,automatic,model,available,working,busy]);
 const stale=!!app.summary&&app.summary.revision!==app.summaryRevision;
 return <section className="app-summary-controls" aria-label="App summary"><div><strong>{running?'Updating app summary…':stale?'Summary is out of date':app.summary?'Summary of linked chats':'Summarise linked chats'}</strong><small>{app.summary?`${new Date(app.summary.generatedAt).toLocaleString()} · ${modelLabel(app.summary.model,state.claude?.models)} · ${app.summary.sources.length} source records · ${app.summary.tokens.toLocaleString()} reported tokens for this summary${app.summary.usageIncomplete?' (partial)':''}`:'Find current work, questions, ideas and plans across your chats.'}</small>{working&&<small>Waiting for active replies to finish.</small>}</div><div className="app-summary-actions"><label>Summary model<select aria-label="App summary model" disabled={running} value={model} onChange={event=>{setModel(event.target.value);localStorage.setItem('app-summary-model:'+app.id,event.target.value);setError('');}}>{!available&&<option value={model}>{modelLabel(model,state.claude?.models)} · unavailable</option>}{models.map(id=><option key={id} value={id}>{modelLabel(id,state.claude?.models)}</option>)}</select></label><label className="summary-auto"><input type="checkbox" checked={automatic} onChange={event=>{setAutomatic(event.target.checked);localStorage.setItem('app-summary-auto:'+app.id,String(event.target.checked));}}/>Update automatically on this page</label>{running?<button onClick={()=>void call('savedAppSummaryStop',{id:app.id}).catch(e=>setError(String(e)))}>Stop summary</button>:<button disabled={!available||(!app.chatIds.length&&!app.todos?.length)||working} onClick={()=>void update()}>Update summary</button>}</div>{(error||app.summaryError)&&<p role="alert">{error||app.summaryError}</p>}</section>;
}

export function SummaryFindings({app,kind,choose}:{app:SavedApp;kind:SummaryKind;choose:(id:string)=>void}){
 const items=app.summary?.items.filter(item=>item.kind===kind)||[];
 return <>{items.map((item,index)=><article className="app-summary-finding" key={index}><p>{item.text}</p><div>{item.evidence.map((e,i)=>{const source=app.summary?.sources.find(s=>s.id===e.sourceId);return source?.chatId?<button key={i} title={e.quote} onClick={()=>choose(source.chatId!)}><span>↗</span> {source.title}</button>:<small key={i} title={e.quote}>Your app notes</small>;})}</div></article>)}</>;
}
