import {pollState} from './fixtures/poll-state';
import {_electron as electron} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PYTHON} from '../app/backend';
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/window-layout-')),namespace='Trismegistus/Test/'+path.basename(data);
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data}});let app=await launch();
// After a relaunch the restored chat windows can attach before the main window, so the main window is found by its
// address, never by which window appeared first (0b: run 5 closed the 'main' page when it was a chat window).
const mainWindow=async()=>{const end=Date.now()+30000;for(;;){const page=app.windows().find(page=>/index\.html$/.test(page.url()));if(page)return page;if(Date.now()>end)throw Error('The main window did not open.');await new Promise(resolve=>setTimeout(resolve,100));}};
try{
 let main=await app.firstWindow();main.setDefaultTimeout(15000);const call=(method:string,args:any={})=>main.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const ready=async()=>{await pollState(main,state=>state.backend==='ready');await main.getByLabel('Close settings',{exact:true}).click();};await ready();
 const first=await call('newChat'),second=await call('newChat');let opening=app.waitForEvent('window');await call('openChatWindow',{chatId:first});let firstPage=await opening;await firstPage.getByLabel('Message',{exact:true}).fill('first window draft');opening=app.waitForEvent('window');await call('openChatWindow',{chatId:second});let secondPage=await opening;await secondPage.getByLabel('Message',{exact:true}).fill('second window draft');
 const bounds=await app.evaluate(({BrowserWindow},id)=>{const view=BrowserWindow.getAllWindows().find(view=>view.webContents.getURL().endsWith('#chat='+id))!;view.setBounds({x:80,y:70,width:760,height:620});return view.getNormalBounds();},first);
 await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows().find(view=>view.webContents.getURL().endsWith('#chat='+id))!.maximize(),second);
 await app.close();app=await launch();main=await mainWindow();await ready();await pollState(main,state=>state.chatWindows?.length===2);await Promise.all(app.windows().map(page=>page.waitForLoadState()));firstPage=app.windows().find(page=>page.url().endsWith('#chat='+first))!;secondPage=app.windows().find(page=>page.url().endsWith('#chat='+second))!;assert.ok(firstPage&&secondPage);
 for(const page of [firstPage,secondPage])await page.waitForFunction(()=>{const input=document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]');return input&&!input.disabled;});assert.equal(await firstPage.getByLabel('Message',{exact:true}).inputValue(),'first window draft');assert.equal(await secondPage.getByLabel('Message',{exact:true}).inputValue(),'second window draft');assert.deepEqual(await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows().find(view=>view.webContents.getURL().endsWith('#chat='+id))!.getNormalBounds(),first),bounds);assert.equal(await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows().find(view=>view.webContents.getURL().endsWith('#chat='+id))!.isMaximized(),second),true);assert.equal((await call('state')).turns.length,0);
 await Promise.all([firstPage.waitForEvent('close'),firstPage.getByLabel('Close chat window',{exact:true}).click({noWaitAfter:true}).catch((error:Error)=>{if(!/closed/i.test(error.message))throw error;})]);await pollState(main,state=>state.chatWindows?.length===1);await app.close();app=await launch();main=await mainWindow();await ready();await pollState(main,state=>state.chatWindows?.length===1);assert.deepEqual((await call('state')).chatWindows,[second]);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({twoWindowsRestored:true,normalBounds:true,maximized:true,drafts:true,closedWindowStaysClosed:true,noInference:true}));console.log(data);
}finally{await app.close();execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1]+'/encryption')",namespace],{windowsHide:true});}
