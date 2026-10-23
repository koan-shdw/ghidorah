// Side answers on screen (FEATURE-SPECS 2): a card floating just above the message box while it matters, and the
// answers kept in the chat, dimmed and folded under the turn they were asked during.
import './side-answers.css';
import React from 'react';
import type {SideAnswer,Snapshot} from './types';
import {Markdown} from './chat-content';
import {modelLabel} from './models';
import {Button} from './kit';

type Call=(method:string,args?:any)=>Promise<any>;
const answerText=(row:SideAnswer)=>row.status==='sorting'?'Checking whether this is a quick question…':row.status==='answering'?'Answering…':row.text;

// The window's call shows any error itself.
export function SideAnswerCard({state,call,chatId}:{state:Snapshot;call:Call;chatId:string}){
 const rows=(state.sideAnswers||[]).filter(row=>row.chatId===chatId),latest=rows.filter(row=>!row.closed).at(-1);
 if(!latest)return null;
 const earlier=rows.filter(row=>row.turnId===latest.turnId&&row.created<latest.created&&row.status!=='sorting');
 const act=(method:string)=>void call(method,{id:latest.id,chatId}).catch(()=>{});
 return <section className="side-card" aria-label="Side answer" key={latest.id}>
  <header><span>Side answer · {modelLabel(latest.model)} · from live state</span><Button iconOnly icon="close" className="side-close" aria-label="Close side answer" title="Close side answer" onClick={()=>act('sideAnswerClose')}/></header>
  <p className="side-question">{latest.question}</p>
  <div className={'side-text'+(latest.status==='failed'?' failed':'')} role="status">{latest.status==='done'?<Markdown text={latest.text} turnId={latest.turnId}/>:answerText(latest)}</div>
  {earlier.length>0&&<details className="side-earlier"><summary>Earlier ({earlier.length})</summary>{earlier.map(row=><div key={row.id}><p className="side-question">{row.question}</p><div className="side-text">{row.text}</div></div>)}</details>}
  {latest.status==='done'&&<div className="side-actions"><Button variant="outline" onClick={()=>act('sideAnswerTell')}>Tell the main model</Button><Button variant="outline" onClick={()=>act('sideAnswerAsk')}>Ask the main model instead</Button></div>}
 </section>;
}

export function SideAnswerRows({state,turnId}:{state:Snapshot;turnId:string}){
 const rows=(state.sideAnswers||[]).filter(row=>row.turnId===turnId&&['done','failed'].includes(row.status));
 if(!rows.length)return null;
 return <div className="side-rows">{rows.map(row=><details className="side-row" key={row.id}><summary>Side answer · {row.question}</summary><div className="side-text"><Markdown text={row.text} turnId={turnId}/></div><span className="side-meta">{modelLabel(row.model)}{row.sent==='told'?' · sent to the main model':row.sent==='asked'?' · asked the main model':''}</span></details>)}</div>;
}
