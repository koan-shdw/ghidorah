// Native control acknowledgements only; no model prompt is sent.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {findClaude,runClaude} from '../app/claude';
import {SecretScrubber} from '../app/redaction';
import type {Mode} from '../app/types';
const root=path.resolve('.'),scratch=await fs.mkdtemp(path.join(root,'work','claude-modes-'));
const cli=await findClaude();assert.ok(cli);
const model=process.env.TRISMEGISTUS_TEST_CLAUDE_MODEL||'claude-haiku-4-5';
for(const mode of ['manual','accept-edits','plan','auto','bypass'] as Mode[]){
  let changed:Promise<void>|undefined;
  const result=await runClaude({executable:cli.executable,python:path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),worker:path.join(root,'backend/claude_worker.py'),directory:scratch,dataRoot:path.join(scratch,'private'),exchangeRoot:scratch,model,effort:'high',mode:'manual',hasFolder:false,scrubber:new SecretScrubber(),prompt:'',inspectUsage:true,signal:AbortSignal.timeout(45000),event:()=>{},approve:async()=>false,controls:control=>{changed=control.setMode(mode);changed.catch(()=>{});}});
  assert.equal(result.status,'completed');assert.ok(changed);
  try{await changed;console.log('PASS native permission-mode acknowledgement: '+mode);}
  catch(error){console.log('UNAVAILABLE native mode '+mode+': '+String(error));process.exitCode=1;}
}
