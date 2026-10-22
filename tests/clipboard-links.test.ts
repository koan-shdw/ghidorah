import test from 'node:test';
import assert from 'node:assert/strict';
import {DOMParser} from '@xmldom/xmldom';
import {Marked} from 'marked';
import {linkedClipboardText} from '../app/clipboard-text';
import {linkIcon,linkIconUrl} from '../app/link-icons';

test('pasted links retain labels, destinations and paragraph order without executing clipboard HTML',()=>{
 const convert=(html:string,plain='fallback')=>linkedClipboardText(new DOMParser().parseFromString('<body>'+html+'</body>','text/html') as unknown as Node,plain);
 const result=convert('<p>Announcing <strong>CULT</strong> at <a href="https://maps.google.com/?q=S01&amp;lang=en">S01 Gallery</a>.</p><p>Previously <a href="https://shdw.gallery/what-if">What If</a>.</p>');
 assert.match(result,/\*\*CULT\*\*/);assert.match(result,/\[S01 Gallery\]\(<https:\/\/maps.google.com\/\?q=S01&lang=en>\)/);
 const rendered=new Marked().parse(result,{async:false});assert.match(rendered,/<a href="https:\/\/maps.google.com\/\?q=S01&lang=en">S01 Gallery<\/a>/);assert.match(rendered,/what-if">What If/);
 assert.equal(convert('<b>Text without links</b>','Keep *this* exactly\n'), 'Keep *this* exactly\n');
 assert.equal(convert('<a href="javascript:alert(1)">Click</a>','Click'),'Click');
 assert.equal(convert('<a href="#" data-chat-href="https://example.com/"><img alt=""/>Site</a>','Site'),'[Site](<https://example.com/>)');
 const mixed=convert('<a href="https://example.com/a_(b)">[same]</a> and <a href="https://example.org/">[same]</a><script>alert(1)</script><img src="file:///secret"/>');
 assert.match(mixed,/a_\(b\)/);assert.match(mixed,/example.org/);assert.doesNotMatch(mixed,/script|alert|file:/);
 const labels=new Marked().parse(mixed,{async:false});assert.equal((labels.match(/>\[same\]<\/a>/g)||[]).length,2);
});

test('site icons send only the hostname, cache requests and reject unsupported or oversized responses',async()=>{
 assert.equal(linkIconUrl('https://example.com/private?secret=123#note'),'https://www.google.com/s2/favicons?sz=32&domain=example.com');
 for(const href of ['javascript:alert(1)','file:///private','http://localhost:3000/','https://127.0.0.1/','https://user:secret@example.com/'])assert.equal(linkIconUrl(href),null);
 const original=globalThis.fetch,calls:string[]=[];
 try{
  globalThis.fetch=async(input,options)=>{calls.push(String(input));assert.equal(options?.credentials,'omit');return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}});};
  assert.equal(await linkIcon('https://example.com/a?secret=123'),'data:image/png;base64,AQID');
  assert.equal(await linkIcon('https://example.com/b'),'data:image/png;base64,AQID');assert.equal(calls.length,1);assert.doesNotMatch(calls[0],/secret|private/);
  globalThis.fetch=async()=>new Response(new Uint8Array(65537),{headers:{'content-type':'image/png'}});
  assert.equal(await linkIcon('https://large.example.com'),null);
  globalThis.fetch=async()=>new Response('<svg onload="bad()"/>',{headers:{'content-type':'image/svg+xml'}});
  assert.equal(await linkIcon('https://unsafe.example.com'),null);
 }finally{globalThis.fetch=original;}
});
