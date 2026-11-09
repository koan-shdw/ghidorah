import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import {applyDelta,buildDelta,emptyChanges,type StateDelta} from '../app/state-delta';
import type {Snapshot,ToolCall,Turn} from '../app/types';

// LAG 2026-11-09: the main window gets what changed, not the whole snapshot.
const tool=(id:string,turnId:string,status='completed'):ToolCall=>({id,turnId,name:'Bash',args:{command:id},result:'ok '+id,status});
test('a delta carries the changed rows, the tools of turns newly shown and what to drop; applying it matches a whole state',()=>{
  const store=new Store(':memory:'),project=store.project(),chat=store.chat(project.id),other=store.chat(project.id);
  const t1=store.accept('t1',chat.id,'one'),t2=store.accept('t2',other.id,'two');
  store.put('tool',tool('a',t1.id));store.put('tool',tool('b',t2.id));
  const whole=(turnIds:string[]):Snapshot=>({projects:store.all('project'),chats:store.all('chat'),turns:store.all<Turn>('turn'),tools:store.whereIn<ToolCall>('tool','turnId',turnIds),approvals:[],connected:false,backend:'ready',providerStatus:'',rev:store.revision});
  const rest=(state:Snapshot)=>{const {turns,tools,...rest}=state;return rest;};
  let state=whole([t1.id]),sent={rev:state.rev!,turnIds:new Set([t1.id])};
  assert.ok(emptyChanges(buildDelta(store,sent,new Set([t1.id]))!),'nothing changed, nothing to send');
  // A turn changes, a tool joins the shown turn, a tool of a turn not shown changes, a new turn appears in the chat.
  store.update<Turn>('turn',t1.id,{status:'completed',text:'done'});store.put('tool',tool('c',t1.id));store.update<ToolCall>('tool','b',{status:'failed'});const t3=store.accept('t3',chat.id,'three');
  let changes=buildDelta(store,sent,new Set([t1.id,t3.id]))!;
  assert.deepEqual(changes.turnChanges.changed.map(t=>t.id).sort(),[t1.id,t3.id].sort());assert.deepEqual(changes.turnChanges.removed,[]);
  assert.deepEqual(changes.toolChanges.changed.map(t=>t.id),['c'],'the other turn\'s tool is not sent');assert.deepEqual(changes.toolChanges.dropTurns,[]);
  const message=(changes:NonNullable<ReturnType<typeof buildDelta>>,base:number):StateDelta=>({...rest(whole([])),delta:true,base,rev:store.revision,turnChanges:changes.turnChanges,toolChanges:changes.toolChanges});
  const before=state;state=applyDelta(state,message(changes,sent.rev));
  assert.deepEqual(state.turns,whole([t1.id,t3.id]).turns,'turns match a whole state, in saved order');
  assert.deepEqual(state.tools.map(t=>t.id).sort(),['a','c']);assert.equal(state.rev,store.revision);
  assert.equal(state.turns.find(t=>t.id===t2.id),before.turns.find(t=>t.id===t2.id),'an unchanged turn keeps its object');
  assert.equal(state.tools.find(t=>t.id==='a'),before.tools.find(t=>t.id==='a'),'an unchanged tool keeps its object');
  // The other chat becomes the shown one: its tools come whole, the first chat's go.
  sent={rev:state.rev!,turnIds:new Set([t1.id,t3.id])};
  changes=buildDelta(store,sent,new Set([t2.id]))!;
  assert.deepEqual(changes.toolChanges.changed.map(t=>t.id),['b']);assert.deepEqual(changes.toolChanges.dropTurns.sort(),[t1.id,t3.id].sort());
  state=applyDelta(state,message(changes,sent.rev));assert.deepEqual(state.tools.map(t=>t.id),['b']);assert.equal(state.tools[0].status,'failed');
  // A removed turn and tool leave; a turn turned into a context snapshot leaves too.
  sent={rev:state.rev!,turnIds:new Set([t2.id])};
  store.remove('tool','b');store.remove('turn',t3.id);store.update<Turn>('turn',t1.id,{contextSnapshot:{turnId:t1.id,status:'completed'}});
  changes=buildDelta(store,sent,new Set([t2.id]))!;
  assert.deepEqual(changes.turnChanges.removed.sort(),[t1.id,t3.id].sort());assert.deepEqual(changes.toolChanges.removed,['b']);
  state=applyDelta(state,message(changes,sent.rev));assert.deepEqual(state.turns.map(t=>t.id),[t2.id]);assert.deepEqual(state.tools,[]);
  // A revision the log no longer reaches, or a rollback, means a whole state.
  store.forgetChangesBefore(store.revision);assert.equal(buildDelta(store,{rev:sent.rev,turnIds:new Set()},new Set()),null);
  assert.throws(()=>store.transaction(()=>{store.accept('t4',chat.id,'four');throw Error('stop');}));assert.equal(buildDelta(store,{rev:store.revision-1,turnIds:new Set()},new Set()),null);
  store.db.close();
});

test('rows new to the window join in the order they were made, whatever the order of their latest change',()=>{
  const turn=(id:string,created:number):Turn=>({id,chatId:'c',prompt:id,text:'',reasoning:'',status:'completed',model:'m',error:null,usage:null,created});
  const previous:Snapshot={projects:[],chats:[],turns:[turn('a',1)],tools:[{...tool('w','a'),started:1}],approvals:[],connected:false,backend:'ready',providerStatus:'',rev:1};
  const {turns:_turns,tools:_tools,...rest}=previous;
  const next=applyDelta(previous,{...rest,delta:true,base:1,rev:4,turnChanges:{changed:[turn('c',3),turn('b',2)],removed:[]},toolChanges:{changed:[{...tool('y','c'),started:3},{...tool('x','b'),started:2}],removed:[],dropTurns:[]}});
  assert.deepEqual(next.turns.map(t=>t.id),['a','b','c']);assert.deepEqual(next.tools.map(t=>t.id),['w','x','y']);
});
