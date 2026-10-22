import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {GatewaySupervisor} from '../app/remote';
import {pair,hotp,fromBase32,checkCode,bindingDigest} from '../app/remote-code';

test('a delayed code cannot authorize a replacement Telegram approval',()=>{
 const state=pair(0),a={owner:'4242',origin:'telegram',chatId:'chat-a',approvalId:'approval-a',action:'original action'};
 const b={...a,approvalId:'approval-b',action:'replacement action'},code=hotp(fromBase32(state.secret),0);
 const shown={digest:bindingDigest(b),at:300,messageId:'message-b'};
 assert.equal(checkCode(state,code,shown,b,400,'message-a').ok,false);
 assert.equal(checkCode(state,code,shown,b,400).ok,false,'an unthreaded code has no action identity');
 assert.equal(checkCode(state,code,shown,b,400,'message-b').ok,true);
 assert.equal(checkCode(state,code,shown,b,200,'message-b').ok,false,'clock rollback expires the challenge');
});

class Child extends EventEmitter {stderr=new EventEmitter();pid=42;}
test('repeated gateway start owns one child and handles a spawn error',()=>{
 const children:Child[]=[],killed:Child[]=[];
 const supervisor=new GatewaySupervisor(()=>{const child=new Child();children.push(child);return child as any;},child=>{killed.push(child as any);},()=>{});
 try{
  supervisor.start();supervisor.start();assert.equal(children.length,1);
  children[0].emit('error',Error('fixture executable missing'));
  assert.equal(supervisor.pid,undefined);assert.equal(supervisor.status,'starting');
  children[0].emit('exit',1); // error and exit are one failed launch
 }finally{supervisor.stop();}
 assert.equal(killed.length,0,'a failed child has already left');
});

test('synchronous launch failure follows the same restart policy',()=>{
 const supervisor=new GatewaySupervisor(()=>{throw Error('fixture launch failed');},()=>{},()=>{});
 try{assert.doesNotThrow(()=>supervisor.start());assert.equal(supervisor.status,'starting');}
 finally{supervisor.stop();}
});
