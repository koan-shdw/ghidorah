import test from 'node:test';
import assert from 'node:assert/strict';
import {readRoutine,nextPresetFiring,tick,firingId,type Routine} from '../app/routines';

const local=(y:number,m:number,d:number,h=0,min=0)=>new Date(y,m-1,d,h,min).getTime();
const noCron=async()=>{throw Error('no cron here');};

test('presets fire at the next local time after the given moment',()=>{
 // 2 October 2026 is a Friday.
 const friday9=local(2026,10,2,9,0);
 assert.equal(nextPresetFiring({kind:'preset',preset:'daily',time:'09:30'},friday9),local(2026,10,2,9,30));
 assert.equal(nextPresetFiring({kind:'preset',preset:'daily',time:'09:00'},friday9),local(2026,10,3,9,0),'strictly after');
 assert.equal(nextPresetFiring({kind:'preset',preset:'weekdays',time:'08:00'},friday9),local(2026,10,5,8,0),'skips the weekend');
 assert.equal(nextPresetFiring({kind:'preset',preset:'weekly',time:'07:15',day:3},friday9),local(2026,10,7,7,15),'next Wednesday');
 assert.equal(nextPresetFiring({kind:'preset',preset:'hourly',time:'00:20'},local(2026,10,2,9,25)),local(2026,10,2,10,20));
});

test('a routine is checked before it is stored',()=>{
 const good={name:' Morning summary ',prompt:'Summarise yesterday.',chatId:'c1',schedule:{kind:'preset',preset:'weekly',time:'07:15',day:3}};
 assert.deepEqual(readRoutine(good),{name:'Morning summary',prompt:'Summarise yesterday.',chatId:'c1',schedule:{kind:'preset',preset:'weekly',time:'07:15',day:3},enabled:true});
 assert.deepEqual(readRoutine({...good,schedule:{kind:'cron',line:' */15  9-17 * * 1-5 '}}).schedule,{kind:'cron',line:'*/15 9-17 * * 1-5'});
 for(const bad of [{...good,name:''},{...good,prompt:''},{...good,chatId:''},{...good,schedule:{kind:'preset',preset:'daily',time:'25:00'}},{...good,schedule:{kind:'preset',preset:'weekly',time:'07:15'}},{...good,schedule:{kind:'cron',line:'* * *'}},{...good,schedule:{kind:'cron',line:'* * * * * ; rm'}},{...good,schedule:{kind:'yearly'}}])
  assert.throws(()=>readRoutine(bad));
});

test('a due routine fires once and moves past now; a long closed spell fires once',async()=>{
 const routine:Routine={id:'r1',name:'n',prompt:'p',chatId:'c1',enabled:true,schedule:{kind:'preset',preset:'hourly',time:'00:00'},nextFiring:local(2026,10,2,9,0)};
 assert.deepEqual(await tick(routine,local(2026,10,2,8,59),noCron),{fire:null,next:routine.nextFiring});
 assert.deepEqual(await tick(routine,local(2026,10,2,9,0),noCron),{fire:local(2026,10,2,9,0),next:local(2026,10,2,10,0)});
 assert.deepEqual(await tick(routine,local(2026,10,5,14,30),noCron),{fire:local(2026,10,2,9,0),next:local(2026,10,5,15,0)},'three days closed: one firing');
 assert.deepEqual(await tick({...routine,enabled:false},local(2026,10,5,14,30),noCron),{fire:null,next:routine.nextFiring});
 assert.equal(firingId('6f1c2a9e-0000-4000-8000-000000000001',local(2026,10,2,9,0)),'routine-6f1c2a9e-0000-4000-8000-000000000001-'+local(2026,10,2,9,0));
 assert.match(firingId('6f1c2a9e-0000-4000-8000-000000000001',local(2026,10,2,9,0)),/^[\w-]{10,80}$/,'the shape submit accepts');
});

test('a cron routine asks the runtime for its next time',async()=>{
 const asked:number[]=[];const cron=async(line:string,after:number)=>{assert.equal(line,'*/15 * * * *');asked.push(after);return after+15*60000;};
 const routine:Routine={id:'r2',name:'n',prompt:'p',chatId:'c1',enabled:true,schedule:{kind:'cron',line:'*/15 * * * *'},nextFiring:1000};
 assert.deepEqual(await tick(routine,5000,cron),{fire:1000,next:5000+15*60000});assert.deepEqual(asked,[5000]);
});
