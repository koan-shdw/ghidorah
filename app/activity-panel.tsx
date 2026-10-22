import React from 'react';
import type {ChatActivity} from './activity';
import {Markdown} from './chat-content';
import {modelLabel} from './models';

export function ActivityPanel({view,activity,call,openAgent}:{openAgent?:(id:string)=>void;view:'plan'|'tasks';activity:ChatActivity;call:(method:string,args?:any)=>Promise<any>}){
 const [error,setError]=React.useState('');
 const run=(method:string,args:any)=>{setError('');void call(method,args).catch(error=>setError(String(error).replace(/^Error invoking remote method 'app': (?:Error: )?/,'')));};
 return <div className="activity-pane">
  {view==='plan'?activity.plans.length?activity.plans.map(({approval,model})=><section key={approval.id} className="activity-plan"><p className="hint">{modelLabel(model)} · {({pending:'Waiting for review',once:'Approved',deny:'Declined',expired:'Expired'} as Record<string,string>)[approval.status]||approval.status}</p><Markdown text={approval.params.plan} turnId={approval.turnId}/>{approval.status==='pending'&&<div className="actions"><button onClick={()=>run('approve',{id:approval.id,choice:'once'})}>Approve plan</button><button onClick={()=>run('approve',{id:approval.id,choice:'deny'})}>Keep planning</button></div>}</section>):<p className="workspace-notice">No plan has been recorded for this chat.</p>:<>
   {!activity.tasks.length&&!activity.agents.length&&<p className="workspace-notice">No tasks have been recorded for this chat.</p>}
   {activity.tasks.map(({owner,model,items})=><section key={owner}><h3>{modelLabel(model)}</h3>{items.length?<ul className="task-list">{items.map((item,index)=><li key={item.id+':'+index}><span className={'task-state '+item.status}>{({pending:'Pending',in_progress:'In progress',completed:'Completed',cancelled:'Cancelled'})[item.status]}</span><span>{item.content}</span></li>)}</ul>:<p className="hint">Task list cleared.</p>}</section>)}
   {activity.agents.length>0&&<section><h3>Subagents</h3>{activity.agents.map(turn=><details key={turn.id}><summary>{turn.automatic?.description||turn.automatic?.agentType||'Agent'} · {turn.status}</summary><button onClick={()=>openAgent?openAgent(turn.id):run('openJob',{id:turn.id})}>Open agent</button><p className="hint">{modelLabel(turn.model)}</p>{turn.text&&<Markdown text={turn.text} turnId={turn.id}/>}</details>)}</section>}
  </>}
  {error&&<p className="error" role="alert">{error}</p>}
 </div>;
}
