import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import type {Chat,Turn} from '../app/types';

// LAG 2026-11-09: the small kinds live in memory and every write is logged with a revision.
test('cached kinds read from memory in saved order, as copies, and follow every write',()=>{
  const store=new Store(':memory:'),project=store.project(),a=store.chat(project.id),b=store.chat(project.id);
  const rows=store.all<Chat>('chat');assert.deepEqual(rows.map(r=>r.id),[a.id,b.id]);
  rows[0].title='mutated';assert.equal(store.get<Chat>('chat',a.id).title,'New chat','a caller cannot change the copy');
  store.update<Chat>('chat',a.id,{title:'First'});assert.equal(store.all<Chat>('chat')[0].title,'First');assert.equal(store.find<Chat>('chat',a.id)?.title,'First');
  assert.equal(JSON.parse((store.db.prepare("SELECT data FROM records WHERE kind='chat' AND id=?").get(a.id) as any).data).title,'First','the disk row matches');
  store.put('chat',{...store.get<Chat>('chat',a.id),title:'Re-put'});assert.deepEqual(store.all<Chat>('chat').map(r=>r.title),['Re-put','New chat'],'a re-put row keeps its place');
  store.remove('chat',a.id);assert.deepEqual(store.all<Chat>('chat').map(r=>r.id),[b.id]);assert.equal(store.find('chat',a.id),undefined);assert.equal(store.has('chat',a.id),false);assert.throws(()=>store.get('chat',a.id),/not found/);
  const t1=store.accept('t1',b.id,'one'),t2=store.accept('t2',b.id,'two');
  assert.deepEqual(store.where<Turn>('turn','chatId',b.id).map(t=>t.id),[t1.id,t2.id]);assert.deepEqual(store.whereIn<Turn>('turn','chatId',[b.id]).map(t=>t.id),[t1.id,t2.id]);
  assert.deepEqual(store.idsWhere('turn','chatId',[b.id]),[t1.id,t2.id]);assert.deepEqual(store.ownedTurns(b.id).map(t=>t.id),[t1.id,t2.id]);
  store.update<Turn>('turn',t2.id,{jobs:['j1']});assert.deepEqual(store.turnsWith('jobs').map(t=>t.id),[t2.id]);
  store.update<Turn>('turn',t1.id,{status:'completed'});assert.deepEqual(store.turnsFinishedAfter(0).map(t=>t.id),[t1.id]);
  // Streamed text shows at once and reaches the disk on flush.
  store.stream(t2.id,{text:'partial'});assert.equal(store.get<Turn>('turn',t2.id).text,'partial');assert.equal(store.all<Turn>('turn').find(t=>t.id===t2.id)!.text,'partial');
  store.flush();assert.equal(JSON.parse((store.db.prepare("SELECT data FROM records WHERE kind='turn' AND id=?").get(t2.id) as any).data).text,'partial');
  // A second store on the same file would see the same rows: the cache is only ever a copy of the disk.
  store.db.close();
});

test('every write is logged with a revision; the log tells what changed since a revision',()=>{
  const store=new Store(':memory:'),project=store.project(),chat=store.chat(project.id);
  const r0=store.revision;
  assert.deepEqual(store.changesSince(r0),[]);
  store.update<Chat>('chat',chat.id,{title:'A'});store.update<Chat>('chat',chat.id,{title:'B'});const turn=store.accept('t1',chat.id,'Hello');
  const changes=store.changesSince(r0)!;
  assert.deepEqual(changes.map(c=>c.kind+':'+c.id+':'+c.removed).sort(),['chat:'+chat.id+':false','turn:'+turn.id+':false'].sort(),'one entry per row, the latest');
  assert.ok(changes.every(c=>c.rev>r0));
  store.remove('turn',turn.id);assert.ok(store.changesSince(r0)!.some(c=>c.kind==='turn'&&c.id===turn.id&&c.removed));
  assert.equal(store.changesSince(store.revision+1),null,'a revision from the future is unknown');
  const r1=store.revision;store.forgetChangesBefore(r1);
  assert.deepEqual(store.changesSince(r1),[]);assert.equal(store.changesSince(r1-1),null,'forgotten changes mean: send everything');
  // A rolled-back transaction leaves the copies and the log untrusted: the disk is read again, the log starts over.
  assert.throws(()=>store.transaction(()=>{store.update<Chat>('chat',chat.id,{title:'Rolled back'});throw Error('stop');}),/stop/);
  assert.equal(store.get<Chat>('chat',chat.id).title,'B');assert.equal(store.changesSince(r1),null);assert.deepEqual(store.changesSince(store.revision),[]);
  store.db.close();
});
