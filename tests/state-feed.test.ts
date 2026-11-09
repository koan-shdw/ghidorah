import test from 'node:test';
import assert from 'node:assert/strict';
import type {Snapshot,Turn} from '../app/types';

// LAG 2026-11-09: the window's one state, fed by pushes (whole or changes) and 'state' answers, shared by every listener.
const pushes:((message:any)=>void)[]=[],streams:((updates:any)=>void)[]=[],requests:{method:string;args:any}[]=[];let answer:any=null;
(globalThis as any).window={desktop:{invoke:async(method:string,args:any)=>{requests.push({method,args});return answer;},subscribe:(handler:any,stream:any)=>{pushes.push(handler);streams.push(stream);return ()=>{};}}};
const feed=await import('../app/state-feed');
const base={projects:[],chats:[],approvals:[],connected:true,backend:'ready',providerStatus:''} as unknown as Snapshot;
const turn=(id:string,over:Partial<Turn>={}):Turn=>({id,chatId:'c1',prompt:'Go on',text:'',reasoning:'',status:'completed',model:'m',error:null,usage:null,created:1,...over});
const whole=(rev:number,turns:Turn[]):Snapshot=>({...base,turns,tools:[],rev});
const change=(from:number,to:number,changed:Turn[]):any=>({...base,delta:true,base:from,rev:to,turnChanges:{changed,removed:[]},toolChanges:{changed:[],removed:[],dropTurns:[]}});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('a whole state reaches every listener; a listener arriving later gets the held state at once',()=>{
  const seen:Snapshot[]=[];feed.subscribeState(state=>seen.push(state));
  assert.equal(seen.length,0,'nothing held yet');assert.equal(feed.heldRevision(),undefined);
  feed.takeState(whole(3,[turn('t1')]));
  assert.equal(seen.length,1);assert.equal(seen[0].rev,3);assert.equal(feed.heldRevision(),3);
  const late:Snapshot[]=[];feed.subscribeState(state=>late.push(state));
  assert.equal(late[0],seen[0],'the held state, the same object');
});

test('a change against the held revision is merged: unchanged rows keep their objects, the revision moves on',()=>{
  const before=feed.heldState()!,seen:Snapshot[]=[];const stop=feed.subscribeState(state=>seen.push(state));
  pushes[0](change(3,5,[turn('t2',{created:2})]));
  const after=feed.heldState()!;
  assert.equal(after.rev,5);assert.deepEqual(after.turns.map(t=>t.id),['t1','t2']);assert.equal(after.turns[0],before.turns[0],'t1 did not change: the same object');
  assert.equal(seen.at(-1),after,'listeners got the merged state');stop();
});

test('a change against another revision asks for the whole state once; a stale change needs nothing',async()=>{
  answer=whole(9,[turn('t9')]);
  pushes[0](change(7,8,[turn('t8')]));pushes[0](change(7,8,[turn('t8')]));
  assert.equal(requests.length,1,'one request while it is out');assert.deepEqual(requests[0],{method:'state',args:{window:true}});
  assert.equal(feed.heldRevision(),5,'the change was not applied');
  await tick();await tick();
  assert.equal(feed.heldRevision(),9);assert.deepEqual(feed.heldState()!.turns.map(t=>t.id),['t9']);
  pushes[0](change(2,4,[turn('t4')]));
  assert.equal(requests.length,1,'older than the held state: ignored');assert.equal(feed.heldRevision(),9);
});

test('streamed text patches the held state and reaches the stream listeners',()=>{
  feed.takeState(whole(10,[turn('t10',{status:'running'})]));
  const streamed:any[]=[];feed.subscribeState(()=>{},updates=>streamed.push(updates));
  streams[0]([{id:'t10',text:'so far'}]);
  assert.equal(feed.heldState()!.turns[0].text,'so far');assert.equal(streamed.length,1);
  pushes[0](change(10,11,[]));
  assert.equal(feed.heldState()!.turns[0].text,'so far','a change without that row keeps the streamed text');
});
