import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {stageRuntime} from '../scripts/stage-runtime.mjs';

test('runtime staging contains exactly committed eligible blobs and preserves the prior runtime',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tris-stage-')),fork=path.join(root,'fork'),app=path.join(root,'app');
  const git=(...args:string[])=>execFileSync('git',args,{cwd:fork,windowsHide:true,encoding:'utf8'}).trim();
  try{
    await fs.mkdir(path.join(fork,'agent'),{recursive:true});git('init','-q');
    await fs.writeFile(path.join(fork,'agent','one.py'),'print("committed")\n');
    await fs.writeFile(path.join(fork,'secret.env'),'excluded');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
    await fs.writeFile(path.join(fork,'agent','untracked.py'),'must not ship');
    await fs.mkdir(path.join(app,'runtime','hermes'),{recursive:true});await fs.writeFile(path.join(app,'runtime','hermes','stale.py'),'previous');
    const manifest=await stageRuntime(app,fork),files=await fs.readdir(path.join(app,'runtime','hermes'),{recursive:true});
    assert.deepEqual(files.sort(),['agent',path.join('agent','one.py')].sort());
    const bytes=execFileSync('git',['show','HEAD:agent/one.py'],{cwd:fork,windowsHide:true});
    assert.deepEqual(await fs.readFile(path.join(app,'runtime','hermes','agent','one.py')),bytes);
    assert.deepEqual(manifest.files,{'agent/one.py':createHash('sha256').update(bytes).digest('hex')});assert.equal(manifest.fork,git('rev-parse','HEAD'));
    const backup=(await fs.readdir(path.join(app,'work')))[0];assert.equal(await fs.readFile(path.join(app,'work',backup,'previous','stale.py'),'utf8'),'previous');
    await fs.writeFile(path.join(fork,'agent','one.py'),'uncommitted');await assert.rejects(stageRuntime(app,fork),/Commit or restore/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(app,'runtime','hermes-manifest.json'),'utf8')),manifest);
  }finally{
    assert.ok(root.startsWith(path.join(os.tmpdir(),'tris-stage-')));await fs.rm(root,{recursive:true,force:true});
  }
});

test('runtime staging reads Hermes from a folder of the app repository',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tris-stage-')),app=path.join(root,'app');
  const git=(...args:string[])=>execFileSync('git',args,{cwd:app,windowsHide:true,encoding:'utf8'}).trim();
  try{
    await fs.mkdir(path.join(app,'hermes','agent'),{recursive:true});git('init','-q');
    await fs.writeFile(path.join(app,'hermes','agent','one.py'),'print("committed")\n');await fs.writeFile(path.join(app,'main.ts'),'app');
    git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
    await fs.writeFile(path.join(app,'main.ts'),'app changes do not block Hermes staging');
    const manifest=await stageRuntime(app,app,'hermes');
    assert.deepEqual(Object.keys(manifest.files),['agent/one.py']);assert.equal(manifest.fork,git('rev-parse','HEAD'));
    await fs.writeFile(path.join(app,'hermes','agent','one.py'),'uncommitted');await assert.rejects(stageRuntime(app,app,'hermes'),/Commit or restore/);
  }finally{
    assert.ok(root.startsWith(path.join(os.tmpdir(),'tris-stage-')));await fs.rm(root,{recursive:true,force:true});
  }
});
