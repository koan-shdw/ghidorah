import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.ts';
import type {Turn,Chat} from '../app/types.ts';
import {mkdtempSync,rmSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
test('default permission mode affects new projects and survives restart',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'trismegistus-default-mode-')),file=path.join(dir,'chat.sqlite');
 let s=new Store(file);
 try{
  assert.equal(s.defaultMode(),'manual');const original=s.project();
  s.defaultMode('bypass');assert.equal(s.project().mode,'bypass');assert.equal(s.get<any>('project',original.id).mode,'manual');
  assert.throws(()=>s.defaultMode('invalid'),/permission mode/);assert.equal(s.defaultMode(),'bypass');
  s.db.close();s=new Store(file);assert.equal(s.defaultMode(),'bypass');assert.equal(s.project().mode,'bypass');
  s.put('settings',{id:'default-permission-mode',mode:'invalid'});assert.equal(s.defaultMode(),'manual');
 }finally{s.db.close();rmSync(file);rmdirSync(dir);}
});
test('duplicate Send and replay are durable single operations; interrupted work is retained',()=>{
 const s=new Store(':memory:');const p=s.project('C:\\work\\alpha');const c=s.chat(p.id);
 const one=s.accept('origin-event-1',c.id,'Make a file');const two=s.accept('origin-event-1',c.id,'Make a file');assert.equal(one.id,two.id);assert.equal(s.all('turn').length,1);
 const apply=()=>s.update<Turn>('turn',one.id,{status:'running',text:'Partial'});
 assert.equal(s.event('epoch:1',apply),true);assert.equal(s.event('epoch:1',()=>assert.fail()),false);
 s.interrupt();assert.equal(s.get<Turn>('turn',one.id).text,'Partial');assert.equal(s.get<Turn>('turn',one.id).status,'interrupted');
 assert.equal(s.all('project').length,1);assert.equal(s.chat(p.id).draft,'');s.db.close();
});

test('one existing working folder becomes the shared root without merging chats',()=>{
 const s=new Store(':memory:');
 const a=s.project('C:\\Projects'),b=s.project('C:\\Projects');
 assert.notEqual(a.id,b.id);
 s.initializeWorkingFolder();
 assert.equal(s.all<any>('settings')[0].folder,'C:\\Projects');
 s.put('settings',{id:'working-folder',folder:null});s.initializeWorkingFolder();
 assert.equal(s.all<any>('settings')[0].folder,null);
 s.db.close();
});

test('native memory migration drops old Claude session caches once and preserves chat and Hermes history',()=>{
 const s=new Store(':memory:'),p=s.project('C:\\Projects'),c=s.chat(p.id),t=s.accept('prior-turn',c.id,'Keep this conversation');
 s.finishEngine(t.id,'hermes','hermes-session',{status:'completed',text:'Saved answer'});s.finishEngine(t.id,'claude','old-native-session',{status:'completed'});
 s.initializeNativeMemoryIsolation();assert.equal(s.enginePosition(c.id,'claude').sessionId,null);assert.equal(s.enginePosition(c.id,'claude').uncertain,true);assert.equal(s.enginePosition(c.id,'hermes').sessionId,'hermes-session');assert.equal(s.get<Turn>('turn',t.id).text,'Saved answer');
 s.finishEngine(t.id,'claude','new-native-session',{status:'completed'});s.initializeNativeMemoryIsolation();assert.equal(s.enginePosition(c.id,'claude').sessionId,'new-native-session');s.db.close();
});

test('disk reopen preserves draft, effort and completed effects while expiring unfinished approval',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'trismegistus-store-')),file=path.join(dir,'chat.sqlite');
 let s=new Store(file);
 try{
  const p=s.project('C:\\project'),c=s.chat(p.id),t=s.accept('durable-turn',c.id,'Run a command');
  s.update<Chat>('chat',c.id,{effort:'max',draft:'Keep my draft',selected:true});
  assert.equal(t.effort,'high');
  s.update<Turn>('turn',t.id,{status:'running',text:'Partial reply'});
  s.finishEngine(t.id,'claude','prior-session',{status:'completed'});
  s.beginEngine(c.id,'claude');
  s.update<Turn>('turn',t.id,{status:'running'});
  s.put('tool',{id:'completed-effect',turnId:t.id,status:'completed',result:'File saved'});
  s.put('tool',{id:'unknown-effect',turnId:t.id,status:'running'});
  s.put('approval',{id:'pending',turnId:t.id,status:'pending'});
  s.db.close();s=new Store(file);s.interrupt();
  assert.equal(s.enginePosition(c.id,'claude').uncertain,true);
  assert.equal(s.enginePosition(c.id,'claude').throughTurnId,t.id);
  assert.equal(s.get<any>('chat',c.id).draft,'Keep my draft');
  assert.equal(s.get<Chat>('chat',c.id).selected,true);
  const next=s.accept('next-durable-turn',c.id,'A new message');
  assert.equal(s.get<Chat>('chat',c.id).selected,false);
  assert.equal(next.effort,'max');
  assert.equal(s.get<any>('tool','completed-effect').status,'completed');
  assert.equal(s.get<any>('tool','unknown-effect').status,'uncertain');
  assert.equal(s.get<any>('approval','pending').status,'expired');
  assert.equal(s.get<Turn>('turn',t.id).text,'Partial reply');
  s.accept(t.id,c.id,'Run a command');assert.equal(s.all('turn').length,2);
 }finally{s.db.close();rmSync(file);rmdirSync(dir);}
});

test('per-tool lookups use indexed fields and match a full read (RUN-PLAN 3c)',()=>{
  const store=new Store(':memory:');
  for(let i=0;i<50;i++){store.put('tool',{id:'t'+i,turnId:'turn'+(i%5),status:i%7?'completed':'running'});store.put('work-action',{id:'a'+i,job:'turn'+(i%3),status:i%4?'completed':'uncertain',signature:'s'+(i%6)});}
  for(const [kind,field,value] of [['tool','turnId','turn2'],['tool','status','running'],['work-action','job','turn1'],['work-action','status','uncertain'],['work-action','signature','s4']] as const)
    assert.deepEqual(store.where(kind,field,value),store.all<any>(kind).filter(row=>row[field]===value));
  assert.match(JSON.stringify(store.db.prepare("EXPLAIN QUERY PLAN SELECT data FROM records WHERE kind=? AND json_extract(data,'$.turnId')=?").all('tool','turn2')),/records_turnId/);
  assert.deepEqual(store.find('tool','t3'),store.get('tool','t3'));assert.equal(store.find('tool','missing'),undefined);
});

test('a window refresh can leave tools out and fetch only the turns it shows (RUN-PLAN 3b)',()=>{
  const store=new Store(':memory:'),chat=store.chat(store.project().id);
  const turns=['a','b','c'].map(text=>store.accept(crypto.randomUUID(),chat.id,text));
  turns.forEach((turn,i)=>store.put('tool',{id:turn.id+':t',turnId:turn.id,name:'Read',status:'completed',args:{},result:'x'.repeat(i+1)}));
  assert.equal(store.snapshot().tools.length,3);assert.deepEqual(store.snapshot({tools:false}).tools,[]);
  assert.deepEqual(store.whereIn('tool','turnId',[turns[0].id,turns[2].id]).map((t:any)=>t.turnId),[turns[0].id,turns[2].id]);
  assert.deepEqual(store.whereIn('tool','turnId',[]),[]);
  const many=Array.from({length:40000},(_,i)=>'missing'+i);assert.deepEqual(store.whereIn('tool','turnId',[...many,turns[1].id]).map((t:any)=>t.turnId),[turns[1].id]);
});

test('a reader holding the database never makes Tris refuse a write (TURN-REVIEW 2 item 8: 21 of 37 refused)',async()=>{
 const {DatabaseSync}=await import('node:sqlite');
 const dir=mkdtempSync(path.join(tmpdir(),'trismegistus-reader-')),file=path.join(dir,'chat.sqlite'),s=new Store(file),chat=s.chat(s.project().id);
 const reader=new DatabaseSync(file,{readOnly:true});
 try{
  reader.exec('BEGIN');reader.prepare('SELECT count(*) FROM records').get();
  for(let i=0;i<20;i++)s.accept('reader-write-'+i,chat.id,'Write '+i);
  assert.equal(s.where<Turn>('turn','chatId',chat.id).length,20,'turns read by chat through the index');
  reader.exec('COMMIT');
 }finally{reader.close();s.db.close();rmSync(dir,{recursive:true,force:true});}
});
