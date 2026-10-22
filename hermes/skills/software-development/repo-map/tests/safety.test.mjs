import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {inventory, saveMap} from '../scripts/inventory.mjs';
import {generate, indexText} from '../scripts/cli.mjs';
const scratch=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../work');
async function fixture(t){await fs.mkdir(scratch,{recursive:true});const root=await fs.mkdtemp(path.join(scratch,'safety-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('Git ignores and private filenames are excluded, generated data does not affect fingerprints',async t=>{
 const root=await fixture(t);execFileSync('git',['init',root],{stdio:'ignore',windowsHide:true});
 await fs.writeFile(path.join(root,'.gitignore'),'ignored.ts\n');
 for(const name of ['ignored.ts','credentials.json','config.yaml','main.ts'])await fs.writeFile(path.join(root,name),'{}');
 execFileSync('git',['-C',root,'add','main.ts'],{stdio:'ignore',windowsHide:true});
 const scan=await inventory(root);assert.deepEqual(scan.files.map(f=>f.path),['main.ts']);
 const {map}=await generate(root);await saveMap(root,map,indexText(map));
 assert.equal((await inventory(root)).fingerprint,scan.fingerprint);
 await fs.rm(path.join(root,'main.ts'));
 const deleted=await inventory(root);assert.notEqual(deleted.fingerprint,scan.fingerprint);
 assert.deepEqual(deleted.issues,[], 'tracked working-tree deletions are changes, not unreadable files');
});
test('oversized input is explicitly partial; unreadable roots fail rather than become empty maps',async t=>{
 const root=await fixture(t);await fs.writeFile(path.join(root,'large.ts'),'x'.repeat(20));
 const scan=await inventory(root,{limits:{fileBytes:10}});assert.equal(scan.files.length,0);assert.equal(scan.issues[0].reason,'byte limit');
 await assert.rejects(()=>inventory(path.join(root,'absent')));
});
test('directory junctions cannot pull code in from outside the repository or redirect the cache',async t=>{
 const root=await fixture(t),outside=await fixture(t);await fs.writeFile(path.join(outside,'private.ts'),'export const secret=1;');
 await fs.symlink(outside,path.join(root,'linked'),'junction');
 assert.equal((await inventory(root)).files.length,0);
 await fs.symlink(outside,path.join(root,'.repo-map'),'junction');
 await assert.rejects(()=>saveMap(root,{schema:2},'test'));
 assert.deepEqual(await fs.readdir(outside),['private.ts']);
});
test('deletions disappear and unsupported syntax is not presented as a complete graph',async t=>{
 const root=await fixture(t);await fs.writeFile(path.join(root,'code.rs'),'fn main() {}');await fs.writeFile(path.join(root,'bad.ts'),'export function {');
 const {map}=await generate(root);assert.equal(map.files.find(f=>f.path==='code.rs').status,'inventory-only');assert.equal(map.partial,true);
 await saveMap(root,map,indexText(map));await fs.rm(path.join(root,'bad.ts'));
 assert.deepEqual((await generate(root)).map.files.map(f=>f.path),['code.rs']);
});
