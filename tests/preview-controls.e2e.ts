import {_electron as electron,chromium,type Page,type Locator} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {mainWindow,pollState} from './fixtures/poll-state';
import {Store} from '../app/store';
import type {Turn} from '../app/types';
import {saveChatOutput} from '../app/chat-files';
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/preview-controls-')),folder=await fs.mkdtemp(path.join(os.tmpdir(),'ghidorah-preview-'));
await fs.writeFile(path.join(folder,'index.html'),'<title>Preview controls</title><link rel="stylesheet" href="/style.css"><h1>Inside preview</h1><input value="kept"><img src="pixel.svg"><button onclick="document.querySelector(\'h1\').textContent=\'Clicked\'">Change</button>');
await fs.writeFile(path.join(folder,'style.css'),'h1{color:rgb(100,200,150)}');await fs.writeFile(path.join(folder,'pixel.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
await fs.copyFile(path.join(folder,'index.html'),path.join(folder,'next.html'));
const store=new Store(path.join(data,'chat.sqlite')),chatId=store.chat(store.project(folder).id).id,turn=store.accept(crypto.randomUUID(),chatId,'Show a preview','deepseek-flash');
const backend:any={dataRoot:data,host:async(_method:string,args:any)=>{const file=path.join(args.staging,'export.zip');await fs.writeFile(file,'test archive');return {file};}};
const bundle=path.join(folder,'bundle');await fs.mkdir(bundle);for(const name of ['index.html','style.css','pixel.svg'])await fs.copyFile(path.join(folder,name),path.join(bundle,name));
const saved=await saveChatOutput(store,data,turn,folder,{path:bundle},()=>{},new AbortController().signal,backend);
store.update<Turn>('turn',turn.id,{status:'completed',text:'::preview{file="index.html"}\n\n'+saved.preview});store.db.close();
const browser=await chromium.launch({channel:'msedge',headless:true}),external=await browser.newPage();
const app=await electron.launch({args:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data}});
await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
await app.evaluate(({shell})=>{(globalThis as any).previewLinks=[];shell.openExternal=async url=>{(globalThis as any).previewLinks.push(url);};});
const page=await mainWindow(app),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
async function aligned(owner:Page){
 await owner.waitForTimeout(700);
 const rect=await owner.locator('.preview-host').boundingBox();assert.ok(rect);
 const actual=await app.evaluate(({BrowserWindow})=>{const owner=BrowserWindow.getAllWindows().find(w=>w.contentView.children.some(v=>(v as any).webContents?.getURL().startsWith('tris-preview:')))!;const view=owner.contentView.children.find(v=>(v as any).webContents?.getURL().startsWith('tris-preview:'))!;return {bounds:view.getBounds(),visible:view.getVisible(),zoom:owner.webContents.getZoomFactor()};});
 assert.equal(actual.visible,true);
 for(const key of ['x','y','width','height'] as const)assert.ok(Math.abs(actual.bounds[key]-rect[key]*actual.zoom)<=1,`${key}: native ${actual.bounds[key]}, expected ${rect[key]*actual.zoom} at zoom ${actual.zoom}`);
}
async function browserButton(owner:Page|Locator){
 await app.evaluate(()=>{(globalThis as any).previewLinks=[];});await owner.getByRole('button',{name:'Open in browser',exact:true}).click();
 let url='';for(const end=Date.now()+10000;Date.now()<end&&!url;await page.waitForTimeout(100))url=await app.evaluate(()=>(globalThis as any).previewLinks[0]);assert.ok(url,'button calls the OS browser opener');await external.goto(url);await external.getByRole('heading',{name:'Inside preview'}).waitFor();
 assert.equal(await external.locator('h1').evaluate(el=>getComputedStyle(el).color),'rgb(100, 200, 150)');await external.waitForFunction(()=>document.querySelector('img')!.naturalWidth===10);await external.getByRole('button',{name:'Change'}).click();await external.getByRole('heading',{name:'Clicked'}).waitFor();
}
try{
 await pollState(page,s=>s.backend==='ready');await call('wizardFinish');await call('workingFolder',{folder});
 if(await page.getByLabel('Close settings',{exact:true}).isVisible())await page.getByLabel('Close settings',{exact:true}).click();
 await page.locator(`[data-chat-id="${chatId}"] .chat-link`).click();
 const inline=page.locator('.inline-preview');await browserButton(inline.first());await browserButton(inline.nth(1));await inline.first().getByRole('button',{name:'Preview in app',exact:true}).click();await aligned(page);
 await page.getByRole('button',{name:'Chat menu',exact:true}).first().click();await page.getByRole('menuitem',{name:'Chat files',exact:true}).click();await browserButton(page.locator('.chat-file-actions'));await page.locator('.chat-file-actions').getByRole('button',{name:'Preview in app',exact:true}).click();await aligned(page);
 await page.getByLabel('Open files',{exact:true}).click();await page.locator('.workspace-files button').filter({hasText:'index.html'}).click();
 await browserButton(page.locator('.editor-toolbar'));await page.locator('.editor-toolbar').getByRole('button',{name:'Preview in app',exact:true}).click();
 await aligned(page);
 await page.locator('.settings-link').click();await page.getByLabel('Text size',{exact:true}).selectOption('1.25');await page.getByLabel('Close settings',{exact:true}).click();
 await aligned(page);
 await app.evaluate(async({webContents})=>{await webContents.getAllWebContents().find(w=>w.getURL().startsWith('tris-preview:'))!.executeJavaScript('location.href="next.html?mode=wide#section";true');});
 await page.waitForTimeout(500);
 await browserButton(page.locator('.preview-toolbar'));
 assert.match(external.url(),/\/next\.html\?mode=wide#section$/,'browser opens the current local page');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1600,1000));await aligned(page);
 const opening=app.waitForEvent('window');await page.getByRole('button',{name:'Pop out Preview',exact:true}).click();const popped=await opening;await popped.getByRole('button',{name:'Return to main window',exact:true}).waitFor();await aligned(popped);await browserButton(popped);
 await assert.rejects(popped.evaluate(()=>window.desktop.invoke('previewBrowser',{chatId:'foreign',file:'index.html'})),/another chat/);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('#workspace='))!.setSize(950,700));await aligned(popped);
 const closed=popped.waitForEvent('close');await popped.getByRole('button',{name:'Return to main window',exact:true}).click();await closed;await aligned(page);
 await page.locator('.settings-link').click();await page.getByLabel('Text size',{exact:true}).selectOption('1.5');await page.getByLabel('Close settings',{exact:true}).click();await aligned(page);
 await page.screenshot({path:path.join(data,'preview-150.png')});
 const detachedOpening=app.waitForEvent('window');await call('openChatWindow',{chatId});const detached=await detachedOpening;await detached.waitForLoadState();await detached.getByLabel('Open preview',{exact:true}).click();await detached.getByRole('button',{name:'Reopen',exact:true}).click();await aligned(detached);await browserButton(detached.locator('.preview-toolbar'));
 console.log('PASS preview bounds at 100%, 125%, 150%, resizing and detached windows; both controls and real Edge rendering with styles, images and scripts');
}finally{await browser.close();await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close();}
