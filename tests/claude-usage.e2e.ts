// Free native CLI metadata request: no model prompt, no token reading.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {findClaude,claudeAccount,runClaude} from '../app/claude';
import {SecretScrubber} from '../app/redaction';
import {claudeUsage} from '../app/usage';

const root=path.resolve('.'),scratch=await fs.mkdtemp(path.join(root,'work','claude-usage-'));
const cli=await findClaude();assert.ok(cli);
assert.deepEqual(await claudeAccount(cli.executable),{loggedIn:true,subscription:true});
const result=await runClaude({executable:cli.executable,python:path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),worker:path.join(root,'backend/claude_worker.py'),directory:scratch,dataRoot:path.join(scratch,'private'),exchangeRoot:scratch,model:'claude-haiku-4-5',effort:'high',mode:'manual',hasFolder:false,scrubber:new SecretScrubber(),prompt:'',inspectUsage:true,signal:AbortSignal.timeout(45000),approve:async()=>{throw Error('Metadata must not request a tool');},event:()=>{}});
assert.equal(result.status,'completed');
const usage=claudeUsage(result.result);
assert.ok(usage.windows.length,'CLI returned no available account windows');
console.log(JSON.stringify({cli:cli.version,...usage,models:result.models}));
console.log('PASS native Claude account usage without a model prompt or token access');
