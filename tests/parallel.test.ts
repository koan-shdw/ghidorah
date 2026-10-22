import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../app/store';
import {createParallel,settleParallel} from '../app/parallel';
import {handover} from '../app/history';
import type {Chat,Turn} from '../app/types';

test('parallel runs share a frozen starting history and have independent engine identities',()=>{
 const store=new Store(':memory:'),project=store.project(),chat=store.chat(project.id),foreign=store.chat(store.project().id);
 const attachment={id:'attached',chatId:chat.id,name:'diagram.png',kind:'image' as const,size:1,sha256:'hash',contentHash:'hash'};
 store.update<Chat>('chat',chat.id,{attachments:[attachment],efforts:{'gpt-6-luna':'low','claude-code:haiku':'high'}});
 const earlier=store.accept('earlier',chat.id,'Existing context');store.update<Turn>('turn',earlier.id,{text:'Existing answer',status:'completed'});
 store.accept('foreign',foreign.id,'FOREIGN SECRET');const parent=store.accept('parent',chat.id,'Same task');store.accept('future',chat.id,'FUTURE MESSAGE');
 const jobs=createParallel(store,parent,['gpt-6-luna','claude-code:haiku']);
 assert.equal(new Set(jobs.map(t=>t.chatId)).size,2);assert.equal(jobs[0].commandContext,jobs[1].commandContext);
 assert.match(jobs[0].commandContext!,/Existing context/);assert.doesNotMatch(jobs[0].commandContext!,/FOREIGN SECRET|FUTURE MESSAGE/);
 assert.deepEqual(jobs[0].attachments,[attachment]);assert.equal(jobs[0].effort,'low');assert.equal(jobs[1].effort,'high');
 for(const job of jobs){assert.equal(store.get<Chat>('chat',job.chatId).projectId,project.id);assert.equal(store.enginePosition(job.chatId,'hermes').sessionId,null);assert.equal(store.enginePosition(job.chatId,'claude').sessionId,null);}
 // A stale caller cannot create a second group or duplicate any run.
 assert.deepEqual(createParallel(store,parent,['gpt-6-luna','claude-code:haiku']).map(t=>t.id),jobs.map(t=>t.id));
 assert.equal(store.snapshot().chats.length,2);assert.equal(store.all<Chat>('chat').length,4);
 store.finishEngine(jobs[0].id,'hermes','session-a',{status:'completed',text:'GPT result'});
 assert.equal(store.enginePosition(jobs[1].chatId,'hermes').sessionId,null);assert.deepEqual(settleParallel(store),[]);
 store.finishEngine(jobs[1].id,'claude','session-b',{status:'completed',text:'Claude result'});
 store.put('tool',{id:'write',turnId:jobs[1].id,name:'Write',args:{path:'built.txt'},result:'written once',status:'completed'});
 assert.deepEqual(settleParallel(store),[chat.id]);assert.deepEqual(settleParallel(store),[]);
 const next=store.get<Turn>('turn','future'),context=handover(store.all<Turn>('turn'),store.all('tool'),next);
 assert.equal(context.prompt.split('GPT result').length-1,1);assert.equal(context.prompt.split('Claude result').length-1,1);assert.match(context.prompt,/written once/);
 assert.doesNotMatch(context.prompt,/FOREIGN SECRET/);store.db.close();
});

test('crash recovery retains completed siblings and interrupts queued or running side jobs without replay',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'tris-parallel-')),file=path.join(folder,'state.sqlite');let store=new Store(file);
 const chat=store.chat(store.project().id),parent=store.accept('parent',chat.id,'Build together');
 const jobs=createParallel(store,parent,['deepseek-flash','gpt-6-luna','claude-code:haiku']);
 store.update<Turn>('turn',jobs[0].id,{status:'completed',text:'Saved answer'});store.update<Turn>('turn',jobs[1].id,{status:'running',text:'Partial reply'});store.db.close();
 store=new Store(file);store.interrupt();settleParallel(store);
 assert.equal(store.get<Turn>('turn',parent.id).status,'partial');assert.equal(store.get<Turn>('turn',jobs[0].id).text,'Saved answer');assert.equal(store.get<Turn>('turn',jobs[1].id).text,'Partial reply');
 assert.equal(store.get<Turn>('turn',jobs[1].id).status,'interrupted');assert.equal(store.get<Turn>('turn',jobs[2].id).status,'interrupted');
 assert.deepEqual(settleParallel(store),[]);store.db.close();
});

test('one backend failing leaves the parent active until its independent sibling finishes',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),parent=store.accept('parent',chat.id,'Work together');
 const jobs=createParallel(store,parent,['deepseek-flash','claude-code:haiku']);
 for(const job of jobs)store.update<Turn>('turn',job.id,{status:'running'});
 store.interrupt('hermes');assert.deepEqual(settleParallel(store),[]);
 assert.equal(store.get<Turn>('turn',parent.id).status,'running');assert.equal(store.get<Turn>('turn',jobs[0].id).status,'interrupted');assert.equal(store.get<Turn>('turn',jobs[1].id).status,'running');
 store.finishEngine(jobs[1].id,'claude','native',{text:'Independent answer',status:'completed'});settleParallel(store);
 assert.equal(store.get<Turn>('turn',parent.id).status,'partial');store.db.close();
});

test('cancelling a queued correction waits for the old process to finish stopping',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),parent=store.accept('parent',chat.id,'Work together'),jobs=createParallel(store,parent,['deepseek-flash','claude-code:haiku']);
 store.update<Turn>('turn',jobs[0].id,{status:'stopping'});store.update<Turn>('turn',jobs[1].id,{status:'completed'});
 const correction=store.accept('correction',jobs[0].chatId,'Correction');store.update<Turn>('turn',correction.id,{parentTurnId:parent.id,status:'stopped'});store.update<Turn>('turn',parent.id,{jobs:[...jobs.map(job=>job.id),correction.id]});
 assert.deepEqual(settleParallel(store),[]);assert.equal(store.get<Turn>('turn',parent.id).status,'running');
 store.update<Turn>('turn',jobs[0].id,{status:'stopped'});settleParallel(store);assert.equal(store.get<Turn>('turn',parent.id).status,'partial');store.db.close();
});
