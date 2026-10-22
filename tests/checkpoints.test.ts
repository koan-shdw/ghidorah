import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../app/store';
import {WorkCoordination,type WorkAction} from '../app/work-coordination';
import {previewCheckpoint,restoreCheckpoint} from '../app/checkpoints';
import {handover} from '../app/history';
import {Sidebar} from '../app/sidebar';
import type {Turn,ToolCall} from '../app/types';

function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tris-checkpoint-')),store=new Store(path.join(root,'test.sqlite')),owner=new WorkCoordination(store),chat=store.chat(store.project(root).id),signal=new AbortController().signal;
 const turn=store.accept(crypto.randomUUID(),chat.id,'Make the change');store.update<Turn>('turn',turn.id,{status:'completed'});
 async function write(name:string,content:string,job=turn.id,native=true){const file=path.join(root,name);if(fs.existsSync(file)){const read=await owner.begin(job,job,root,native?'Read':'read_file',native?{file_path:file}:{path:file},signal);await owner.finish(read,job,'read');}const id=await owner.begin(job,job,root,native?'Write':'write_file',native?{file_path:file,content}:{path:file,content},signal);fs.writeFileSync(file,content);await owner.finish(id,job,'written');return id!;}
 const preview=()=>previewCheckpoint(store,chat.id,turn.id,root),restore=()=>restoreCheckpoint(store,chat.id,turn.id,root,preview().revision);
 return {root,store,owner,chat,turn,signal,write,preview,restore};
}

test('native and Hermes edits restore exact bytes, remove new files, survive restart and retain context',async()=>{
 const f=fixture(),before=Buffer.from('\uFEFForiginal\r\n');fs.writeFileSync(path.join(f.root,'source.txt'),before);
 await f.write('source.txt','first');await f.write('source.txt','second',f.turn.id,false);await f.write('new.txt','created');
 const p=f.preview();assert.deepEqual(p.files.map(r=>r.action),['restore','remove']);assert.equal(p.files[0].beforeText,'\uFEFForiginal\r\n');
 f.store.db.close();const store=new Store(path.join(f.root,'test.sqlite'));
 const result=restoreCheckpoint(store,f.chat.id,f.turn.id,f.root,p.revision);assert.ok(result.results.every(r=>r.status==='restored'));
 assert.deepEqual(fs.readFileSync(path.join(f.root,'source.txt')),before);assert.equal(fs.existsSync(path.join(f.root,'new.txt')),false);
 assert.ok(previewCheckpoint(store,f.chat.id,f.turn.id,f.root).files.every(r=>r.action==='unchanged'));
 const current=store.accept(crypto.randomUUID(),f.chat.id,'Continue');const transfer=handover(store.all<Turn>('turn'),store.all<ToolCall>('tool'),current,store.enginePosition(f.chat.id,'claude'));
 assert.equal(transfer.sessionId,null);assert.match(transfer.prompt,/supersedes earlier file-write outcomes/);assert.match(transfer.prompt,/checkpoint_restore/);assert.match(transfer.prompt,/restored/);store.db.close();
});

test('current user edits and intervening edits are preserved; stale previews cannot restore',async()=>{
 const f=fixture();fs.writeFileSync(path.join(f.root,'one.txt'),'original');await f.write('one.txt','first');const preview=f.preview();
 fs.writeFileSync(path.join(f.root,'one.txt'),'user edit');assert.throws(()=>restoreCheckpoint(f.store,f.chat.id,f.turn.id,f.root,preview.revision),/Refresh/);assert.equal(f.preview().files[0].action,'preserve');
 await f.write('one.txt','second');assert.match(f.preview().files[0].reason,/between/);assert.throws(()=>f.restore(),/no verified/);assert.equal(fs.readFileSync(path.join(f.root,'one.txt'),'utf8'),'second');
 await f.write('safe.txt','safe');const result=f.restore();assert.equal(result.preserved,1);assert.equal(fs.existsSync(path.join(f.root,'safe.txt')),false);assert.equal(fs.readFileSync(path.join(f.root,'one.txt'),'utf8'),'second');f.store.db.close();
});

test('older, unsupported, uncertain and mismatched writes are never claimed as restorable',async()=>{
 const f=fixture();const id=await f.write('one.txt','first');f.store.remove('checkpoint-file',id);assert.match(f.preview().files[0].reason,/predates/);
 const other=await f.write('two.txt','second');f.store.update<WorkAction>('work-action',other,{after:'wrong'});assert.match(f.preview().files[1].reason,/verified/);
 const unknown=await f.write('three.txt','third');f.store.update<WorkAction>('work-action',unknown,{status:'uncertain'});assert.equal(f.preview().files[2].action,'preserve');
 const shell=await f.owner.begin(f.turn.id,f.turn.id,f.root,'Bash',{command:'build'},f.signal).catch(()=>null);
 assert.equal(shell,null); // Unknown effects remain held until inspected.
 f.store.update<WorkAction>('work-action',unknown,{status:'completed'});
 const command=await f.owner.begin(f.turn.id,f.turn.id,f.root,'Bash',{command:'build'},f.signal);await f.owner.finish(command,f.turn.id,'Exit code 0\ndone');assert.deepEqual(f.preview().otherActions,[{name:'Bash',count:1}]);f.store.db.close();
});

test('foreign messages, moved roots, junctions and large-file captures cannot escape the checkpoint boundary',async()=>{
 const f=fixture(),other=f.store.chat(f.chat.projectId);await f.write('one.txt','value');
 assert.throws(()=>previewCheckpoint(f.store,other.id,f.turn.id,f.root),/ordinary message/);
 assert.equal(previewCheckpoint(f.store,f.chat.id,f.turn.id,path.dirname(f.root)).files[0].action,'preserve');
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'tris-checkpoint-outside-')),dir=path.join(f.root,'directory');fs.mkdirSync(dir);await f.write('directory/nested.txt','owned');fs.renameSync(dir,dir+'-saved');fs.writeFileSync(path.join(outside,'nested.txt'),'outside');fs.symlinkSync(outside,dir,'junction');assert.equal(f.preview().files.find(r=>r.path.endsWith('nested.txt'))!.action,'preserve');assert.equal(fs.readFileSync(path.join(outside,'nested.txt'),'utf8'),'outside');
 fs.writeFileSync(path.join(f.root,'large.txt'),Buffer.alloc(2*1024*1024+1,65));await f.write('large.txt','small');assert.match(f.preview().files.find(r=>r.path==='large.txt')!.reason,/2 MB/);f.store.db.close();
});

test('parallel child edits belong to their parent checkpoint; earlier messages and other chats stay out',async()=>{
 const f=fixture();await f.write('earlier.txt','earlier');const selected=f.store.accept(crypto.randomUUID(),f.chat.id,'Parallel changes');f.store.update<Turn>('turn',selected.id,{status:'completed'});
 const child=f.store.chat(f.chat.projectId),job=f.store.accept(crypto.randomUUID(),child.id,'Child task');f.store.update<Turn>('turn',job.id,{status:'completed',parentTurnId:selected.id});await f.write('parallel.txt','parallel',job.id,false);
 const other=f.store.chat(f.chat.projectId),foreign=f.store.accept(crypto.randomUUID(),other.id,'Unrelated');f.store.update<Turn>('turn',foreign.id,{status:'completed'});await f.write('unrelated.txt','unrelated',foreign.id);
 const p=previewCheckpoint(f.store,f.chat.id,selected.id,f.root);assert.deepEqual(p.files.map(r=>r.path),['parallel.txt']);restoreCheckpoint(f.store,f.chat.id,selected.id,f.root,p.revision);assert.equal(fs.existsSync(path.join(f.root,'parallel.txt')),false);assert.equal(fs.existsSync(path.join(f.root,'earlier.txt')),true);assert.equal(fs.existsSync(path.join(f.root,'unrelated.txt')),true);f.store.db.close();
});

test('partial restore records an inspectable action and never proceeds past a failed file',async()=>{
 const f=fixture();await f.write('one.txt','one');await f.write('two.txt','two');fs.linkSync(path.join(f.root,'one.txt'),path.join(f.root,'alias.txt'));
 const result=f.restore();assert.deepEqual(result.results.map(r=>r.status),['needs-inspection','not-restored']);assert.equal(fs.readFileSync(path.join(f.root,'two.txt'),'utf8'),'two');assert.equal(f.owner.pending().length,1);
 f.store.db.close();const store=new Store(path.join(f.root,'test.sqlite')),owner=new WorkCoordination(store);owner.interrupt();assert.equal(owner.pending().length,1);assert.equal(store.all<ToolCall>('tool').at(-1)!.status,'uncertain');store.db.close();
});

test('a retry after restoration keeps restoration results with completed effects',async()=>{
 const f=fixture();await f.write('new.txt','new');f.restore();const id=new Sidebar(f.store).fork(f.chat.id,{beforeTurnId:f.turn.id});
 const next=f.store.accept(crypto.randomUUID(),id,'Try again'),transfer=handover(f.store.all<Turn>('turn'),f.store.all<ToolCall>('tool'),next);
 assert.match(transfer.prompt,/checkpoint_restore/);assert.match(transfer.prompt,/restored/);assert.equal(fs.existsSync(path.join(f.root,'new.txt')),false);f.store.db.close();
});
