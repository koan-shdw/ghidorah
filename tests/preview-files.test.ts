import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {previewFileResponse} from '../app/preview-files';
test('local previews serve real relative assets and byte ranges while refusing private files and escapes',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tris-preview-')),outside=fs.mkdtempSync(path.join(os.tmpdir(),'tris-preview-outside-'));
 fs.writeFileSync(path.join(root,'index.html'),'<h1>Preview</h1>');fs.writeFileSync(path.join(root,'clip.webm'),'0123456789');fs.writeFileSync(path.join(root,'.env.json'),'protected');fs.writeFileSync(path.join(root,'source.py'),'private source');fs.mkdirSync(path.join(root,'assets'));fs.writeFileSync(path.join(root,'assets','a b.css'),'h1{color:red}');fs.writeFileSync(path.join(outside,'outside.html'),'outside');fs.symlinkSync(outside,path.join(root,'escape'),'junction');
 const response=(file:string,range?:string)=>previewFileResponse(new Request('tris-preview://test/'+file,{headers:range?{Range:range}:undefined}),root,'test');
 assert.equal(await response('index.html').text(),'<h1>Preview</h1>');assert.equal(await response('assets/a%20b.css').text(),'h1{color:red}');
 const part=response('clip.webm','bytes=2-5');assert.equal(part.status,206);assert.equal(part.headers.get('content-range'),'bytes 2-5/10');assert.equal(await part.text(),'2345');assert.equal(await response('clip.webm','bytes=-3').text(),'789');assert.equal(response('clip.webm','bytes=11-').status,416);
 for(const file of ['.env.json','source.py','escape/outside.html','..%2Foutside.html','%2e%2e%2foutside.html','assets'])assert.equal(response(file).status,403,file);
 assert.equal(previewFileResponse(new Request('tris-preview://foreign/index.html'),root,'test').status,403);
});
