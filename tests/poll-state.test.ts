import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pollState} from './fixtures/poll-state';

test('state polling waits past false asynchronous results and rejects unmet conditions',async()=>{
  let reads=0;
  const page={evaluate:async()=>({backend:++reads<3?'starting':'ready'}),waitForTimeout:async()=>{}} as any;
  assert.equal((await pollState(page,state=>state.backend==='ready')).backend,'ready');
  assert.equal(reads,3);
  await assert.rejects(pollState(page,()=>false,0),/Timed out/);
});
