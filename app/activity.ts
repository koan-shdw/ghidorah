import type {Approval,Snapshot,Turn} from './types';

export interface TaskItem {id:string;content:string;status:'pending'|'in_progress'|'completed'|'cancelled';}
export interface ChatActivity {
 plans:{approval:Approval;model:string}[];
 tasks:{owner:string;model:string;items:TaskItem[]}[];
 agents:Turn[];
}
const object=(value:unknown):any=>{try{return typeof value==='string'?JSON.parse(value):value;}catch{return null;}};
export function taskItems(value:unknown):TaskItem[]|null{
 if(!Array.isArray(value)||value.length>1000)return null;
 const rows:TaskItem[]=[];
 for(const [index,item] of value.entries()){
  if(!item||typeof item!=='object'||typeof item.content!=='string'||!item.content.trim()||item.content.length>20000||!['pending','in_progress','completed','cancelled'].includes(item.status))return null;
  rows.push({id:typeof item.id==='string'?item.id:String(index),content:item.content,status:item.status});
 }
 return rows;
}
export function chatActivity(state:Pick<Snapshot,'chats'|'jobChats'|'turns'|'tools'|'approvals'>,chatId:string):ChatActivity{
 const allTurns=new Map(state.turns.map(turn=>[turn.id,turn])),owners=new Set([chatId,...[...state.chats,...state.jobChats||[]].filter(chat=>chat.parentChatId===chatId).map(chat=>chat.id)]);
 for(const turn of state.turns)if(turn.parentTurnId&&allTurns.get(turn.parentTurnId)?.chatId===chatId)owners.add(turn.chatId);
 const turns=new Map(state.turns.filter(turn=>owners.has(turn.chatId)).map(turn=>[turn.id,turn]));
 const plans=state.approvals.filter(approval=>owners.has(approval.chatId)&&turns.has(approval.turnId)&&typeof approval.params?.plan==='string').map(approval=>({approval,model:turns.get(approval.turnId)!.model}));
 const tasks=new Map<string,{owner:string;model:string;items:TaskItem[]}>();
 for(const tool of state.tools){
  const turn=turns.get(tool.turnId);if(!turn||tool.status!=='completed'||!['todo','todo_list','TodoWrite'].includes(tool.name))continue;
  const result=object(tool.result),args=object(tool.args);if(result?.error||result?.is_error)continue;
  const items=taskItems(tool.name==='TodoWrite'?args?.todos:result?.todos);if(items===null)continue;
  const owner=turn.automatic?.kind==='agent'?turn.id:turn.chatId;
  tasks.set(owner,{owner,model:turn.model,items});
 }
 return {plans,tasks:[...tasks.values()],agents:[...turns.values()].filter(turn=>turn.automatic?.kind==='agent')};
}
