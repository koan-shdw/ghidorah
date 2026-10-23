import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {Snapshot,Turn} from './types';
import {modelLabel} from './models';
import {modelUsage,priceLines} from './usage';
import {UsageWindows,compact} from './usage-panel';
export function ModelUsageTooltip({id,model,state,turns,pool,status}:{id?:string;model:string;state:Snapshot;turns:Turn[];pool:string[];status?:string}){
 const marker=useRef<HTMLSpanElement>(null),card=useRef<HTMLDivElement>(null),[anchor,setAnchor]=useState<DOMRect|null>(null);
 useEffect(()=>{const button=marker.current?.previousElementSibling;if(!button)return;const show=()=>setAnchor(button.getBoundingClientRect()),hide=()=>setAnchor(null);button.addEventListener('mouseenter',show);button.addEventListener('focus',show);button.addEventListener('mouseleave',hide);button.addEventListener('blur',hide);window.addEventListener('resize',hide);return()=>{button.removeEventListener('mouseenter',show);button.removeEventListener('focus',show);button.removeEventListener('mouseleave',hide);button.removeEventListener('blur',hide);window.removeEventListener('resize',hide);};},[]);
 useLayoutEffect(()=>{if(!anchor||!card.current)return;const el=card.current;el.style.left=Math.max(8,Math.min(anchor.left,innerWidth-el.offsetWidth-8))+'px';el.style.top=Math.max(8,Math.min(anchor.top-el.offsetHeight-10,innerHeight-el.offsetHeight-8))+'px';},[anchor]);
 const usage=modelUsage(turns,model),subscription=model.startsWith('gpt-')?state.codex:model.startsWith('claude-code:')?state.claude:(/^api:[^:]+-oauth:/.test(model)||model.startsWith('api:nous:'))?{windows:[]}:null;
 return <><span ref={marker} hidden/>{anchor&&createPortal(<div ref={card} className="model-usage-tooltip" role="tooltip" id={id||'model-usage-'+model} style={{display:'block',position:'fixed',bottom:'auto'}}>
  <div className="usage-account-heading"><h3>{modelLabel(model,state.claude?.models)}</h3><span>{status||'Connection unverified'}</span></div>
  <p className="usage-tip-tokens" title={usage.tokens===null?undefined:usage.tokens.toLocaleString()+' tokens'}><strong>{usage.tokens===null?'—':compact(usage.tokens)}{usage.partial?'*':''}</strong><span>{usage.tokens===null?'Tokens unavailable':'tokens in this chat'+(usage.partial?' · partial reporting':'')}</span></p>
  <p className="usage-tip-note">{subscription?'Subscription · no per-token billing':usage.cost===null?'Cost unavailable':(usage.costPartial?'Reported cost $':'Estimated cost $')+usage.cost.toFixed(4)}</p>
  {subscription?.windows?.length?<UsageWindows name={modelLabel(model,state.claude?.models)} windows={subscription.windows} now={Date.now()}/>:null}
  {!subscription&&priceLines(model,pool,state.modelPrices,other=>modelLabel(other,state.claude?.models)).map((line,i)=><p className="usage-tip-note" key={'price-'+i}>{line}</p>)}
 </div>,document.body)}</>;
}
