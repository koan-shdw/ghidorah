import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../app/store';
import {WorkCoordination,type WorkAction} from '../app/work-coordination';
import {BackgroundWork} from '../app/background-work';
import {SecretScrubber} from '../app/redaction';
import type {Chat} from '../app/types';
import type {PluginProcessOwner} from '../app/plugin-commands';

test('plugin process handles route to their retained worker and cannot use a gateway or a later owner',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tris-plugin-bg-')),store=new Store(':memory:'),work=new WorkCoordination(store);
 const chat=store.chat(store.project(dir).id),calls:string[]=[],owners=new Map<string,PluginProcessOwner>();
 const backend:any={generation:'gateway',status:'ready',scrubber:new SecretScrubber(),rpc:{request:async()=>{throw Error('Plugin handle reached gateway');}}};
 backend.scrubber.register('synthetic-private-value');
 for(const id of ['first','second'])owners.set(id,{id,close:async()=>{},request:async(method,handle)=>{calls.push(id+':'+method);if(method==='kill'){assert.equal(handle,'proc_same');return {status:'killed',output:'stopped'};}return {processes:[{session_id:'proc_same',status:'running',output_preview:'synthetic-private-value'}]};}});
 const owner=new BackgroundWork(store,backend,work,()=>{},owners),signal=new AbortController().signal;
 for(const id of ['first','second']){
  await work.inspectAction(id,dir,{tool:'terminal',arguments:{command:id},summary:'No shared effects in fixture.',evidence:[],resources:[]});
  const lease=await work.begin(id,id,dir,'terminal',{command:id},signal);await owner.finishTool(chat,id,lease,{session_id:'proc_same'},false,false,id);work.interrupt(id);
 }
 const [first,second]=owner.rows();assert.notEqual(first.id,second.id);assert.ok(owner.rows().every(row=>!row.output.includes('synthetic-private-value')));assert.ok(owner.rows().every(row=>row.status==='running'));assert.equal(work.records('first')[0].status,'background');
 await owner.stop(first.id);assert.equal(owner.rows().find(row=>row.id===first.id)?.status,'stopped');assert.equal(owner.rows().find(row=>row.id===second.id)?.status,'running');assert.deepEqual(calls,['first:list','second:list','first:kill']);
 await owner.pluginSnapshot(chat,'second','second',[{session_id:'proc_same',status:'exited',exit_code:0,output_preview:'final output'}]);await owner.pluginClosed('second',false);owners.delete('second');
 assert.equal(owner.rows().find(row=>row.id===second.id)?.status,'exited');assert.equal(owner.rows().find(row=>row.id===second.id)?.output,'final output');assert.equal(work.records('second')[0].status,'completed');
 store.put('background',{...second,id:'orphan',status:'running'});await owner.refresh();assert.equal(owner.rows().find(row=>row.id==='orphan')?.status,'lost');assert.equal(calls.length,3);await assert.rejects(owner.pluginSnapshot(chat,'second','second',[]),/owner is unavailable/);store.db.close();
});

test('background receipts retain action ownership through replies, transient polls and confirmed exit',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tris-bg-')),store=new Store(':memory:'),work=new WorkCoordination(store),signal=new AbortController().signal;
 const chat=store.chat(store.project(dir).id);chat.runtimeId='owned-session';store.put('chat',chat);store.accept('start',chat.id,'Start work');
 let fail=false,entry:any={session_id:'proc_aaaa',status:'running',output_tail:'working'};
 const backend:any={generation:'generation-1',status:'ready',scrubber:new SecretScrubber(),rpc:{request:async(name:string,args:any)=>{assert.equal(name,'process.list');assert.equal(args.session_id,chat.runtimeId);if(fail)throw Error('poll timed out');return {processes:[entry]};}}};
 const owner=new BackgroundWork(store,backend,work,()=>{});
 const action=await work.begin('start','start',dir,'terminal',{command:'unknown job',background:true},signal);
 await owner.finishTool(chat,'start',action,JSON.stringify({session_id:'proc_aaaa',pid:12}),false);work.interrupt('start');
 assert.equal(work.records('start')[0].status,'background');assert.equal(owner.rows()[0].status,'running');
 const read=await work.begin('inspect','inspect',dir,'Read',{file_path:'result.txt'},signal);await work.finish(read,'inspect','not found',true);
 await assert.rejects(work.begin('next','next',dir,'Write',{file_path:'result.txt',content:'x'},signal),/Background work owns/);
 const poll=await work.begin('next','next',dir,'process_manage',{action:'poll',session_id:'proc_aaaa'},signal);await work.finish(poll,'next',{status:'running'});
 fail=true;await owner.refresh();assert.equal(owner.rows()[0].status,'running');assert.match(owner.rows()[0].error!,/timed out/);assert.equal(work.records('start')[0].status,'background');
 fail=false;entry={...entry,status:'exited',exit_code:0,output_tail:'done'};await owner.refresh();assert.equal(owner.rows()[0].status,'exited');assert.equal(work.records('start')[0].status,'completed');
 const write=await work.begin('next','next',dir,'Write',{file_path:'result.txt',content:'x'},signal);assert.ok(write);await work.finish(write,'next','done');store.db.close();
});

test('inspected background resources allow independent work and preserve source evidence',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tris-bg-scope-')),store=new Store(':memory:'),work=new WorkCoordination(store),signal=new AbortController().signal;
 await fs.writeFile(path.join(dir,'server.py'),'serve source');
 const read=await work.begin('group','server',dir,'Read',{file_path:'server.py'},signal);await work.finish(read,'server','serve source');
 const args={command:'python server.py',background:true},inspection={tool:'terminal',arguments:args,summary:'Read the server: observes this source tree and exclusively listens on port 3000.',evidence:['server.py'],resources:[{kind:'path',value:dir,access:'observe'},{kind:'port',value:'tcp:3000',access:'write'}]};
 await work.inspectAction('server',dir,inspection);const server=await work.begin('group','server',dir,'terminal',args,signal);work.holdBackground(server!,'server',{session_id:'proc_server'});work.interrupt('server');
 const edit=await work.begin('group','editor',dir,'Write',{file_path:'new.txt',content:'independent'},signal);assert.ok(edit);await work.finish(edit,'editor','written');
 await work.inspectAction('second',dir,{...inspection,arguments:{command:'second server'},evidence:[],resources:[{kind:'port',value:'tcp:3001',access:'write'}]});
 const independent=await work.begin('other','second',dir,'terminal',{command:'second server'},signal);assert.ok(independent);await work.finish(independent,'second','done');
 await work.inspectAction('collision',dir,{...inspection,arguments:{command:'same port'},evidence:[],resources:[{kind:'port',value:'TCP:03000',access:'write'}]});await assert.rejects(work.begin('other','collision',dir,'terminal',{command:'same port'},signal),/Background work owns/);
 await work.finishBackground(server!,{exit_code:0},false);
 const again=await work.begin('group','server',dir,'terminal',args,signal);await fs.writeFile(path.join(dir,'server.py'),'user changed source');
 await assert.rejects(work.checkApproval('server','terminal: '+JSON.stringify(args)),/source changed during approval/);work.denied('server','terminal: '+JSON.stringify(args));
 await assert.rejects(work.begin('group','server',dir,'terminal',args,signal),/source changed/);
 const fresh=await work.begin('group','server',dir,'Read',{file_path:'server.py'},signal);await work.finish(fresh,'server','user changed source');await work.inspectAction('server',dir,inspection);
 const pending=await work.begin('group','server',dir,'terminal',args,signal);await fs.writeFile(path.join(dir,'server.py'),'changed while pending');
 const newer=await work.begin('group','server',dir,'Read',{file_path:'server.py'},signal);await work.finish(newer,'server','changed while pending');await work.inspectAction('server',dir,inspection);
 await assert.rejects(work.checkApproval('server','terminal: '+JSON.stringify(args)),/source changed during approval/,'a later inspection cannot replace the evidence frozen into an already pending action');work.denied('server','terminal: '+JSON.stringify(args));
 await assert.rejects(work.inspectAction('other',dir,inspection),/Read the current/);store.db.close();
});

test('Stop deduplicates control, late status cannot resurrect work, restart records uncertainty without signaling old PIDs',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tris-bg-recovery-')),file=path.join(dir,'state.sqlite');let store=new Store(file),work=new WorkCoordination(store);
 const chat=store.chat(store.project(dir).id);chat.runtimeId='session';store.put('chat',chat);store.accept('turn',chat.id,'start');
 let kills=0;let complete!:()=>void;const hold=new Promise<void>(resolve=>complete=resolve);
 const backend:any={generation:'one',status:'ready',scrubber:new SecretScrubber(),rpc:{request:async(name:string)=>{if(name==='process.kill'){kills++;await hold;return {status:'killed',output:'partial effect',exit_code:1};}return {processes:[{session_id:'proc_a',status:'running'}]};}}};
 let owner=new BackgroundWork(store,backend,work,()=>{});const action=await work.begin('group','turn',dir,'terminal',{command:'work'},new AbortController().signal);
 await owner.finishTool(chat,'turn',action,{yielded_session_id:'proc_a'},false);const row=owner.rows()[0];
 const stop=owner.stop(row.id),duplicate=owner.stop(row.id);assert.equal(kills,1);assert.equal(stop,duplicate);complete();await stop;await owner.refresh();
 assert.equal(owner.rows()[0].status,'stopped');assert.equal(work.pending().length,1);
 // Simulate an abrupt app loss while a second receipt is still live.
 store.put('background',{...row,id:'crashed',status:'running'});store.update<WorkAction>('work-action',action!,{status:'background'});store.db.close();
 store=new Store(file);work=new WorkCoordination(store);work.interrupt();owner=new BackgroundWork(store,backend,work,()=>{});await owner.lost('App restarted');
 assert.equal(owner.rows().find(row=>row.id==='crashed')?.status,'lost');assert.equal(kills,1);assert.equal(work.pending().length,1);store.db.close();
});
