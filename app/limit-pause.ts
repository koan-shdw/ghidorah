// Resume after the usage limit (Koan 2026-11-09): a message that a supplier's usage limit stops, before it is sent or
// while its reply runs, does not fail. It stays queued with the reset time the limit answer gave, says so on its row,
// and goes by itself at that time, also after a restart. Stop (the remove button on the message) cancels the wait.
import {blockedFor,type Availability} from './availability';
import type {Turn} from './types';

/** The reset time of a usage limit blocking this model, when the answer gave one and it is still ahead. */
export function limitReset(rows:Availability[],model:string,now=Date.now()):number|null{
  const blocked=blockedFor(rows,model,now);
  return blocked&&blocked.reason==='limit'&&blocked.resetAt!==null&&blocked.resetAt>now?blocked.resetAt:null;
}
/** "Paused until 14:00, limit. Resumes by itself", with the weekday when the reset is not today. */
export function pauseText(at:number,now=Date.now()){
  const date=new Date(at),today=new Date(now),time=date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const sameDay=date.getFullYear()===today.getFullYear()&&date.getMonth()===today.getMonth()&&date.getDate()===today.getDate();
  return `Paused until ${sameDay?time:date.toLocaleDateString([],{weekday:'short'})+' '+time}, limit. Resumes by itself`;
}
/** The row while it waits: queued again with the reset time; nothing of the stopped attempt is left on it. */
export function pausePatch(at:number,now=Date.now()):Partial<Turn>{
  return {status:'queued',resume:{at,reason:'limit'},hold:pauseText(at,now),error:null,delivery:undefined,activity:undefined,preparation:undefined,stopReason:undefined};
}
/** A waiting message goes when its reset time has passed, or when the limit was lifted earlier. */
export function resumeDue(turn:Pick<Turn,'resume'|'model'>,rows:Availability[],now=Date.now()){
  return !turn.resume||turn.resume.at<=now||!blockedFor(rows,turn.model,now);
}
// Work Claude runs by itself (its agents, and the turns it starts itself after a job notice or a wake-up) is not a
// message of his, so the pause above never held it: a limit ended it and the chat sat until he sent a message by
// hand (read from his data 2026-11-19: 179 agent turns and 7 of a chat's own since 10-31). Such a chat now carries on
// by itself at the reset: the app sends that message for him.
/** Whether a turn's end reads as a usage limit, in the supplier's own words ("You've hit your session limit · resets 2:50pm"). */
export function limitStop(turn:Pick<Turn,'status'|'error'|'text'>){
  if(turn.status!=='failed'&&turn.status!=='interrupted')return false;
  return /\bhit your (?:\w+ )?limit\b|\busage limit\b|\bsession limit\b|\blimit (?:reached|exceeded)\b/i.test(String(turn.error||'')+'\n'+String(turn.text||'').slice(-400));
}
/** The clock time a refusal names ("resets 2:50pm", "resets at 7am"), as the next such time; null when it names none. */
export function namedReset(words:string,now=Date.now()):number|null{
  const match=/\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(words);if(!match)return null;
  const hour=Number(match[1])%12+(match[3].toLowerCase()==='pm'?12:0),minute=Number(match[2]||0);if(Number(match[1])<1||Number(match[1])>12||minute>59)return null;
  const at=new Date(now);at.setHours(hour,minute,0,0);if(at.getTime()<=now)at.setDate(at.getDate()+1);
  return at.getTime();
}
/** When work a limit stopped can carry on: once every limit that blocks its model has reset; else the time the
 * refusal itself names; null when neither is known (then nothing is promised). */
export function carryOnAt(rows:Availability[],model:string,words:string,now=Date.now()):number|null{
  const provider=model.startsWith('claude-code:')?'claude-code':undefined;
  const resets=rows.filter(row=>row.blocked&&row.reason==='limit'&&row.resetAt!==null&&row.resetAt>now&&(provider?row.provider===provider:!!blockedFor([row],model,now))).map(row=>row.resetAt!);
  return resets.length?Math.max(...resets):namedReset(words,now);
}
/** Whether no block is left on work with this model: for Claude no limit at all (its agents may run another Claude
 * model than the chat) and nothing else on the model; for other suppliers nothing on the model. */
export function limitLifted(rows:Availability[],model:string,now=Date.now()){
  if(!model.startsWith('claude-code:'))return !blockedFor(rows,model,now);
  return !rows.some(row=>row.provider==='claude-code'&&row.blocked&&!(row.reason==='limit'&&row.resetAt!==null&&row.resetAt<=now)&&(row.reason==='limit'||!!blockedFor([row],model,now)));
}
/** Whether carried-on work goes now: its time has come, or the block it waited on lifted early (a usage check saw
 * room, credits were bought). Work that only had the refusal's own words ("resets 2:50pm") waits for that time. */
export function carryReady(row:{at:number;model:string;held?:boolean},rows:Availability[],now=Date.now()){
  return row.at<=now||row.held!==false&&limitLifted(rows,row.model,now);
}
/** What the app sends into the chat at the reset, in place of a message he sent by hand. */
export function carryOnText(agents:number){
  return 'The usage limit that stopped this work has reset. Carry on from where it stopped.'+(agents?' '+(agents===1?'One agent was':agents+' agents were')+' stopped by the limit before finishing: start '+(agents===1?'it':'them')+' again where the work still needs '+(agents===1?'it':'them')+'.':'');
}
/** "22:30", with the weekday when that is not today. */
export function resetClock(at:number,now=Date.now()){
  const date=new Date(at),today=new Date(now),time=date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  return date.toDateString()===today.toDateString()?time:date.toLocaleDateString([],{weekday:'short'})+' '+time;
}
/** A reply ending as `patch` while the usage limit blocks its model pauses instead; any other end stays as it is. */
export function limitPause(turn:Pick<Turn,'model'>,patch:Partial<Turn>,rows:Availability[],now=Date.now()):Partial<Turn>{
  if(patch.status!=='failed'&&patch.status!=='interrupted')return patch;
  const at=limitReset(rows,turn.model,now);
  return at===null?patch:pausePatch(at,now);
}
