import test from 'node:test';
import assert from 'node:assert/strict';
import {carryOnAt,carryOnText,carryReady,limitLifted,limitPause,limitReset,limitStop,namedReset,pausePatch,pauseText,resetClock,resumeDue} from '../app/limit-pause';
import type {Availability} from '../app/availability';
import type {Turn} from '../app/types';

// Resume after the usage limit (Koan 2026-11-09).
const now=Date.parse('2026-11-09T12:00:00'),later=now+2*3600000;
const row=(over:Partial<Availability>={}):Availability=>({id:'claude-code:rate:five_hour:account',provider:'claude-code',key:'rate:five_hour',scope:'account',blocked:true,reason:'limit',resetAt:later,observedAt:now,...over});
const turn=(over:Partial<Turn>={}):Turn=>({id:'t1',chatId:'c1',prompt:'Go on',text:'',reasoning:'',status:'running',model:'claude-code:opus',error:null,usage:null,created:now,...over});
const time=(at:number)=>new Date(at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});

test('a usage limit with a reset time ahead pauses a stopped reply; anything else ends as it did',()=>{
  const rows=[row()];
  assert.equal(limitReset(rows,'claude-code:opus',now),later);
  assert.equal(limitReset(rows,'deepseek-flash',now),null,'another supplier is not blocked');
  assert.equal(limitReset([row({resetAt:null})],'claude-code:opus',now),null,'no reset time: nothing to wait for');
  assert.equal(limitReset([row({resetAt:now-1})],'claude-code:opus',now),null,'a reset in the past blocks nothing');
  assert.equal(limitReset([row({reason:'credit'})],'claude-code:opus',now),null,'credit does not come back by itself');
  const failed:Partial<Turn>={status:'failed',error:'You have hit your limit',stopReason:'provider-error'};
  const paused=limitPause(turn(),failed,rows,now);
  assert.equal(paused.status,'queued');assert.deepEqual(paused.resume,{at:later,reason:'limit'});assert.equal(paused.error,null);assert.equal(paused.stopReason,undefined);
  assert.equal(paused.hold,'Paused until '+time(later)+', limit. Resumes by itself');
  assert.equal(limitPause(turn(),{status:'interrupted',error:'Preparing reply: limit'},rows,now).status,'queued','a limit during preparation waits too');
  assert.equal(limitPause(turn(),failed,[row({reason:'credit'})],now),failed,'out of credit fails as before');
  assert.equal(limitPause(turn(),{status:'stopped'},rows,now).status,'stopped','Stop is his, never a wait');
  assert.equal(limitPause(turn(),{status:'completed'},rows,now).status,'completed');
});

test('the wait ends at the reset time or when the limit lifts earlier; the text names the day when it is not today',()=>{
  const rows=[row()],waiting=turn({status:'queued',resume:{at:later,reason:'limit'}});
  assert.equal(resumeDue(waiting,rows,now),false);
  assert.equal(resumeDue(waiting,rows,later),true,'the time has come');
  assert.equal(resumeDue(waiting,[row({blocked:false})],now),true,'the limit lifted early');
  assert.equal(resumeDue(waiting,[],now),true);
  assert.equal(resumeDue(turn({status:'queued'}),rows,now),true,'a message without a wait is due');
  const tomorrow=now+20*3600000;
  assert.equal(pauseText(tomorrow,now),'Paused until '+new Date(tomorrow).toLocaleDateString([],{weekday:'short'})+' '+time(tomorrow)+', limit. Resumes by itself');
  assert.deepEqual(Object.keys(pausePatch(later,now)).sort(),['activity','delivery','error','hold','preparation','resume','status','stopReason']);
});

// Ghidorah 4, job 5 (Koan 2026-11-19): work Claude runs by itself was ended by a limit and the chat sat until he
// sent a message by hand. Read from his data: "You've hit your session limit · resets 2:50pm", with a block that has
// no end time beside the right one.
test('work a limit stopped is known by the supplier\'s words, and carries on once every limit on its model has reset',()=>{
  assert.equal(limitStop(turn({status:'failed',error:"You've hit your session limit · resets 2:50pm"})),true);
  assert.equal(limitStop(turn({status:'failed',error:null,text:'Reading the folders.\n\nYou\'ve hit your usage limit.'})),true,'the words can be the end of the reply');
  assert.equal(limitStop(turn({status:'interrupted',error:'Usage limit reached · resets 11am'})),true);
  assert.equal(limitStop(turn({status:'failed',error:'The command exited with code 1'})),false);
  assert.equal(limitStop(turn({status:'completed',text:'You asked about the session limit.'})),false,'a finished reply that talks about limits is not a stop');
  assert.equal(limitStop(turn({status:'stopped',error:"You've hit your session limit"})),false,'Stop is his');
  // The time the refusal names is the next such time on the clock.
  const at=(hour:number,minute:number,days=0)=>{const date=new Date(now);date.setDate(date.getDate()+days);date.setHours(hour,minute,0,0);return date.getTime();};
  assert.equal(namedReset('hit your session limit · resets 2:50pm',now),at(14,50));
  assert.equal(namedReset('resets 6:20am',now),at(6,20,1),'already past today: tomorrow');
  assert.equal(namedReset('resets at 7pm',now),at(19,0));assert.equal(namedReset('resets 12:05am',now),at(0,5,1));
  assert.equal(namedReset('resets soon',now),null);assert.equal(namedReset('resets 13:70pm',now),null);
  // The block without an end time does not hide the limit that has one; the latest reset decides.
  const blind=row({id:'claude-code:limit:claude-code:opus',key:'limit',scope:'claude-code:opus',resetAt:null}),weekly=row({id:'claude-code:rate:seven_day:account',key:'rate:seven_day',resetAt:later+3600000});
  assert.equal(limitReset([blind,row()],'claude-code:opus',now),null,'the hole: the first block found has no end time');
  assert.equal(carryOnAt([blind,row()],'claude-code:opus','',now),later);
  assert.equal(carryOnAt([blind,row(),weekly],'claude-code:opus','',now),later+3600000);
  assert.equal(carryOnAt([blind],'claude-code:opus','resets 2:50pm',now),at(14,50),'no end time on record: the time the refusal names');
  assert.equal(carryOnAt([blind],'claude-code:opus','',now),null,'nothing known: nothing is promised');
  assert.equal(carryOnAt([row()],'deepseek-flash','',now),null,'another supplier\'s limit');
  assert.equal(carryOnAt([row({resetAt:now-1})],'claude-code:opus','',now),null);
  assert.match(carryOnText(0),/^The usage limit that stopped this work has reset\. Carry on from where it stopped\.$/);
  assert.match(carryOnText(1),/One agent was stopped by the limit before finishing: start it again/);assert.match(carryOnText(3),/3 agents were stopped .* start them again/);
  assert.equal(resetClock(later,now),time(later));assert.equal(resetClock(now+20*3600000,now),new Date(now+20*3600000).toLocaleDateString([],{weekday:'short'})+' '+time(now+20*3600000));
});

// Fable credits came back before the old reset and stalled chats sat until it (Koan 2026-11-27).
test('carried-on work goes as soon as the block it waited on lifts; work that had only the refusal\'s words waits',()=>{
  const fable=row({id:'claude-code:rate:seven_day_fable:claude-code:fable',key:'rate:seven_day_fable',scope:'claude-code:fable',refused:true});
  // An agent on Fable stopped an Opus chat: any Claude limit still holds it, whichever model it carries on with.
  assert.equal(limitLifted([fable],'claude-code:opus',now),false);
  assert.equal(limitLifted([fable,row({blocked:false})],'claude-code:opus',now),false);
  assert.equal(limitLifted([{...fable,blocked:false}],'claude-code:opus',now),true);
  assert.equal(limitLifted([row({key:'billing',resetAt:null})],'claude-code:opus',now),false,'credits run out: no end time, still a block');
  assert.equal(limitLifted([row({provider:'openai-codex'})],'claude-code:opus',now),true,'another supplier\'s limit');
  const carry={at:later,model:'claude-code:opus'};
  assert.equal(carryReady(carry,[fable],now),false);
  assert.equal(carryReady(carry,[{...fable,blocked:false}],now),true,'lifted early');
  assert.equal(carryReady({...carry,held:false},[],now),false,'only a named time: wait for it');
  assert.equal(carryReady({...carry,held:false},[],later),true);
});
