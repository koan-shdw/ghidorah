import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import {contextSource,saveContext,readChatHistory,type ContextDraft} from '../app/chat-context';
import {handover} from '../app/history';
import {Sidebar} from '../app/sidebar';
import {createParallel} from '../app/parallel';
import type {Chat,Turn,ToolCall} from '../app/types';

function fixture(){const store=new Store(':memory:'),chat=store.chat(store.project().id);function turn(prompt:string,model='deepseek-flash'){const t=store.accept(crypto.randomUUID(),chat.id,prompt,model);return store.update<Turn>('turn',t.id,{status:'completed',text:'Response '+prompt});}return {store,chat,turn};}
function draft(f:ReturnType<typeof fixture>){const source=contextSource(f.store,f.chat.id);f.store.put<ContextDraft>('context-draft',{...source,id:f.chat.id,summary:'Retain ANCHOR_COPPER and complete the remaining work.',instructions:'',model:'deepseek-flash',created:1,tokens:100});return source;}

test('summary sources preserve complete records, parallel results and corrected goals while keeping the latest exchange verbatim',()=>{
 const f=fixture(),first=f.turn('ANCHOR_COPPER '+('long source '.repeat(4000))),second=f.turn('second','claude-code:haiku');
 const jobs=createParallel(f.store,second,['deepseek-flash','claude-code:haiku']);for(const j of jobs)f.store.update<Turn>('turn',j.id,{status:'completed',text:'Child ANCHOR_CHILD'});f.store.update<Turn>('turn',second.id,{status:'completed'});
 const last=f.turn('Newest instruction must stay exact');f.store.put('goal',{id:f.chat.id,objective:'Build KOAN’s approved app; retain the exact spelling.'});
 const s=contextSource(f.store,f.chat.id);assert.equal(s.throughTurnId,second.id);assert.ok(s.batches.length>1);assert.equal(s.batches.flat().length,s.sources.length);assert.ok(s.sources.some(row=>row.id.startsWith(jobs[0].id)));assert.equal(s.sources.some(row=>row.id.startsWith(last.id)),false);
 const joined=s.sources.filter(row=>row.id.startsWith(first.id)).map(row=>row.text).join('');assert.equal(JSON.parse(joined).request,first.prompt);assert.equal(s.goal,'Build KOAN’s approved app; retain the exact spelling.');f.store.db.close();
});

test('reviewed compaction crosses engines, preserves instructions and outcomes, and keeps original attachment/history records',()=>{
 const f=fixture(),first=f.turn('ANCHOR_COPPER original details'),middle=f.turn('Changes'),latest=f.turn('New exact request','claude-code:haiku');
 f.store.update<Turn>('turn',first.id,{attachments:[{id:'image',chatId:f.chat.id,name:'reference.png',kind:'image',size:1,sha256:'sha',contentHash:'hash'}]});
 f.store.put<ToolCall>('tool',{id:'write-id',turnId:middle.id,name:'Write',args:{path:'app.ts',content:'x'.repeat(5000)},result:'File written',status:'completed'});
 const s=draft(f),original=f.store.all<Turn>('turn'),pins='Preserve\n  the approved wording exactly.';const saved=saveContext(f.store,f.chat.id,s.revision,'ANCHOR_COPPER is required. app.ts was already written.',pins);
 const current=f.turn('Continue'),transfer=handover(f.store.all('turn'),f.store.all('tool'),current,undefined,saved,pins);
 assert.match(transfer.prompt,/ANCHOR_COPPER is required/);assert.match(transfer.prompt,/write-id/);assert.match(transfer.prompt,/"status":"completed"/);assert.match(transfer.prompt,/New exact request/);assert.doesNotMatch(transfer.prompt,/ANCHOR_COPPER original details/);assert.match(transfer.prompt,/read_chat_history/);assert.equal(transfer.attachments[0].id,'image');assert.ok(transfer.prompt.includes(pins));assert.deepEqual(f.store.all<Turn>('turn').slice(0,3),original);
 const result=readChatHistory(f.store,current,{toolId:'write-id'});assert.equal(JSON.parse(result.text!).args.content.length,5000);
 const resumed=handover(f.store.all('turn'),f.store.all('tool'),current,{id:'e',chatId:f.chat.id,engine:'claude',sessionId:'runtime',throughTurnId:latest.id,uncertain:false,exchanges:1},saved,pins);assert.equal(resumed.sessionId,'runtime');assert.doesNotMatch(resumed.prompt,/<reviewed_summary>/);assert.ok(resumed.prompt.includes(pins));
 const full=handover(f.store.all('turn'),f.store.all('tool'),current,undefined,undefined,pins);assert.match(full.prompt,/ANCHOR_COPPER original details/);assert.ok(full.prompt.includes(pins));f.store.db.close();
});

test('stale, active, foreign and invalid compaction cannot replace active context',()=>{
 const f=fixture();f.turn('first');f.turn('last');const s=draft(f);f.turn('newer');assert.throws(()=>saveContext(f.store,f.chat.id,s.revision,'summary',''),/changed/);assert.equal(f.store.get<Chat>('chat',f.chat.id).context,undefined);
 const next=draft(f);assert.throws(()=>saveContext(f.store,f.chat.id,next.revision,'',''),/summary/);
 f.store.accept('pending',f.chat.id,'Work in progress');assert.throws(()=>contextSource(f.store,f.chat.id),/current work/);f.store.db.close();
});

test('history retrieval pages complete results, refuses other chats and excludes future messages',()=>{
 const f=fixture(),first=f.turn('Earlier decision'),current=f.turn('Current request');f.store.put<ToolCall>('tool',{id:'large-tool',turnId:first.id,name:'Read',args:{},result:'qrs'.repeat(25000),status:'completed'});
 const other=f.store.chat(f.chat.projectId),foreign=f.store.accept('foreign',other.id,'Private');f.store.put<ToolCall>('tool',{id:'foreign-tool',turnId:foreign.id,name:'Write',args:{},result:'Private',status:'completed'});f.turn('Future queued request');
 // q, r and s are not hex digits, so no random record id can match the search (the 1-in-6 flake, TRIS-TODO 1.9).
 const matches=readChatHistory(f.store,current,{query:'qrs'});assert.equal(matches.total,1);let offset=0,result='';do{const part=readChatHistory(f.store,current,{toolId:'large-tool',offset});result+=part.text;offset=part.nextOffset!;}while(offset!==null);assert.equal(JSON.parse(result).result,'qrs'.repeat(25000));
 assert.throws(()=>readChatHistory(f.store,current,{turnId:'foreign'}),/not available/);assert.throws(()=>readChatHistory(f.store,current,{toolId:'foreign-tool'}),/not available/);assert.equal(readChatHistory(f.store,current,{query:'Future'}).total,0);assert.throws(()=>readChatHistory(f.store,current,{offset:-1}),/Invalid/);f.store.db.close();
});

test('forks retain compact context with remapped history access; earlier retries discard future summaries',()=>{
 const f=fixture(),first=f.turn('first'),second=f.turn('second'),last=f.turn('last');f.store.put<ToolCall>('tool',{id:'tool-original',turnId:first.id,name:'Write',args:{path:'one'},result:'written',status:'completed'});
 const s=draft(f);saveContext(f.store,f.chat.id,s.revision,'The source is '+first.id+' and tool-original.','Keep exact.');const side=new Sidebar(f.store),fork=side.fork(f.chat.id),chat=f.store.get<Chat>('chat',fork);
 assert.ok(chat.context);assert.notEqual(chat.context!.throughTurnId,second.id);const next=f.store.accept('next',fork,'Continue');assert.notEqual(readChatHistory(f.store,next,{turnId:first.id}).id,first.id);assert.notEqual(readChatHistory(f.store,next,{toolId:'tool-original'}).id,'tool-original');
 const earlier=side.fork(f.chat.id,{beforeTurnId:first.id});assert.equal(f.store.get<Chat>('chat',earlier).context,undefined);const later=side.fork(f.chat.id,{beforeTurnId:last.id});assert.ok(f.store.get<Chat>('chat',later).context);f.store.db.close();
});

test('parallel jobs receive the reviewed parent context and can retrieve parent source results',()=>{
 const f=fixture(),first=f.turn('Old source'),last=f.turn('Latest');const s=draft(f);saveContext(f.store,f.chat.id,s.revision,'Reviewed compact context','Exact instruction');const current=f.store.accept('parallel-current',f.chat.id,'Build');const jobs=createParallel(f.store,current,['deepseek-flash','claude-code:haiku']);
 for(const job of jobs){assert.match(job.commandContext!,/Reviewed compact context/);assert.match(job.commandContext!,/Exact instruction/);assert.equal(readChatHistory(f.store,job,{turnId:first.id}).id,first.id);}f.store.db.close();
});

test('a summary run continues after the batches a partial draft covered; a partial draft is never applied (batch 5, 7a)',async()=>{
 const {resumeDraft}=await import('../app/chat-context');
 const draft:any={partial:true,revision:'r1',done:2,summary:'two batches'};
 assert.deepEqual(resumeDraft(draft,'r1',5),{start:2,summary:'two batches'});
 assert.equal(resumeDraft(draft,'r2',5),null,'the history changed');assert.equal(resumeDraft({...draft,partial:false},'r1',5),null);assert.equal(resumeDraft(draft,'r1',2),null,'already complete');assert.equal(resumeDraft(undefined,'r1',5),null);
});
