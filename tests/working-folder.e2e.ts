import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {mainWindow,pollState} from './fixtures/poll-state';

// The private data directory, a folder inside it and a junction into it are refused as the root working folder; nothing saved changes.
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/working-folder-')),outside=await fs.mkdtemp(path.join(os.tmpdir(),'tris-working-folder-'));
const folder=path.join(outside,'normal root folder'),descendant=path.join(data,'nested','inside'),junction=path.join(outside,'link into data');
await fs.mkdir(folder);await fs.mkdir(descendant,{recursive:true});await fs.symlink(data,junction,'junction');
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath},timeout:30000});
try{
 const page=await mainWindow(app);page.setDefaultTimeout(15000);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.hide()));
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,state=>state.backend==='ready');
 const profiles=async()=>{const state=await call('state');return Promise.all(state.projects.map(async(project:any)=>[project.folder,...await Promise.all(['config.yaml','trismegistus-policy.json'].map(name=>fs.readFile(path.join(data,'hermes','profiles',project.profile,name),'utf8').catch(()=>null)))]));};
 const refused=async(expected:string|null)=>{
  const before=await profiles();
  for(const bad of [data,descendant,junction])await assert.rejects(call('workingFolder',{folder:bad}),/Protected credential directory/,bad);
  const state=await call('state');assert.equal(state.defaultFolder,expected);assert.ok(state.projects.length>=2);assert.ok(state.projects.every((project:any)=>project.folder===expected));
  assert.deepEqual(await profiles(),before,'project profiles are unchanged');
 };
 await call('workingFolder',{folder});await call('addProject');await call('addProject');
 let state=await call('state');assert.equal(state.defaultFolder,folder);assert.ok(state.projects.every((project:any)=>project.folder===folder));
 await refused(folder);
 await call('workingFolder',{clear:true});state=await call('state');assert.equal(state.defaultFolder,null);assert.ok(state.projects.every((project:any)=>project.folder===null));
 await refused(null);
 await call('workingFolder',{folder});state=await call('state');assert.equal(state.defaultFolder,folder);assert.ok(state.projects.every((project:any)=>project.folder===folder));
 const chatId=await call('newChat');state=await call('state');assert.equal(state.projects.find((project:any)=>project.id===state.chats.find((chat:any)=>chat.id===chatId).projectId).folder,folder);
 console.log('PASS a normal root with spaces works and clears; the data directory, a descendant and a junction into it are refused without changing the saved root or project folders. Evidence: '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});await fs.unlink(junction).catch(()=>{});}
