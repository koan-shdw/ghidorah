// Settings > Appearance (Koan 2026-10-16): Text size ("add settings for making the font bigger") zooms the whole window,
// like Claude's View > Zoom; Font ("a drop down selector ... with all the main fonts including helv") lists only fonts
// Windows has, starts on Helvetica, and is checked as the font Chromium draws, not the name in the CSS; five themes paint
// their own colours. Size and font reach an open chat window and are kept after a restart. Runs on the source build and,
// with TRISMEGISTUS_EXE, on a release build (inspector fuse off: Chromium CDP, as finish-W).
import {_electron as electron,type Page} from 'playwright';import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';
import {Backend,PYTHON} from '../app/backend';import {mainWindow,pollState} from './fixtures/poll-state';import {launchPackaged} from './fixtures/launch-packaged';
const root=process.cwd(),packaged=!!process.env.TRISMEGISTUS_EXE,data=await fs.mkdtemp(path.join(root,'work','appearance-')),folder=await fs.mkdtemp(path.join(root,'work','appearance-folder-')),namespace='Trismegistus/Test/'+path.basename(data);
const host=new Backend(packaged?path.join(path.dirname(process.env.TRISMEGISTUS_EXE!),'resources'):root,data,namespace,()=>{});await host.host('initialize');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
type Run={page:Page;nextWindow:()=>Promise<Page>;quit:()=>Promise<void>};
const launch=async():Promise<Run>=>{
 if(packaged){const {page,close}=await launchPackaged(env);return {page,nextWindow:()=>page.context().waitForEvent('page'),quit:close};}
 const app=await electron.launch({args:[root,'--hidden'],env});await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
 return {page:await mainWindow(app),nextWindow:()=>app.waitForEvent('window'),quit:async()=>{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}};
};
// Page zoom shows in devicePixelRatio, so the ratio to the 100% reading is the zoom factor.
let base=0;const ratio=(view:Page)=>view.evaluate(()=>window.devicePixelRatio);
const settle=async(views:Page[],factor:number)=>{let last:number[]=[];for(const end=Date.now()+10000;Date.now()<end;await new Promise(r=>setTimeout(r,100))){last=await Promise.all(views.map(async view=>await ratio(view)/base));if(last.every(z=>Math.abs(z-factor)<0.01))return;}throw Error(`Windows at ${last.join(', ')}, expected ${factor}`);};
// The platform font Chromium used for the first ordinary text in the window (CDP CSS.getPlatformFontsForNode), after a
// forced layout: hidden test windows can skip it and report the font from before a change.
const drawn=async(view:Page)=>{
 await view.evaluate(()=>{document.querySelector('[data-font-probe]')?.removeAttribute('data-font-probe');const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);for(let node=walk.nextNode();node;node=walk.nextNode()){const parent=node.parentElement;if(node.textContent?.trim()&&parent&&!parent.closest('pre,code,svg,.welcome-art,textarea,select')){parent.setAttribute('data-font-probe','');void document.body.offsetHeight;return;}}});
 const cdp=await view.context().newCDPSession(view);
 try{await cdp.send('DOM.enable');await cdp.send('CSS.enable');const {root}=await cdp.send('DOM.getDocument',{depth:-1});const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector:'[data-font-probe]'});return (await cdp.send('CSS.getPlatformFontsForNode',{nodeId})).fonts.map(font=>font.familyName);}
 finally{await cdp.detach();}
};
// Windows names some weights as families of their own (Inter SemiBold), so each check lists the faces it accepts.
const drawsIn=async(view:Page,families:string[])=>{let last:string[]=[];for(const end=Date.now()+10000;Date.now()<end;await new Promise(r=>setTimeout(r,100))){last=await drawn(view);if(families.includes(last[0]))return;}throw Error(`Window draws ${last.join(', ')}, expected ${families.join(' or ')}`);};
const helvetica=['Helvetica'],inter=['Inter','Inter Medium','Inter SemiBold'];
let run=await launch();
try{
 let page=run.page;page.setDefaultTimeout(20000);const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready');await call('wizardFinish');await call('workingFolder',{folder});const chatId=await call('newChat');
 if(await page.getByLabel('Close settings',{exact:true}).isVisible())await page.getByLabel('Close settings',{exact:true}).click();
 base=await ratio(page);
 const installed=(await call('fontFamilies') as string[]).map(name=>name.toLowerCase());assert.ok(installed.includes('helvetica')&&installed.includes('inter'),'this test needs Helvetica and Inter installed');
 await page.locator('.settings-link').dispatchEvent('click');const size=page.getByLabel('Text size',{exact:true}),font=page.getByLabel('Font',{exact:true});
 assert.equal(await size.inputValue(),'1','100% by default');assert.equal(await font.inputValue(),'Helvetica','Helvetica by default');
 await page.waitForFunction(()=>document.querySelectorAll('select[aria-label="Font"] option').length>1);
 const choices=await font.locator('option').allTextContents();assert.equal(choices[0],'Helvetica');
 for(const name of choices)assert.ok(installed.includes(name.toLowerCase()),`${name} is listed only when Windows has it`);
 await drawsIn(page,helvetica);
 // Themes (Koan 2026-10-16: "give me color themes in settings"): each one paints its own background, Dark last.
 for(const [value,background,text] of [['light','rgb(250, 249, 245)','rgb(41, 40, 36)'],['black','rgb(0, 0, 0)','rgb(236, 236, 236)'],['contrast','rgb(0, 0, 0)','rgb(255, 255, 255)'],['paper','rgb(243, 234, 214)','rgb(58, 50, 39)'],['dark','rgb(20, 20, 19)','rgb(232, 230, 220)']]){
  await page.getByLabel('Theme',{exact:true}).selectOption(value);
  assert.deepEqual(await page.evaluate(()=>{const style=getComputedStyle(document.documentElement);return [document.documentElement.dataset.theme,style.backgroundColor,style.color];}),[value,background,text],value+' theme');
 }
 const opened=run.nextWindow();await call('openChatWindow',{chatId});const detached=await opened;await detached.waitForLoadState();
 await settle([page,detached],1);await drawsIn(detached,helvetica);
 await size.selectOption('1.25');await settle([page,detached],1.25);
 await font.selectOption('Inter');await drawsIn(page,inter);await drawsIn(detached,inter);
 // A release build can only be killed here (closing its window hides it), and Chromium writes local storage on a clean
 // exit, so the restart is checked on the source build, which quits cleanly. His Quit (menu) is a clean exit.
 if(!packaged){
 await run.quit();
 run=await launch();page=run.page;await pollState(page,s=>s.backend==='ready');await settle([page],1.25);await drawsIn(page,inter);
 await page.locator('.settings-link').dispatchEvent('click');assert.equal(await page.getByLabel('Text size',{exact:true}).inputValue(),'1.25','size kept after a restart');assert.equal(await page.getByLabel('Font',{exact:true}).inputValue(),'Inter','font kept after a restart');
 }
 await page.getByLabel('Text size',{exact:true}).selectOption('1');await settle([page],1);await page.getByLabel('Font',{exact:true}).selectOption('Helvetica');await drawsIn(page,helvetica);
 await assert.doesNotReject(page.evaluate(()=>window.desktop.textSize(40)));await settle([page],1);
 console.log(`PASS (${packaged?'release':'source'} build) Five themes paint their own colours, Text size zooms and Font draws Helvetica then Inter in the main and chat windows, only installed fonts listed, ${packaged?'':'both kept after a restart, '}out-of-range sizes ignored`);
}catch(error){console.log('Appearance evidence: '+data);throw error;}
finally{await run.quit().catch(()=>{});execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});}
