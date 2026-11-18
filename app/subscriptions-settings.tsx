// Settings › Subscriptions (Koan's pick 2026-11-18: version 3 of the mockup). One page for every connection: what
// it costs a month and where that figure comes from, what is left, and where the tokens went. First what needs a
// look, then the ledger with its sums at the foot of the page, then the month by day, model and app.
// The rows are built here from the window's own state (subscriptions.ts); the `subscriptions` command adds the typed
// prices, the ElevenLabs account and a month's token sums.
import React,{useEffect,useRef,useState} from 'react';
import type {ElevenLabsAccount} from './elevenlabs-account';
import {Tabs} from './kit';
import {modelLabel} from './models';
import {needsLook,subscriptionRows,subscriptionTotals,tightest,usedBy,type PriceSource,type SubscriptionRow} from './subscriptions';
import type {Snapshot} from './types';
import type {MonthUsage,UsageSum} from './usage-months';
import {compact,Meter,shortReset} from './usage-panel';
import {VendorIcon} from './vendor-icons';
// Styles: settings-dialog.css (.sub-*).

type Call=(method:string,args?:any)=>Promise<any>;
interface View {prices:Record<string,number>;elevenlabs:ElevenLabsAccount|null;elevenlabsNote:string;month:string;months:string[];usage:MonthUsage;apps:{id:string;name:string;chatIds:string[]}[];titles:Record<string,string>}
const usd=(amount:number)=>'$'+amount.toFixed(2);
const share=(part:number,whole:number)=>{const value=whole?part/whole:0;return (value>=.1?Math.round(value*100):value>=.001?(value*100).toFixed(1):'0')+'%';};
const monthName=(month:string)=>{const [year,index]=month.split('-').map(Number);return new Date(year,index-1,1).toLocaleString(undefined,{month:'long'});};
const marks:Record<PriceSource,[string,string]>={confirmed:['✓','Confirmed'],estimate:['≈','Estimate'],unknown:['?','Amount unknown']};
function Mark({source,why}:{source:PriceSource;why:string}){return <i className={'sub-src '+source} role="img" aria-label={marks[source][1]} title={marks[source][1]+'. '+why+'.'}>{marks[source][0]}</i>;}
function Price({row}:{row:SubscriptionRow}){
 const {price}=row;
 return <div className={'sub-price'+(price.usd===null&&!price.other?' unknown':'')}><Mark source={price.source} why={price.why}/>{price.usd!==null?usd(price.usd):price.other||'Paid'}</div>;
}
function Left({row,now}:{row:SubscriptionRow;now:number}){
 const window=tightest(row);
 if(window)return <div className={'sub-left'+(window.left<=0?' danger':window.left<=20?' warning':'')}><span><b>{Math.round(window.left)}% left</b><span>{window.label}</span></span><Meter label={row.name+' '+window.label+' remaining'} used={100-window.left} remaining/><small title={window.resetAt?new Date(window.resetAt).toLocaleString():undefined}>{shortReset(window.resetAt,now)}</small></div>;
 return <div className="sub-left"><span>{row.balance?<><b>{row.balance}</b><span>left</span></>:<span>No limit reported</span>}</span></div>;
}
function Row({row,used,month,now,open,toggle,typed,call,saved,hold}:{row:SubscriptionRow;used:string;month:string;now:number;open:boolean;toggle:(open:boolean)=>void;typed:number|undefined;call:Call;saved:(prices:Record<string,number>)=>void;hold:(element:HTMLDetailsElement|null)=>void}){
 const [draft,setDraft]=useState(typed===undefined?'':String(typed)),[error,setError]=useState('');
 // The figure is saved as it is typed; an empty field gives the row back to its list price.
 function type(text:string){
  setDraft(text);const clean=text.replace(/[^0-9.]/g,''),value=clean===''?null:Number(clean);
  if(value!==null&&!Number.isFinite(value)){setError('Type the monthly price as a number.');return;}
  setError('');void call('subscriptionPrice',{id:row.id,usd:value}).then(saved).catch(problem=>setError(String(problem).replace(/^Error invoking remote method 'app': (?:Error: )?/,'')));
 }
 return <details className="supplier-pill sub-row" ref={hold} open={open} onToggle={event=>toggle(event.currentTarget.open)}>
  <summary><div className="sub-name"><VendorIcon id={row.vendor}/><strong>{row.name}</strong><small>{row.plan}</small></div><Left row={row} now={now}/><div className={'sub-used'+(used==='None'?' none':'')}>{used}</div><Price row={row}/><span className="supplier-chevron">⌄</span></summary>
  <div className="supplier-settings sub-detail"><div className="sub-detail-grid">
   <div><h4>What is left</h4>{row.windows.length?row.windows.map(window=><div className={'sub-window'+(window.left<=0?' danger':window.left<=20?' warning':'')} key={window.label}><div><span>{window.label}</span><strong>{Math.round(window.left)}% left</strong></div><Meter label={row.name+' '+window.label+' remaining'} used={100-window.left} remaining/><small title={window.resetAt?new Date(window.resetAt).toLocaleString():undefined}>{shortReset(window.resetAt,now)}</small></div>)
    :row.balance?<div className="sub-window"><div><span>{row.group==='use'?'Credit':'Balance'}</span><strong>{row.balance}</strong></div></div>:<p className="hint">{row.name} reports no limit or balance to apps.</p>}</div>
   <div><h4>{monthName(month)}</h4><div className="sub-facts"><div><span>How you pay</span><span>{row.how}</span></div><div><span>Used</span><span>{used}</span></div>{row.facts.map(([name,value])=><div key={name}><span>{name}</span><span>{value}</span></div>)}</div>
    <label>Monthly price<input inputMode="decimal" aria-label={'Monthly price of '+row.name} placeholder={row.listUsd!==undefined?row.listUsd.toFixed(2):'0.00'} value={draft} onChange={event=>type(event.target.value)}/><small>{typed!==undefined?'You typed this figure. Empty the field to go back to what the supplier reports.':row.price.source==='confirmed'?row.price.why+'. Type a figure to replace it.':row.price.why+'. Type the figure from your bill to confirm it.'}</small></label>
    {error&&<p className="error" role="alert">{error}</p>}</div>
  </div><div className="actions">{row.links.map(link=><button type="button" key={link.kind} onClick={()=>void call('link',{kind:link.kind}).catch(()=>{})}>{link.label} ↗</button>)}</div></div>
 </details>;
}
function Stack({sum,max,rank,only}:{sum:UsageSum;max:number;rank:Record<string,number>;only:string}){
 const parts=Object.entries(sum.models).filter(([model,tokens])=>tokens>0&&(!only||model===only)).sort((a,b)=>b[1]-a[1]),shown=parts.reduce((total,[,tokens])=>total+tokens,0),rest=only?0:Math.max(0,sum.tokens-shown);
 return <span className="sub-stack" style={{width:Math.max(.5,(shown+rest)/max*100)+'%'}}>{parts.map(([model,tokens])=><i key={model} className={'sub-m'+Math.min(rank[model]??4,4)} style={{flex:tokens+' 0 0'}}/>)}{rest>0&&<i className="sub-m4" style={{flex:rest+' 0 0'}}/>}</span>;
}
function Usage({view,state,model,setModel}:{view:View;state:Snapshot;model:string;setModel:(model:string)=>void}){
 const {usage}=view,label=(id:string)=>modelLabel(id,state.claude?.models),models=Object.entries(usage.models).filter(([,tokens])=>tokens>0).sort((a,b)=>b[1]-a[1]),rank=Object.fromEntries(models.map(([id],index)=>[id,index]));
 const apps=[...view.apps.flatMap(app=>usage.apps[app.id]?.tokens?[{...app,sum:usage.apps[app.id]}]:[]),...(usage.unlinked.tokens?[{id:'',name:'No app',chatIds:[] as string[],sum:usage.unlinked}]:[])];
 const value=(sum:UsageSum)=>model?sum.models[model]||0:sum.tokens,shown=apps.filter(app=>value(app.sum)>0).sort((a,b)=>value(b.sum)-value(a.sum)),max=Math.max(1,...shown.map(app=>value(app.sum)));
 const [year,index]=view.month.split('-').map(Number),length=new Date(year,index,0).getDate(),today=new Date(),current=today.getFullYear()===year&&today.getMonth()===index-1?today.getDate():0,top=Math.max(1,...Object.values(usage.days));
 const day=(n:number)=>usage.days[view.month+'-'+String(n).padStart(2,'0')]||0;
 return <section className="settings-card sub-usage"><div className="sub-usage-head"><h3>Where it went</h3><span>{compact(usage.tokens)} tokens · {monthName(view.month)}{current?' so far':''}{usage.partial?' · some replies saved no count':''}</span></div>
  <div className="sub-days" style={{gridTemplateColumns:'repeat('+length+',minmax(0,1fr))'}} role="img" aria-label="Tokens per day">{Array.from({length},(_,i)=><i key={i} className={current&&i+1>current?'future':i+1===current?'today':''} style={{height:current&&i+1>current?undefined:Math.max(1.5,day(i+1)/top*100)+'%'}} title={(i+1)+' '+monthName(view.month)+': '+compact(day(i+1))+' tokens'}/>)}</div>
  <div className="sub-days-axis"><span>1</span><span>{current?'today, '+current:Math.ceil(length/2)}</span><span>{length}</span></div>
  <div className="sub-legend" role="group" aria-label="Model"><button type="button" className="link-button" aria-pressed={!model} onClick={()=>setModel('')}>All models</button>{models.map(([id,tokens])=><button type="button" className="link-button" key={id} aria-pressed={model===id} onClick={()=>setModel(model===id?'':id)}><span className={'sub-swatch sub-m'+Math.min(rank[id],4)}/>{label(id)} · {compact(tokens)}</button>)}</div>
  {shown.length?<div className="sub-bars">{shown.map(app=><details className="sub-appfold" key={app.id||'none'}><summary className="sub-app"><span title={app.name}>{app.name}</span><span><Stack sum={app.sum} max={max} rank={rank} only={model}/></span><span className="sub-num">{compact(value(app.sum))}</span><span className="sub-share">{model?share(value(app.sum),usage.models[model])+' of '+label(model):share(app.sum.tokens,usage.tokens)+' of the month'}</span></summary>
   <div className="sub-sessions">{usage.chats.filter(chat=>app.id?app.chatIds.includes(chat.chatId):!view.apps.some(other=>other.chatIds.includes(chat.chatId))).slice(0,5).map(chat=><div key={chat.chatId}><span title={view.titles[chat.chatId]}>{view.titles[chat.chatId]||'Chat'}</span><span>{chat.replies} {chat.replies===1?'reply':'replies'}</span><span>{compact(chat.tokens)} tok</span></div>)}</div></details>)}</div>
   :<p className="hint">No tokens were counted{model?' for '+label(model):''} in {monthName(view.month)}.</p>}
  {usage.shared>0&&<p className="hint">A chat linked to several apps counts in each, so the apps add up to more than the month.</p>}
 </section>;
}
export function SubscriptionsSettings({state,call,openConnections}:{state:Snapshot;call:Call;openConnections:()=>void}){
 const [view,setView]=useState<View|null>(null),[model,setModel]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[now,setNow]=useState(Date.now()),[open,setOpen]=useState<string[]>([]);
 const elements=useRef(new Map<string,HTMLDetailsElement>());
 async function load(month?:string,fresh=false){setBusy(true);try{setView(await call('subscriptions',{month,fresh}));setError('');}catch(problem){setError(String(problem).replace(/^Error invoking remote method 'app': (?:Error: )?/,''));}finally{setBusy(false);}}
 useEffect(()=>{void load();const timer=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(timer);},[]);
 const {rows,free}=subscriptionRows(state,{prices:view?.prices||{},elevenlabs:view?.elevenlabs,elevenlabsNote:view?.elevenlabsNote}),totals=subscriptionTotals(rows),look=needsLook(rows);
 const used=(row:SubscriptionRow)=>{if(row.id==='elevenlabs'&&view?.elevenlabs)return compact(view.elevenlabs.used)+' credits';const tokens=view?usedBy(row,view.usage.models):null;return tokens===null?'—':tokens?compact(tokens)+' tok':'None';};
 const show=(id:string)=>{setOpen(list=>list.includes(id)?list:[...list,id]);requestAnimationFrame(()=>elements.current.get(id)?.scrollIntoView({block:'center'}));};
 const groups=[['subscription','Subscriptions','a flat price each month'],['use','Pay per use','billed by what you send']] as const;
 return <section className="sub-page">
  <div className="sub-topline"><p className="hint">Everything Ghidorah is connected to: what it costs a month, what is left, and where to manage it. <span className="sub-key"><Mark source="confirmed" why="Typed by you, or reported as money by the supplier"/>confirmed</span><span className="sub-key"><Mark source="estimate" why="The list price of the plan the supplier reports"/>estimate</span></p>
   <div className="sub-tools">{view&&view.months.length>1&&<Tabs className="sub-month" label="Month" items={view.months.slice(0,4).reverse().map(id=>({id,label:monthName(id)}))} value={view.month} onChange={month=>void load(month)}/>}<button type="button" disabled={busy} onClick={()=>{void call('refreshUsage').catch(()=>{});void load(view?.month,true);}}>{busy?'Reading…':'Refresh'}</button></div></div>
  {error&&<p className="error" role="alert">{error}</p>}
  {!rows.length?<><p className="hint">Nothing is connected yet. A supplier is added in Connections.</p><div className="actions"><button type="button" className="primary" onClick={openConnections}>Open Connections</button></div></>:<>
   {look.length>0&&<ul className="sub-look" aria-label="Needs a look">{look.map((item,index)=><li key={index} className={item.tone==='warning'?'warning':undefined}><span className={'kit-dot'+(item.tone==='warning'?' kit-tone-warning':'')}/><span><b>{item.lead}</b> {item.rest}</span><button type="button" className="link-button" onClick={()=>show(item.id)}>Show ›</button></li>)}</ul>}
   <section className="settings-card sub-ledger"><div className="sub-head"><span>Service</span><span>What is left</span><span>Used</span><span>A month</span><span/></div>
    {groups.map(([id,label,what])=>rows.some(row=>row.group===id)&&<React.Fragment key={id}><div className="sub-group-label">{label} · {what}</div>{rows.filter(row=>row.group===id).map(row=><Row key={row.id} row={row} used={used(row)} month={view?.month||new Date().toISOString().slice(0,7)} now={now} open={open.includes(row.id)} toggle={next=>setOpen(list=>next?list.includes(row.id)?list:[...list,row.id]:list.filter(item=>item!==row.id))}
     typed={view?.prices[row.id]} call={call} saved={prices=>setView(current=>current&&{...current,prices})} hold={element=>{if(element)elements.current.set(row.id,element);else elements.current.delete(row.id);}}/>)}</React.Fragment>)}
    {free.length>0&&<><div className="sub-group-label">No charge</div><ul className="sub-free">{free.map(item=><li key={item.name}><strong>{item.name}</strong><span>{item.what}</span></li>)}</ul></>}
   </section>
   {view&&<Usage view={view} state={state} model={model in view.usage.models?model:''} setModel={setModel}/>}
   <footer className="sub-totals"><span><Mark source="confirmed" why="Typed by you, or reported as money by the supplier"/>Confirmed <b>{usd(totals.confirmed)}</b></span><span><Mark source="estimate" why="The list price of the plan the supplier reports"/>Estimated <b>{usd(totals.estimated)}</b></span>{totals.unknown>0&&<span><Mark source="unknown" why="Paid, with no figure in dollars"/><b>{totals.unknown}</b> paid, amount unknown</span>}
    <span className="sub-sum"><span className="sub-split" aria-hidden="true"><i style={{width:(totals.sum?totals.confirmed/totals.sum*100:0)+'%'}}/><i style={{width:(totals.sum?totals.estimated/totals.sum*100:0)+'%'}}/></span>A month <b>{usd(totals.sum)}</b></span></footer>
  </>}
 </section>;
}
