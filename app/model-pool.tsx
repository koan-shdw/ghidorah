import {apiSuppliers} from './api-catalog';
import React,{useId,useState} from 'react';
import type {Snapshot} from './types';
import {modelLabel,newestFirst} from './models';
import {modelStatus} from './availability';

export function ModelPool({state,chatId,call,connections,defaults=false}:{state:Snapshot;chatId:string;defaults?:boolean;call:(method:string,args:any)=>Promise<any>;connections:()=>void}){
  const titleId=useId();
  const [pending,setPending]=useState<string[]>([]);
  const chat=state.chats.find(chat=>chat.id===chatId),pool=defaults?(state.defaultModels||['deepseek-flash']):(chat?.pool||[]);
  const models=newestFirst([
    ...(state.apiProviders||[]).filter(row=>row.connected).flatMap(row=>row.models.map(model=>({id:model.id,supplier:apiSuppliers[row.provider].name,created:model.created||null,description:model.description||null}))),
    ...(state.connected?(state.deepseekModels||['deepseek-flash']).map(id=>({id,supplier:'DeepSeek',created:null,description:null})):[]),
    ...(state.codex?.connected?state.codex.models.map(id=>({id,supplier:'OpenAI',created:null,description:state.codex?.details?.[id]?.description||null})):[]),
    ...(state.claude?.connected?(state.claude.models||[]).map(model=>({id:model.id,supplier:'Anthropic',created:null,description:model.description||null})):[]),
  ],id=>modelLabel(id,state.claude?.models));
  const favourites=state.favouriteModels||[];
  async function add(model:string){setPending(previous=>[...previous,model]);try{await call(defaults?'defaultModel':'addModel',{chatId,model,enabled:!pool.includes(model)});}catch{}finally{setPending(previous=>previous.filter(id=>id!==model));}}
  function pill({id,created,description}:{id:string;supplier:string;created:number|null;description:string|null}){
    const added=pool.includes(id),label=modelLabel(id,state.claude?.models),favourite=favourites.includes(id),{status,health}=modelStatus(state,id);
    const toggle=()=>void call('favouriteModel',{model:id,enabled:!favourite}).catch(()=>{});
    const about=[description,created?'Released '+new Date(created).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}):null,status||'Connection unverified','Right-click to change favourite'].filter(Boolean).join('\n');
    return <div key={id} data-model={id} className={'pool-pill'+(added?' added':'')} onContextMenu={event=>{event.preventDefault();toggle();}} title={about}>
      <button className="pool-add" disabled={(!defaults&&(!chat||added))||pending.includes(id)} aria-pressed={added} aria-label={defaults?(added?'Remove ':'Add ')+label+(added?' from defaults':' to defaults'):added?label+' is in this chat':'Add '+label+' to this chat'} onClick={()=>void add(id)}>
        <span><span className={'health-dot '+health} aria-hidden="true"/><strong>{label}</strong>{models.some(model=>model.id!==id&&modelLabel(model.id,state.claude?.models)===label)&&<small className="pool-variant">{id.replace('claude-code:','')}</small>}</span><span className="pool-action">{added?'✓':pending.includes(id)?'…':'＋'}</span>
      </button>
      <button className={'pool-star'+(favourite?' active':'')} aria-label={(favourite?'Unfavourite ':'Favourite ')+label} aria-pressed={favourite} onClick={toggle}> {favourite?'★':'☆'} </button>
    </div>;
  }
  return <section className="model-pool" aria-labelledby={titleId}>
    <h3 id={titleId}>{defaults?'Default models':chat?.title||'Choose a chat'}</h3>
    <p>{defaults?'Choose the models included in new chats.':'Click a model to add it to this chat. A check marks a linked model.'} Right-click or use the star to save a favourite.</p>
    <section aria-label="Favourite models"><h4>Favourites</h4><div className="pool-pills">{models.filter(model=>favourites.includes(model.id)).map(pill)}</div>{!models.some(model=>favourites.includes(model.id))&&<p className="pool-empty">Your favourites appear here.</p>}</section>
    <section aria-label="All available models"><h4>All available models</h4>{[...new Set(models.map(model=>model.supplier))].map(supplier=><section className="pool-group" aria-label={supplier+' models'} key={supplier}><h5>{supplier}</h5><div className="pool-pills">{models.filter(model=>model.supplier===supplier).map(pill)}</div></section>)}</section>
    {!models.length&&<p>Connect a supplier to see its available models here.</p>}
    {(state.codex?.connected&&!state.codex.models.length||state.claude?.connected&&!state.claude.models?.length)&&<p>Waiting for the supplier’s model list.</p>}
    <button className="pool-connections" onClick={connections}>Manage connections →</button>

  </section>;
}
