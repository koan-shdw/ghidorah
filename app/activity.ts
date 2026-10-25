import type {Approval,Snapshot,ToolCall,Turn} from './types';

export interface TaskItem {id:string;content:string;status:'pending'|'in_progress'|'completed'|'cancelled';}
export interface ChatActivity {
 plans:{approval:Approval;model:string}[];
 tasks:{owner:string;model:string;items:TaskItem[]}[];
 agents:Turn[];
}
export function taskItems(value:unknown):TaskItem[]|null{
 if(!Array.isArray(value)||value.length>1000)return null;
 const rows:TaskItem[]=[];
 for(const [index,item] of value.entries()){
  if(!item||typeof item!=='object'||typeof item.content!=='string'||!item.content.trim()||item.content.length>20000||!['pending','in_progress','completed','cancelled'].includes(item.status))return null;
  rows.push({id:typeof item.id==='string'?item.id:String(index),content:item.content,status:item.status});
 }
 return rows;
}
export type PlanStep=TaskItem&{now?:string};
const listTools=new Set(['todo','todo_list','todowrite']),taskTools=new Set(['taskcreate','taskupdate','tasklist']);
const unwrap=(value:unknown):any=>{try{const raw=typeof value==='string'?JSON.parse(value):value;return raw?.content?.length===1&&raw.content[0].type==='text'?unwrap(raw.content[0].text)??raw:raw;}catch{return null;}};
const key=(tool:ToolCall)=>(tool.name||'').split('__').at(-1)!.toLowerCase();
const failed=(result:any)=>!!(result?.error||result?.is_error||result?.success===false);
/** The steps a reply's task tools leave, or null when it touched none; an emptied whole list is []. The reply checklist
 * (plan-checklist.tsx) and the Tasks panel both read this. `before` is the chat's earlier tool calls. */
export function planSteps(tools:ToolCall[],before:ToolCall[]|(()=>ToolCall[])=[]):PlanStep[]|null{
 const done=tools.filter(tool=>tool.status==='completed'&&!failed(unwrap(tool.result)));
 const list=[...done].reverse().find(tool=>listTools.has(key(tool)));
 if(list){const raw=key(list)==='todowrite'?unwrap(list.args)?.todos:unwrap(list.result)?.todos,items=taskItems(raw);if(items)return items.map((item,index)=>typeof raw[index]?.activeForm==='string'?{...item,now:raw[index].activeForm}:item);}
 if(!done.some(tool=>taskTools.has(key(tool))))return null;
 const steps=new Map<string,PlanStep>();
 // The chat's earlier calls are gathered only for a reply that touched a task.
 for(const tool of [...(typeof before==='function'?before():before),...tools]){
  if(tool.status!=='completed'||!taskTools.has(key(tool)))continue;
  const args=unwrap(tool.args)||{},result=unwrap(tool.result)||{};if(failed(result))continue;
  if(key(tool)==='taskcreate'&&typeof result.task?.id==='string')steps.set(result.task.id,{id:result.task.id,content:String(result.task.subject||args.subject||''),status:'pending',now:typeof args.activeForm==='string'?args.activeForm:undefined});
  else if(key(tool)==='tasklist'&&Array.isArray(result.tasks)){const old=new Map(steps);steps.clear();for(const task of result.tasks)if(typeof task?.id==='string')steps.set(task.id,{...old.get(task.id),id:task.id,content:String(task.subject||''),status:['in_progress','completed'].includes(task.status)?task.status:'pending'});}
  else if(key(tool)==='taskupdate'&&typeof args.taskId==='string'){
   if(args.status==='deleted'){steps.delete(args.taskId);continue;}
   const step=steps.get(args.taskId);if(!step)continue;
   steps.set(args.taskId,{...step,...(typeof args.subject==='string'?{content:args.subject}:{}),...(['pending','in_progress','completed'].includes(args.status)?{status:args.status}:{}),...(typeof args.activeForm==='string'?{now:args.activeForm}:{})});
  }
 }
 const rows=[...steps.values()].filter(step=>step.content.trim());return rows.length?rows:null;
}
/** "6 of 6 steps done": dropped steps are left out of both numbers. */
export function foldText(items:TaskItem[]){const kept=items.filter(item=>item.status!=='cancelled');return kept.filter(item=>item.status==='completed').length+' of '+kept.length+(kept.length===1?' step':' steps')+' done';}

export function chatActivity(state:Pick<Snapshot,'chats'|'jobChats'|'turns'|'tools'|'approvals'>,chatId:string):ChatActivity{
 const allTurns=new Map(state.turns.map(turn=>[turn.id,turn])),owners=new Set([chatId,...[...state.chats,...state.jobChats||[]].filter(chat=>chat.parentChatId===chatId).map(chat=>chat.id)]);
 for(const turn of state.turns)if(turn.parentTurnId&&allTurns.get(turn.parentTurnId)?.chatId===chatId)owners.add(turn.chatId);
 const turns=new Map(state.turns.filter(turn=>owners.has(turn.chatId)).map(turn=>[turn.id,turn]));
 const plans=state.approvals.filter(approval=>owners.has(approval.chatId)&&turns.has(approval.turnId)&&typeof approval.params?.plan==='string').map(approval=>({approval,model:turns.get(approval.turnId)!.model}));
 const tasks=new Map<string,{owner:string;model:string;items:TaskItem[]}>(),byOwner=new Map<string,ToolCall[]>();
 for(const tool of state.tools){const turn=turns.get(tool.turnId);if(!turn)continue;const owner=turn.automatic?.kind==='agent'?turn.id:turn.chatId;(byOwner.get(owner)||byOwner.set(owner,[]).get(owner)!).push(tool);}
 // Each chat or agent shows the list its latest task call left, the same steps as that reply's checklist.
 for(const [owner,rows] of byOwner){
  const last=rows.findLast(tool=>tool.status==='completed'&&(listTools.has(key(tool))||taskTools.has(key(tool))));if(!last)continue;
  const first=rows.findIndex(tool=>tool.turnId===last.turnId),items=planSteps(rows.filter(tool=>tool.turnId===last.turnId),()=>rows.slice(0,first));
  if(items)tasks.set(owner,{owner,model:turns.get(last.turnId)!.model,items});
 }
 return {plans,tasks:[...tasks.values()],agents:[...turns.values()].filter(turn=>turn.automatic?.kind==='agent')};
}
