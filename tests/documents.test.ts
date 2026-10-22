import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {Store} from '../app/store';import {saveChatOutput} from '../app/chat-files';import {documentToolCall,newDocumentPath} from '../app/documents';import {WorkCoordination} from '../app/work-coordination';import type {Backend} from '../app/backend';
const signal=new AbortController().signal;
test('document copies are owned, exact and never overwrite or escape',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tris-docs-')),data=path.join(root,'data'),folder=path.join(root,'work');await fs.mkdir(data);await fs.mkdir(folder);const store=new Store(path.join(data,'chat.sqlite'));t.after(async()=>{store.db.close();await fs.rm(root,{recursive:true,force:true});});
 const project=store.project(folder),chat=store.chat(project.id),turn=store.accept(crypto.randomUUID(),chat.id,'Edit a file','deepseek-flash'),backend={dataRoot:data} as Backend;
 const bytes=Buffer.from([0,255,12,34,67]);await fs.writeFile(path.join(folder,'original.bin'),bytes);const saved=await saveChatOutput(store,data,turn,folder,{path:'original.bin'},()=>{},signal);
 const copied:any=await documentToolCall(store,backend,turn,folder,'copy_chat_file',{id:'output:'+saved.id,destination:'editable.bin'},signal);assert.deepEqual(await fs.readFile(copied.file),bytes);assert.equal(copied.sha256,saved.sha256);
 let refusals=0;await assert.rejects(documentToolCall(store,backend,turn,folder,'copy_chat_file',{id:'output:'+saved.id,destination:'editable.bin'},signal,()=>refusals++),/exists/);assert.equal(refusals,1);
 const foreign=store.chat(project.id),other=store.accept(crypto.randomUUID(),foreign.id,'Other','deepseek-flash');await assert.rejects(documentToolCall(store,backend,other,folder,'copy_chat_file',{id:'output:'+saved.id,destination:'foreign.bin'},signal),/not part/);
 for(const destination of ['../outside',path.join(data,'secret'),'.env'])await assert.rejects(newDocumentPath(folder,data,destination));
 await fs.symlink(data,path.join(folder,'linked'),'junction');await assert.rejects(newDocumentPath(folder,data,'linked/new-file'));
 const abort=new AbortController();abort.abort();await assert.rejects(documentToolCall(store,backend,turn,folder,'copy_chat_file',{id:'output:'+saved.id,destination:'cancelled.bin'},abort.signal));await assert.rejects(fs.stat(path.join(folder,'cancelled.bin')));
});
test('document mutation scope includes input reads and output writes without blocking unrelated work',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tris-doc-work-')),store=new Store(path.join(root,'state.sqlite'));t.after(async()=>{store.db.close();await fs.rm(root,{recursive:true,force:true});});const work=new WorkCoordination(store,()=>{});await fs.writeFile(path.join(root,'source.docx'),'document');
 const a=await work.begin('group','job',root,'mcp__ghidorah__render_document',{path:'source.docx',destination:'rendered'},signal);const row=store.get<any>('work-action',a!);assert.equal(row.scope.length,2);assert.equal(row.scope[0].access,'write');assert.equal(row.scope[1].access,'read');
 const b=await work.begin('other','other',root,'Write',{file_path:path.join(root,'separate.txt'),content:'Independent'},signal);assert.ok(b);await fs.writeFile(path.join(root,'separate.txt'),'Independent');await work.finish(b,'other','done');
 const abort=new AbortController();const conflicting=work.begin('other','other',root,'Write',{file_path:path.join(root,'rendered/page.png'),content:'wrong'},abort.signal);abort.abort();await assert.rejects(conflicting);await work.finish(a,'job',{file:'rendered/document.pdf'});
});
