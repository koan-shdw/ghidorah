// Agent pills (Koan's pick 2026-11-18: version 2 of the mockup). The chat's agents that are working right now, as a
// stack in the top corner of the chat: each with its task as its name, its current step under it, how long it has
// run and a stop square. An agent waiting for a permission turns amber and takes Allow or Deny right there. An
// agent that finishes shows a tick for a few seconds, then leaves. The full list stays in Workspace › Tasks.
// The agents come from activeAgents (activity.ts); the step is the agent's own running tool, in the words the
// action list uses, read only from the tool rows of the agents shown.
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {activeAgents,type ActiveAgent} from './activity';
import {Icon,Spinner} from './kit';
import {activityInfo} from './tool-activity';
import type {Approval,Snapshot,ToolCall} from './types';
// Styles: ui.css (.agent-pill*).

type Call=(method:string,args?:any)=>Promise<any>;
/** How long ago, short: 40s, 4m, 1h 5m. */
export const elapsed=(from:number,now:number)=>{const seconds=Math.max(0,Math.round((now-from)/1000));return seconds<60?seconds+'s':seconds<3600?Math.floor(seconds/60)+'m':Math.floor(seconds/3600)+'h '+Math.floor(seconds%3600/60)+'m';};
/** Each agent's running tool in plain words; the latest one when several run. Agents with none are left out. */
export function agentSteps(agents:{id:string}[],tools:ToolCall[]){
 const ids=new Set(agents.map(agent=>agent.id)),steps:Record<string,string>={};
 if(ids.size)for(const tool of tools)if(tool.status==='running'&&ids.has(tool.turnId)){const info=activityInfo(tool);if(!info.internal)steps[tool.turnId]=info.words;}
 return steps;
}
/** What a waiting permission is for, in the action list's words ("Write notes.md"). A question has no such line. */
export function approvalWords(approval:Pick<Approval,'method'|'params'>){
 if(approval.method.startsWith('clarify'))return '';
 const [name,...rest]=String(approval.params?.description||'').split('\n');let args:any={};
 try{args=JSON.parse(rest.join('\n'));}catch{}
 return activityInfo({id:'',turnId:'',name:name||'Tool',args,result:null,status:'running'}).words;
}

export function AgentPills({state,chatId,call,openAgent}:{state:Snapshot;chatId:string;call:Call;openAgent:(id:string)=>void}){
 const agents=chatId?activeAgents(state,chatId):[],ids=agents.map(agent=>agent.id).join(' ');
 const steps=useMemo(()=>agentSteps(agents,state.tools),[state.tools,ids]);
 const [now,setNow]=useState(Date.now()),[hidden,setHidden]=useState(false),[done,setDone]=useState<{id:string;name:string;took:string}[]>([]),[error,setError]=useState('');
 const seen=useRef(new Map<string,ActiveAgent>()),timers=useRef<ReturnType<typeof setTimeout>[]>([]);
 useEffect(()=>{if(!ids)return;const timer=setInterval(()=>setNow(Date.now()),5000);return()=>clearInterval(timer);},[!!ids]);
 useEffect(()=>()=>{for(const timer of timers.current)clearTimeout(timer);},[]);
 // An agent that was working and has completed shows its tick for five seconds. One that failed or was stopped
 // just leaves: its row in the chat and in Tasks says what happened.
 useEffect(()=>{
  const current=new Set(agents.map(agent=>agent.id)),ended=[...seen.current.values()].filter(agent=>!current.has(agent.id));
  seen.current=new Map(agents.map(agent=>[agent.id,agent]));
  const finished=ended.flatMap(agent=>{const turn=state.turns.find(row=>row.id===agent.id);return turn?.status==='completed'?[{id:agent.id,name:agent.name,took:elapsed(agent.since,turn.finished||Date.now())}]:[];});
  if(!finished.length)return;
  setDone(list=>[...list.filter(row=>!finished.some(item=>item.id===row.id)),...finished]);
  timers.current.push(setTimeout(()=>setDone(list=>list.filter(row=>!finished.some(item=>item.id===row.id))),5000));
 });
 if(!agents.length&&!done.length)return null;
 const run=(method:string,args:any)=>{setError('');void call(method,args).catch(problem=>setError(String(problem).replace(/^Error invoking remote method 'app': (?:Error: )?/,'')));};
 const asking=agents.filter(agent=>agent.approvalId).length,stoppable=agents.filter(agent=>agent.stopId&&!agent.stopping);
 return <div className="agent-pills-anchor"><aside className="agent-pills" aria-label="Agents at work">
  <div className="agent-pills-head"><span><b>{agents.length}</b> {agents.length===1?'agent':'agents'} working{asking?' · '+asking+(asking===1?' needs you':' need you'):''}</span>
   {stoppable.length>1&&<button type="button" onClick={()=>{for(const agent of stoppable)run('backgroundStop',{id:agent.stopId});}}>Stop all</button>}
   <button type="button" aria-expanded={!hidden} onClick={()=>setHidden(!hidden)}>{hidden?'Show':'Hide'}</button></div>
  {!hidden&&agents.map(agent=>{
   const approval=agent.approvalId?state.approvals.find(row=>row.id===agent.approvalId):undefined,words=approval?approvalWords(approval):'';
   return <div className={'agent-pill'+(approval?' ask':'')} role="group" aria-label={agent.name} key={agent.id}>
    {approval?<span className="agent-mark ask" aria-hidden="true"/>:<Spinner label="Working"/>}
    <span className="agent-pill-text"><button type="button" className="agent-pill-name" title="Open this agent" onClick={()=>openAgent(agent.id)}>{agent.name}</button>
     {approval?<><small>{words?'Needs your permission: '+words:'Has a question for you'}</small>{words?<span className="agent-pill-ask"><button type="button" onClick={()=>run('approve',{id:approval.id,choice:'once'})}>Allow once</button><button type="button" onClick={()=>run('approve',{id:approval.id,choice:'deny'})}>Deny</button></span>:<span className="agent-pill-ask"><button type="button" onClick={()=>openAgent(agent.id)}>Open</button></span>}</>
      :<small>{agent.stopping?'Stopping…':steps[agent.id]||agent.step||'Working'}</small>}</span>
    <span className="agent-pill-meta">{elapsed(agent.since,now)}</span>
    {agent.stopId&&<button type="button" className="agent-pill-stop" disabled={agent.stopping} aria-label={'Stop '+agent.name} title="Stop this agent" onClick={()=>run('backgroundStop',{id:agent.stopId})}><Icon name="stop"/></button>}
   </div>;})}
  {!hidden&&done.map(row=><div className="agent-pill done" role="group" aria-label={row.name} key={row.id}><span className="agent-mark done" aria-hidden="true">✓</span><span className="agent-pill-text"><button type="button" className="agent-pill-name" title="Open this agent" onClick={()=>openAgent(row.id)}>{row.name}</button><small>Done in {row.took}</small></span>
   <button type="button" className="agent-pill-stop" aria-label={'Close '+row.name} title="Close" onClick={()=>setDone(list=>list.filter(item=>item.id!==row.id))}>×</button></div>)}
  {error&&<p className="error" role="alert">{error}</p>}
 </aside></div>;
}
