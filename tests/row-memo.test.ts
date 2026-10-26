import test from 'node:test';
import assert from 'node:assert/strict';
import {rowIndex,same,sameRow,stabilize} from '../app/row-memo';
import {applyTurnStream} from '../app/turn-stream';
import type {Snapshot} from '../app/types';

const base=()=>({
 turns:[{id:'a',chatId:'c',status:'completed',text:'Old reply',prompt:'Hi',created:1},{id:'b',chatId:'c',status:'running',text:'Writ',prompt:'More',created:2},{id:'j',chatId:'c',status:'completed',prompt:'Joined',answeredIn:'b',readAt:{text:0,tools:0},created:3}],
 tools:[{id:'a:1',turnId:'a',name:'Read',args:{},result:'x',status:'completed'},{id:'b:1',turnId:'b',name:'Bash',args:{},result:null,status:'running'}],
 approvals:[],background:[],chats:[{id:'c',title:'Chat'}],claude:{models:[]},availableModels:['m'],workReview:[]
}) as unknown as Snapshot;
const row=(state:Snapshot,id:string)=>({state,t:state.turns.find(t=>t.id===id)!,pool:['m'],chatId:'c',index:rowIndex(state)});

test('same compares values, not identity or key order',()=>{
 assert.ok(same({a:[1,{b:2}],c:'x'},{c:'x',a:[1,{b:2}]}));
 assert.ok(!same({a:undefined},{b:undefined}));assert.ok(!same([1,2],[1,2,3]));assert.ok(!same({a:1},[1]));
});

test('a pushed state reuses unchanged records, so only changed messages re-render (SPEED-PLAN 6)',()=>{
 const first=base(),pushed=stabilize(first,base());
 assert.equal(pushed.turns,first.turns,'an identical push keeps the same lists');assert.equal(pushed.tools,first.tools);assert.equal(pushed.chats,first.chats);
 for(const id of ['a','b'])assert.ok(sameRow(row(first,id),row(pushed,id)));
 // A tool finishes on the running turn: only that row changes.
 const next=base();(next.tools[1] as any).status='completed';const after=stabilize(first,next);
 assert.equal(after.turns,first.turns);assert.equal(after.tools[0],first.tools[0]);assert.notEqual(after.tools[1],first.tools[1]);
 assert.ok(sameRow(row(first,'a'),row(after,'a')),'the finished message is skipped');
 assert.ok(!sameRow(row(first,'b'),row(after,'b')),'the message whose tool changed re-renders');
});

test('a streamed piece re-renders only the replying message; shared values re-render all',()=>{
 const first=base(),streamed=applyTurnStream(first,[{id:'b',text:'Writing',reasoning:''} as any]);
 assert.ok(sameRow(row(first,'a'),row(streamed,'a')));assert.ok(!sameRow(row(first,'b'),row(streamed,'b')));
 // A message joined into a reply belongs to that reply's row.
 const joined=base();(joined.turns[2] as any).prompt='Edited';const withJoin=stabilize(first,joined);
 assert.ok(!sameRow(row(first,'b'),row(withJoin,'b')));assert.ok(sameRow(row(first,'a'),row(withJoin,'a')));
 const models=stabilize(first,{...base(),availableModels:['m','n']} as Snapshot);
 assert.ok(!sameRow(row(first,'a'),row(models,'a')),'a change every reply shows re-renders every row');
 assert.ok(!sameRow(row(first,'a'),{...row(first,'a'),pool:['m','n']}));assert.ok(sameRow(row(first,'a'),{...row(first,'a'),pool:['m']}),'an equal pool list is the same');
});
