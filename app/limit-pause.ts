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
/** A reply ending as `patch` while the usage limit blocks its model pauses instead; any other end stays as it is. */
export function limitPause(turn:Pick<Turn,'model'>,patch:Partial<Turn>,rows:Availability[],now=Date.now()):Partial<Turn>{
  if(patch.status!=='failed'&&patch.status!=='interrupted')return patch;
  const at=limitReset(rows,turn.model,now);
  return at===null?patch:pausePatch(at,now);
}
