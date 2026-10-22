import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../app/store';
import {Sidebar} from '../app/sidebar';
import {captureExport,exportDefaults,exportDocuments,exportMarkdown,writeChatExport} from '../app/chat-export';
import {saveChatOutput} from '../app/chat-files';
import type {Backend} from '../app/backend';
const signal=new AbortController().signal;
async function fixture(t:any){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tris-export-')),data=path.join(root,'data'),folder=path.join(root,'workspace');await fs.mkdir(data);await fs.mkdir(folder);const store=new Store(path.join(data,'chat.sqlite'));
 t.after(async()=>{store.db.close();assert.equal(await fs.realpath(root),root);await fs.rm(root,{recursive:true,force:true});});
 const project=store.project(folder),chat=store.chat(project.id),turn=store.accept(crypto.randomUUID(),chat.id,'Make a report','deepseek-flash');store.update<any>('turn',turn.id,{status:'completed',reasoning:'Optional thinking',text:'Saved report'});
 await fs.writeFile(path.join(folder,'report [日本語].md'),'# Original\nExact original bytes.');const output=await saveChatOutput(store,data,turn,folder,{path:'report [日本語].md'},()=>{},signal);
 const capture=(options=exportDefaults)=>captureExport(store,chat.id,options,s=>s.replaceAll('private-secret','[redacted]'));
 return {root,data,folder,store,chat,turn,output,capture};
}
test('snapshot includes owned jobs and sent files, excludes drafts, foreign chats and private metadata',async t=>{
 const f=await fixture(t),{store,chat,turn}=f;
 const child=store.chat(chat.projectId);store.update<any>('chat',child.id,{parentChatId:chat.id});const job=store.accept(crypto.randomUUID(),child.id,'Owned job','deepseek-flash');store.update<any>('turn',job.id,{status:'running'});
 const foreign=store.chat(chat.projectId);store.accept(crypto.randomUUID(),foreign.id,'FOREIGN CONTENT','deepseek-flash');store.put('settings',{id:'export-secret',password:'private-secret'});
 store.update<any>('chat',chat.id,{draft:'UNSENT DRAFT',attachments:[{id:crypto.randomUUID(),name:'draft-only.txt',size:4,sha256:'unused'}]});store.put('tool',{id:'tool1',turnId:turn.id,name:'test',args:{'private-secret':'private-secret'},result:'TOOL RESULT',status:'completed'});
 const record=f.capture(),docs=exportDocuments(record),json=docs['conversation.json'];assert.equal(record.messages.length,2);assert.equal(record.files.length,1);assert.doesNotMatch(json,/UNSENT|FOREIGN|draft-only|Optional thinking|TOOL RESULT|originRoot|originPath|"blob"|private-secret/);
 assert.equal(captureExport(store,child.id,exportDefaults,s=>s).messages.length,1);
 const full=exportDocuments(f.capture({...exportDefaults,tools:true,reasoning:true}))['conversation.json'];assert.match(full,/Optional thinking/);assert.match(full,/TOOL RESULT/);assert.match(full,/\[redacted\]/);assert.doesNotMatch(full,/private-secret/);
 assert.throws(()=>f.capture({files:true,tools:true} as any),/Invalid export options/);
 store.update<any>('chat-output',f.output.id,{name:'a'.repeat(119)+'.txt'});assert.doesNotMatch(f.capture().files[0].path,/[. ]$/);
});
test('portable links work for original and forked versions; formatting and fenced code survive',async t=>{
 const f=await fixture(t),href='tris-output:'+f.output.id,source='## Result\n\n- [x] Ready **now**\n- [Report]('+href+')\n\n| File | Value |\n| :--- | ---: |\n| [Report]('+href+') | 4 |\n\n> Open [report]('+href+').\n\n```js\nconst link = "'+href+'";\n```\n\n![remote](https://example.com/tracker.png)\n\n[working](C:/private/file.txt)';
 f.store.update<any>('turn',f.turn.id,{text:source});const fork=new Sidebar(f.store).fork(f.chat.id),record=captureExport(f.store,fork,exportDefaults,s=>s),docs=exportDocuments(record),md=docs['conversation.md'];
 assert.match(md,/- \[x\] Ready \*\*now\*\*/);assert.match(md,/\[Report\]\(<files\//);assert.match(md,/\| :--- \| ---: \|/);assert.ok(md.includes('```js\nconst link = "'+href+'";\n```'));assert.match(md,/\[remote\]\(<https:/);assert.doesNotMatch(md,/!\[remote\]/);assert.doesNotMatch(md,/C:\/private/);assert.match(docs['conversation.html'],/href="files\//);assert.doesNotMatch(docs['conversation.html'],/src="https:/);
 assert.equal(exportMarkdown(f.capture({...exportDefaults,files:false}),'[report]('+href+')').trim(),'report');
});
test('readable HTML escapes raw scripts, attributes and unsafe schemes',async t=>{
 const f=await fixture(t);f.store.update<any>('chat',f.chat.id,{title:'<img src=x onerror=alert(1)>'});f.store.update<any>('turn',f.turn.id,{text:'<script>window.BAD=1</script>\n\n[bad](javascript:alert%281%29)\n\n[account](https://user:password@example.com/)\n\n![tracker](https://example.com/pixel)\n\n```html\n<img onerror="bad()">\n```'});
 const html=exportDocuments(f.capture())['conversation.html'];assert.doesNotMatch(html,/<script|<img |href="javascript|user:password|src="https/);assert.match(html,/&lt;script&gt;/);assert.match(html,/default-src 'none'/);assert.match(html,/&lt;img onerror/);
});
test('archive publication preserves prior files on cancellation, tampering and destination races',async t=>{
 const f=await fixture(t),dest=path.join(f.folder,'chat.zip');await fs.writeFile(dest,'Existing export');const cancel=new AbortController();
 const backend={dataRoot:f.data,host:async(_op:string,{staging}:any)=>{await fs.writeFile(path.join(staging,'export.zip'),'ZIP placeholder');cancel.abort();return {file:path.join(staging,'export.zip')};}} as Backend;
 await assert.rejects(writeChatExport(backend,f.capture(),dest,cancel.signal));assert.equal(await fs.readFile(dest,'utf8'),'Existing export');assert.deepEqual(await fs.readdir(path.join(f.data,'exports')),[]);
 backend.host=async(_op:string,{staging}:any)=>{await fs.writeFile(path.join(staging,'export.zip'),'ZIP placeholder');await fs.writeFile(dest,'Concurrent user edit');return {file:path.join(staging,'export.zip')};};await assert.rejects(writeChatExport(backend,f.capture(),dest,signal),/destination changed/);assert.equal(await fs.readFile(dest,'utf8'),'Concurrent user edit');
 await fs.writeFile(path.join(f.data,'outputs',f.output.id,'source'),'Tampered');await assert.rejects(writeChatExport(backend,f.capture(),dest,signal),/changed/);assert.equal(await fs.readFile(dest,'utf8'),'Concurrent user edit');assert.deepEqual(await fs.readdir(path.join(f.data,'exports')),[]);
 await assert.rejects(writeChatExport(backend,f.capture(),path.join(f.data,'private.zip'),signal),/private/);assert.deepEqual((await fs.readdir(f.folder)).filter(n=>n.endsWith('.tmp')),[]);
});
