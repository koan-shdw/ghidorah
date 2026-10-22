import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';

// Exercise the distribution artifact, not only the unbundled development imports.
test('bundled map worker parses TS/Python, exports HTML and detects stale source',async t=>{
 const work=path.resolve('work');await fs.mkdir(work,{recursive:true});
 const root=await fs.mkdtemp(path.join(work,'repo-map-bundle-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const buildScript=new URL('../scripts/build-repo-map.mjs',import.meta.url).href;
 execFileSync(process.execPath,['--input-type=module','-e',`import {buildRepoMap} from ${JSON.stringify(buildScript)}; await buildRepoMap(${JSON.stringify(root)});`],{windowsHide:true,timeout:60000});
 const repo=path.join(root,'fixture');await fs.mkdir(repo);
 await fs.writeFile(path.join(repo,'entry.ts'),'export function bundleEntry() {}\n');
 await fs.writeFile(path.join(repo,'helper.py'),'def python_helper():\n    return 1\n');
 const moved=path.join(root,'relocated-skill');await fs.rename(path.join(root,'dist/skills/repo-map'),moved);
 for(const cli of [path.join(root,'dist/repo-map/cli.mjs'),path.join(moved,'scripts/cli.mjs')]){
 await fs.writeFile(path.join(repo,'entry.ts'),'export function bundleEntry() {}\n');
 const run=(...args:string[])=>spawnSync(process.execPath,[cli,repo,...args],{encoding:'utf8',windowsHide:true,timeout:30000});
 const result=run('--json','--html');assert.equal(result.status,0,result.stderr);
 const map=JSON.parse(result.stdout);assert.equal(map.partial,false);
 assert.ok(map.files.some((f:any)=>f.symbols.some((s:any)=>s.name==='bundleEntry')));
 assert.ok(map.files.some((f:any)=>f.symbols.some((s:any)=>s.name==='python_helper')));
 assert.match(await fs.readFile(path.join(repo,'.repo-map/map.html'),'utf8'),/mountGraph/);
 assert.equal(run('--check').status,0);
 await fs.writeFile(path.join(repo,'entry.ts'),'export function changedEntry() {}\n');
 assert.equal(run('--check').status,1);
 }
});
