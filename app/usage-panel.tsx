import {apiSuppliers} from './api-catalog';
import React,{useEffect,useRef,useState} from 'react';
import type {Snapshot,Turn,Chat,ClaudeConnection} from './types';
import {modelLabel,modelEfforts,providerFor} from './models';
import {modelStatus} from './availability';
import {modelUsage,usageModels,resetLabel,windowLabel} from './usage';
import {picker,pickerTokens} from './pickers';
import {ContextDialog} from './context-dialog';

export const compact=(value:number)=>Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(value);
export function Meter({label,used,max=100,remaining=false}:{label:string;used:number;max?:number;remaining?:boolean}){
  const percent=used/max*100;
  return <progress aria-label={label} className={'usage-meter '+(remaining?'remaining ':'')+(percent>=100?'exhausted':percent>=80?'warning':'')} value={Math.max(0,Math.min(remaining?max-used:used,max))} max={max}/>;
}
export function shortReset(value:string|null,now:number){
  if(value&&Date.parse(value)-now>=86400000)return 'Resets '+new Date(value).toLocaleString(undefined,{weekday:'short',hour:'numeric',minute:'2-digit'});
  return resetLabel(value,now);
}
function AccountUsage({name,connection,now}:{name:string;connection?:Omit<ClaudeConnection,'models'>;now:number}){
  return <section className="usage-account" aria-label={name+' account usage'}>
    <div className="usage-account-heading"><h3>{name}</h3><span title={connection?.status}>{connection?.plan||'Subscription'}</span></div>
    {connection?.windows?.length?<UsageWindows name={name} windows={connection.windows} now={now}/>:<p className="usage-unavailable">{connection?.connected?'Windows unavailable':connection?.status||'Not connected'}</p>}
  </section>;
}
// One account's limit windows: name, what is left (amber from 80% used, red when spent), a bar and the reset.
export function UsageWindows({name,windows,now}:{name:string;windows:NonNullable<ClaudeConnection['windows']>;now:number}){
  return <>{windows.map((window,index)=>{
    const label=windowLabel(window.label,window.durationSeconds),used=window.usedPercent;
    return <div className="usage-window" key={index}>
      <div><span>{label}</span><strong className={used!=null&&used>=100?'usage-exhausted':used!=null&&used>=80?'usage-warning':''} title={used==null?undefined:used.toLocaleString()+'% used'}>{used==null?'Unavailable':`${Math.max(0,100-used).toLocaleString()}% left`}</strong></div>
      {used!=null&&<Meter label={name+' '+label+' remaining'} used={used} remaining/>}
      <small title={window.resetAt?new Date(window.resetAt).toLocaleString():undefined}>{shortReset(window.resetAt,now)}</small>
    </div>;
  })}</>;
}
// Level, sign-in state with its dot, and the live vendor address under each model (F7, 5.21 M3).
function ModelDetails({state,chat,model}:{state:Snapshot;chat?:Chat;model:string}){
  const effort=chat?.efforts?.[model]||(model==='deepseek-flash'?chat?.effort:'high')||'high',{status,health}=modelStatus(state,model),provider=providerFor(model);
  const address=provider==='claude-code'?'local Claude Code':state.providerUrls?.[provider]||'Address unavailable';
  return <div className="usage-model-details"><span title="Thinking level">{modelEfforts(model)[effort]||(effort==='xhigh'?'Extra high':effort[0].toUpperCase()+effort.slice(1))}</span><span className="usage-signin"><span className={'health-dot '+health} aria-hidden="true"/>{status||'Not checked'}</span><span className="usage-address" title={address}>{address}</span></div>;
}
export function UsagePanel({id="usage-panel",state,chat,turns,models,refresh,close,call}:{id?:string;state:Snapshot;chat?:Chat;turns:Turn[];models:string[];refresh:()=>Promise<void>;close:()=>void;call:(method:string,args?:any)=>Promise<any>}){
  const panel=useRef<HTMLDivElement>(null),[busy,setBusy]=useState(false),[now,setNow]=useState(Date.now());
  const [contextOpen,setContextOpen]=useState(false);
  // Focus goes back to the button that opened the panel (the ring or Model details), else the first that controls it.
  const opener=useRef<HTMLElement|null>(typeof document==='undefined'?null:document.activeElement as HTMLElement|null);
  const giveBack=()=>{const back=opener.current?.isConnected&&opener.current.getAttribute('aria-controls')===id?opener.current:document.querySelector<HTMLButtonElement>('button[aria-controls="'+CSS.escape(id)+'"]');back?.focus();};
  useEffect(()=>{
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside=(event:PointerEvent)=>{const target=event.target as Element;if(!panel.current?.contains(target)&&!target.closest('[aria-controls="'+CSS.escape(id)+'"]'))close();};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!panel.current?.querySelector('dialog[open]')){close();giveBack();event.stopPropagation();}};
    const timer=setInterval(()=>setNow(Date.now()),30000);
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key);
    return()=>{clearInterval(timer);document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key);};
  },[]);
  async function update(){setBusy(true);try{await refresh();}finally{setBusy(false);}}
  // One row per picker that routed in this chat. Turns saved before the engine field count as Jev.
  const routed=turns.filter(turn=>turn.routingUsage&&turn.routingUsage.engine!=='selector'),engines=[...new Set(routed.map(turn=>turn.routingUsage!.engine||'jev'))];
  const all=usageModels(turns,models,chat?.summarizationUsage);
  const measured=all.map(model=>({model,label:modelLabel(model,state.claude?.models),...modelUsage(turns,model,chat?.summarizationUsage)}));
  return <div ref={panel} id={id} className="usage-panel" role="dialog" aria-label="Context window and usage">
    <header><strong>Context window <span>This chat & accounts</span></strong><button aria-label="Close usage" onClick={()=>{close();giveBack();}}>×</button></header>
    <div className="usage-scroll">
      <div className="usage-columns" aria-hidden="true"><span>This chat</span><span>Context used</span><span>Tokens</span></div>
      {measured.map(({model,label,context,tokens,partial,cost,costPartial})=><section className="usage-model" key={model} aria-label={label+' usage'}>
        <div><h3>{label}</h3><ModelDetails state={state} chat={chat} model={model}/></div>
        <div className="usage-context" aria-label="Context window" title={context?`${context.used.toLocaleString()} / ${context.max.toLocaleString()} · ${context.estimated?'Estimated':context.source==='claude_code'?'Claude Code reported':'Provider reported'}`:'Context unavailable'}>
          {context?<><div><strong>{context.estimated?'≈ ':''}{Math.round(context.used/context.max*100)}%</strong><small>{compact(context.used)} / {compact(context.max)}</small></div><Meter label={label+' context used'} used={context.used} max={context.max}/></>:<span className="usage-unavailable">Unavailable</span>}
        </div>
        <div className="usage-tokens" title={tokens==null?'Token usage unavailable':`${tokens.toLocaleString()} tokens${partial?' reported':''} in this chat`}><strong>{tokens==null?'—':compact(tokens)}{partial&&tokens!=null?'*':''}</strong>{(model.startsWith('deepseek-')||model.startsWith('api:')&&!model.startsWith('api:xai-oauth:'))&&<small title={cost==null?'Cost unavailable':`${costPartial?'Reported':'Estimated'} cost $${cost.toFixed(4)}`}>{cost==null?'Cost unavailable':'$'+cost.toFixed(4)+(costPartial?'*':' est.')}</small>}</div>
      </section>)}
      <div className="usage-section-heading"><h3>Account allowances</h3><span>Shared across chats & apps</span></div>
      <div className="usage-accounts">
        {(state.codex?.connected||all.some(model=>model.startsWith('gpt-')))&&<AccountUsage name="OpenAI" connection={state.codex} now={now}/>}
        {(state.claude?.connected||all.some(model=>model.startsWith('claude-')))&&<AccountUsage name="Claude Code" connection={state.claude} now={now}/>}
      </div>
      {(state.connected||all.some(model=>model.startsWith('deepseek-')))&&<section className="usage-credit" aria-label="DeepSeek account usage"><h3>DeepSeek <span>Prepaid credit</span></h3><strong>{state.balance||'Unavailable'}</strong></section>}
      {(state.apiProviders||[]).filter(row=>row.connected).map(row=><section className="usage-credit" key={row.provider} aria-label={apiSuppliers[row.provider].name+' account usage'}><h3>{apiSuppliers[row.provider].name} <span>{row.provider==='openrouter-api'?'Key budget remaining'+(row.keyLimitReset?' · resets '+row.keyLimitReset:''):(row.provider==='nous'||row.provider.endsWith('-oauth'))?'Subscription allowance':'API allowance'}</span></h3><strong>{row.keyBudgetRemaining==null?'Unavailable':'$'+row.keyBudgetRemaining.toFixed(2)}</strong></section>)}
      {engines.map(engine=>{const info=picker(engine),rows=routed.filter(turn=>(turn.routingUsage!.engine||'jev')===engine),reported=rows.filter(turn=>typeof pickerTokens(turn.routingUsage)==='number'),name=info?.short||'Retired selector';
        return <section className="usage-credit" key={engine} aria-label={name+' routing usage'}><h3>{name} <span>{info?.connects==='key'?'Routing tokens in this chat':'Local routing tokens · no account charge'}</span></h3><strong>{reported.length?compact(reported.reduce((sum,turn)=>sum+pickerTokens(turn.routingUsage)!,0)):'—'}{reported.length>0&&reported.length<rows.length?'*':''}</strong></section>;})}
      <details className="usage-details"><summary>Exact counts & reporting details</summary>
        {measured.map(({model,label,context,tokens,partial,cost,costPartial,summaryTokens,contextTokens})=><p key={model}><strong>{label}</strong><br/>{context?`Context window: ${context.used.toLocaleString()} / ${context.max.toLocaleString()} · ${context.estimated?'Estimated':context.source==='claude_code'?'Claude Code reported':'Provider reported'} · ${new Date(context.created).toLocaleString()}`:'Context unavailable'}<br/>{tokens==null?'Token usage unavailable':`${tokens.toLocaleString()} tokens${partial?' reported':''} in this chat${partial?' · Partial reporting':''}`}{summaryTokens>0&&<><br/>{summaryTokens.toLocaleString()} tokens for routing summaries</>}{contextTokens>0&&<><br/>{contextTokens.toLocaleString()} tokens for compaction and history assistance</>}{cost!=null&&<><br/>{costPartial?'Reported':'Estimated'} cost ${cost.toFixed(4)}</>}</p>)}
        {[['OpenAI',state.codex],['Claude Code',state.claude]] .map(([name,connection])=>{const account=connection as Snapshot['codex'];return account&&<p key={String(name)}><strong>{String(name)}</strong> · {account.status}<br/>{account.checkedAt?'Checked '+new Date(account.checkedAt).toLocaleString():'Not checked'}{account.windows?.map((window,index)=><span className="usage-detail-window" key={index}>{windowLabel(window.label,window.durationSeconds)} · {window.usedPercent==null?'Usage unavailable':window.usedPercent+'% used'} · {window.resetAt?new Date(window.resetAt).toLocaleString():'Reset unavailable'}</span>)}</p>;})}
        {(state.connected||all.some(model=>model.startsWith('deepseek-')))&&<p>DeepSeek credit · {state.balanceCheckedAt?'Checked '+new Date(state.balanceCheckedAt).toLocaleString():'Not checked'}</p>}
      </details>
    </div>
    <footer><span>{chat?.context?'Summary saved · latest reported usage':'Latest reported usage'}</span>{chat&&!chat.parentChatId&&!chat.sideSourceId&&<button onClick={()=>setContextOpen(true)}>Manage context</button>}<button disabled={busy} onClick={()=>void update()}>{busy?'Refreshing…':'Refresh account usage'}</button></footer>
    {contextOpen&&chat&&<ContextDialog chat={chat} state={state} call={call} close={()=>setContextOpen(false)}/>}
  </div>;
}
