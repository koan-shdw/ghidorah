import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Marked} from 'marked';
import {Store} from '../app/store';
import {InlinePreviews} from '../app/inline-previews';
import {previewDirective,previewImages,outputPreview} from '../app/message-previews';
import {saveChatOutput} from '../app/chat-files';

test('preview directives and Markdown images render placeholders; quoted code stays code',()=>{
 const parser=new Marked({renderer:previewImages},previewDirective);
 const href='I:/DEV/app/dedupe-layout-example.html';
 assert.match(parser.parse('::preview{file="'+href+'"}') as string,/data-preview-href="I:\/DEV\/app\/dedupe-layout-example.html"/);
 assert.match(parser.parse('Before\n\n::preview{file="'+href+'"}\n\nAfter') as string,/>After</);
 for(const text of ['`::preview{file="x.html"}`','```html\n::preview{file="x.html"}\n```','    ::preview{file="x.html"}'])assert.doesNotMatch(parser.parse(text) as string,/data-preview-href/);
 assert.match(parser.parse('![Mockup](image.png "Example")') as string,/data-preview-title="Example"/);
 assert.doesNotMatch(parser.parse('![x](x.png "&quot; onload=bad")') as string,/title="" onload=/);
 assert.equal(outputPreview('report.md','id'),undefined);
 assert.match(outputPreview('mockup.html','id')!,/^::preview/);
 assert.match(outputPreview('image.png','id')!,/^!\[/);
});

async function fixture(t:any){
 const base=await fs.mkdtemp(path.join(process.cwd(),'work/inline-preview-')),root=path.join(base,'project'),data=path.join(base,'private');await fs.mkdir(root);await fs.mkdir(data);
 const store=new Store(':memory:');t.after(()=>store.db.close());const project=store.project(root),chat=store.chat(project.id),turn=store.accept(crypto.randomUUID(),chat.id,'Show mockup','deepseek-flash');
 return {base,root,data,store,turn,server:new InlinePreviews(store,data)};
}
test('inline HTML serves its script and style; grants cannot read private files, escape or write',async t=>{
 const f=await fixture(t),page='<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><button id="b">Click</button><script src="app.js"></script></body></html>';
 await fs.writeFile(path.join(f.root,'index.html'),page);await fs.writeFile(path.join(f.root,'style.css'),'button{color:red}');await fs.writeFile(path.join(f.root,'app.js'),'document.querySelector("button").onclick=()=>document.body.dataset.clicked="yes";');
 const opened=await f.server.open(f.turn,f.root,'index.html'),response=await f.server.response(new Request(opened.url));assert.equal(opened.kind,'html');assert.equal(response.status,200);assert.match(await response.text(),/<script src="app.js"><\/script>/);
 const policy=response.headers.get('Content-Security-Policy')!;assert.match(policy,/sandbox allow-scripts;/);assert.doesNotMatch(policy,/allow-same-origin|https:|unsafe-eval/);assert.match(policy,/connect-src tris-inline:\/\//);assert.match(policy,/frame-src 'none'/);
 for(const name of ['style.css','app.js']){const result=await f.server.response(new Request(new URL(name,opened.url)));assert.equal(result.status,200);assert.equal(await result.text(),await fs.readFile(path.join(f.root,name),'utf8'));}
 await fs.writeFile(path.join(f.root,'.env'),'secret');await fs.writeFile(path.join(f.data,'auth.json'),'secret');
 await fs.symlink(f.data,path.join(f.root,'linked'),'junction');
 for(const name of ['.env','linked/auth.json','..%2fprivate%2fauth.json'])assert.equal((await f.server.response(new Request(new URL(name,opened.url)))).status,403);
 assert.equal((await f.server.response(new Request(opened.url,{method:'POST',body:'overwrite'}))).status,403);
 await assert.rejects(f.server.open(f.turn,f.root,path.join(f.data,'auth.json')));
 await assert.rejects(f.server.open(f.turn,f.root,'https://example.com'));
 const head=await f.server.response(new Request(opened.url,{method:'HEAD'}));assert.equal(head.status,200);assert.equal(await head.text(),'');
 f.server.close('another-turn',opened.url);assert.equal((await f.server.response(new Request(opened.url))).status,200);
 f.server.close(f.turn.id,opened.url);assert.equal((await f.server.response(new Request(opened.url))).status,403);
 assert.equal(await fs.readFile(path.join(f.root,'index.html'),'utf8'),page);
});
test('saved images and artifact resources retain chat ownership and content verification',async t=>{
 const f=await fixture(t),signal=new AbortController().signal,png=Buffer.from('89504e470d0a1a0a','hex');await fs.writeFile(path.join(f.root,'image.png'),png);
 const saved=await saveChatOutput(f.store,f.data,f.turn,f.root,{path:'image.png'},()=>{},signal);
 const image=await f.server.open(f.turn,f.root,'tris-output:'+saved.id);assert.equal(image.kind,'image');assert.deepEqual(Buffer.from(await (await f.server.response(new Request(image.url))).arrayBuffer()),png);
 const another=f.store.chat(f.store.get<any>('chat',f.turn.chatId).projectId),other=f.store.accept(crypto.randomUUID(),another.id,'Other','deepseek-flash');await assert.rejects(f.server.open(other,f.root,'tris-output:'+saved.id),/not part/);
 const folder=path.join(f.root,'mockup');await fs.mkdir(folder);await fs.writeFile(path.join(folder,'index.html'),'<button>Example</button><script src="app.js"></script>');await fs.writeFile(path.join(folder,'app.js'),'document.body.dataset.ready="yes"');
 const backend:any={dataRoot:f.data,host:async(_method:string,args:any)=>{const file=path.join(args.staging,'export.zip');await fs.writeFile(file,'test archive');return {file};}};
 const artifact=await saveChatOutput(f.store,f.data,f.turn,f.root,{path:folder},()=>{},signal,backend);assert.match(artifact.preview!,/^::preview/);
 const opened=await f.server.open(f.turn,f.root,'tris-output:'+artifact.id);assert.equal((await f.server.response(new Request(opened.url))).status,200);
 const script=new URL('app.js',opened.url);assert.equal((await f.server.response(new Request(script))).status,200);
 await fs.writeFile(path.join(f.data,'outputs',artifact.id,'files/app.js'),'tampered');assert.equal((await f.server.response(new Request(script))).status,403);
 assert.equal((await f.server.response(new Request(new URL('unknown.js',opened.url)))).status,403);
});
