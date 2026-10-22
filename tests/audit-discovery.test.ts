import test from 'node:test';
import assert from 'node:assert/strict';
import {readDiscovery,fetchModelPage} from '../app/model-discovery';
import {compareVersions,installedCopy} from '../app/updates';
import path from 'node:path';
import {createServer} from 'node:http';

test('an incomplete discovery answer cannot consume a new-model change',()=>{
 const diff={added:[{provider:'deepseek',id:'new-model'}]};
 assert.equal(readDiscovery(JSON.stringify({models:[],changes:[],suggestions:[]}),diff,{deepseek:'https://example.invalid/models'}),null);
});

test('capability changes must name current models and their own supplier source',()=>{
 const row={provider:'deepseek',id:'same-id',description:'Now accepts images.',abilities:['images'],source:'https://deepseek.invalid/models'},sources={deepseek:row.source,gemini:'https://gemini.invalid/models'},catalogue={deepseek:['same-id']};
 const value={models:[],changes:[row],suggestions:[]};
 assert.deepEqual(readDiscovery(JSON.stringify(value),{added:[]},sources,catalogue)?.changes,[row]);
 assert.equal(readDiscovery(JSON.stringify({...value,changes:[{...row,source:sources.gemini}]}),{added:[]},sources,catalogue),null);
 assert.equal(readDiscovery(JSON.stringify({...value,changes:[{...row,id:'invented'}]}),{added:[]},sources,catalogue),null);
});

test('supplier pages fail on HTTP errors, excessive bodies and cancellation',async()=>{
 const server=createServer((req,res)=>{if(req.url==='/bad')res.writeHead(503).end();else if(req.url==='/large')res.end('x'.repeat(4*1024*1024+1));else if(req.url==='/slow'){res.writeHead(200);res.write('waiting');}else res.end('<h1>Official model information for the local fixture.</h1>');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+(server.address() as any).port;
 try{
  assert.match(await fetchModelPage(url,new AbortController().signal),/Official model information/);
  await assert.rejects(fetchModelPage(url+'/bad',new AbortController().signal),/HTTP 503/);
  await assert.rejects(fetchModelPage(url+'/large',new AbortController().signal),/too large/);
  await assert.rejects(fetchModelPage(url+'/slow',AbortSignal.timeout(40)),/abort|timeout/i);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('release ordering handles prereleases and rejects malformed versions',()=>{
 assert.equal(compareVersions('1.0.0-beta.2','1.0.0-beta.11'),-1);
 assert.equal(compareVersions('1.0.0-beta.11','1.0.0'),-1);
 assert.throws(()=>compareVersions('garbage','1.0.0'));
});
test('a build beside the install directory is not an installed copy',()=>{
 const base=process.env.LOCALAPPDATA!;
 assert.equal(installedCopy(path.join(base,'Programs-copy','Trismegistus.exe'),true),false);
 assert.equal(installedCopy(path.join(base,'Programs','unrelated','Trismegistus.exe'),true),false);
});
