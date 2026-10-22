// Routines (6e, F22): a prompt sent to a chat on a schedule. The app keeps the schedule itself; Hermes's own
// cron stays off (section 5, call 3). Pure logic: main stores the routines, asks this file for the next firing
// and sends each firing through the normal dispatcher with a firing id, so a firing runs once even across a
// restart. A cron line's next time comes from the croniter in the bundled runtime (a host call), passed in.
export type Preset='hourly'|'daily'|'weekdays'|'weekly';
export type Schedule={kind:'preset';preset:Preset;time:string;day?:number}|{kind:'cron';line:string};
export interface Routine {id:string;name:string;schedule:Schedule;chatId:string;prompt:string;enabled:boolean;nextFiring:number|null;lastFiring?:number}
export const PRESETS:Record<Preset,string>={hourly:'Every hour',daily:'Every day',weekdays:'Weekdays',weekly:'Every week'};

export function readRoutine(input:any):Omit<Routine,'id'|'nextFiring'|'lastFiring'>{
 const name=typeof input?.name==='string'?input.name.trim():'',prompt=typeof input?.prompt==='string'?input.prompt.trim():'';
 if(!name||name.length>80)throw Error('Give the routine a name of up to 80 characters.');
 if(!prompt||prompt.length>8000)throw Error('Write the prompt the routine sends, up to 8,000 characters.');
 if(typeof input?.chatId!=='string'||!input.chatId)throw Error('Choose the chat the routine sends to.');
 const schedule=input?.schedule;let read:Schedule;
 if(schedule?.kind==='cron'){const line=typeof schedule.line==='string'?schedule.line.trim().replace(/\s+/g,' '):'';if(!/^[\d*,/\-A-Za-z?LW#]+( [\d*,/\-A-Za-z?LW#]+){4}$/.test(line))throw Error('A cron line has five fields: minute, hour, day of month, month, day of week.');read={kind:'cron',line};}
 else if(schedule?.kind==='preset'&&Object.hasOwn(PRESETS,schedule.preset)){
  const time=typeof schedule.time==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)?schedule.time:null;
  if(!time)throw Error('Give the time as hours and minutes, like 09:30.');
  if(schedule.preset==='weekly'&&!(Number.isInteger(schedule.day)&&schedule.day>=0&&schedule.day<=6))throw Error('Choose the day of the week.');
  read={kind:'preset',preset:schedule.preset,time,...(schedule.preset==='weekly'?{day:schedule.day}:{})};
 }else throw Error('Choose how often the routine runs.');
 return {name,prompt,chatId:input.chatId,schedule:read,enabled:input.enabled!==false};
}

// The first preset time strictly after `after`, in local time. Hourly runs at the given minute of every hour.
export function nextPresetFiring(schedule:Extract<Schedule,{kind:'preset'}>,after:number){
 const [hours,minutes]=schedule.time.split(':').map(Number),at=new Date(after);at.setSeconds(0,0);
 if(schedule.preset==='hourly'){at.setMinutes(minutes);while(at.getTime()<=after)at.setHours(at.getHours()+1);return at.getTime();}
 at.setHours(hours,minutes,0,0);
 for(let day=0;day<=8;day++,at.setDate(at.getDate()+1),at.setHours(hours,minutes,0,0)){
  if(at.getTime()<=after)continue;
  if(schedule.preset==='weekdays'&&(at.getDay()===0||at.getDay()===6))continue;
  if(schedule.preset==='weekly'&&at.getDay()!==schedule.day)continue;
  return at.getTime();
 }
 throw Error('No firing found.');
}

export async function nextFiring(routine:Pick<Routine,'schedule'>,after:number,cronNext:(line:string,after:number)=>Promise<number>){
 const next=routine.schedule.kind==='cron'?await cronNext(routine.schedule.line,after):nextPresetFiring(routine.schedule,after);
 if(!Number.isSafeInteger(next)||next<=after)throw Error('The schedule did not return a future time.');return next;
}

// One id per scheduled time, in the shape message ids take: the dispatcher's "seen before" check turns a second
// send of it into nothing.
export function firingId(routineId:string,at:number){return 'routine-'+routineId+'-'+at;}

// What a tick does with one routine: a due time fires once, and the schedule moves to the first time after now,
// so any number of times missed while the app was closed fire once, under the first missed time. That time is
// the stored one, so a crash before the new time is saved sends the same firing id again, which does nothing.
export async function tick(routine:Routine,now:number,cronNext:(line:string,after:number)=>Promise<number>):Promise<{fire:number|null;next:number|null}>{
 if(!routine.enabled||routine.nextFiring===null||routine.nextFiring>now)return {fire:null,next:routine.nextFiring};
 return {fire:routine.nextFiring,next:await nextFiring(routine,now,cronNext)};
}
