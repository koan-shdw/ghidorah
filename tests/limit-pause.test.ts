import test from 'node:test';
import assert from 'node:assert/strict';
import {limitPause,limitReset,pausePatch,pauseText,resumeDue} from '../app/limit-pause';
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
