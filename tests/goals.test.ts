import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import {Goals} from '../app/goals';
import {createParallel,settleParallel} from '../app/parallel';
import type {Chat,Turn,Mode} from '../app/types';

test('chat goals continue only at idle boundaries, preserve steering, evidence and budgets',async()=>{
 const store=new Store(':memory:'),project=store.project(),chat=store.chat(project.id),other=store.chat(project.id);let hold:string|null=null,mode:Mode='manual',sent:string[]=[];
 const goals=new Goals(store,()=>{},()=>hold,()=>mode,async(chatId,runId,text)=>{const turn=store.accept(crypto.randomUUID(),chatId,text);goals.attach(turn,runId);sent.push(turn.id);store.update<Turn>('turn',turn.id,{status:'running'});hold='Running';});
 const finish=(status:'continue'|'complete'|'blocked',tokens:number|null=50)=>{const id=sent.at(-1)!;goals.tool(id,{status,summary:'Checked output',evidence:'Actual fixture output: passed'});store.update<Turn>('turn',id,{status:'completed',usage:tokens===null?null:{turn_total:tokens}});hold=null;return id;};
 try{
  const ordinary=store.accept('ordinary-turn',chat.id,'Discuss the app');assert.match(goals.context(ordinary),/Chat goal: not set/);
  goals.set(chat.id,'Write and verify the report',500);await goals.tick();assert.equal(sent.length,1);assert.equal(goals.get(other.id),undefined);
  await goals.tick();assert.equal(sent.length,1);assert.throws(()=>goals.tool(sent[0],{status:'complete',summary:'Done'}),/evidence/);
  finish('continue');store.update<Chat>('chat',chat.id,{draft:'My new direction'});await goals.tick();assert.equal(sent.length,1);assert.equal(goals.get(chat.id)?.tokens,50);
  store.update<Chat>('chat',chat.id,{draft:''});await goals.tick();assert.equal(sent.length,2);
  finish('complete',75);await goals.tick();assert.equal(goals.get(chat.id)?.status,'complete');assert.equal(goals.get(chat.id)?.tokens,125);assert.match(goals.get(chat.id)!.evidence,/passed/);await goals.tick();assert.equal(sent.length,2);
  assert.match(goals.context(ordinary),/Chat goal: complete/);assert.doesNotMatch(goals.context(ordinary),/Write and verify the report/);
  goals.set(chat.id,'Budgeted work',40);await goals.tick();finish('continue',50);await goals.tick();assert.equal(goals.get(chat.id)?.status,'budget-limited');assert.throws(()=>goals.resume(chat.id,40),/above/);
  goals.resume(chat.id,100);await goals.tick();finish('blocked',10);await goals.tick();assert.equal(goals.get(chat.id)?.status,'blocked');assert.equal(goals.get(chat.id)?.tokens,60);
  goals.resume(chat.id,100,'Refined direction');await goals.tick();const stale=sent.at(-1)!;goals.pause(chat.id);assert.equal(goals.tool(stale,{}).status,'paused');assert.match(goals.context(store.get<Turn>('turn',stale)),/Refined direction/);assert.throws(()=>goals.tool(stale,{status:'complete',summary:'Late',evidence:'Late'}),/no longer/);store.update<Turn>('turn',stale,{status:'stopped',usage:{turn_total:5}});hold=null;await goals.tick();assert.equal(goals.get(chat.id)?.tokens,65);
  goals.resume(chat.id,100);await goals.tick();assert.throws(()=>goals.tool(stale,{}),/no longer/);finish('continue',null);await goals.tick();assert.equal(goals.get(chat.id)?.status,'paused');assert.equal(goals.get(chat.id)?.usageIncomplete,true);assert.throws(()=>goals.resume(chat.id,200),/not reported/);
  goals.resume(chat.id,null);await goals.tick();goals.recover();assert.equal(goals.get(chat.id)?.status,'paused');await goals.tick();assert.equal(goals.get(chat.id)?.status,'paused');
 }finally{goals.close();store.db.close();}
});

test('goal stop, stalled reports, plan mode, queued user work and parallel completion remain bounded',async()=>{
 const store=new Store(':memory:'),p=store.project(),chat=store.chat(p.id);let mode:Mode='manual',hold:string|null=null,count=0;
 const goals=new Goals(store,()=>{},()=>hold,()=>mode,async(chatId,runId)=>{const turn=store.accept('turn-'+ ++count,chatId,'Continue');goals.attach(turn,runId);store.update<Turn>('turn',turn.id,{status:'running'});hold='Running';});
 const finish=(report=true)=>{if(report)goals.tool('turn-'+count,{status:'continue',summary:'Progress',evidence:'Read the inputs'});store.update<Turn>('turn','turn-'+count,{status:'completed',usage:{turn_total:5}});hold=null;};
 try{
  goals.set(chat.id,'Plan',null);mode='plan';await goals.tick();finish();await goals.tick();assert.equal(goals.get(chat.id)?.status,'paused');assert.equal(count,1);
  mode='manual';goals.resume(chat.id,null);await goals.tick();finish(false);await goals.tick();assert.match(goals.get(chat.id)!.summary,/without a goal update/);
  goals.resume(chat.id,null);await goals.tick();finish();await goals.tick();assert.match(goals.get(chat.id)!.summary,/no tool calls/);
  goals.resume(chat.id,null);await goals.tick();finish();store.put('tool',{id:'read',turnId:'turn-'+count,name:'read_file',status:'completed'});hold='Queued user message';await goals.tick();assert.equal(count,4);goals.pause(chat.id);hold=null;await goals.tick();assert.equal(count,4);
  goals.clear(chat.id);assert.equal(goals.get(chat.id),undefined);
  goals.set(chat.id,'Both models must finish',null);await goals.tick();const parent=store.get<Turn>('turn','turn-'+count),jobs=createParallel(store,parent,['deepseek-flash','claude-code:haiku']);hold=null;
  for(const job of jobs){store.update<Turn>('turn',job.id,{status:'running'});goals.tool(job.id,{status:'complete',summary:'Verified by '+job.model,evidence:'Independent fixture check passed'});}
  store.update<Turn>('turn',jobs[0].id,{status:'completed',usage:{turn_total:9}});settleParallel(store);await goals.tick();assert.equal(goals.get(chat.id)?.status,'active');
  store.update<Turn>('turn',jobs[1].id,{status:'completed',usage:{turn_total:11}});settleParallel(store);await goals.tick();assert.equal(goals.get(chat.id)?.status,'complete');assert.equal(goals.get(chat.id)?.tokens,20);assert.match(goals.get(chat.id)!.evidence,/Independent/);
 }finally{goals.close();store.db.close();}
});
