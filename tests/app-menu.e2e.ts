import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {mainWindow,pollState} from './fixtures/poll-state';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/app-menu-')),folder=await fs.mkdtemp(path.join(root,'work/app-menu-files-'));
let processOutput='';
const launch=async()=>{
 const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath}});
 instance.process().stdout?.on('data',bytes=>processOutput+=bytes.toString());
 await instance.evaluate(({BrowserWindow,Menu,dialog,app},data)=>{
  BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};
  // Capture native surfaces without displaying a menu/dialog over the user's desktop.
  Menu.prototype.popup=function(){(globalThis as any).appMenu=this;};
  (globalThis as any).exitDialogs=[];(globalThis as any).exitAnswer=0;
  dialog.showMessageBox=(async(_window:any,options:any)=>{(globalThis as any).exitDialogs.push(options);return {response:(globalThis as any).exitAnswer,checkboxChecked:false};}) as typeof dialog.showMessageBox;
  app.relaunch=()=>{process.stdout.write('APP_MENU_RELAUNCH_REQUESTED\n');};
 },data);
 return instance;
};
let instance=await launch();
try{
 let page=await mainWindow(instance);page.setDefaultTimeout(15000);
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&s.claude?.models?.some(m=>m.id==='claude-code:haiku')===true);
 await call('wizardFinish');await call('workingFolder',{folder});
 if(await page.getByLabel('Close settings',{exact:true}).isVisible())await page.getByLabel('Close settings',{exact:true}).click();
 const chatId=await call('newChat');await call('addModel',{chatId,model:'claude-code:haiku'});
 const trigger=page.getByRole('button',{name:'Ghidorah menu',exact:true});await trigger.click();
 for(const deadline=Date.now()+5000;!await instance.evaluate(()=>!!(globalThis as any).appMenu)&&Date.now()<deadline;)await page.waitForTimeout(20);
 assert.equal(await trigger.evaluate(el=>getComputedStyle(el).getPropertyValue('-webkit-app-region')),'no-drag');
 assert.equal(await page.locator('.app-titlebar').evaluate(el=>getComputedStyle(el).getPropertyValue('-webkit-app-region')),'drag');
 assert.deepEqual(await instance.evaluate(()=>((globalThis as any).appMenu.items as any[]).filter(i=>i.type!=='separator').map(i=>i.label)),['Restart Ghidorah','Quit Ghidorah']);
 await trigger.focus();await page.keyboard.press('Enter');
 await fs.writeFile(path.join(data,'titlebar.png'),Buffer.from(await instance.evaluate(async({BrowserWindow})=>Array.from((await BrowserWindow.getAllWindows().find(w=>/index\.html$/.test(w.webContents.getURL()))!.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG()))));
 const turnId=crypto.randomUUID(),target=path.join(folder,'pending.txt');
 await call('submit',{chatId,id:turnId,text:JSON.stringify({action:'write',path:target,content:'must not run after exit'}),models:['claude-code:haiku']});
 await pollState(page,s=>s.approvals.some(a=>a.turnId===turnId&&a.status==='pending'));
 await call('draft',{chatId,text:'Keep this chat draft'});await call('terminalOpen',{chatId});await call('workspaceDraft',{dirty:true});
 const choose=(label:string)=>instance.evaluate((_electron,label)=>(globalThis as any).appMenu.items.find((item:any)=>item.label===label).click(),label);
 await choose('Restart Ghidorah');
 await page.waitForTimeout(100);
 const warning=await instance.evaluate(()=>(globalThis as any).exitDialogs[0]);
 assert.equal(warning.message,'Restart Ghidorah?');assert.equal(warning.defaultId,0);assert.match(warning.detail,/Active work will stop/);assert.match(warning.detail,/terminals will close/);assert.match(warning.detail,/Unsaved file edits/);
 assert.equal((await call('state')).approvals.some((a:any)=>a.turnId===turnId&&a.status==='pending'),true,'Cancel preserves the running task');
 await choose('Quit Ghidorah');await page.waitForTimeout(100);
 assert.equal(await instance.evaluate(()=>(globalThis as any).exitDialogs.at(-1).message),'Quit Ghidorah?');
 assert.equal(processOutput.includes('APP_MENU_RELAUNCH_REQUESTED'),false,'Cancel schedules no relaunch');
 assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 await instance.evaluate(()=>(globalThis as any).exitAnswer=1);
 const closed=instance.waitForEvent('close',{timeout:30000});await choose('Restart Ghidorah');await closed;
 assert.equal(processOutput.includes('APP_MENU_RELAUNCH_REQUESTED'),true);
 assert.equal(await fs.stat(target).then(()=>true,()=>false),false,'exit does not approve the pending write');
 instance=await launch();page=await mainWindow(instance);await pollState(page,s=>s.backend==='ready');
 let state=await call('state');assert.equal(state.chats.find((c:any)=>c.id===chatId).draft,'Keep this chat draft');assert.equal(state.approvals.some((a:any)=>a.turnId===turnId&&a.status==='pending'),false);assert.equal(state.turns.filter((t:any)=>t.id===turnId).length,1);
 await call('window',{action:'close'});assert.equal((await call('state')).backend,'ready','Close window retains the running app');
 await call('appMenu');
 const quit=instance.waitForEvent('close',{timeout:30000});await choose('Quit Ghidorah');await quit;
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({logoMenu:true,keyboard:true,dragStripPreserved:true,activeWorkWarning:true,unsavedWarning:true,terminalWarning:true,cancelPreservesWork:true,relaunchRequested:true,reopenedProfile:true,draftPreserved:true,noActionReplay:true,closeKeepsRunning:true,quitExits:true,noVisibleWindows:true,relaunchIntercepted:true},null,2));
 console.log('PASS app menu: restart/quit, Cancel, cleanup and preserved history. '+data);
}finally{await instance.evaluate(({app})=>{(globalThis as any).exitAnswer=1;app.quit();}).catch(()=>{});await instance.close().catch(()=>{});}
