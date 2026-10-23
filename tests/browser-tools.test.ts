import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {installProgram,installedProgram,programs,readScreenSettings,windowsTar} from '../app/browser-tools';

test('screen control: on by default, his own Chrome carries over from the old choice; pins are complete',()=>{
 assert.deepEqual(readScreenSettings(undefined),{screen:true,ownChrome:false});assert.deepEqual(readScreenSettings({choice:'claude'}),{screen:true,ownChrome:true});
 assert.deepEqual(readScreenSettings({screen:false,ownChrome:false,choice:'claude'}),{screen:false,ownChrome:false});
 for(const pin of Object.values(programs)){assert.match(pin.url,/^https:\/\//);assert.ok(pin.hash.value.length>40);}
});

test('ZIP installs reject missing binaries and linked destinations without touching the old tool',async()=>{
 const root=await fs.mkdtemp(path.join(path.resolve('work'),'program-zip-')),source=path.join(root,'source');
 await fs.mkdir(source);await fs.writeFile(path.join(source,'cua-driver.exe'),'MZzip-fixture');
 const archive=path.join(root,'driver.zip');execFileSync(windowsTar,['-a','-cf',archive,'-C',source,'cua-driver.exe'],{windowsHide:true});
 const bytes=await fs.readFile(archive),server=createServer((_req,res)=>res.end(bytes));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const pin=programs['cua-driver'],saved={...pin},data=path.join(root,'data');
 try{
  Object.assign(pin,{url:`http://127.0.0.1:${(server.address() as any).port}/driver.zip`,size:bytes.length,hash:{algorithm:'sha256',encoding:'hex',value:createHash('sha256').update(bytes).digest('hex')}});
  const file=await installProgram(data,'cua-driver',()=>{});assert.equal(await fs.readFile(file,'utf8'),'MZzip-fixture');
  pin.binary='missing.exe';await assert.rejects(installProgram(data,'cua-driver',()=>{}),/one unambiguous/);assert.equal(await fs.readFile(file,'utf8'),'MZzip-fixture');pin.binary=saved.binary;
  const linked=path.join(root,'linked');await fs.mkdir(linked);await fs.symlink(path.join(data,'tools'),path.join(linked,'tools'),'junction');
  assert.equal(installedProgram(linked,'cua-driver'),null);await assert.rejects(installProgram(linked,'cua-driver',()=>{}),/must not be a link/);assert.equal(await fs.readFile(file,'utf8'),'MZzip-fixture');
  await fs.unlink(path.join(linked,'tools'));
 }finally{Object.assign(pin,saved);server.closeAllConnections();server.close();await fs.rm(root,{recursive:true,force:true});}
});

test('a program installs only when its download matches the pinned hash',async()=>{
 const root=await fs.mkdtemp(path.join(path.resolve('work'),'program-install-')),source=path.join(root,'source');
 await fs.mkdir(path.join(source,'package','bin'),{recursive:true});await fs.writeFile(path.join(source,'package','bin','agent-browser-win32-x64.exe'),'MZstand-in');
 execFileSync(windowsTar,['-czf',path.join(root,'pkg.tgz'),'-C',source,'package'],{windowsHide:true});
 const bytes=await fs.readFile(path.join(root,'pkg.tgz'));
 const server=createServer((_req,res)=>res.end(bytes));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const pin=programs['agent-browser'],saved={...pin};
 try{
  Object.assign(pin,{url:`http://127.0.0.1:${(server.address() as any).port}/pkg.tgz`,size:bytes.length,hash:{algorithm:'sha512',encoding:'base64',value:createHash('sha512').update(bytes).digest('base64')}});
  const data=path.join(root,'data'),seen:string[]=[];
  const file=await installProgram(data,'agent-browser',status=>seen.push(status));
  assert.equal(await fs.readFile(file,'utf8'),'MZstand-in');assert.equal(installedProgram(data,'agent-browser'),file);assert.ok(seen.includes('Installed'));
  pin.hash={...pin.hash,value:'A'.repeat(88)};
  await assert.rejects(installProgram(data,'agent-browser',()=>{}),/did not match its pinned hash/);
  assert.equal(installedProgram(data,'agent-browser'),file,'a bad replacement preserves the installed version');assert.equal(await fs.readFile(file,'utf8'),'MZstand-in');
  const cancel=new AbortController();cancel.abort();await assert.rejects(installProgram(data,'agent-browser',()=>{},cancel.signal),/abort/i);assert.equal(installedProgram(data,'agent-browser'),file);
  Object.assign(pin,{hash:{algorithm:'sha512',encoding:'base64',value:createHash('sha512').update(bytes).digest('base64')}});
  await installProgram(data,'agent-browser',()=>{});const backups=(await fs.readdir(path.dirname(path.dirname(path.dirname(file))))).filter(name=>name.includes('.previous-'));assert.equal(backups.length,1,'one prior working version is retained');
 }finally{Object.assign(pin,saved);server.closeAllConnections();server.close();await fs.rm(root,{recursive:true,force:true});}
});
