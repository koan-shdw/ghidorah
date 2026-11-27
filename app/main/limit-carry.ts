// Work a usage limit stopped carries on by itself at the reset (Koan 2026-11-19, Ghidorah 4 job 5; app/limit-pause.ts
// says what counts and why). One record per chat: when it can carry on, with which model, and how much was stopped.
// At that time the app sends the chat a message to carry on, which he sent by hand before.
import {health,store} from '../main';
import {blockedFor} from '../availability';
import {carryOnAt,carryOnText,carryReady,limitLifted,limitStop} from '../limit-pause';
import type {Chat,Turn} from '../types';
import {submitTurn} from './context';
import {randomUUID} from 'node:crypto';

// held: a saved block stopped the work, so it carries on as soon as that block lifts (a usage check, credits bought),
// not only at the reset. False when only the refusal's words gave a time. Rows from before it count as held: at worst
// one refused carry-on, which saves itself again as not held.
export interface LimitCarry {id:string;at:number;model:string;agents:number;turns:number;created:number;held?:boolean}
// A message sent the instant a limit reset was refused a second time, with no reset left to wait for; a minute on it goes.
const MARGIN=60000;
const due=(row:LimitCarry,now:number)=>carryReady({...row,at:row.at+MARGIN},health.rows(),now);
export const limitCarries=()=>store.all<LimitCarry>('limit-carry');
export function dropLimitCarry(chatId:string){if(!store.find<LimitCarry>('limit-carry',chatId))return false;store.remove('limit-carry',chatId);return true;}
/** The times emit() wakes for. */
export function carryTimes(now=Date.now()){return limitCarries().map(row=>row.at+MARGIN).filter(at=>at>now);}
let firing=false;
export function settleLimitCarry(){
  const now=Date.now(),cursor=store.find<{id:string;at:number}>('settings','limit-carry-cursor')?.at;
  // The first run starts from now: what a limit stopped before this version is his to carry on, as it was.
  if(typeof cursor!=='number'){store.put('settings',{id:'limit-carry-cursor',at:now});return;}
  let at=cursor;
  for(const turn of store.turnsFinishedAfter<Turn>(cursor)){
    at=Math.max(at,turn.finished||0);
    if(turn.contextSnapshot||!limitStop(turn))continue;
    const chat=store.find<Chat>('chat',turn.chatId),root=chat?.parentChatId?store.find<Chat>('chat',chat.parentChatId):chat;if(!root||root.archived)continue;
    const reset=carryOnAt(health.rows(),turn.model,String(turn.error||'')+' '+String(turn.text||'').slice(-400),now);if(reset===null)continue;
    const old=store.find<LimitCarry>('limit-carry',root.id),origin=turn.automatic?.originTurnId?store.find<Turn>('turn',turn.automatic.originTurnId):undefined,agent=turn.automatic?.kind==='agent';
    // An agent's own model is not the chat's: the chat carries on with the model of the message the agent worked for.
    store.put<LimitCarry>('limit-carry',{id:root.id,at:Math.max(old?.at||0,reset),model:old?.model||origin?.model||(agent?root.model:turn.model),agents:(old?.agents||0)+(agent?1:0),turns:(old?.turns||0)+(agent?0:1),created:old?.created||now,held:old?.held!==false&&!limitLifted(health.rows(),turn.model,now)});
  }
  if(at!==cursor)store.put('settings',{id:'limit-carry-cursor',at});
  if(!firing&&limitCarries().some(row=>due(row,now)))void fire(now);
}
async function fire(now:number){
  firing=true;
  try{
    for(const row of limitCarries()){
      if(!due(row,now))continue;
      const chat=store.find<Chat>('chat',row.id),later=chat?store.where<Turn>('turn','chatId',row.id).filter(turn=>!turn.parentTurnId&&turn.created>row.created):[];
      // Nothing to do when the chat is gone, when he turned its wake-ups off, when he has carried on himself (a
      // message of his that has left the queue) or when Claude woke itself after the reset. Messages of his that
      // the limit still holds go first by themselves; the carry-on follows them.
      if(!chat||chat.archived||chat.wakeUps===false||later.some(turn=>turn.automatic?turn.automatic.kind!=='agent'&&turn.created>row.at:turn.status!=='queued')){store.remove('limit-carry',row.id);continue;}
      const blocked=blockedFor(health.rows(),row.model,now);
      if(blocked){store.put<LimitCarry>('limit-carry',{...row,at:blocked.resetAt&&blocked.resetAt>now?blocked.resetAt:now+600000-MARGIN});continue;}
      store.remove('limit-carry',row.id);
      // A refusal here (the engine is down, the folder is changing) leaves the chat as it was, for him.
      try{await submitTurn({id:randomUUID(),chatId:row.id,text:carryOnText(row.agents),...((chat.pool||[]).includes(row.model)?{models:[row.model]}:{})},{carried:{at:row.at,agents:row.agents}});}catch{}
    }
  }finally{firing=false;}
}
