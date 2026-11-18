// Token use over a stretch of time (a month): in total, per model, per app, per chat and per day, from the usage
// each reply saved. It follows the rules the per-chat panel follows (modelUsage in usage.ts), so the two never
// disagree: a parallel group's parent counts nothing (its jobs do), a reply several models shared has no per-model
// split, and routing summaries count for the model that wrote them. It reads turns only, never tool rows; run it in
// the main process over the store, since a window's state lacks most job chats.
import type {Turn} from './types';
import {pickerTokens} from './pickers';

export interface UsageSum {tokens:number;models:Record<string,number>}
export interface ChatUsage extends UsageSum {chatId:string;replies:number}
export interface MonthUsage extends UsageSum {
 /** Replies in the stretch that saved no token count, or were shared by several models: the sums are a floor. */
 partial:boolean;
 /** Tokens the pickers and routing summaries used; already inside `tokens`. */
 routing:number;
 /** Tokens agents reported for themselves. Kept apart: whether the reply that started an agent already counts
  * them is not proven, so adding them could count them twice. */
 agents:number;
 /** By app id. A chat linked to several apps counts in each, so these can add up to more than `tokens`. */
 apps:Record<string,UsageSum>;
 /** The chats no app links. */
 unlinked:UsageSum;
 /** Tokens counted in more than one app. */
 shared:number;
 chats:ChatUsage[];
 /** By day, as dayOf names it. */
 days:Record<string,number>;
}
const measured=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const localDay=(time:number)=>{const d=new Date(time);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');};

export function monthUsage({turns,chats,apps,from,to,dayOf=localDay}:{turns:Turn[];chats:{id:string;parentChatId?:string}[];apps:{id:string;chatIds:string[]}[];from:number;to:number;dayOf?:(time:number)=>string}):MonthUsage{
 const byTurn=new Map(turns.map(turn=>[turn.id,turn])),byChat=new Map(chats.map(chat=>[chat.id,chat]));
 // The root chat of a reply: up the chat's parents, and for a job chat the list does not hold, up the reply that
 // started it (as chatActivity does).
 const root=(turn:Turn):string=>{
  let id=turn.chatId;const seen=new Set<string>();let via:Turn|undefined=turn;
  for(;;){
   if(seen.has(id))return id;seen.add(id);
   const chat=byChat.get(id);
   if(chat?.parentChatId){id=chat.parentChatId;continue;}
   if(chat)return id;
   const parent:Turn|undefined=via?.parentTurnId?byTurn.get(via.parentTurnId):undefined;
   if(!parent)return id;
   via=parent;id=parent.chatId;
  }
 };
 const appsOf=new Map<string,string[]>();for(const app of apps)for(const chatId of app.chatIds)(appsOf.get(chatId)||appsOf.set(chatId,[]).get(chatId)!).push(app.id);
 const out:MonthUsage={tokens:0,models:{},partial:false,routing:0,agents:0,apps:{},unlinked:{tokens:0,models:{}},shared:0,chats:[],days:{}};
 const perChat=new Map<string,ChatUsage>();
 const add=(sum:UsageSum,model:string|null,tokens:number)=>{sum.tokens+=tokens;if(model)sum.models[model]=(sum.models[model]||0)+tokens;};
 for(const turn of turns){
  if(turn.created<from||turn.created>=to)continue;
  if(turn.automatic?.kind==='agent'){const own=turn.usage?.native_task_usage?.total_tokens;if(measured(own))out.agents+=own;continue;}
  const parts:{model:string|null;tokens:number;routing?:boolean}[]=[];
  if(!turn.jobs?.length&&!turn.model.startsWith('command:')){
   if(measured(turn.usage?.turn_total))parts.push({model:turn.usage.mixed_models?null:turn.model,tokens:turn.usage.turn_total});
   else out.partial=true;
   if(turn.usage?.mixed_models)out.partial=true;
  }
  if(turn.routingUsage){
   if(measured(turn.routingUsage.summaryTokens))parts.push({model:turn.routingUsage.summaryModel,tokens:turn.routingUsage.summaryTokens,routing:true});
   const picker=pickerTokens(turn.routingUsage);if(measured(picker))parts.push({model:null,tokens:picker,routing:true});
  }
  if(!parts.length)continue;
  const chatId=root(turn),linked=appsOf.get(chatId)||[],day=dayOf(turn.created);
  let chat=perChat.get(chatId);if(!chat){chat={chatId,tokens:0,models:{},replies:0};perChat.set(chatId,chat);}
  if(parts.some(part=>!part.routing))chat.replies++;
  for(const part of parts){
   add(out,part.model,part.tokens);add(chat,part.model,part.tokens);
   out.days[day]=(out.days[day]||0)+part.tokens;if(part.routing)out.routing+=part.tokens;
   for(const appId of linked)add(out.apps[appId]||(out.apps[appId]={tokens:0,models:{}}),part.model,part.tokens);
   if(!linked.length)add(out.unlinked,part.model,part.tokens);else if(linked.length>1)out.shared+=part.tokens*(linked.length-1);
  }
 }
 out.chats=[...perChat.values()].sort((a,b)=>b.tokens-a.tokens);
 return out;
}
/** The first and the next first millisecond of the month `at` falls in, in local time. */
export function monthBounds(at:number){const d=new Date(at);return {from:new Date(d.getFullYear(),d.getMonth(),1).getTime(),to:new Date(d.getFullYear(),d.getMonth()+1,1).getTime()};}
