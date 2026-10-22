import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {listWorkspace,readWorkspaceFile,saveWorkspaceFile,workspacePath} from '../app/workspace-files';

test('editor preserves encoding and refuses stale saves and links outside the root',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tris-editor-')),outside=await fs.mkdtemp(path.join(os.tmpdir(),'tris-outside-'));
  await fs.writeFile(path.join(root,'code.txt'),'\uFEFFone\r\ntwo\r\n');
  const opened=readWorkspaceFile(root,'code.txt');assert.equal(opened.text,'one\r\ntwo\r\n');assert.equal(opened.lineEnding,'\r\n');
  const saved=saveWorkspaceFile(root,'code.txt','edited\r\n',opened.revision);assert.equal(await fs.readFile(path.join(root,'code.txt'),'utf8'),'\uFEFFedited\r\n');
  await fs.writeFile(path.join(root,'code.txt'),'external edit\n');
  assert.throws(()=>saveWorkspaceFile(root,'code.txt','stale',saved.revision),/changed on disk/);assert.equal(await fs.readFile(path.join(root,'code.txt'),'utf8'),'external edit\n');
  await fs.symlink(outside,path.join(root,'external'),'junction');
  assert.throws(()=>workspacePath(root,'external'),/outside/);
  assert.throws(()=>workspacePath(root,'../outside'),/inside/);
  assert.throws(()=>workspacePath(root,'code.txt:stream'),/inside/);
  await fs.writeFile(path.join(root,'binary.bin'),Buffer.from([1,0,255]));assert.throws(()=>readWorkspaceFile(root,'binary.bin'),/UTF-8/);
  await fs.writeFile(path.join(root,'legacy.txt'),Buffer.from([255,254,1]));assert.throws(()=>readWorkspaceFile(root,'legacy.txt'),/UTF-8/);
  assert.equal(listWorkspace(root).entries.find(item=>item.name==='external')?.link,true);
});
