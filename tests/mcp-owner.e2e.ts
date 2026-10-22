import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Backend} from '../app/backend';
import {McpOwner} from '../app/mcp-owner';
import {oauthFixture} from './fixtures/mcp-oauth';
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','mcp-owner-'));
const backend=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});await backend.host('initialize');
const owner=new McpOwner(backend,()=>{});let id:string|undefined;
try{
 id=await owner.request('add',{name:'Node owner fixture',config:{command:backend.python,args:[path.join(root,'tests','fixtures','mcp_stdio.py')],env:{SERVICE_KEY:'synthetic-owner-node-key'}}});
 assert.deepEqual((await owner.request('tools',{id})).map((tool:any)=>tool.name),['echo','slow','child']);
 const call=(marker:string)=>owner.request('call',{id,name:'echo',arguments:{marker}});
 const results=await Promise.all([call('chat-a'),call('chat-b')]);
 assert.match(results[0].content[0].text,/chat-a/);assert.doesNotMatch(results[0].content[0].text,/chat-b|synthetic-owner-node-key/);
 assert.match(results[1].content[0].text,/chat-b/);assert.doesNotMatch(results[1].content[0].text,/chat-a|synthetic-owner-node-key/);
 const cancel=new AbortController();const pending=owner.request('call',{id,name:'slow'},cancel.signal);setTimeout(()=>cancel.abort(),300);await assert.rejects(pending,/Cancelled/);
 assert.match((await call('after-stop')).content[0].text,/after-stop/);
 await owner.stop();assert.equal((await owner.request('list'))[0].id,id);assert.match((await call('after-restart')).content[0].text,/after-restart/);
 await owner.request('off',{id});await assert.rejects(call('disabled'),/off/);await owner.request('on',{id});assert.match((await call('enabled')).content[0].text,/enabled/);
 await owner.request('remove',{id});id=undefined;assert.deepEqual(await owner.request('list'),[]);
 const fixture=await oauthFixture();
 try{
  id=await owner.request('add',{name:'OAuth loopback',config:{url:fixture.origin+'/mcp',auth:'oauth',oauth:{cimd:false}}});
  let callback='';
  await owner.login(id!,async url=>{
   callback=(await (await fetch(url)).json()).callback;
   const wrong=new URL(callback);wrong.pathname='/other';assert.equal((await fetch(wrong)).status,404);
   wrong.pathname=new URL(callback).pathname;wrong.searchParams.set('state','wrong');assert.equal((await fetch(wrong)).status,400);
   const response=await fetch(callback);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  });
  assert.equal(fixture.observed.exchanges,1);
  assert.doesNotMatch(JSON.stringify(await owner.request('call',{id,name:'echo',arguments:{marker:'node-oauth'}})),/synthetic-node-mcp-access/);
  await assert.rejects(fetch(callback),'callback listener closes after sign-in');
  await owner.stop();await owner.login(id!,async()=>{throw Error('Cached login should not open browser');});assert.equal(fixture.observed.exchanges,1);
  await owner.request('revoke',{id});await owner.request('on',{id});
  const before=fixture.observed.headers.length;await assert.rejects(owner.request('tools',{id}));assert.ok(fixture.observed.headers.slice(before).every(value=>value===undefined));
  let opened!:()=>void;const ready=new Promise<void>(resolve=>opened=resolve),cancel=new AbortController();
  const pending=owner.login(id!,async url=>{callback=(await (await fetch(url)).json()).callback;opened();},cancel.signal);const refused=assert.rejects(pending,/Cancelled/);
  await ready;cancel.abort();await refused;await assert.rejects(fetch(callback));assert.equal(fixture.observed.exchanges,1);
  await owner.request('remove',{id});id=undefined;
  console.log('PASS Node OAuth loopback: PKCE, wrong state/path refusal, encrypted cached sign-in, cancellation, revocation and closed callback listeners');
 }finally{await fixture.close();}
 console.log('PASS Node private-pipe MCP owner: concurrent call routing, scoped credentials, cancellation without replay, restart and off/remove');
}finally{if(id)await owner.request('remove',{id}).catch(()=>{});await owner.stop();}
