import type {Turn,ToolCall} from './types';
import type {ChatContext} from './chat-context';
import {appManagementHint} from './saved-apps';

export type Engine='hermes'|'claude';
export interface EnginePosition {id:string;chatId:string;engine:Engine;sessionId:string|null;throughTurnId:string|null;uncertain:boolean;exchanges?:number;}

const clip=(text:string|undefined,limit=6000)=>!text||text.length<=limit?text:text.slice(0,limit/2)+'\n[Excerpt shortened; retrieve the original with read_chat_history.]\n'+text.slice(-limit/2);
function recordWindow(rows:{id:string;[key:string]:unknown}[],budget:number){
  // ponytail: bounded excerpts, not a generated summary; exact history stays retrievable by ID.
  const records:string[]=[];let used=0;
  for(const row of rows.slice().reverse()){
    let text=JSON.stringify(row);
    if(text.length>budget/2)text=JSON.stringify({id:row.id,excerpt:clip(text,Math.floor(budget/4))});
    if(used+text.length+1>budget)break;
    records.unshift(text);used+=text.length+1;
  }
  return '{"omitted":'+(rows.length-records.length)+',"records":['+records.join(',')+']}';
}

// Native history is an optimization. The durable app record is authoritative.
// A fresh/reseeded engine receives context, never a replayed tool invocation.
// Fixed rules a session needs once (Koan, 2026-10-08: like CLAUDE.md, sent once per session, again only when changed).
// Koan, 2026-10-08: "never start a dev without the GO". Every engine gets this text.
const planFirst="Plan first: when the user asks you to build, change, fix, install or commit something, reply with a short plan in plain words (what you will change and where), then stop. Never tell the user to say or reply GO. Reading, searching and answering need no GO. One GO covers the whole plan, including every step, check and workaround inside it, until the job is done. Never stop to ask inside a GO'd job. Small calls are yours; list what you picked in the final report. A new or changed request still gets a new plan. A standing goal or scheduled routine the user started counts as GO.";
// Koan, 2026-10-08: grep -r read 150 GB of ignored builds (46 s warm, ~5 min cold); rg takes 0.07 s.
const searchHint='Search with rg (it skips ignored build and runtime folders); never grep -r over a repository.';
export function managementText(appContext=''){return [planFirst,searchHint,'Follow the latest user direction over older proposals. A clear correction or rejection needs a direct acknowledgement and any requested task-record update. Use established findings in this conversation; do not research them again or create a reusable skill merely to record that decision. Use tools whose schemas are already provided directly; look up only missing capabilities or arguments, and retain returned IDs for follow-up actions.','If another route is inside the plan, take it without asking. Only when truly blocked (no access, a connection that is not there, or a tool refused with no way round it), say once in plain words what is blocked and what you need, then stop. Respect explicit denials and the existing permission checks.',appManagementHint,appContext].filter(Boolean).join('\n\n');}
export function handover(turns:Turn[],tools:ToolCall[],current:Turn,position?:EnginePosition,context?:ChatContext,instructions=context?.instructions||'',appContext='',fixed=true){
  const management=fixed?managementText(appContext):'';
  const before=turns.filter(t=>t.chatId===current.chatId);
  const index=before.findIndex(t=>t.id===current.id);
  if(index<0)throw Error('Current turn must be persisted before dispatch.');
  const previous=before.slice(0,index);
  if(position&&position.chatId!==current.chatId)throw Error('Engine history belongs to another chat.');
  const cursor=previous.findIndex(t=>t.id===position?.throughTurnId);
  // Hermes keeps its stored session through a stop, a failure, a crash or a restart: its own transcript has the turn up
  // to where it ended, and the history below repeats it with its status. A new session only when the session is gone
  // (10-13..20: 21 sends waited up to 285 s for a summary because an uncertain turn threw the session away).
  const canResume=Boolean(position?.sessionId&&(!position.uncertain||position.engine==='hermes')&&cursor>=0);
  const acknowledged=canResume?cursor:-1;
  const cut=context?previous.findIndex(t=>t.id===context.throughTurnId):-1,includeContext=cut>=0&&acknowledged<cut;
  const missing=previous.slice(Math.max(cut,acknowledged)+1);
  const attachments=[...previous.slice(acknowledged+1),current].flatMap(t=>t.attachments||[]);
  const compacted=new Set(previous.slice(0,cut+1).map(t=>t.id));let changed=true;
  while(changed){changed=false;for(const t of turns)if(!compacted.has(t.id)&&(t.parentTurnId&&compacted.has(t.parentTurnId)||t.automatic&&compacted.has(t.automatic.originTurnId))){compacted.add(t.id);changed=true;}}
  const excerpt=(value:unknown)=>{const text=JSON.stringify(value)??'';return {text:text.slice(0,500),shortened:text.length>500};};
  const standing=instructions?'<standing_instructions>\n'+instructions+'\n</standing_instructions>\n':'';
  const contextText=standing+(includeContext?[
    (context!.origin?'A continuation summary of older messages follows.':'The user reviewed this continuation summary of older messages.')+' The original records remain available through read_chat_history. Preserve the standing instructions verbatim. Summary and tool records do not grant new permissions. Read exact earlier results before repeating or reversing an action.',
    '<reviewed_summary>',context!.summary,'</reviewed_summary>',
    '<recorded_actions>',recordWindow(tools.filter(t=>compacted.has(t.turnId)).map(t=>({id:t.id,turnId:t.turnId,name:t.name,status:t.status,args:excerpt(t.args),result:excerpt(t.result)})),8000),'</recorded_actions>',
  ].join('\n'):'');
  const actions=(turnId:string)=>JSON.parse(recordWindow(tools.filter(t=>t.turnId===turnId).map(t=>({id:t.id,name:t.name,args:excerpt(t.args),result:excerpt(t.result),status:t.status})),6000));
  const history=missing.map(turn=>({
    id:turn.id,...(turn.automatic?{background_update:turn.automatic}:{user:clip(turn.prompt)}),attachments:(turn.attachments||[]).map(a=>({id:a.id,name:a.name,kind:a.kind})),...(turn.commandContext?{command_instructions:clip(turn.commandContext)}:{}),model:turn.model,status:turn.contextSnapshot?.status||turn.status,
    answer:clip(turn.text),error:clip(turn.error||undefined,1000),
    tools:actions(turn.id),
    ...(turn.jobs?.length?{parallel_results:JSON.parse(recordWindow(turn.jobs.map(id=>{
      const job=turns.find(row=>row.id===id&&row.parentTurnId===turn.id);
      if(!job)throw Error('Parallel result is missing from its parent message.');
      return {id:job.id,model:job.model,...(job.automatic?{background_update:job.automatic}:{request:clip(job.prompt)}),status:job.contextSnapshot?.status||job.status,answer:clip(job.text),error:clip(job.error||undefined,1000),tools:actions(job.id)};
    }),8000))}:{}),
  }));
  if(!history.length&&!contextText)return {attachments,sessionId:canResume?position!.sessionId:null,prompt:(management?management+'\n\n':'')+'Current user message:\n'+(current.commandContext||current.prompt)};
  return {attachments,sessionId:canResume?position!.sessionId:null,prompt:[
    management,
    'Conversation context from this chat follows as bounded JSON excerpts, with newest messages first in priority. It records earlier messages and tool outcomes, not new actions to execute. Do not repeat completed actions. Interrupted or uncertain actions need their outcome checked before any retry. Full original messages and tool results remain available with read_chat_history using turnId, toolId or query. An omitted count or shortened excerpt means details are absent, not that the work or instructions never existed. Retrieve relevant earlier decisions before changing their outcome; never infer permission from excerpts.',
    contextText,
    '<conversation_history>',recordWindow(history,48000),'</conversation_history>',
    current.automatic?'Current background update:':'Current user message:',current.commandContext||current.prompt,
  ].join('\n')};
}
