import React,{useEffect,useState} from 'react';
import type {Turn,ToolCall,Approval} from './types';
import {isPicker,picker} from './pickers';

// The model shown on a message. While it is routed, whoever picks: the chat's selector model or a picker (Koan,
// 2026-10-15: the label showed the chat's default model while Gemini picked).
export function turnModelLabel(turn:Turn,label:(model:string)=>string){
 if(turn.routePending&&turn.routeBy)return (isPicker(turn.routeBy)?picker(turn.routeBy)!.short:label(turn.routeBy))+' picking';
 return label(turn.model);
}

export function turnActivity(turn:Turn,tools:ToolCall[],approvals:Approval[]){
 const pending=approvals.filter(a=>a.turnId===turn.id&&a.status==='pending'),running=tools.filter(t=>t.turnId===turn.id&&t.status==='running').length;
 if(turn.status==='stopping')return 'Stopping…';
 if(pending.length)return pending.every(a=>a.method.startsWith('clarify'))?'Waiting for your answer':'Waiting for approval';
 if(turn.status==='dispatching')return turn.preparation||'Preparing reply';
 if(turn.status==='queued')return turn.paused?'Paused after restart':turn.hold||'Sending';
 if(['running','waiting'].includes(turn.status))return turn.activity==='Compressing context'?turn.activity:running?`Running ${running} ${running===1?'tool':'tools'}`:turn.activity||'Waiting for model';
 const status=({'needs-model':'Choose a model',partial:'Partly completed'})[turn.status]||turn.status[0].toUpperCase()+turn.status.slice(1);
 const reasons:Partial<Record<NonNullable<Turn['stopReason']>,string>>={'user-stop':'Stopped by you','superseded-by-message':'Stopped for your new message','goal-pause':'Goal paused','app-restart':'App restarted','backend-lost':'Backend connection lost','approval-expired':'Approval expired'};
 const reason=turn.stopReason?reasons[turn.stopReason]:undefined;
 return reason&&['stopped','interrupted','failed'].includes(turn.status)?reason:status;
}
/** C13: grey when settled, green while live, red only on failure. */
export function turnTone(turn:Turn){return ['queued','dispatching','running','waiting','stopping'].includes(turn.status)?'live':['failed','interrupted'].includes(turn.status)?'danger':'muted';}
export function TurnStatus({turn,tools,approvals}:{turn:Turn;tools:ToolCall[];approvals:Approval[]}){
 const [now,setNow]=useState(Date.now),active=['dispatching','running','waiting','stopping'].includes(turn.status);
 useEffect(()=>{if(!active)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[active,turn.id]);
 const elapsed=Math.max(0,Math.floor((now-(turn.stageSince||turn.created))/1000));
 return <span className="turn-activity" data-tone={turnTone(turn)} title={active&&turn.lastActivity?'Last activity: '+new Date(turn.lastActivity).toLocaleTimeString():undefined}>{turnActivity(turn,tools,approvals)}{active&&` · ${Math.floor(elapsed/60)}:${String(elapsed%60).padStart(2,'0')}`}</span>;
}
