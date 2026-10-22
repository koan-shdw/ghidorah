import {_electron as electron} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {PYTHON} from '../app/backend';
import {Store} from '../app/store';
import {mainWindow,pollState} from './fixtures/poll-state';
import type {Turn} from '../app/types';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/workspace-transition-')),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-transition-')),next=await fs.mkdtemp(path.join(os.tmpdir(),'tris-transition-next-')),namespace='Trismegistus/Test/'+path.basename(data);
await fs.writeFile(path.join(folder,'a.txt'),'first file');await fs.writeFile(path.join(folder,'b.txt'),'second file');await fs.writeFile(path.join(folder,'page.html'),'<h1>Linked preview</h1>');
const store=new Store(path.join(data,'chat.sqlite')),projects=[store.project(folder),store.project(folder)],chats=projects.map(project=>store.chat(project.id)),turns=chats.map(chat=>{const turn=store.accept(crypto.randomUUID(),chat.id,'saved file links');store.update<Turn>('turn',turn.id,{status:'completed',text:'Saved response'});return turn;});
store.put('settings',{id:'working-folder',folder});store.db.close();
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data}});
try{
 const page=await mainWindow(app);page.setDefaultTimeout(15000);
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,state=>state.backend==='ready');await page.getByLabel('Close settings',{exact:true}).click();
 // Work started while the native folder picker was open must keep the old root.
 await app.evaluate(({dialog})=>{const original=dialog.showOpenDialog;(globalThis as any).restoreFolderDialog=()=>{dialog.showOpenDialog=original;};dialog.showOpenDialog=()=>new Promise(resolve=>{(globalThis as any).folderChoice=resolve;});});
 const changing=call('workingFolder').then(()=>'',String);
 for(const end=Date.now()+5000;!await app.evaluate(()=>!!(globalThis as any).folderChoice);){assert.ok(Date.now()<end);await page.waitForTimeout(50);}
 const terminal=await call('terminalOpen',{chatId:chats[0].id});
 await app.evaluate((_electron,next)=>{(globalThis as any).folderChoice({filePaths:[next],canceled:false});(globalThis as any).restoreFolderDialog();},next);
 assert.match(await changing,/Close open terminals/);assert.equal((await call('state')).defaultFolder,folder);await call('terminalClose',{chatId:chats[0].id,id:terminal.id});
 // Hold and fail the second profile write, after the first profile changed on disk.
 const originals=new Map<string,string>();for(const project of projects)for(const name of ['config.yaml','trismegistus-policy.json']){const file=path.join(data,'hermes/profiles',project.profile,name);originals.set(file,await fs.readFile(file,'utf8'));}
 const target=path.join(data,'hermes/profiles',projects[1].profile,'config.yaml');
 await app.evaluate((_electron,target)=>{const fs=process.getBuiltinModule('fs/promises'),original=fs.writeFile;(globalThis as any).folderWriteRelease=null;fs.writeFile=(async(file:any,...args:any[])=>{if(String(file)===target){await new Promise(resolve=>{(globalThis as any).folderWriteRelease=resolve;});fs.writeFile=original;throw Error('fixture: second profile write failed');}return (original as any)(file,...args);}) as any;},target);
 const failed=call('workingFolder',{folder:next}).then(()=>'',String);
 for(const end=Date.now()+5000;!await app.evaluate(()=>!!(globalThis as any).folderWriteRelease);){assert.ok(Date.now()<end);await page.waitForTimeout(50);}
 for(const [method,args] of [['terminalOpen',{chatId:chats[0].id}],['submit',{id:crypto.randomUUID(),chatId:chats[0].id,text:'must not send'}],['newChat',{}],['mode',{projectId:projects[0].id,mode:'bypass'}]] as const)await assert.rejects(call(method,args),/working folder change/);
 await app.evaluate(()=>(globalThis as any).folderWriteRelease());assert.match(await failed,/second profile write failed/);
 const unchanged=await call('state');assert.equal(unchanged.defaultFolder,folder);assert.ok(unchanged.projects.every((project:any)=>project.folder===folder));for(const [file,contents] of originals)assert.equal(await fs.readFile(file,'utf8'),contents,file);
 // File and preview links reuse the matching window and refuse another chat's owner.
 let opening=app.waitForEvent('window');await call('workspaceWindowOpen',{view:'files',chatId:chats[0].id,file:'a.txt'});const files=await opening;await files.getByRole('textbox',{name:'File contents',exact:true}).waitFor();
 await call('chatLink',{turnId:turns[0].id,href:'b.txt'});await files.waitForFunction(()=>document.querySelector('.cm-content')?.textContent==='second file');
 await assert.rejects(call('workspaceWindowOpen',{view:'files',chatId:chats[1].id}),/another chat/);await assert.rejects(call('chatLink',{turnId:turns[1].id,href:'a.txt'}),/another chat/);
 const editor=files.getByRole('textbox',{name:'File contents',exact:true});await editor.fill('unfinished popup edit');await call('chatLink',{turnId:turns[0].id,href:'a.txt'});await files.getByRole('alert').filter({hasText:'Save or discard'}).waitFor();assert.equal(await editor.innerText(),'unfinished popup edit');await files.getByRole('button',{name:'Save',exact:true}).click();
 opening=app.waitForEvent('window');await call('workspaceWindowOpen',{view:'preview',chatId:chats[0].id});const preview=await opening;await preview.getByLabel('Preview address',{exact:true}).waitFor();await call('chatLink',{turnId:turns[0].id,href:'page.html'});await preview.waitForFunction(()=>document.querySelector<HTMLInputElement>('[aria-label="Preview address"]')?.value==='page.html');
 for(const view of [files,preview]){const closed=view.waitForEvent('close');void view.getByRole('button',{name:'Return to main window',exact:true}).click().catch(()=>{});await closed;}
 await call('workingFolder',{folder:next});const changed=await call('state');assert.equal(changed.defaultFolder,next);assert.ok(changed.projects.every((project:any)=>project.folder===next));
 for(const project of projects){assert.equal(JSON.parse(await fs.readFile(path.join(data,'hermes/profiles',project.profile,'config.yaml'),'utf8')).terminal.cwd,next);assert.equal(JSON.parse(await fs.readFile(path.join(data,'hermes/profiles',project.profile,'trismegistus-policy.json'),'utf8')).folder,next);}
 console.log(data);
}catch(error){console.error('Profile: '+data,error);for(const [index,view] of app.windows().entries())await view.screenshot({path:path.join(data,'failure-'+index+'.png')}).catch(()=>{});throw error;
}finally{await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});}).catch(()=>{});await app.close();execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1]+'/encryption')",namespace],{windowsHide:true});}
