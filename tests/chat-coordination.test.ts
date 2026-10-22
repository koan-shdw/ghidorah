import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../app/store';import {chatToolCall} from '../app/chat-coordination';import {createParallel} from '../app/parallel';import {Sidebar} from '../app/sidebar';import type {Chat,Turn} from '../app/types';
function fixture(t:any){const store=new Store(':memory:');t.after(()=>store.db.close());const source=store.chat(store.project().id),other=store.chat(store.project().id),current=store.accept(crypto.randomUUID(),source.id,'Find earlier work'),past=store.accept(crypto.randomUUID(),other.id,'Decision: use SQLite');store.update<Turn>('turn',past.id,{text:'SQLite keeps the app offline.',status:'completed'});store.update<Chat>('chat',other.id,{title:'Earlier work',draft:'PRIVATE UNSENT DRAFT',attachments:[{id:'unsent'} as any]});const approvals:string[]=[],deliveries:string[]=[];let mode='bypass';const access={approve:async(text:string)=>{approvals.push(text);return true;},mode:()=>mode,submit:async(id:string,chatId:string,message:string,handoff:NonNullable<Turn['handoff']>)=>{deliveries.push(id);store.accept(id,chatId,message,'deepseek-flash',{handoff});}};return {store,source,other,current,past,approvals,deliveries,access,setMode:(value:string)=>{mode=value;},call:(name:string,args:any,signal=new AbortController().signal)=>chatToolCall(store,current,name,args,access,signal)};}

test('cross-chat content and sends require approval, with no model-supplied bypass',async t=>{
 const f=fixture(t);f.access.approve=async()=>false;
 for(const [name,args] of [['search_chats',{query:'SQLite'}],['read_other_chat',{chatId:f.other.id}],['send_chat_message',{chatId:f.other.id,message:'Build it'}]] as const)await assert.rejects(f.call(name,args),/denied/);
 assert.equal(f.store.all('chat-search').length,0);assert.equal(f.store.all('chat-read-grant').length,0);assert.equal(f.deliveries.length,0);
 await assert.rejects(f.call('read_other_chat',{chatId:f.other.id,approved:true}),/Invalid/);
 await assert.rejects(f.call('read_other_chat',{chatId:f.source.id}),/read_chat_history/);
});
test('search finds messages, parallel results and tool evidence, excludes drafts and freezes pagination',async t=>{
 const f=fixture(t),group=f.store.accept(crypto.randomUUID(),f.other.id,'Compare options');f.store.update<Turn>('turn',group.id,{collaboration:{strategy:'ownership',lead:'a'}});const [job]=createParallel(f.store,group,['a','b']);f.store.update<Turn>('turn',job.id,{text:'SQLite is the decision in parallel.',status:'completed'});
 f.store.put('tool',{id:'old-tool',turnId:f.past.id,name:'Read',args:{},result:'TOOL_FACT the schema is version 3',status:'completed'});
 const result:any=await f.call('search_chats',{query:'SQLite',limit:1});assert.ok(result.total>=2);assert.equal(result.chats[0].chatId,f.other.id);assert.match(result.chats[0].link,/tris-chat:/);
 f.store.accept(crypto.randomUUID(),f.other.id,'SQLite NEW LATER MATCH');const rest:any=await f.call('search_chats',{query:'SQLite',offset:1});assert.equal(rest.total,result.total);assert.equal(f.approvals.length,1);assert.ok(rest.chats.some((row:any)=>row.turnId===job.id));
 const tools:any=await f.call('search_chats',{query:'TOOL_FACT'});assert.match(tools.chats[0].excerpt,/schema is version 3/);
 assert.equal((await f.call('search_chats',{query:'PRIVATE UNSENT DRAFT'}) as any).total,0);
 for(const turn of f.store.all<Turn>('turn'))if(turn.id!==f.current.id)f.store.update<Turn>('turn',turn.id,{status:'completed'});
 const fork=new Sidebar(f.store).fork(f.other.id);const forkResult:any=await f.call('search_chats',{query:'offline'});assert.ok(forkResult.chats.some((row:any)=>row.chatId===fork));
});
test('a read grant belongs to this reply and stops before messages added after the request',async t=>{
 const f=fixture(t);const first:any=await f.call('read_other_chat',{chatId:f.other.id});assert.equal(first.messages[0].id,f.past.id);assert.equal(first.scope.throughTurnId,f.past.id);assert.match(first.scope.note,/added later are excluded/);assert.equal(f.approvals.length,1);
 const later=f.store.accept(crypto.randomUUID(),f.other.id,'LATER PRIVATE MESSAGE');await assert.rejects(f.call('read_other_chat',{chatId:f.other.id,turnId:later.id}),/not available/);
 const full:any=await f.call('read_other_chat',{chatId:f.other.id,turnId:f.past.id});assert.match(full.text,/SQLite/);assert.doesNotMatch(full.text,/PRIVATE UNSENT/);assert.equal(f.approvals.length,1);
 const next=f.store.accept(crypto.randomUUID(),f.source.id,'Another reply');f.access.approve=async()=>false;await assert.rejects(chatToolCall(f.store,next,'read_other_chat',{chatId:f.other.id},f.access,new AbortController().signal),/denied/);
});
test('handoffs preserve drafts, use stable delivery IDs and deduplicate sibling jobs and repeated calls',async t=>{
 const f=fixture(t);const first:any=await f.call('send_chat_message',{chatId:f.other.id,message:'Implement the saved decision.'});assert.equal(first.status,'queued');assert.equal(f.approvals.length,1);
 const target=f.store.get<Chat>('chat',f.other.id);assert.equal(target.draft,'PRIVATE UNSENT DRAFT');assert.equal(target.attachments?.[0].id,'unsent');assert.equal(f.store.get<Turn>('turn',first.turnId).attachments?.length,0);assert.equal(f.store.get<Turn>('turn',first.turnId).handoff?.sourceChatId,f.source.id);
 const child={...f.current,id:crypto.randomUUID(),parentTurnId:f.current.id};f.store.put('turn',child);f.setMode('plan');const duplicate:any=await chatToolCall(f.store,child,'send_chat_message',{chatId:f.other.id,message:'Implement the saved decision.'},f.access,new AbortController().signal);assert.equal(duplicate.turnId,first.turnId);assert.equal(f.deliveries.length,1);assert.equal(f.approvals.length,1);
 f.store.put('turn-removed',{id:first.turnId,chatId:f.other.id,cancelled:true});f.store.remove('turn',first.turnId);assert.equal((await f.call('send_chat_message',{chatId:f.other.id,message:'Implement the saved decision.'}) as any).status,'cancelled');assert.equal(f.deliveries.length,1);
});
test('Plan, cancellation and changed destinations cannot dispatch a pending handoff',async t=>{
 const f=fixture(t),args={chatId:f.other.id,message:'Run this task'};f.setMode('plan');await assert.rejects(f.call('send_chat_message',args),/Plan mode/);assert.equal(f.approvals.length,0);
 f.setMode('bypass');const abort=new AbortController();f.access.approve=async()=>{abort.abort();return true;};await assert.rejects(f.call('send_chat_message',args,abort.signal));assert.equal(f.deliveries.length,0);assert.equal(f.store.all('chat-handoff').length,0);
 f.access.approve=async()=>{f.setMode('plan');return true;};await assert.rejects(f.call('send_chat_message',args),/Plan mode/);assert.equal(f.deliveries.length,0);
 f.setMode('bypass');f.access.approve=async()=>{f.store.update<Chat>('chat',f.other.id,{archived:true});return true;};await assert.rejects(f.call('send_chat_message',args),/Restore/);assert.equal(f.deliveries.length,0);
});
