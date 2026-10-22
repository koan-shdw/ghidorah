import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import type {Turn,Chat} from '../app/types';
import {Sidebar} from '../app/sidebar';
import {WorkNotifications,type WorkNotice} from '../app/work-notifications';
import {readAlwaysOn} from '../app/always-on';

test('question sound is once per new request, even when focused, with no replay after mute or restart',()=>{
 const store=new Store(':memory:');try{
  const chat=store.chat(store.project().id);store.accept('turn',chat.id,'question');
  let notices=new WorkNotifications(store),sounds=0;const shown:WorkNotice[]=[];
  const scan=(sound=true)=>notices.scan(false,()=>true,notice=>shown.push(notice),()=>{if(sound)sounds++;});
  const ask=(id:string)=>store.put('approval',{id,turnId:'turn',chatId:chat.id,method:'clarify',status:'pending'});
  ask('one');scan();scan();assert.equal(sounds,1);assert.equal(shown.length,0);
  notices=new WorkNotifications(store);scan();assert.equal(sounds,1);
  ask('muted');scan(false);scan();assert.equal(sounds,1);
  ask('two');ask('three');scan();assert.equal(sounds,2);
  assert.equal(readAlwaysOn(undefined).questionSound,true);assert.equal(readAlwaysOn({questionSound:false}).questionSound,false);
 }finally{store.db.close();}
});

test('work alerts cover results, approvals, questions and inspection without replay or child completion spam',()=>{
 const store=new Store(':memory:');try{
  const chat=store.chat(store.project().id);store.accept('old',chat.id,'private prompt');store.update<Turn>('turn','old',{status:'completed'});
  let notifications=new WorkNotifications(store);const shown:WorkNotice[]=[];let visible=false,enabled=true;
  const scan=()=>notifications.scan(enabled,()=>visible,notice=>shown.push(notice));scan();assert.equal(shown.length,0);
  store.accept('new',chat.id,'a secret prompt');store.update<Turn>('turn','new',{status:'completed'});scan();scan();assert.equal(shown.length,1);assert.equal(shown[0].label,'Reply ready');assert.ok(!JSON.stringify(shown).includes('secret'));
  notifications=new WorkNotifications(store);scan();assert.equal(shown.length,1);
  const child=store.chat(chat.projectId);store.update<Chat>('chat',child.id,{parentChatId:chat.id});store.accept('job',child.id,'job');store.update<Turn>('turn','job',{parentTurnId:'new',status:'completed'});scan();assert.equal(shown.length,1);
  store.put('approval',{id:'approve',turnId:'job',chatId:child.id,method:'approval',params:{command:'secret'},status:'pending'});scan();assert.equal(shown.at(-1)?.chatId,chat.id);assert.equal(shown.at(-1)?.turnId,'new');assert.equal(shown.at(-1)?.label,'Your approval is needed');
  notifications=new WorkNotifications(store);scan();assert.equal(shown.length,2);
  store.put('approval',{id:'ask',turnId:'job',chatId:child.id,method:'clarify',params:{question:'secret'},status:'pending'});scan();assert.equal(shown.at(-1)?.label,'Your answer is needed');
  store.put('work-action',{id:'effect',job:'job',status:'uncertain',access:'write'});scan();assert.notEqual(shown.at(-1)?.label,'Inspect interrupted work'); // never shown (Koan 2026-10-06)
  visible=true;store.accept('focused',chat.id,'focused');store.update<Turn>('turn','focused',{status:'completed'});scan();visible=false;scan();assert.equal(shown.length,3);
  enabled=false;store.accept('muted',chat.id,'muted');store.update<Turn>('turn','muted',{status:'failed'});scan();enabled=true;scan();assert.equal(shown.length,3);
  for(const status of ['failed','partial','interrupted','needs-model']){store.accept(status,chat.id,status);store.update<Turn>('turn',status,{status});scan();assert.equal(shown.at(-1)?.turnId,status);}
  store.accept('stopped',chat.id,'stop');store.update<Turn>('turn','stopped',{status:'stopped'});scan();assert.equal(shown.length,7);
  assert.equal(readAlwaysOn({desktopNotifications:false}).desktopNotifications,false);
 }finally{store.db.close();}
});

test('forked history does not alert; newly completed work in the fork does',()=>{
 const store=new Store(':memory:');try{
  const chat=store.chat(store.project().id),sidebar=new Sidebar(store);sidebar.initialize();
  store.accept('source',chat.id,'finished earlier');store.update<Turn>('turn','source',{status:'completed'});
  const notifications=new WorkNotifications(store),shown:WorkNotice[]=[];
  const fork=sidebar.fork(chat.id);notifications.scan(true,()=>false,notice=>shown.push(notice));assert.equal(shown.length,0);
  store.accept('fresh',fork,'new work');store.update<Turn>('turn','fresh',{status:'completed'});notifications.scan(true,()=>false,notice=>shown.push(notice));
  assert.equal(shown.length,1);assert.equal(shown[0].chatId,fork);assert.equal(shown[0].turnId,'fresh');
 }finally{store.db.close();}
});
