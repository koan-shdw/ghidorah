import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import {Sidebar} from '../app/sidebar';
import {SecretScrubber} from '../app/redaction';
import {researchTool} from '../app/web-research';
import type {Turn} from '../app/types';

test('web pages persist with provenance, paginate exactly and survive forks without granting other-chat access',async()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),turn=store.accept('turn',chat.id,'Read a source'),controller=new AbortController(),text='Public source text. '.repeat(2500);let calls=0;
 const backend={scrubber:new SecretScrubber(),host:async()=>{calls++;return {url:'https://example.com/docs',title:'Documentation',text,truncated:false};}};
 const read=(t:Turn,args:any)=>researchTool(store,backend,t,'read_web_page',args,controller.signal);
 const first=await read(turn,{url:'https://example.com/docs'});assert.equal(first.text,text.slice(0,12000));assert.ok(first.retrievedAt);assert.equal(first.totalCharacters,text.length);assert.equal(first.nextOffset,12000);assert.match(first.notice,/untrusted/);
 let output=first.text,offset=first.nextOffset;while(offset!==null){const part=await read(turn,{sourceId:first.sourceId,offset});output+=part.text;offset=part.nextOffset;}
 assert.equal(output,text);assert.equal(calls,1);
 const other=store.chat(chat.projectId),foreign=store.accept('foreign',other.id,'Read');await assert.rejects(read(foreign,{sourceId:first.sourceId}),/another chat/);
 store.update<Turn>('turn',turn.id,{status:'completed'});const side=new Sidebar(store),fork=side.fork(chat.id),next=store.accept('fork-turn',fork,'Continue');side.delete(chat.id);
 const copied=await read(next,{sourceId:first.sourceId});assert.notEqual(copied.sourceId,first.sourceId);assert.equal(copied.text,first.text);assert.equal(calls,1);store.db.close();
});

test('web request validation and cancellation prevent transmissions and saved results',async()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),turn=store.accept('turn',chat.id,'Research'),controller=new AbortController();let calls=0;
 const backend={scrubber:new SecretScrubber(),host:async()=>{calls++;controller.abort();return {url:'https://example.com',text:'late response'};}};backend.scrubber.register('private-test-value');
 for(const [name,args] of [['search_web',{query:'private-test-value'}],['search_web',{query:'',limit:0}],['read_web_page',{url:'https://example.com',sourceId:'wrong'}],['read_web_page',{url:'https://example.com',offset:-1}],['read_web_page',{url:'https://example.com',length:30000}],['read_web_page',{sourceId:'wrong',chatId:'foreign'}]])await assert.rejects(researchTool(store,backend,turn,name as string,args,controller.signal));
 assert.equal(calls,0);await assert.rejects(researchTool(store,backend,turn,'read_web_page',{url:'https://example.com'},controller.signal));assert.equal(calls,1);assert.equal(store.all('web-source').length,0);store.db.close();
});
