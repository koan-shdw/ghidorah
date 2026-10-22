import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {existingAppPath} from '../app/app-repositories';

test('existing absolute repositories can be outside the workspace; private paths and relative escapes cannot',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tris-app-paths-')),base=path.join(root,'workspace'),external=path.join(root,'external'),privateRoot=path.join(root,'private');
 for(const folder of [base,external,privateRoot])await fs.mkdir(folder);
 assert.equal(await existingAppPath(base,external,privateRoot),await fs.realpath(external));
 assert.equal(await existingAppPath(null,external,privateRoot),await fs.realpath(external));
 await assert.rejects(existingAppPath(base,'../external',privateRoot),/inside the working folder/);
 await assert.rejects(existingAppPath(base,privateRoot,privateRoot),/private account/);
 const alias=path.join(base,'alias');await fs.symlink(privateRoot,alias,process.platform==='win32'?'junction':'dir');
 await assert.rejects(existingAppPath(base,alias,privateRoot),/private account/);
 const config=path.join(external,'auth.json');await fs.writeFile(config,'private');await assert.rejects(existingAppPath(base,config,privateRoot),/private account/);
});
