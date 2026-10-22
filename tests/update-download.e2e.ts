import {build} from 'esbuild';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work/update-delivery-'));
const environment={...process.env};delete environment.ELECTRON_RUN_AS_NODE;
await fs.writeFile(path.join(data,'package.json'),JSON.stringify({name:'tris-update-test',version:'0.1.0',main:'main.cjs'}));
await build({entryPoints:['tests/fixtures/update-delivery.ts'],outfile:path.join(data,'main.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']});
for(const scenario of ['retry','cache','automatic','build']){
 const profile=path.join(data,scenario==='cache'?'retry':scenario);await fs.mkdir(profile,{recursive:true});
 const result=await promisify(execFile)(path.join(root,'node_modules/electron/dist/electron.exe'),[data,'--hidden'],{
  windowsHide:true,timeout:30000,env:{...environment,LOCALAPPDATA:profile,TRIS_UPDATE_TEST_DATA:profile,TRIS_UPDATE_TEST_SCENARIO:scenario},maxBuffer:1024*1024,
 });
 assert.equal(result.stderr.includes('AssertionError'),false,result.stderr);
 const receipt=JSON.parse(await fs.readFile(path.join(profile,scenario+'.json'),'utf8'));
 console.log('PASS update delivery: '+JSON.stringify(receipt));
}
console.log('Evidence: '+data);
