import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import {joinTurn,resetJoinedText,replyParts,isJoinedTurn,settleJoined,busyHermesRows} from '../app/turn-joins';
import type {Turn,ToolCall} from '../app/types';

test('read points split text and tools once, survive replacement and keep old messages visible',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),owner=store.accept('owner',chat.id,'Start');
 store.update<Turn>('turn',owner.id,{text:'Before. '});store.accept('joined',chat.id,'Correction');
 store.put<ToolCall>('tool',{id:'tool1',turnId:owner.id,name:'Read',args:{},result:'done',status:'completed'});
 joinTurn(store,'joined',owner.id);store.update<Turn>('turn',owner.id,{text:'Before. After.'});
 store.put<ToolCall>('tool',{id:'tool2',turnId:owner.id,name:'Read',args:{},result:'done',status:'completed'});
 store.accept('second',chat.id,'Another correction');joinTurn(store,'second',owner.id);joinTurn(store,'joined',owner.id);
 const parts=()=>replyParts(store.get<Turn>('turn',owner.id),store.all('tool'),store.all('turn'));
 assert.deepEqual(parts().map(p=>[p.text,p.tools.map(t=>t.id),p.message?.id]),[['Before. ',['tool1'],'joined'],['After.',['tool2'],'second'],['',[],undefined]]);
 resetJoinedText(store,owner.id);store.update<Turn>('turn',owner.id,{text:'Final answer'});
 assert.equal(parts().map(p=>p.text).join(''),'Final answer');assert.deepEqual(store.get<Turn>('turn','joined').readAt,{text:0,tools:1});
 store.accept('legacy',chat.id,'Old message');store.update<Turn>('turn','legacy',{answeredIn:owner.id});
 assert.equal(parts()[0].message?.id,'legacy');assert.equal(parts()[0].text,'');
 assert.equal(isJoinedTurn(store.get('turn','joined'),store.all('turn')),true);
 assert.equal(isJoinedTurn(store.get('turn','joined'),[store.get('turn','joined')]),false,'missing owner never hides the message');
 store.db.close();
});

// 10-19: messages joined to a reply that then failed (PendingSteer) stayed "running" until a restart and blocked Fork.
test('a finished reply settles the messages it read, never the ones Hermes still holds',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),owner=store.accept('owner',chat.id,'Start');
 for(const id of ['read','held','done'])store.accept(id,chat.id,id);
 for(const id of ['read','held'])store.update<Turn>('turn',id,{status:'running'});
 for(const id of ['read','held','done'])joinTurn(store,id,owner.id);
 store.update<Turn>('turn','done',{status:'completed'});
 assert.deepEqual(settleJoined(store,owner.id,'failed','PendingSteer crash',new Set(['held'])),['read']);
 assert.deepEqual([store.get<Turn>('turn','read').status,store.get<Turn>('turn','read').error],['failed','PendingSteer crash']);
 assert.equal(store.get<Turn>('turn','held').status,'running','a steer Hermes still holds runs next');
 assert.equal(store.get<Turn>('turn','done').status,'completed');
 settleJoined(store,owner.id,'completed',null,new Set());
 assert.deepEqual([store.get<Turn>('turn','held').status,store.get<Turn>('turn','held').error],['completed',null]);
 store.db.close();
});

// Rows the idle check closes when Tris tracks nothing in the chat: busy Hermes rows only.
test('busy Hermes rows are the ones a quiet chat closes',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id);
 for(const [id,status,model] of [['run','running','gpt-6'],['wait','waiting','gpt-6'],['queued','queued','gpt-6'],['done','completed','gpt-6'],['opus','running','claude-code:opus']]){store.accept(id,chat.id,id,model);store.update<Turn>('turn',id,{status:status as Turn['status']});}
 assert.deepEqual(busyHermesRows(store.where<Turn>('turn','chatId',chat.id)).map(t=>t.id),['run','wait'],'queued messages are his own queue; Claude rows have their own engine');
 store.db.close();
});
