// The reply's plan as a checklist at its top (his pick 10-25, V1 of notes/mockups/plan-checklist), ticked off as the
// model works, with the current action under the current step; folded to "6 of 6 steps done" once the reply ends.
// Steps come from the model's own task tools: a whole list per call (Claude's TodoWrite, the Hermes todo tool), or
// Claude Code's TaskCreate / TaskUpdate / TaskList, which keep one list across the chat and are replayed up to this reply.
import React,{useState} from 'react';
import {planSteps,foldText} from './activity';
import {activityInfo} from './tool-activity';
import type {ToolCall} from './types';

export {planSteps,foldText} from './activity';

const said={pending:'Not started',in_progress:'In progress',completed:'Done',cancelled:'Dropped'};
export function PlanChecklist({tools,before,working}:{tools:ToolCall[];before?:()=>ToolCall[];working:boolean}){
 const [open,setOpen]=useState(false),items=planSteps(tools,before);if(!items?.length)return null;
 const running=tools.map(tool=>({tool,...activityInfo(tool)})).findLast(row=>row.state==='running'&&!row.internal)?.words;
 const list=<ol className="plan-checklist" aria-label="Plan">{items.map((item,index)=>{const now=working&&item.status==='in_progress'?running||item.now:undefined;return <li key={item.id+':'+index} className={item.status}>
  <span className={'plan-mark '+item.status} role="img" aria-label={said[item.status]}/><span className="plan-text">{item.content}{now&&<span className="plan-now">{now}</span>}</span></li>;})}</ol>;
 if(working)return list;
 const all=items.every(item=>item.status==='completed'||item.status==='cancelled');
 return <div className="plan-folded"><button type="button" className="plan-fold" aria-expanded={open} onClick={()=>setOpen(!open)}><span className={'plan-mark '+(all?'completed':'pending')} aria-hidden="true"/>{foldText(items)}<span className="plan-chevron" aria-hidden="true">›</span></button>{open&&list}</div>;
}
