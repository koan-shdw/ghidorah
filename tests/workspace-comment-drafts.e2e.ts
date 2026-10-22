import {_electron as electron} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/workspace-comment-drafts-')),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-comment-drafts-')),namespace='Trismegistus/Test/'+path.basename(data);
const git=(...args:string[])=>execFileSync('git',['-C',folder,...args],{windowsHide:true,stdio:'pipe'});
await fs.mkdir(path.join(folder,'subfolder'));
for(const name of ['a.txt','b.txt'])await fs.writeFile(path.join(folder,name),'first\nold\nlast\n');
git('init','-q');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','base');
for(const name of ['a.txt','b.txt'])await fs.writeFile(path.join(folder,name),'first\nnew\nlast\n');
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data}});
try{
 await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
 const page=await mainWindow(app);page.setDefaultTimeout(15000);
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,state=>state.backend==='ready');
 await page.getByLabel('Close settings',{exact:true}).click();
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1550,1000));
 await call('workingFolder',{folder});const chatId=await call('newChat'),other=await call('newChat');
 await page.locator('[data-chat-id="'+chatId+'"] .chat-link').click();
 await page.getByLabel('Open changes',{exact:true}).click();
 const working=(name:string)=>page.locator('.change-list > div').filter({has:page.getByRole('button',{name,exact:true})}).getByRole('button',{name:'Working',exact:true});
 await working('a.txt').click();
 const comment=page.getByLabel('Line comment',{exact:true});
 await page.getByLabel('Comment on new line 2',{exact:true}).click();await comment.fill('keep my unfinished review');
 for(const label of ['Comment on new line 2','Comment on new line 1']){await page.getByLabel(label,{exact:true}).click();assert.equal(await comment.inputValue(),'keep my unfinished review');}
 await working('b.txt').click();assert.equal(await comment.inputValue(),'keep my unfinished review');
 await page.getByLabel('Refresh changes',{exact:true}).click();assert.equal(await comment.inputValue(),'keep my unfinished review');
 await page.locator('[data-chat-id="'+other+'"] .chat-link').click();assert.equal(await comment.inputValue(),'keep my unfinished review');
 await assert.rejects(call('sidebarChat',{action:'delete',chatId}),/Save or discard workspace edits/);
 await page.getByLabel('Open files',{exact:true}).click();await page.locator('.workspace-files button').filter({hasText:'subfolder'}).click();
 await page.getByRole('alert').filter({hasText:'Save or cancel the line comment'}).first().waitFor();
 await page.getByLabel('Open changes',{exact:true}).click();assert.equal(await comment.inputValue(),'keep my unfinished review');
 // A failed durable write must leave the only copy in the editor.
 await page.evaluate(()=>{const original=Storage.prototype.setItem;(window as any).restoreCommentStorage=()=>{Storage.prototype.setItem=original;};Storage.prototype.setItem=function(key,value){if(key.startsWith('diff-comments:'))throw Error('fixture: storage full');return original.call(this,key,value);};});
 await page.getByRole('button',{name:'Save comment',exact:true}).click();await page.getByRole('status').filter({hasText:'Comments could not be saved'}).waitFor();assert.equal(await comment.inputValue(),'keep my unfinished review');
 await page.evaluate(()=>(window as any).restoreCommentStorage());await page.getByRole('button',{name:'Save comment',exact:true}).click();await page.getByText('keep my unfinished review',{exact:true}).waitFor();assert.equal(await comment.count(),0);
 await page.locator('[data-chat-id="'+other+'"] .chat-link').click();await pollState(page,state=>state.chatLayout?.chatId===other);
 assert.equal(await page.getByText('keep my unfinished review',{exact:true}).count(),0);
 await page.locator('[data-chat-id="'+chatId+'"] .chat-link').click();await page.getByText('keep my unfinished review',{exact:true}).waitFor();
 // Begin a slow refresh, then type. The eventual response must not erase new text.
 await app.evaluate(({ipcMain})=>{const handler=(ipcMain as any)._invokeHandlers.get('app');(globalThis as any).commentRefreshRelease=null;ipcMain.removeHandler('app');ipcMain.handle('app',async(event,method,args)=>{if(method==='workspaceChanges'&&!args?.file)await new Promise(resolve=>{(globalThis as any).commentRefreshRelease=resolve;});return handler(event,method,args);});(globalThis as any).restoreCommentHandler=()=>{ipcMain.removeHandler('app');ipcMain.handle('app',handler);};});
 await page.getByLabel('Refresh changes',{exact:true}).click();
 for(const end=Date.now()+5000;!await app.evaluate(()=>(globalThis as any).commentRefreshRelease!==null);){assert.ok(Date.now()<end,'refresh did not start');await page.waitForTimeout(50);}
 await page.getByLabel('Comment on new line 1',{exact:true}).click();await comment.fill('typed during refresh');
 await app.evaluate(()=>{(globalThis as any).commentRefreshRelease();(globalThis as any).restoreCommentHandler();});
 await page.getByRole('alert').filter({hasText:'Save or cancel the line comment'}).first().waitFor();assert.equal(await comment.inputValue(),'typed during refresh');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await working('b.txt').click();await page.locator('.editor-toolbar').filter({hasText:'b.txt'}).waitFor();
 console.log(data);
}catch(error){console.error('Profile: '+data,error);for(const view of app.windows())await view.screenshot({path:path.join(data,'failure.png')}).catch(()=>{});throw error;
}finally{await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});}).catch(()=>{});await app.close();execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1]+'/encryption')",namespace],{windowsHide:true});}
