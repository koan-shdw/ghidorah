import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import {contextSource,saveContext,shouldAutoCompact,type ContextDraft} from '../app/chat-context';
import {queryChatHistory,rlmContext} from '../app/rlm-history';
import type {Chat,Turn,ToolCall} from '../app/types';

function fixture(){const store=new Store(':memory:'),chat=store.chat(store.project().id);const turn=(prompt:string)=>{const t=store.accept(crypto.randomUUID(),chat.id,prompt);return store.update<Turn>('turn',t.id,{status:'completed',text:'Reply',reasoning:'PRIVATE_REASONING'});};return {store,chat,turn};}
const signal=()=>new AbortController().signal;
const answer=async(_system:string,prompt:string)=>{const p=JSON.parse(prompt),e=p.sources?{id:p.sources[0].id,quote:p.sources[0].text.slice(0,80)}:p.findings[0].evidence[0];return {text:JSON.stringify({answer:'The saved records say this.',evidence:[e]}),tokens:30};};

test('automatic compaction measures original history, keeps newest exchange and pending input, and retains all originals',()=>{
 const f=fixture(),first=f.turn('ANCHOR original request');f.store.put<ToolCall>('tool',{id:'big-result',turnId:first.id,name:'read_file',args:{path:'huge.log'},result:'large log '.repeat(50000),status:'completed'});const latest=f.turn('Latest correction must stay exact'),current=f.store.accept('current',f.chat.id,'Continue');f.store.accept('later',f.chat.id,'Future queued input');
 const before=f.store.all('turn'),options={beforeTurnId:current.id,concise:true,origin:'automatic' as const},source=contextSource(f.store,f.chat.id,options);
 assert.ok(shouldAutoCompact(f.store,current));assert.ok(source.originalCharacters>400000);assert.ok(source.sourceCharacters<4000);assert.equal(source.throughTurnId,first.id);assert.doesNotMatch(JSON.stringify(source.sources),/PRIVATE_REASONING|Latest correction|Future queued/);
 f.store.put<ContextDraft>('context-draft',{...source,...options,id:f.chat.id,summary:'ANCHOR: original request. No files changed.',model:current.model,created:Date.now(),tokens:42});const saved=saveContext(f.store,f.chat.id,source.revision,'ANCHOR: original request. No files changed.','Keep I: authoritative.');assert.equal(saved.origin,'automatic');assert.deepEqual(f.store.all('turn'),before);assert.equal(f.store.get<Turn>('turn',latest.id).prompt,'Latest correction must stay exact');assert.ok(!shouldAutoCompact(f.store,current));assert.equal(f.store.get<ToolCall>('tool','big-result').result.length,500000);f.store.db.close();
});

test('Tris summarises only for a fresh session, and honors off, attempt markers and failure cooldown (Koan, 2026-10-08)',()=>{
 const f=fixture();f.turn('Earlier '+'old work '.repeat(25000));f.turn('Newest');const current=f.store.accept('current',f.chat.id,'Continue');
 assert.equal(shouldAutoCompact(f.store,current,false),false,'a live session is shrunk by its own engine');
 assert.ok(shouldAutoCompact(f.store,current,true),'a fresh session gets a summary of large earlier history');
 f.store.update<Chat>('chat',f.chat.id,{autoCompact:false});assert.ok(!shouldAutoCompact(f.store,current,true));
 f.store.update<Chat>('chat',f.chat.id,{autoCompact:true,contextRetryAfter:Date.now()+300000});assert.ok(!shouldAutoCompact(f.store,current,true));
 f.store.update<Chat>('chat',f.chat.id,{contextRetryAfter:undefined,contextAttemptThrough:contextSource(f.store,f.chat.id,{beforeTurnId:current.id}).throughTurnId});assert.ok(!shouldAutoCompact(f.store,current,true));
 f.store.db.close();
});
test('measured context never triggers a Tris summary for a live session (Koan, 2026-10-08)',()=>{
 const f=fixture(),first=f.turn('Earlier');f.store.put<ToolCall>('tool',{id:'large',turnId:first.id,name:'read_file',args:{},result:'x'.repeat(500000),status:'completed'});
 const latest=f.turn('Newest'),current=f.store.accept('pending',f.chat.id,'Continue');
 f.store.update<Turn>('turn',latest.id,{usage:{context_max:256000,context_used:240000}});assert.equal(shouldAutoCompact(f.store,current,false),false);
 f.store.db.close();
});
test('RLM is default on, read-only, chat scoped, cited, bounded and off means no helper calls',async()=>{
 const f=fixture(),first=f.turn('ANCHOR approved decision');const current=f.turn('Question');f.turn('Future private decision');const foreign=f.store.chat(f.chat.projectId);f.store.accept('foreign',foreign.id,'Foreign private decision');const before=f.store.all('turn');let calls=0;
 const complete=async(system:string,prompt:string)=>{calls++;assert.doesNotMatch(prompt,/Future private|Foreign private|PRIVATE_REASONING/);return answer(system,prompt);};
 const result=await queryChatHistory(f.store,current,{question:'What was approved?',query:'ANCHOR'},signal(),complete);assert.equal(result.calls,1);assert.equal(result.evidence[0].id,first.id);assert.deepEqual(f.store.all('turn'),before);
 assert.match(rlmContext(f.store,f.chat),/assistance is on/);f.store.update<Chat>('chat',f.chat.id,{rlm:false});assert.match(rlmContext(f.store,f.store.get<Chat>('chat',f.chat.id)),/assistance is off/);await assert.rejects(queryChatHistory(f.store,current,{question:'What?'},signal(),complete),/off/);assert.equal(calls,1);f.store.update<Chat>('chat',f.chat.id,{rlm:true});
 for(let i=0;i<3;i++)await queryChatHistory(f.store,current,{question:'What?',query:'ANCHOR'},signal(),complete);await assert.rejects(queryChatHistory(f.store,current,{question:'What?'},signal(),complete),/four RLM/);assert.equal(calls,4);f.store.db.close();
});

test('RLM uses one bounded call and falls back to original excerpts when citations fail',async()=>{
 const f=fixture();for(let i=0;i<12;i++)f.turn('ANCHOR '+i+' '+('details '.repeat(900)));const current=f.turn('Question');const before=f.store.all('turn');
 const result=await queryChatHistory(f.store,current,{question:'Summarize decisions',query:'ANCHOR'},signal(),async(system,prompt)=>{assert.ok(prompt.length<45000);return answer(system,prompt);});assert.equal(result.calls,1);assert.equal(result.depth,0);assert.equal(result.truncated,true);assert.deepEqual(f.store.all('turn'),before);
 const next=f.turn('Another question');const fallback=await queryChatHistory(f.store,next,{question:'What?',query:'ANCHOR 0 '},signal(),async()=>({text:JSON.stringify({answer:'Incorrect',evidence:[{id:'invented',quote:'not in source'}]}),tokens:9}));assert.deepEqual(fallback.evidence,[]);assert.doesNotMatch(fallback.answer,/Incorrect/);assert.match(JSON.stringify(fallback),/ANCHOR 0 /);assert.match(JSON.stringify(fallback),/unsupported citation/);
 for(const complete of [async()=>({text:'not JSON',tokens:9}),async()=>{throw Error('Provider timeout');}]){const fallback=await queryChatHistory(f.store,next,{question:'What?',query:'ANCHOR 0 '},signal(),complete);assert.deepEqual(fallback.evidence,[]);assert.match(JSON.stringify(fallback),/ANCHOR 0 /);assert.equal(fallback.calls,1);}
 const interrupted=new AbortController();await assert.rejects(queryChatHistory(f.store,next,{question:'What?',query:'ANCHOR 0 '},interrupted.signal,async()=>{interrupted.abort();throw Error('Cancelled helper');}),/abort/i);
 const controller=new AbortController();controller.abort();await assert.rejects(queryChatHistory(f.store,next,{question:'What?'},controller.signal,answer),/abort/i);f.store.db.close();
});

test('RLM can find a message by its ID, including its status and request',async()=>{
 const f=fixture(),target=f.turn('The original request'),current=f.turn('Investigate this turn');
 const result=await queryChatHistory(f.store,current,{question:'What happened?',query:target.id},signal(),async(system,prompt)=>{assert.match(prompt,/The original request/);assert.match(prompt,/completed/);return answer(system,prompt);});
 assert.equal(result.calls,1);assert.deepEqual(result.sourceIds,[target.id]);f.store.db.close();
});

test('the first summary of a huge chat is capped to recent history so it always finishes (Koan, 2026-10-08)',async()=>{
 const {SUMMARY_SOURCE_CAP}=await import('../app/chat-context');
 const f=fixture();for(let i=0;i<60;i++)f.turn('Step '+i+' '+'detail '.repeat(5000));f.turn('Newest');
 const s=contextSource(f.store,f.chat.id,{concise:true});
 assert.ok(s.sourceCharacters<=SUMMARY_SOURCE_CAP+8000,String(s.sourceCharacters));assert.ok(s.batches.length<=5,String(s.batches.length));
 assert.ok(s.sources.some(row=>row.text.includes('Step 58')),'the newest history is covered');assert.ok(!s.sources.some(row=>row.text.includes('Step 0 ')),'the oldest is left to lookups');
 f.store.db.close();
});
test('automatic compaction summarises with a fast model so long Opus chats finish (speed plan)',async()=>{
 const {summaryModel}=await import('../app/chat-context');
 const ready=['claude-code:opus','deepseek-flash','gpt-6-astra'];
 assert.equal(summaryModel(true,'claude-code:opus',['claude-code:opus'],ready,'deepseek-flash'),'deepseek-flash','Jev summary model first');
 assert.equal(summaryModel(true,'claude-code:opus',[],['claude-code:opus','claude-code:haiku'],'deepseek-flash'),'claude-code:haiku','else any Haiku/Flash that is connected');
 assert.equal(summaryModel(true,'claude-code:opus',[],['claude-code:opus'],'deepseek-flash'),'claude-code:opus','no fast model: the chat model');
 assert.equal(summaryModel(false,'claude-code:opus',[],ready,'deepseek-flash'),'claude-code:opus','/compact keeps the chat model');
});
