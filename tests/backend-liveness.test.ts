import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JsonRpcRequestChannel} from '../app/upstream/json-rpc-channel';
import {backendSendError} from '../app/backend-state';

test('sleep and a clock adjustment grant a fresh heartbeat window; a silent backend still fails',t=>{
 t.mock.timers.enable({apis:['setInterval']});
 let clock=1000000;t.mock.method(Date,'now',()=>clock);
 const tick=(elapsed=15000)=>{clock+=elapsed;t.mock.timers.tick(15000);};
 const sent:any[]=[],failures:Error[]=[];
 const channel=new JsonRpcRequestChannel({onHeartbeatFailure:error=>failures.push(error)});
 channel.attach({send:text=>sent.push(JSON.parse(text))});channel.startHeartbeat();
 tick();assert.equal(sent.length,1);
 // The app's event loop did not run during the six hours asleep.
 tick(6*60*60*1000);
 assert.equal(failures.length,0);assert.equal(sent.length,2);
 channel.handleFrame(JSON.stringify({jsonrpc:'2.0',id:sent.at(-1).id,result:{}}));
 tick();assert.equal(failures.length,0);
 tick(-60000);
 assert.equal(failures.length,0);
 tick();tick();tick();assert.equal(failures.length,1);
 assert.match(failures[0].message,/acknowledgement timed out/);
 t.mock.timers.tick(60000);assert.equal(failures.length,1);
 channel.detach(Error('Done'));
});

test('offline sends preserve drafts and native Claude remains usable',()=>{
 assert.equal(backendSendError('ready',['gpt-6-astra']),null);
 assert.match(backendSendError('starting',['gpt-6-astra'])!,/starting/);
 for(const status of ['stopped','failed']){
  assert.match(backendSendError(status,[])!,/draft is saved/);
  assert.match(backendSendError(status,['claude-code:opus','gpt-6-astra'])!,/offline/);
  assert.equal(backendSendError(status,['claude-code:opus']),null);
 }
});
