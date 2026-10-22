import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../app/store';
import {createParallel} from '../app/parallel';
import {enqueueRemote,claimRemoteOutbox,recordRemoteReceipt,recoverRemoteOutbox,enqueueRemoteReply} from '../app/remote-outbox';
import type {Chat,Turn} from '../app/types';
import {enqueueRemoteInbound,finishRemoteInbound,recoverRemoteInbox,type InRecord} from '../app/remote-inbox';

test('remote and scheduled input preserve the desktop composer and parallel origin',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id);
 const attachment={id:'unsent-attachment',chatId:chat.id,name:'private.txt',kind:'file' as const,size:1,sha256:'fixture',contentHash:'fixture'};
 const edits={draft:'Unsent desktop draft',attachments:[attachment],selected:true,selectedModels:['deepseek-flash']};
 store.update<Chat>('chat',chat.id,edits);
 try{
  const remote={chatId:'4242',messageId:'7'};
  const parent=store.accept('remote-parent',chat.id,'Remote input','deepseek-flash',{remote});
  assert.deepEqual(parent.attachments,[]);assert.deepEqual(parent.remote,remote);
  const routine=store.accept('routine-input',chat.id,'Scheduled input','deepseek-flash',{routine:{id:'routine-1',firing:1}});
  assert.deepEqual(routine.attachments,[]);
  const saved=store.get<Chat>('chat',chat.id);for(const [key,value] of Object.entries(edits))assert.deepEqual((saved as any)[key],value);
  const jobs=createParallel(store,parent,['deepseek-flash','gpt-test']);
  assert.ok(jobs.every(job=>JSON.stringify(job.remote)===JSON.stringify(remote)));
 }finally{store.db.close();}
});

test('outbox receipts bind message identity and uncertain delivery is never replayed after restart',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tris-outbox-')),file=path.join(dir,'state.sqlite');let store=new Store(file);
 try{
  const first=enqueueRemote(store,'4242','Approval A','approval-a',true),second=enqueueRemote(store,'4242','Reply B');
  assert.deepEqual(claimRemoteOutbox(store,0,'999'),[]);
  assert.equal(claimRemoteOutbox(store,0,'4242')[0].seq,first.seq);
  assert.equal(recordRemoteReceipt(store,first.seq,true,'123').messageId,'123');
  assert.equal(recordRemoteReceipt(store,first.seq,false).status,'sent','a repeated receipt cannot downgrade success');
  assert.equal(claimRemoteOutbox(store,first.seq,'4242')[0].seq,second.seq);
  store.db.close();store=new Store(file);
  assert.equal(recoverRemoteOutbox(store)[0].status,'uncertain');
  assert.deepEqual(claimRemoteOutbox(store,0,'4242'),[],'neither sent nor uncertain deliveries are sent again');
 }finally{store.db.close();fs.rmSync(file);for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);}
});

test('completed turn and queued reply commit together',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id);
 const turn=store.accept('remote-result',chat.id,'Task','deepseek-flash',{remote:{chatId:'4242',messageId:'5'}});
 const put=store.put.bind(store);store.put=(kind,value)=>{if(kind==='remote-out')throw Error('fixture storage failure');return put(kind,value);};
 try{
  assert.throws(()=>enqueueRemoteReply(store,turn.id,'Answer'),/storage failure/);
  assert.equal(store.get<Turn>('turn',turn.id).remote?.replied,undefined);
  store.put=put;
  assert.equal(enqueueRemoteReply(store,turn.id,'Answer')?.chat_id,'4242');
  assert.equal(store.get<Turn>('turn',turn.id).remote?.replied,true);
  assert.equal(enqueueRemoteReply(store,turn.id,'Answer'),undefined);
  assert.equal(store.all('remote-out').length,1);
 }finally{store.db.close();}
});

test('inbox persists before dispatch, retains duplicates, and never stores authentication codes',()=>{
 const store=new Store(':memory:');
 try{
  const message={message_id:'7',chat_id:'4242',user_id:'4242',text:'A task'};
  const id=enqueueRemoteInbound(store,message);
  assert.equal(store.get<InRecord>('remote-in',id).status,'pending');
  assert.equal(enqueueRemoteInbound(store,message),id);assert.equal(store.all('remote-in').length,1);
  store.update<InRecord>('remote-in',id,{status:'processing'});
  assert.equal(recoverRemoteInbox(store)[0].status,'uncertain');
  assert.equal(store.get<InRecord>('remote-in',id).message,undefined);
  for(const text of ['123456','/approve 123456'])assert.throws(()=>enqueueRemoteInbound(store,{...message,message_id:'8',text}),/must not be persisted/);
  finishRemoteInbound(store,id);assert.deepEqual(store.get<InRecord>('remote-in',id),{id,status:'done'});
 }finally{store.db.close();}
});
