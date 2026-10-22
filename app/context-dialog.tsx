import React,{useEffect,useRef,useState} from 'react';
import type {Chat,Snapshot,Turn} from './types';
import {modelLabel} from './models';
import {contextPercent,contextTooltip,usageModels} from './usage';
import {Button,Dialog,Notice,Switch} from './kit';

export function ContextControls({chat,turns,call}:{chat:Chat;turns:Turn[];call:(method:string,args?:any)=>Promise<any>}){
 const [error,setError]=useState('');
 const models=usageModels([],chat.lockedModel?[chat.lockedModel]:chat.selectedModels?.length?chat.selectedModels:[chat.model]);
 const percent=contextPercent(turns,models);
 const pressure=chat.autoCompact===false||percent===null?'neutral':percent>=90?'high':percent>=70?'warning':'normal';
 const tooltip=[contextTooltip(turns,models),chat.compacting?`Compacting · ${chat.compacting.done}/${chat.compacting.total}`:chat.contextNotice,'Click to turn automatic compaction '+(chat.autoCompact===false?'on':'off')+'.'].filter(Boolean).join('\n');
 const claude=(chat.pool||[chat.model]).some(model=>model.startsWith('claude-code:'));
 const set=(change:Record<string,boolean>)=>{setError('');void call('contextSettings',{chatId:chat.id,...change}).catch(e=>setError(String(e)));};
 return <>{claude&&!chat.parentChatId&&<Switch semantics="pressed" className="rlm-toggle" ariaLabel="Let Claude wake itself up" checked={chat.wakeUps!==false} title="Let Claude wake itself up: Claude's own wake-ups and timers in this chat. They spend money while you are away." label="Wake-ups" onChange={on=>set({wakeUps:on})}/>}<Switch semantics="pressed" className="rlm-toggle" ariaLabel="RLM history" checked={chat.rlm!==false} title="RLM history assistance: focused lookups using the current model. Up to four helper calls per turn; their tokens appear in usage." label="RLM" onChange={on=>set({rlm:on})}/>{!chat.parentChatId&&!chat.sideSourceId&&<Switch semantics="pressed" className="rlm-toggle auto-compact" ariaLabel="Automatic compaction" checked={chat.autoCompact!==false} data-pressure={pressure} aria-busy={!!chat.compacting} aria-description={tooltip} title={tooltip} label="Auto-compact" onChange={on=>set({autoCompact:on})}/>}{error&&<span role="alert">{error}</span>}</>;
}

export function ContextDialog({chat,state,call,close}:{chat:Chat;state:Snapshot;call:(method:string,args?:any)=>Promise<any>;close:()=>void}){
 const [info,setInfo]=useState<any>(null),[draft,setDraft]=useState<any>(null),[summary,setSummary]=useState(''),[instructions,setInstructions]=useState(''),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const models=state.availableModels||[],[model,setModel]=useState(models.includes(chat.model)?chat.model:models[0]||'');
 const clean=(e:unknown)=>String(e).replace(/^Error invoking remote method 'app': (?:Error: )?/,'');
 async function load(initial=false){const next=await call('contextInfo',{chatId:chat.id});setInfo(next);if(initial){setDraft(next.draft);setSummary(next.draft?.summary||next.current?.summary||'');setInstructions(next.draft?.instructions??next.instructions??next.current?.instructions??'');}return next;}
 useEffect(()=>{void load(true).catch(e=>setError(clean(e)));},[chat.id]);
 useEffect(()=>{if(busy!=='generate')return;const timer=setInterval(()=>void load().catch(()=>{}),1000);return()=>clearInterval(timer);},[busy]);
 async function generate(){setBusy('generate');setError('');setNotice('');try{const next=await call('contextGenerate',{chatId:chat.id,model});setDraft(next);setSummary(next.summary);setInstructions(next.instructions);await load();}catch(e){setError(clean(e));}finally{setBusy('');}}
 async function apply(){setBusy('apply');setError('');try{await call('contextApply',{chatId:chat.id,revision:draft.revision,summary,instructions});setDraft(null);await load();setNotice('Summary saved. The next reply starts with this context.');}catch(e){setError(clean(e));}finally{setBusy('');}}
 async function reset(){setBusy('reset');setError('');try{await call('contextReset',{chatId:chat.id});await load();setNotice('Full saved history will be used for the next reply.');}catch(e){setError(clean(e));}finally{setBusy('');}}
 return <Dialog title="Chat context" id="context-title" className="checkpoint-dialog context-dialog" size="lg" busy={!!busy} closeLabel="Close chat context" onClose={close} footer={<><Button variant="outline" disabled={!!busy||!info?.current} onClick={()=>void reset()}>Use full history</Button><Button variant="outline" disabled={!!busy} onClick={close}>Close</Button><Button variant="primary" disabled={!!busy||!draft||!summary.trim()||draft.revision!==info?.revision} onClick={()=>void apply()}>Use reviewed summary</Button></>}>
   <p className="kit-dialog-lead">Review and shorten older conversation history.</p>
   <p className="hint">Use /compact to summarize older messages, or let automatic compaction run before context fills. The newest exchange, original history, attachments, goals and project memory are retained. You can also review a summary here before applying it.</p>
   <label className="context-auto"><input type="checkbox" checked={chat.autoCompact!==false} onChange={e=>void call('contextSettings',{chatId:chat.id,autoCompact:e.target.checked}).catch(e=>setError(clean(e)))}/> Compact automatically</label>
   <p className="hint">Compaction and RLM history lookups use your connected model and its normal token allowance. Turning RLM off keeps automatic compaction and direct history reading available.</p>
   <div className="checkpoint-counts"><span>{info?.current?'Summary active':'Full history'}</span>{info?.sourceCharacters>0&&<span>{info.sourceCharacters.toLocaleString()} characters to summarize</span>}{info?.batches>0&&<span>{info.batches} {info.batches===1?'batch':'batches'}</span>}</div>
   {info?.reason&&<p className="hint">{info.reason}</p>}{info?.goal&&<details className="context-goal"><summary>Goal · kept verbatim</summary><p>{info.goal}</p></details>}
   <div className="context-model"><label>Summary model<select aria-label="Summary model" value={model} disabled={!!busy} onChange={e=>setModel(e.target.value)}>{models.map(id=><option key={id} value={id}>{modelLabel(id,state.claude?.models)}</option>)}</select></label><button disabled={!!busy||!model||!!info?.reason||!info} onClick={()=>void generate()}>Generate summary</button>{busy==='generate'&&<button onClick={()=>void call('contextCancel',{chatId:chat.id})}>Stop summary</button>}</div>
   {busy==='generate'&&<p role="status">Summarizing{info?.progress?' · '+info.progress.done+' / '+info.progress.total+' batches':''}… Your current context stays active.</p>}
   <label>Continuation summary<textarea aria-label="Continuation summary" rows={9} maxLength={40000} value={summary} disabled={!!busy||!draft} onChange={e=>setSummary(e.target.value)} placeholder="Generate a draft, then review decisions, files, results and unfinished work."/></label>
   <label>Standing instructions · kept verbatim<textarea aria-label="Standing instructions" rows={3} maxLength={16000} value={instructions} disabled={!!busy||!draft} onChange={e=>setInstructions(e.target.value)} placeholder="Add any wording or constraints the next model must retain exactly."/></label>
   {draft&&<p className="hint">{summary.length.toLocaleString()} summary characters · {draft.tokens==null?'Summary token usage unavailable':draft.tokens.toLocaleString()+' summary tokens reported'}{draft.revision!==info?.revision?' · Chat changed: generate a fresh draft.':''}</p>}
   <p className="hint">Recorded tool outcomes stay in context with shortened excerpts; full results remain retrievable. Large attachments and tool histories can still use substantial context.</p>
   {error&&<Notice tone="danger" role="alert" className="error">{error}</Notice>}{notice&&<p role="status">{notice}</p>}
 </Dialog>;
}
