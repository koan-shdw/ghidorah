// Learning (PLAN 3c): what happened to each picked turn, read from what Koan did next. No thumbs buttons, no
// training: recent outcomes for the same kind of task go into every picker's state, kept small.
import type {Turn} from './types';

export type Reaction='correction'|'praise'|'neutral';
export interface LearningRow {id:string;chatId:string;kind:string;reaction?:Reaction}
export interface Choice {chatId:string;model:string|null;created:number;selected?:boolean}
export type Outcome='accepted'|'praised'|'overridden'|'corrected'|'stopped'|'failed'|'interrupted';
export interface LearningState {kind:string;recent:{model:string;outcome:Outcome}[];models:{model:string;turns:number;accepted:number;seconds:number|null;cost:number|null}[]}

const terminal=new Set(['completed','stopped','failed','interrupted']);

// One outcome per picked turn. Worst signal wins: Stop, then a correcting reply, then a changed pick.
export function outcomes(turns:Turn[],rows:LearningRow[],choices:Choice[]){
 const learned=new Map(rows.map(row=>[row.id,row])),result:{turn:Turn;kind:string;outcome:Outcome}[]=[];
 const picked=turns.filter(turn=>turn.routingUsage&&terminal.has(turn.status)&&!turn.parentTurnId).sort((a,b)=>a.created-b.created);
 for(const turn of picked){
  const row=learned.get(turn.id),next=turns.filter(other=>other.chatId===turn.chatId&&other.created>turn.created&&!other.parentTurnId).sort((a,b)=>a.created-b.created)[0];
  const until=next?.created??Infinity;
  // A pick or a lock for another model, or a next message sent to another model, is Koan overriding the pick.
  const overridden=choices.some(choice=>choice.chatId===turn.chatId&&choice.created>turn.created&&choice.created<until&&choice.model!==null&&choice.model!==turn.model&&choice.selected!==false)
   ||!!next?.requestedModels?.length&&!next.requestedModels.includes(turn.model);
  const outcome:Outcome=turn.status==='failed'||turn.status==='interrupted'||turn.status==='stopped'?turn.status:row?.reaction==='correction'?'corrected':overridden?'overridden':row?.reaction==='praise'?'praised':'accepted';
  result.push({turn,kind:row?.kind||'general',outcome});
 }
 return result;
}

// Per kind: the latest outcomes and each model's acceptance, speed and cost, cut to fit the picker's limit.
export function learningState(all:ReturnType<typeof outcomes>,kind?:string,limit=8,maxChars=2000):LearningState{
 const same=kind?all.filter(row=>row.kind===kind):all,models=[...new Set(same.map(row=>row.turn.model))];
 const average=(values:number[])=>values.length?Math.round(values.reduce((sum,value)=>sum+value,0)/values.length*100)/100:null;
 const state:LearningState={kind:kind||'all',recent:same.slice(-limit).map(row=>({model:row.turn.model,outcome:row.outcome})),models:models.map(model=>{
  const rows=same.filter(row=>row.turn.model===model);
  return {model,turns:rows.length,accepted:rows.filter(row=>['accepted','praised'].includes(row.outcome)).length,
   seconds:average(rows.flatMap(row=>row.turn.finished?[(row.turn.finished-row.turn.created)/1000]:[])),
   cost:average(rows.flatMap(row=>typeof row.turn.usage?.turn_cost_usd==='number'?[row.turn.usage.turn_cost_usd]:[]))};
 })};
 while(JSON.stringify(state).length>maxChars&&(state.recent.length||state.models.length))state.recent.length?state.recent.shift():state.models.pop();
 return state;
}

export function withLearning(summary:string,history?:LearningState){return history?.recent.length?summary+'\nRecent routing outcomes: '+JSON.stringify(history):summary;}

// The routing summary ends with two lines about the task and about the reply before it; read and remove them.
export function readSummary(text:string){
 const kind=/^Task kind:\s*(.+)$/im.exec(text)?.[1].trim().toLowerCase().slice(0,40)||'general';
 const word=/^Previous reply:\s*(\w+)/im.exec(text)?.[1].toLowerCase();
 const reaction:Reaction=word==='correction'||word==='praise'?word:'neutral';
 return {summary:text.replace(/^(Task kind|Previous reply):.*$/gim,'').trim(),kind,reaction};
}
