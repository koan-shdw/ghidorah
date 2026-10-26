import type {Store} from './store';
import type {Turn,ToolCall} from './types';

export function joinTurn(store:Store,id:string,ownerId:string,readAt?:Turn['readAt']){
 const row=store.find<Turn>('turn',id),owner=store.find<Turn>('turn',ownerId);
 if(!row||!owner||id===ownerId||row.chatId!==owner.chatId)return;
 store.update<Turn>('turn',id,{answeredIn:ownerId,delivery:undefined,activity:undefined,
  readAt:row.answeredIn===ownerId&&row.readAt?row.readAt:readAt||{text:owner.text.length,tools:store.where<ToolCall>('tool','turnId',ownerId).length}});
}

// Joined messages always sit in their owner's chat (joinTurn refuses otherwise), so only that chat is read.
const ownerChat=(store:Store,ownerId:string)=>{const owner=store.find<Turn>('turn',ownerId);return owner?store.where<Turn>('turn','chatId',owner.chatId):store.all<Turn>('turn');};

export function resetJoinedText(store:Store,ownerId:string){
 for(const row of ownerChat(store,ownerId))if(row.answeredIn===ownerId&&row.readAt)store.update<Turn>('turn',row.id,{readAt:{...row.readAt,text:0}});
}

// A Hermes tool result that belongs to an earlier reply of this chat, not the one running now: exactly one recorded
// tool must end in ":<toolId>", or nothing is attached. The reply running now owns its own tools, so the search runs
// only for a tool it lacks, and reads record ids from the index, never tool bodies (SPEED-PLAN 1: 0.5 s per tool).
export function lateToolOwner(store:Store,chatId:string,toolId:string,current?:string):ToolCall|undefined{
 const suffix=':'+toolId;
 if(current&&store.has('tool',current+suffix))return;
 const matches=store.idsWhere('tool','turnId',store.idsWhere('turn','chatId',[chatId])).filter(id=>id.endsWith(suffix));
 const tool=matches.length===1?store.get<ToolCall>('tool',matches[0]):undefined;
 return tool&&tool.turnId!==current?tool:undefined;
}

const busy=['queued','running','waiting','dispatching','stopping'];

// A finished reply settles every message it read that is still busy; ones the engine still holds run next.
export function settleJoined(store:Store,ownerId:string,status:'completed'|'stopped'|'failed',error:string|null,held:Set<string>){
 const rows=ownerChat(store,ownerId).filter(row=>row.answeredIn===ownerId&&row.id!==ownerId&&busy.includes(row.status)&&!held.has(row.id));
 for(const row of rows)store.update<Turn>('turn',row.id,{status,delivery:undefined,activity:undefined,error:status==='failed'?error:null});
 return rows.map(row=>row.id);
}

// Hermes rows still busy. Called only when Tris tracks nothing in the chat: then each of these ended unseen.
export function busyHermesRows(rows:Turn[]){
 return rows.filter(row=>busy.includes(row.status)&&row.status!=='queued'&&!row.command&&!row.contextCommand&&!row.jobs?.length&&!row.model.startsWith('claude-code:'));
}

export function isJoinedTurn(row:Turn,turns:Turn[]){
 return !!row.answeredIn&&turns.some(owner=>owner.id===row.answeredIn&&owner.id!==row.id&&owner.chatId===row.chatId&&!owner.answeredIn);
}

export function replyParts(owner:Turn,tools:ToolCall[],turns:Turn[]){
 const actions=tools.filter(tool=>tool.turnId===owner.id),joined=turns.filter(row=>row.answeredIn===owner.id&&isJoinedTurn(row,turns));
 joined.sort((a,b)=>(a.readAt?.tools||0)-(b.readAt?.tools||0)||(a.readAt?.text||0)-(b.readAt?.text||0)||a.created-b.created);
 let text=0,tool=0;
 const parts:{text:string;tools:ToolCall[];message?:Turn}[]=joined.map(message=>{
  const point=message.readAt||{text:0,tools:0},endText=Math.max(text,Math.min(owner.text.length,point.text)),endTool=Math.max(tool,Math.min(actions.length,point.tools));
  const part={text:owner.text.slice(text,endText),tools:actions.slice(tool,endTool),message};text=endText;tool=endTool;return part;
 });
 parts.push({text:owner.text.slice(text),tools:actions.slice(tool)});return parts;
}
