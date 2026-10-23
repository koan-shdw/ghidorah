// models: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import {attachmentMismatch,conversationAttachments,readsVideo} from '../attachments';
import {availabilityMessage,blockedFor} from '../availability';
import {apiProviders,backend,claude,claudeExecutable,codex,connected,emit,health,namespace,store,visionModels} from '../main';
import {modelLabel,newestFirst,providerFor} from '../models';
import type {Chat,Turn} from '../types';
import {randomUUID} from 'node:crypto';

// deepseek-flash stays listed: existing chats and defaults depend on it even if DeepSeek's list names it differently.
export function deepseekModels():string[]{const saved=store.all<any>('settings').find(row=>row.id==='deepseek-models')?.models;return [...new Set(['deepseek-flash',...(Array.isArray(saved)?saved:[])])];}
export function connectedModels(){return [...(connected?deepseekModels():[]),...(codex.connected?codex.models:[]),...(claude.connected?(claude.models||[]).map(model=>model.id):[]),...(apiProviders?.models()||[])];}
export function availableModels(){return connectedModels().filter(model=>!blockedFor(health.rows(),model)&&(providerFor(model)!=='claude-code'||claudeExecutable));}
export function unavailableMessage(model:string){const blocked=blockedFor(health.rows(),model);return modelLabel(model,claude.models)+': '+(blocked?availabilityMessage(blocked):'Not connected or available')+'. Choose another model or check account usage.';}
export function recordRoute(turnId:string,decision:{reason:string;[key:string]:unknown}){store.put('route',{...decision,id:randomUUID(),turnId,created:Date.now()});}
export function inputMismatch(turn:Turn){return attachmentMismatch(conversationAttachments(store.all<Turn>('turn'),turn),visionModels[turn.model]===true,turn.model);}
// The Gemini model a video goes to: the one picked or already in the chat, else the newest connected.
export function videoModel(chat:Chat,turn?:Turn){
  const gemini=availableModels().filter(readsVideo),created=new Map((apiProviders?.rows()||[]).flatMap(row=>row.models.map(model=>[model.id,model.created||null] as const)));
  return [turn?.model,...(turn?.requestedModels||[]),...(chat.pool||[])].find(id=>!!id&&gemini.includes(id))||newestFirst(gemini.map(id=>({id,supplier:'gemini',created:created.get(id)||null})),id=>id)[0]?.id||null;
}
export async function loadInputCapabilities(turn:Turn,signal?:AbortSignal){
  if(!conversationAttachments(store.all<Turn>('turn'),turn).some(a=>a.kind!=='file'))return;
  const missing=connectedModels().filter(model=>visionModels[model]===undefined);
  if(missing.length)Object.assign(visionModels,await backend.host('attachment_capabilities',{models:missing},signal));
}
export function checkDispatch(chat:Chat,turn:Turn){
  const mismatch=inputMismatch(turn);
  if(!mismatch&&availableModels().includes(turn.model)&&(chat.pool||['deepseek-flash']).includes(turn.model))return true;
  const error=mismatch||unavailableMessage(turn.model);store.transaction(()=>{store.update<Turn>('turn',turn.id,{status:'needs-model',error});recordRoute(turn.id,{model:turn.model,reason:'unavailable',error});});emit();return false;
}
export function fixtureClaude(){return namespace.startsWith('Trismegistus/Test/')?process.env.TRISMEGISTUS_TEST_CLAUDE:undefined;}
