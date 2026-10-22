import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {Store} from '../app/store';import {imageToolCall,imageSettings} from '../app/images';import {chatFiles} from '../app/chat-files';import {WorkCoordination} from '../app/work-coordination';import type {Backend} from '../app/backend';
test('image selection, versions, ownership, input validation and cancellation',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tris-images-')),data=path.join(root,'data'),folder=path.join(root,'work');await fs.mkdir(data);await fs.mkdir(folder);const store=new Store(path.join(data,'state.sqlite'));t.after(async()=>{store.db.close();await fs.rm(root,{recursive:true,force:true});});const project=store.project(folder),chat=store.chat(project.id),turn=store.accept(crypto.randomUUID(),chat.id,'Image','deepseek-flash'),signal=new AbortController().signal;
 const bytes=Buffer.from('fixture-image'),calls:any[]=[];let reply:any={image:bytes.toString('base64'),provider:'xai',model:'image'};
 const backend={dataRoot:data,host:async(op:string,args:any)=>{if(op==='image_info')return {providers:[{id:'xai',models:['image'],connected:true}]};calls.push(args);return reply;}} as unknown as Backend;let refused=0;
 const run=(args:any,s=signal)=>imageToolCall(store,backend,turn,folder,'generate_image',args,s,()=>refused++,()=>{});
 await assert.rejects(run({prompt:'Logo',destination:'logo.png'}),/Settings/);assert.equal(calls.length,0);
 await imageSettings(store,backend,{provider:'xai',model:'image'});await assert.rejects(imageSettings(store,backend,{provider:'xai',model:'invalid'}));
 const first=await run({prompt:'Logo',destination:'logo.png'});assert.deepEqual(await fs.readFile(first.file),bytes);const second=await run({prompt:'Blue',destination:'logo-v2.png',references:['output:'+first.id]});assert.equal(calls[1].sources[0],bytes.toString('base64'));assert.equal(chatFiles(store,chat.id).length,2);assert.notEqual(first.id,second.id);
 for(const destination of ['logo.png','../escaped.png',path.join(data,'private.png'),'wrong.jpg'])await assert.rejects(run({prompt:'Logo',destination}));assert.equal(calls.length,2);
 const other=store.chat(project.id),foreign=store.accept(crypto.randomUUID(),other.id,'Other','deepseek-flash');await assert.rejects(imageToolCall(store,backend,foreign,folder,'generate_image',{prompt:'Other',destination:'stolen.png',references:['output:'+first.id]},signal,()=>refused++,()=>{}),/not part/);
 const abort=new AbortController();abort.abort();await assert.rejects(run({prompt:'Logo',destination:'cancelled.png'},abort.signal));assert.equal(calls.length,2);
 const before=refused;reply={error:'Quota',outcome:'refused'};await assert.rejects(run({prompt:'Logo',destination:'retry.png'}),/Quota/);assert.equal(refused,before+1);reply={error:'Disconnected',outcome:'unknown'};await assert.rejects(run({prompt:'Logo',destination:'retry.png'}));assert.equal(refused,before+1);
 await imageSettings(store,backend,null);assert.equal((await imageSettings(store,backend)).selected,null);
});
test('image work reserves output, input and service, including unknown cancelled requests',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tris-image-work-')),store=new Store(path.join(root,'state.sqlite'));t.after(async()=>{store.db.close();await fs.rm(root,{recursive:true,force:true});});const work=new WorkCoordination(store,()=>{}),signal=new AbortController().signal;
 const id=await work.begin('group','job',root,'generate_image',{destination:'asset.png',references:['original.png','upload:id']},signal),row=store.get<any>('work-action',id!);assert.deepEqual(row.scope.map((r:any)=>[r.kind,r.access]),[['path','write'],['path','read'],['service','write']]);await work.finish(id,'job','Cancelled',true);await assert.rejects(work.begin('group2','job2',root,'generate_image',{destination:'other.png'},signal),/uncertain/);
});
