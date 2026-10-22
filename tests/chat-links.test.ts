import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolveChatLink} from '../app/chat-links';

test('chat links resolve real workspace files and lines without enabling arbitrary protocols or secret access',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tris-links-')),outside=fs.mkdtempSync(path.join(os.tmpdir(),'tris-link-outside-'));
 fs.writeFileSync(path.join(root,'a b.ts'),'first\nsecond\n');fs.writeFileSync(path.join(outside,'outside.txt'),'outside');fs.mkdirSync(path.join(root,'.codex'));fs.writeFileSync(path.join(root,'.codex','auth.json'),'synthetic');fs.writeFileSync(path.join(root,'.env'),'synthetic');
 for(const href of ['a%20b.ts:2:3',path.join(root,'a b.ts')+':2:3',pathToFileURL(path.join(root,'a b.ts')).href+'#L2C3']){
  const link=resolveChatLink(root,href);assert.equal(link.kind,'file');if(link.kind==='file'){assert.equal(link.path,'a b.ts');assert.equal(link.line,2);assert.equal(link.column,3);}
 }
 assert.equal(resolveChatLink(root,'.').kind,'file');assert.deepEqual(resolveChatLink(null,'https://example.org/test?q=1#two'),{kind:'web',url:'https://example.org/test?q=1#two'});
 for(const href of ['javascript:alert(1)','data:text/html,hi','mailto:x@example.org','cmd.exe:run','https://user:password@example.org','//server/share','\\\\server\\share','file://server/share','a%20b.ts:0','a%20b.ts:2:0','.env','.codex/auth.json',path.join(outside,'outside.txt'),'a%00.ts'])assert.throws(()=>resolveChatLink(root,href),Error,href);
 fs.symlinkSync(outside,path.join(root,'escape'),'junction');assert.throws(()=>resolveChatLink(root,'escape/outside.txt'),/outside/);
 fs.mkdirSync(path.join(root,'private'));fs.writeFileSync(path.join(root,'private','plain.txt'),'synthetic');assert.throws(()=>resolveChatLink(root,'private/plain.txt',[path.join(root,'private')]),/Protected/);
});
