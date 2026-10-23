// turns: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import {apiChanging,backend,background,checkingReplies,checkpointChanging,commandTurns,contextJobs,emit,gitOperation,goals,hermesErrors,hermesEvents,hermesSent,hermesStarted,hermesTurns,hermesWaiting,installing,modeChanges,native,pluginOwners,pluginsChanging,preparing,quitting,receive,store} from '../main';
import {busyHermesRows} from '../turn-joins';
import type {Chat,Turn} from '../types';
import {waitingFor,wake} from './dispatch';
import {projectFor} from './projects';

// The row whose reply this chat is getting now, and whether anything in it runs.
// The running reply comes first: a message being prepared behind it is a waiting message, never Stop's target.
export function replyRow(chatId:string){return native?.replyRow(chatId)??hermesTurns.get(chatId)??commandTurns.get(chatId)??preparing.get(chatId)?.turnId;}
export function chatBusy(chatId:string){return preparing.has(chatId)||commandTurns.has(chatId)||hermesTurns.has(chatId)||hermesWaiting(chatId)>0||!!native?.processing(chatId);}
export function anyChatBusy(){return preparing.size>0||commandTurns.size>0||hermesTurns.size>0||[...hermesSent.values()].some(rows=>rows.size>0)||!!native?.busy;}
// A Hermes session the chat lets go of is closed, so abandoned sessions do not pile up in the backend (audit 2.5, 7d).
export function releaseHermesSession(chat:Chat){
  const sid=store.get<Chat>('chat',chat.id).runtimeId;if(!sid||backend?.status!=='ready')return;
  void backend.rpc.request('session.close',{session_id:sid,profile:projectFor(chat).profile},10000).catch(()=>{});
}
// A Hermes Stop that gets no answer ends locally after its deadline (audit 3.5): the turn is marked stopped,
// the chat lets go of that Hermes session so the next message starts a fresh one, and the session is closed.
export function stopDeadline(chatId:string,id:string,sid:string){
  if(quitting||hermesTurns.get(chatId)!==id||store.get<Turn>('turn',id).status!=='stopping')return;
  receive({type:'message.complete',session_id:sid,payload:{status:'interrupted'}});
  if(store.get<Chat>('chat',chatId).runtimeId===sid)store.transaction(()=>{store.update<Chat>('chat',chatId,{runtimeId:null,storedId:null});store.put('engine',{...store.enginePosition(chatId,'hermes'),sessionId:null});});
  void backend.rpc.request('session.close',{session_id:sid,profile:projectFor(store.get<Chat>('chat',chatId)).profile},10000).catch(()=>{});emit();
}
// A send that fails after Hermes already took the prompt must keep its turn watched, not leave the run
// going unseen (audit 3.6). Hermes says whether the session is now busy.
export async function hermesAccepted(profile:string,sid:string){
  try{const live:any=await backend.rpc.request('session.active_list',{profile},10000);return ['working','waiting','starting'].includes((live.sessions||[]).find((row:any)=>row.id===sid)?.status);}catch{return false;}
}
// Hermes numbers each session's events 1, 2, 3... The watermark moves only one step at a time, so a lost
// event (e.g. the completion) holds it back and the replay fills the gap. Before, a later title event moved
// it past the lost completion and the replay never returned it (audit 3.11, reply-recovery check 2/6 fails).
export function nextWatermark(previous:number|undefined,seq:number|undefined){
  if(seq==null||previous==null)return Math.max(previous||0,seq||0);
  return seq===previous+1?seq:previous;
}
export async function reconcileReplies(){
  if(quitting||backend.status!=='ready')return;
  for(const [chatId,id] of hermesTurns){
    const chat=store.get<Chat>('chat',chatId),turn=store.get<Turn>('turn',id),sid=chat.runtimeId;
    if(!sid||turn.command||turn.model.startsWith('claude-code:')||!['running','waiting','stopping'].includes(turn.status)||checkingReplies.has(sid))continue;
    const seen=hermesEvents.get(sid)||{seq:0,at:turn.created};if(Date.now()-seen.at<15000)continue;
    checkingReplies.add(sid);const generation=backend.generation;
    try{
      // Recover a missing completion from the backend's existing event ledger. Never resubmit work.
      const result:any=await backend.rpc.request('session.events.since',{profile:projectFor(chat).profile,session_id:sid,last_seen:seen.seq},10000);
      if(backend.generation!==generation||hermesTurns.get(chatId)!==id)continue;
      for(const event of result.events||[])receive(event);
      if(hermesTurns.get(chatId)===id){
        const live:any=await backend.rpc.request('session.active_list',{profile:projectFor(chat).profile},10000);
        const row=(live.sessions||[]).find((row:any)=>row.id===sid);
        if(backend.generation===generation&&hermesTurns.get(chatId)===id&&!['working','waiting','starting'].includes(row?.status)){
          receive({type:'message.complete',session_id:sid,payload:{status:'error',error:hermesErrors.get(sid)||'Hermes ended this turn without a reply.'}});
          const waiting=waitingFor(chatId);for(const turnId of [...waiting]){waiting.delete(turnId);if(store.find<Turn>('turn',turnId))store.update<Turn>('turn',turnId,{status:'queued',delivery:undefined,activity:undefined});}
          wake(chatId);
        }
      }
      // The replay returned everything after the watermark: the session is seen through its latest event.
      const current=hermesEvents.get(sid)||seen;hermesEvents.set(sid,{seq:Math.max(current.seq,Number(result.latest_seq)||0),at:Date.now()});
    }catch(error){
      if(!quitting&&backend.generation===generation&&backend.status==='ready'){
        // A slow read is not proof the model stopped. Keep work running and retry the check.
        store.put('connection-check',{id,chatId,sessionId:sid,at:Date.now(),error:backend.scrubber.text(String(error))});
        hermesEvents.set(sid,{...(hermesEvents.get(sid)||seen),at:Date.now()});
      }
    }finally{checkingReplies.delete(sid);}
  }
  // Messages Hermes took and never started, with nothing running: after 15 s of quiet and an idle session they go out
  // again, never left waiting.
  for(const [chatId,rows] of hermesSent){
    if(!rows.size||hermesTurns.has(chatId))continue;
    const chat=store.find<Chat>('chat',chatId),sid=chat?.runtimeId;if(!chat||!sid||checkingReplies.has(sid)||Date.now()-(hermesEvents.get(sid)?.at||0)<15000)continue;
    checkingReplies.add(sid);const generation=backend.generation;
    try{
      const live:any=await backend.rpc.request('session.active_list',{profile:projectFor(chat).profile},10000),row=(live.sessions||[]).find((row:any)=>row.id===sid);
      if(backend.generation===generation&&!hermesTurns.has(chatId)&&!['working','waiting','starting'].includes(row?.status)){for(const turnId of [...rows]){rows.delete(turnId);if(store.find<Turn>('turn',turnId))store.update<Turn>('turn',turnId,{status:'queued',delivery:undefined,activity:undefined});}wake(chatId);emit();}
    }catch{}finally{checkingReplies.delete(sid);}
  }
  // Every wait has its own deadline (TURN-REVIEW rule 3): once Tris tracks nothing in a chat and Hermes has been quiet
  // and idle for 15 s, a Hermes row still busy there ended unseen; it is closed instead of holding the chat (Fork).
  for(const chat of store.all<Chat>('chat')){
    const sid=chat.runtimeId,tracked=hermesTurns.has(chat.id)||hermesWaiting(chat.id)>0||preparing.has(chat.id)||commandTurns.has(chat.id);
    if(tracked||sid&&(checkingReplies.has(sid)||Date.now()-(hermesEvents.get(sid)?.at||0)<15000))continue;
    const quiet=(row:Turn)=>Date.now()-(row.lastActivity||row.created)>=15000;
    if(!busyHermesRows(store.where<Turn>('turn','chatId',chat.id)).some(quiet))continue;
    if(sid)checkingReplies.add(sid);const generation=backend.generation;
    try{
      const live:any=sid?await backend.rpc.request('session.active_list',{profile:projectFor(chat).profile},10000):{sessions:[]},row=(live.sessions||[]).find((row:any)=>row.id===sid);
      if(backend.generation!==generation||hermesTurns.has(chat.id)||hermesWaiting(chat.id)>0||preparing.has(chat.id)||['working','waiting','starting'].includes(row?.status))continue;
      for(const turn of busyHermesRows(store.where<Turn>('turn','chatId',chat.id)).filter(quiet)){store.update<Turn>('turn',turn.id,{status:'failed',error:'Hermes ended this turn without a reply.',activity:undefined,delivery:undefined});hermesStarted.delete(turn.id);}
      emit();
    }catch{}finally{if(sid)checkingReplies.delete(sid);}
  }
}
export async function waitForMode(projectId:string){while(modeChanges.has(projectId))await modeChanges.get(projectId)!.catch(()=>{});}
export function hasWork(includeGoals=true,includePluginChanges=true){return includePluginChanges&&(pluginsChanging||installing)||!!gitOperation||contextJobs.size>0||checkpointChanging||apiChanging||includeGoals&&!!goals?.rows().some(goal=>goal.status==='active')||modeChanges.size>0||anyChatBusy()||pluginOwners.size>0||!!background?.rows().some(row=>['running','checking','stopping'].includes(row.status));}
 // session id -> fixed text it last received
// Fixed text goes to a fresh session, and again when it changed, but never inside a message steered into a running
// reply: there it buried his words (10-19: "are you done?" arrived as 10,615 characters). It waits for an idle message.
export function resendFixed(fresh:boolean,busy:boolean,last:string|undefined,next:string){return fresh||!busy&&last!==next;}
