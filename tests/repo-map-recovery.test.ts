import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildRepoMap} from '../app/repo-map';

test('the recovered scanner counts readable code and respects its read budget',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'recovered-map-'));
 try{
  await fs.mkdir(path.join(root,'src'));await fs.writeFile(path.join(root,'src','main.ts'),'export const value=1;\n');
  const result=await buildRepoMap(root);assert.equal(result.error,'');assert.equal(result.name,path.basename(root));assert.equal(result.files,1);assert.equal(result.nodes[0].lines,2);assert.equal(result.nodes[0].kind,'code');
  await fs.writeFile(path.join(root,'src','main.ts'),'x'.repeat(200001));assert.equal((await buildRepoMap(root)).truncated,true);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
