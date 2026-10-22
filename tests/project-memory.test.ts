import test from 'node:test';
import assert from 'node:assert/strict';
import {projectMemory} from '../app/project-memory';
import {mcpExchange} from '../app/mcp-exchange';
import {SecretScrubber} from '../app/redaction';
import type {Mode} from '../app/types';

test('app memory enforces modes, origin, cancellation and one execution per request',async()=>{
 let mode:Mode='manual',allowed=true,approvals=0,writes=0;
 const backend:any={scrubber:new SecretScrubber(),host:async(_op:string,args:any)=>{assert.equal(args.profile,'bound-profile');if(args.name==='prepare_project_memory')return {success:true,payload:args.arguments};writes++;return {success:true};}};
 const memory=projectMemory(backend,'bound-profile',()=>mode,async()=>{approvals++;return allowed;});
 const signal=new AbortController().signal;
 await memory.call('read_project_memory',{},signal);assert.equal(approvals,0);
 for(const next of ['manual','accept-edits','auto'] as Mode[]){mode=next;await memory.call('update_project_memory',{action:'add',content:'fact'},signal);}
 assert.equal(approvals,3);mode='bypass';await memory.call('update_project_memory',{action:'add',content:'fact'},signal);assert.equal(approvals,3);
 mode='plan';await assert.rejects(memory.call('update_project_memory',{},signal),/Plan mode/);await memory.call('read_project_memory',{},signal);
 mode='manual';allowed=false;const before=writes;await assert.rejects(memory.call('update_project_memory',{},signal),/denied/);assert.equal(writes,before);
 await assert.rejects(memory.call('read_project_memory',{profile:'other'},signal),/profile or path/);
 allowed=true;const exchange=mcpExchange({} as any,[],memory),message={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'update_project_memory',arguments:{action:'add',content:'once'}}};
 const count=writes;const [a,b]=await Promise.all([exchange.handle('ghidorah',message,signal),exchange.handle('ghidorah',message,signal)]);assert.deepEqual(a,b);assert.equal(writes,count+1);
 await exchange.handle('ghidorah',message,signal);assert.equal(writes,count+1);
 const altered:any=await exchange.handle('ghidorah',{...message,params:{...message.params,arguments:{action:'remove'}}},signal);assert.match(altered.error.message,/cannot be changed/);
 const cancel=new AbortController(),delayed=projectMemory(backend,'bound-profile',()=>mode,async()=>{cancel.abort();return true;});
 await assert.rejects(delayed.call('update_project_memory',{},cancel.signal),/abort/i);assert.equal(writes,count+1);
 const changed=projectMemory(backend,'bound-profile',()=>mode,async()=>{mode='plan';return true;});await assert.rejects(changed.call('update_project_memory',{},signal),/Plan mode/);assert.equal(writes,count+1);
});

test('memory refusal is trusted only before dispatch, never after an uncertain write',async()=>{
 const refused:any[]=[],args={action:'add',content:'fact'},signal=new AbortController().signal;
 let allowed=false,fail=false;
 const backend:any={scrubber:new SecretScrubber(),host:async(_op:string,input:any)=>{if(input.name==='prepare_project_memory')return {success:true,payload:input.arguments};if(fail)throw Error('Connection lost after dispatch');return {success:true};}};
 const memory=projectMemory(backend,'owned',()=> 'manual',async()=>allowed,(name,args)=>refused.push({name,args}));
 await assert.rejects(memory.call('update_project_memory',args,signal),/denied/);assert.deepEqual(refused,[{name:'update_project_memory',args}]);
 allowed=true;fail=true;await assert.rejects(memory.call('update_project_memory',args,signal),/after dispatch/);assert.equal(refused.length,1);
});

test('project memory is read again only when its files change (TURN-REVIEW part 4)',async()=>{
  const {MemoryCache}=await import('../app/project-memory');
  const fsp=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
  const home=await fsp.mkdtemp(path.join(os.tmpdir(),'tris-memory-')),file=path.join(home,'memories','MEMORY.md');
  await fsp.mkdir(path.dirname(file));await fsp.writeFile(file,'one');await fsp.writeFile(path.join(home,'config.yaml'),'memory: {}');
  let reads=0;const cache=new MemoryCache(()=>home,async()=>({memory:'read '+(++reads)}));
  assert.deepEqual(await cache.get('p'),{memory:'read 1'});assert.deepEqual(await cache.get('p'),{memory:'read 1'});assert.equal(reads,1,'no helper for unchanged files');
  await fsp.writeFile(file,'one two');assert.deepEqual(await cache.get('p'),{memory:'read 2'});
  await fsp.writeFile(path.join(home,'memories','USER.md'),'new file');await cache.get('p');assert.equal(reads,3);
  await fsp.rm(home,{recursive:true,force:true});
});
