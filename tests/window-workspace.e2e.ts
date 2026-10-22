import {_electron as electron} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/window-workspace-')),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-window-workspace-'));
await fs.writeFile(path.join(folder,'note.txt'),'original');await fs.writeFile(path.join(folder,'index.html'),'<h1>Window preview</h1><p id="isolation"></p><script>document.querySelector("#isolation").textContent=typeof window.desktop+" / "+typeof require</script>');
const git=(...args:string[])=>execFileSync('git',['-C',folder,...args],{windowsHide:true,stdio:'pipe'});git('init','-q');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','base');
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data}});
try{
 const main=await app.firstWindow();main.setDefaultTimeout(15000);
 const invoke=(page:any,method:string,args:any={})=>page.evaluate(({method,args}:any)=>window.desktop.invoke(method,args),{method,args});
 const call=(method:string,args:any={})=>invoke(main,method,args);
 async function wait(check:()=>Promise<boolean>,label:string){for(let n=0;n<900;n++){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out: '+label);}
 await wait(async()=>(await call('state')).backend==='ready','backend');await main.getByLabel('Close settings',{exact:true}).click();await call('workingFolder',{folder});
 const chatId=await call('newChat'),other=await call('newChat');await main.locator('[data-chat-id="'+chatId+'"] .chat-link').click();
 const opening=app.waitForEvent('window');await call('openChatWindow',{chatId});const side=await opening;side.setDefaultTimeout(15000);await side.getByLabel('Open files',{exact:true}).click();
 await side.locator('.workspace-files button').filter({hasText:'note.txt'}).click();const editor=side.getByRole('textbox',{name:'File contents'});await editor.fill('side draft');
 await wait(async()=>{try{await call('workingFolder',{folder});return false;}catch(error){return /Save or discard/.test(String(error));}},'side draft blocks root change');
 // A clean main panel must not erase the side window's dirty flag.
 await call('workspaceDraft',{dirty:false});await assert.rejects(call('workingFolder',{folder}),/Save or discard/);await assert.rejects(call('sidebarChat',{chatId,action:'delete'}),/Save or discard/);
 await app.evaluate(({dialog})=>{(globalThis as any).originalDialog=dialog.showMessageBox;dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});});
 await side.getByLabel('Close chat window',{exact:true}).click();assert.equal(side.isClosed(),false);assert.equal(await editor.textContent(),'side draft');
 await app.evaluate(({app})=>app.quit());assert.equal(await editor.textContent(),'side draft');
 await side.getByRole('button',{name:'Save',exact:true}).click();await wait(async()=>(await fs.readFile(path.join(folder,'note.txt'),'utf8'))==='side draft','save');
 await editor.fill('keep conflict draft');await fs.writeFile(path.join(folder,'note.txt'),'external edit');await side.getByRole('button',{name:'Save',exact:true}).click();await side.getByRole('alert').filter({hasText:'changed on disk'}).waitFor();assert.equal(await editor.textContent(),'keep conflict draft');
 await side.getByRole('button',{name:'Discard',exact:true}).click();await side.getByRole('button',{name:'Discard draft',exact:true}).click();await side.locator('.workspace-files button').filter({hasText:'index.html'}).click();await side.getByRole('button',{name:'Preview in app',exact:true}).click();
 const views=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({url:w.webContents.getURL(),views:w.contentView.children.filter(v=>(v as any).webContents).map(v=>({id:(v as any).webContents.id,url:(v as any).webContents.getURL(),visible:v.getVisible()}))})));
 await wait(async()=>(await views()).some(w=>w.url.endsWith('#chat='+chatId)&&w.views.some(v=>v.url.startsWith('tris-preview:')&&v.visible)),'preview owned by side');
 const preview=(await views()).find(w=>w.url.endsWith('#chat='+chatId))!.views.find(v=>v.url.startsWith('tris-preview:'))!;
 assert.equal(await app.evaluate(({webContents},id)=>webContents.fromId(id)!.executeJavaScript('document.querySelector("#isolation").textContent'),preview.id),'undefined / undefined');
 await assert.rejects(invoke(side,'previewOpen',{chatId:other,file:'index.html'}),/another chat/);await assert.rejects(call('previewOpen',{chatId,file:'index.html'}),/chat window/);
 await assert.rejects(invoke(side,'terminalList',{chatId:other}),/another chat/);await assert.rejects(invoke(side,'workspaceRead',{file:'../outside.txt'}));
 await side.screenshot({path:path.join(data,'preview.png')});
 const png=await app.evaluate(async({webContents},id)=>(await webContents.fromId(id)!.capturePage()).toPNG().toString('base64'),preview.id);await fs.writeFile(path.join(data,'preview-content.png'),Buffer.from(png,'base64'));
 await side.getByRole('button',{name:'Changes',exact:true}).click();await side.getByRole('button',{name:'Working',exact:true}).click();await side.getByLabel('Git diff').filter({hasText:'+external edit'}).waitFor();
 await side.screenshot({path:path.join(data,'changes.png')});
 await side.keyboard.press('Control+Backquote');await wait(async()=>(await invoke(side,'terminalList',{chatId})).length===1,'terminal shortcut');const terminal=(await invoke(side,'terminalList',{chatId}))[0];
 await invoke(side,'terminalWrite',{chatId,id:terminal.id,data:"[IO.File]::WriteAllText('window-terminal.txt', 'window command')\r"});await wait(async()=>fs.stat(path.join(folder,'window-terminal.txt')).then(()=>true,()=>false),'terminal command');
 await side.getByLabel('Hide workspace',{exact:true}).click();await Promise.all([side.waitForEvent('close'),side.getByLabel('Close chat window',{exact:true}).click({noWaitAfter:true}).catch((error:Error)=>{if(!/closed/i.test(error.message))throw error;})]);await wait(async() =>!(await call('state')).chatWindows.includes(chatId),'closed');
 assert.equal((await call('terminalList',{chatId}))[0].id,terminal.id);assert.equal((await call('previewState',{chatId})).restore,true);assert.ok(!(await views()).some(w=>w.views.some(v=>v.id===preview.id)));
 await call('terminalClose',{chatId,id:terminal.id});
 const reopening=app.waitForEvent('window');await call('openChatWindow',{chatId});const reopened=await reopening;await reopened.getByLabel('Open files',{exact:true}).click();await reopened.locator('.workspace-files button').filter({hasText:'note.txt'}).click();await reopened.getByRole('textbox',{name:'File contents'}).fill('discard at close');
 await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});await Promise.all([reopened.waitForEvent('close'),reopened.getByLabel('Close chat window',{exact:true}).click({noWaitAfter:true}).catch((error:Error)=>{if(!/closed/i.test(error.message))throw error;})]);await wait(async() =>!(await call('state')).chatWindows.includes(chatId),'discard close');assert.equal(await fs.readFile(path.join(folder,'note.txt'),'utf8'),'external edit');
 await call('workingFolder',{folder});await app.evaluate(({dialog})=>{dialog.showMessageBox=(globalThis as any).originalDialog;});
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({sideFileSave:true,conflictPreservesDraft:true,dirtyOwnerIsolation:true,closeAndQuitKeepEditing:true,deleteDraftGuard:true,discardClose:true,previewWindowOwnership:true,previewIsolation:true,crossChatRefused:true,terminal:true,gitDiff:true,closeKeepsTerminal:true,previewCloseRetainsRestore:true},null,2));console.log(data);
}finally{await app.evaluate(({dialog,app})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});app.quit();}).catch(()=>{});await app.close().catch(()=>{});execFileSync(path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",'Trismegistus/Test/'+path.basename(data)+'/encryption'],{windowsHide:true});}
