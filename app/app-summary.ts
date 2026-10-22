import {createHash} from 'node:crypto';
import type {Snapshot} from './types';
import {appTurnOwners,type SavedApp,type AppTodo} from './saved-apps';
import type {Store} from './store';

export type SummaryKind='current'|'question'|'idea'|'planned'|'delivery';
export interface SummarySource {id:string;chatId:string|null;title:string;text:string;}
export interface SummaryItem {kind:SummaryKind;text:string;evidence:{sourceId:string;quote:string}[];}
export interface AppSummary {id:string;revision:string;model:string;items:SummaryItem[];sources:{id:string;chatId:string|null;title:string}[];generatedAt:number;tokens:number;usageIncomplete:boolean;}
export function appSummaryError(error:unknown,stopped=false){
 if(stopped)return 'Summary stopped.';
 const message=String(error).replace(/^Error: /,'');
 if(/timed?\s*out|timeout/i.test(message))return 'The summary model took too long to respond. Try again or choose another model. Your notes and previous summary are unchanged.';
 if(message.length>400||/Traceback|File "/.test(message))return 'Could not update the app summary. Try again or choose another model. Your notes and previous summary are unchanged.';
 return message;
}
export function appSummarySources(app:SavedApp,state:Pick<Snapshot,'chats'|'turns'|'goals'|'approvals'>):SummarySource[]{
 const owners=appTurnOwners(app.chatIds,state.turns),out:SummarySource[]=[];
 for(const turn of state.turns.filter(t=>owners.has(t.id)).sort((a,b)=>a.created-b.created||a.id.localeCompare(b.id))){
  const chatId=owners.get(turn.id)!,title=state.chats.find(c=>c.id===chatId)?.title||'Linked chat';
  for(const [part,text] of [['request',turn.prompt],['reply',turn.text],['error',turn.error]] as const){
   if(!text)continue;for(let offset=0;offset<text.length;offset+=8000)out.push({id:turn.id+':'+part+':'+offset,chatId,title,text:`${new Date(turn.created).toISOString()} · ${part} · turn ${turn.status}\n${text.slice(offset,offset+8000)}`});
  }
 }
 for(const goal of state.goals||[])if(app.chatIds.includes(goal.id))out.push({id:'goal:'+goal.id,chatId:goal.id,title:'Goal',text:JSON.stringify({objective:goal.objective,status:goal.status,summary:goal.summary,evidence:goal.evidence})});
 for(const request of state.approvals)if(request.status==='pending'&&(app.chatIds.includes(request.chatId)||owners.has(request.turnId)))out.push({id:'approval:'+request.id,chatId:owners.get(request.turnId)||request.chatId,title:'Pending request',text:JSON.stringify({method:request.method,params:request.params})});
 out.push({id:'app:notes',chatId:null,title:'Your app notes',text:JSON.stringify({name:app.name,stage:app.stage,current:app.current,ideas:app.ideas,planned:app.planned,questions:app.questions||''})});
 for(const todo of (app.todos||[]).slice().sort((a,b)=>a.created-b.created||a.id.localeCompare(b.id)))out.push({id:'todo:'+todo.id,chatId:null,title:'Your to-do notes',text:(todo.done?'Completed':'Open')+' to-do: '+todo.title});
 return out;
}
export function applyTodoTitles(store:Store,todos:AppTodo[],value:unknown){
 if(!Array.isArray(value)||value.length!==todos.length)throw Error('The model did not return a title for each to-do.');
 const ids=new Set<string>();
 for(const item of value){
  if(!item||typeof item.id!=='string'||ids.has(item.id)||!todos.some(todo=>todo.id===item.id)||typeof item.text!=='string'||!item.text.trim()||item.text.length>96||/[\r\n]/.test(item.text))throw Error('The model returned an invalid to-do title.');
  ids.add(item.id);
 }
 store.transaction(()=>{for(const source of todos){
  const current=store.all<AppTodo>('app-todo').find(todo=>todo.id===source.id&&todo.appId===source.appId);
  if(current?.title===source.title)store.update<AppTodo>('app-todo',source.id,{summary:value.find(item=>item.id===source.id).text.trim()});
 }});
}
export const summaryRevision=(sources:SummarySource[])=>createHash('sha256').update(JSON.stringify(sources)).digest('hex');
export function summaryBatches(sources:SummarySource[]){
 const batches:SummarySource[][]=[];let size=0;
 for(const source of sources){const count=JSON.stringify(source).length;if(count>60000)throw Error('A saved request is too large for the summary.');if(!batches.length||size+count>45000){batches.push([]);size=0;}batches.at(-1)!.push(source);size+=count;}
 return batches;
}
export function validateSummary(value:unknown,sources:SummarySource[]):SummaryItem[]{
 if(!Array.isArray(value)||value.length>40)throw Error('The model returned too many app findings.');
 const lookup=new Map(sources.map(source=>[source.id,source.text]));
 return value.map(item=>{
  if(!item||!['current','question','idea','planned','delivery'].includes(item.kind)||typeof item.text!=='string'||!item.text.trim()||item.text.length>700||!Array.isArray(item.evidence)||!item.evidence.length||item.evidence.length>3)throw Error('The model returned an invalid app finding.');
  for(const evidence of item.evidence)if(!evidence||typeof evidence.sourceId!=='string'||typeof evidence.quote!=='string'||evidence.quote.trim().length<4||evidence.quote.length>400||!lookup.get(evidence.sourceId)?.includes(evidence.quote))throw Error('The app summary included a finding without matching source evidence.');
  return {kind:item.kind,text:item.text.trim(),evidence:item.evidence.map((e:any)=>({sourceId:e.sourceId,quote:e.quote}))};
 });
}
