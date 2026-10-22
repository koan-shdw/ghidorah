import test from 'node:test';
import assert from 'node:assert/strict';
import {PluginChanges} from '../app/plugin-changes';

test('reviewed plugin changes wait, deduplicate, cancel, and apply once in order',async()=>{
 let blocked=true,calls=0;const queue=new PluginChanges(()=>blocked?'Current reply is running':null,()=>{});
 const apply=async(signal:AbortSignal,activate:()=>void)=>{signal.throwIfAborted();activate();calls++;return true;};
 const first=queue.enqueue('pony','Ponytail','Install',apply);
 assert.equal(queue.enqueue('pony','Ponytail','Install',apply),first);assert.equal(calls,0);assert.equal(queue.rows()[0].status,'queued');
 const cancelled=queue.enqueue('other','Other','Install',apply),rejected=assert.rejects(cancelled,/cancelled/);
 queue.cancel(queue.rows()[1].id);await rejected;
 blocked=false;queue.poke();assert.equal(await first,true);assert.equal(calls,1);assert.equal(queue.rows()[0].status,'completed');assert.equal(queue.pending,false);
 const failed=queue.enqueue('bad','Bad','Install',async()=>{throw Error('Setup failed');});await assert.rejects(failed,/Setup failed/);assert.equal(queue.rows().at(-1)?.status,'failed');
});
