// SPEED-PLAN 6: a message re-renders only when its own records change. Each pushed state arrives as new objects, so
// records equal to the previous ones are reused first; a row then compares its own records by identity.
import type {Snapshot,Turn,ToolCall,Approval} from './types';

export function same(a:any,b:any):boolean{
  if(a===b)return true;
  if(typeof a!=='object'||typeof b!=='object'||!a||!b||Array.isArray(a)!==Array.isArray(b))return false;
  const keys=Object.keys(a);if(keys.length!==Object.keys(b).length)return false;
  for(const key of keys)if(!(key in b)||!same(a[key],b[key]))return false;
  return true;
}
function reuse<T extends {id?:string}>(prev:T[]|undefined,next:T[]|undefined):T[]|undefined{
  if(!Array.isArray(prev)||!Array.isArray(next)||prev===next)return next;
  if(!next.every(row=>typeof row?.id==='string'))return same(prev,next)?prev:next;
  const old=new Map(prev.map(row=>[row.id,row]));let all=prev.length===next.length;
  const rows=next.map((row,i)=>{const earlier=old.get(row.id);if(earlier&&same(earlier,row)){if(prev[i]!==earlier)all=false;return earlier;}all=false;return row;});
  return all?prev:rows;
}
const keyed=['turns','tools','approvals','chats','jobChats','background','sideAnswers','projects','goals'] as const;
const whole=['claude','availableModels','workReview','share','shareTargets','agentWindows','chatWindows'] as const;
// The next state, with every record equal to the previous one replaced by that previous object.
export function stabilize<S extends Partial<Snapshot>>(prev:S,next:S):S{
  if(prev===next||!prev)return next;
  const out:any={...next};
  for(const key of keyed)if(key in next)out[key]=reuse((prev as any)[key],(next as any)[key]);
  for(const key of whole)if(key in next&&same((prev as any)[key],(next as any)[key]))out[key]=(prev as any)[key];
  return out;
}

export interface RowIndex {turn:Map<string,Turn>;tools:Map<string,ToolCall[]>;approvals:Map<string,Approval[]>;background:Map<string,unknown[]>;joined:Map<string,Turn[]>;}
const group=<T,>(rows:T[],key:(row:T)=>string|undefined)=>{const map=new Map<string,T[]>();for(const row of rows){const id=key(row);if(id===undefined)continue;const list=map.get(id);if(list)list.push(row);else map.set(id,[row]);}return map;};
export function rowIndex(state:Pick<Snapshot,'turns'|'tools'|'approvals'>&{background?:{turnId?:string}[]}):RowIndex{
  return {turn:new Map(state.turns.map(t=>[t.id,t])),tools:group(state.tools||[],t=>t.turnId),approvals:group(state.approvals||[],a=>a.turnId),background:group(state.background||[],b=>b.turnId),joined:group(state.turns,t=>t.answeredIn||undefined)};
}
const sameList=(a?:readonly unknown[],b?:readonly unknown[])=>a===b||(a?.length||0)===(b?.length||0)&&(a||[]).every((row,i)=>row===b![i]);
export interface RowProps {state:Snapshot;t:Turn;pool:string[];chatId:string;index:RowIndex;[key:string]:unknown}
// True when nothing this message shows has changed: its turn, its jobs, the messages joined into them, their tools,
// approvals and processes, and the few shared values a reply shows. Functions are passed through a stable ref.
export function sameRow(a:RowProps,b:RowProps){
  if(a.t!==b.t||a.chatId!==b.chatId||!sameList(a.pool,b.pool))return false;
  const s=a.state,n=b.state;if(s===n)return true;
  for(const key of ['claude','availableModels','chats','workReview','share','shareTargets'] as const)if((s as any)[key]!==(n as any)[key])return false;
  for(const id of [a.t.id,...(a.t.jobs||[])])
    if(a.index.turn.get(id)!==b.index.turn.get(id)||!sameList(a.index.tools.get(id),b.index.tools.get(id))||!sameList(a.index.approvals.get(id),b.index.approvals.get(id))||!sameList(a.index.background.get(id),b.index.background.get(id))||!sameList(a.index.joined.get(id),b.index.joined.get(id)))return false;
  // A handover's buttons follow the chat's latest messages.
  if(n.chats.find(c=>c.id===a.t.chatId)?.handover&&s.turns!==n.turns)return false;
  return true;
}
