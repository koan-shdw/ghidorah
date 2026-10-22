import React,{useEffect,useId,useRef,useState} from 'react';
import type {Goal} from './goals';
import {Button,Dialog,Notice} from './kit';
import './goal.css';

const labels={active:'Active',paused:'Paused',blocked:'Needs input',complete:'Complete','budget-limited':'Budget reached'};
export function GoalPanel({chatId,goal,busy,call}:{chatId:string;goal?:Goal;busy:boolean;call:(name:string,args:any)=>Promise<any>}){
 const titleId=useId(),[open,setOpen]=useState(false),[objective,setObjective]=useState(goal?.objective||''),[budget,setBudget]=useState(goal?.tokenBudget?.toString()||''),[error,setError]=useState(''),[pending,setPending]=useState(false);
 useEffect(()=>{setObjective(goal?.objective||'');setBudget(goal?.tokenBudget?.toString()||'');},[goal?.key,goal?.objective,goal?.tokenBudget]);
 const active=goal?.status==='active';
 async function action(name:string){setPending(true);setError('');try{await call(name,{chatId,objective,tokenBudget:budget.trim()?Number(budget):null});if(name==='goalClear')setOpen(false);}catch(error){setError(String(error).replace(/^Error invoking remote method 'app': (?:Error: )?/,''));}finally{setPending(false);}}
 return <>
  <div className={'goal-bar '+(goal?'has-goal':'')}>
   {goal?<><button className="goal-direction" onClick={()=>setOpen(true)} title={goal.objective}><span className={'goal-dot '+goal.status}/><span><strong>Goal</strong> {goal.objective}</span></button><span className="goal-state">{labels[goal.status]}</span><button aria-label="Open goal" onClick={()=>setOpen(true)}>↗</button></>:<button className="set-goal" disabled={!chatId} onClick={()=>setOpen(true)}>＋ Set Goal</button>}
  </div>
  {open&&<Dialog title={goal?'Chat goal':'Set Goal'} id={titleId} className="goal-dialog" closeLabel="Close goal" onClose={()=>setOpen(false)} footer={<>{goal&&!active&&<Button variant="outline" className="kit-spacer" disabled={pending||busy} onClick={()=>void action('goalClear')}>Clear goal</Button>}{active?<Button variant="primary" disabled={pending} onClick={()=>void action('goalPause')}>Pause</Button>:<Button variant="primary" disabled={pending||busy||!objective.trim()} onClick={()=>void action(goal&&goal.status!=='complete'?'goalResume':'goalSet')}>{goal&&goal.status!=='complete'?'Save and resume':goal?'Set new goal':'Set Goal'}</Button>}</>}>
   <p>Set the direction for this chat. Models keep working toward it using this chat’s permissions.</p>
   <label>What should we achieve?<textarea aria-label="Goal objective" value={objective} maxLength={12000} disabled={active||pending} placeholder="Describe the outcome and how we’ll know it’s done…" onChange={event=>setObjective(event.target.value)}/></label>
   <details><summary>Token budget{goal?.tokenBudget?' · '+goal.tokenBudget.toLocaleString(): ' · optional'}</summary><label>Maximum reported tokens<input aria-label="Goal token budget" type="number" min="1" step="1" placeholder="No limit" value={budget} disabled={active||pending} onChange={event=>setBudget(event.target.value)}/></label><p>Checked between turns. The final turn can exceed the limit. Missing usage stops automatic continuation when a budget is set.</p></details>
   {goal&&<section className="goal-progress" aria-label="Goal progress"><div><strong>{labels[goal.status]}</strong><span>{goal.turns} {goal.turns===1?'turn':'turns'} · {goal.tokens.toLocaleString()}{goal.usageIncomplete?'+':''} reported tokens</span></div>{goal.tokenBudget!==null&&<progress aria-label="Goal token usage" max={goal.tokenBudget} value={Math.min(goal.tokens,goal.tokenBudget)}/>}<p>{goal.summary}</p>{goal.evidence&&<details><summary>Evidence and progress</summary><pre>{goal.evidence}</pre></details>}</section>}
   {error&&<Notice tone="danger" role="alert" className="error">{error}</Notice>}
  </Dialog>}
 </>;
}
