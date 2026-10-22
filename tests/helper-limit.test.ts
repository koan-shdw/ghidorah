import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Backend} from '../app/backend';

// The 1.11 shape (TURN-REVIEW part 4): a helper that never closes, and a kill that does nothing.
test('a helper step that never closes ends at its own limit, even when the kill does nothing',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tris-helper-'));fs.mkdirSync(path.join(root,'backend'));
  fs.writeFileSync(path.join(root,'backend','host.py'),'setInterval(()=>{},1000);');
  const backend=new Backend(root,root,'Trismegistus/Test/helper',()=>{});
  Object.defineProperty(backend,'python',{get:()=>process.execPath});
  const killed:number[]=[];backend.stopHelper=pid=>{if(pid)killed.push(pid);};
  const started=Date.now();
  await assert.rejects(backend.host('plugin_runtime_check',{},undefined,300),(error:any)=>error.name==='TimeoutError'&&/plugin_runtime_check/.test(error.message));
  assert.ok(Date.now()-started<2000,'rejected on its own timer');assert.equal(killed.length,1);
  const controller=new AbortController();setTimeout(()=>controller.abort(),200);
  await assert.rejects(backend.host('project_memory',{},controller.signal),/cancelled/);assert.equal(killed.length,2,'Stop ends the wait at once');
  for(const pid of killed)try{process.kill(pid);}catch{}
  fs.rmSync(root,{recursive:true,force:true});
});
