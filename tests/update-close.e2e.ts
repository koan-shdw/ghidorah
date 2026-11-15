// The update window and Settings › Updates with a hidden window open beside the main one. The wake-word listener is a
// hidden 1x1 window; Electron lists the newest window first, and in 0.1.42 every window that was not a chat, job or
// workspace window took the main window's change message, so the main window got none: Close told the app, the app hid
// the window, and the main window never heard. The window now only says what is installed and what is new; the Hermes
// releases (ten wait to roll in here) are answered in Settings › Updates, with a dot on Settings while one is new. A
// plain hidden window stands in for the wake-word one, which needs the wake model and a microphone. Pictures of the
// page and the window in the dark and light themes land in work\desktop-tests\pictures\update-close.
import {_electron as electron} from 'playwright';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {Backend} from '../app/backend';import {mainWindow,pollState,wakeWindows} from './fixtures/poll-state';
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work','update-close-')),namespace='Trismegistus/Test/'+path.basename(data);
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');
// Ten releases newer than the pinned v2026.9.24 (Hermes 0.21.5), none answered.
const releases=['0.21.6','0.21.7','0.22.0','0.22.1','0.22.2','0.22.3','0.22.4','0.22.5','0.22.6','0.22.7'].map((version,index)=>({tag_name:`v2026.10.${index+1}`,name:`Hermes Agent v${version}`,published_at:`2026-10-${String(index+1).padStart(2,'0')}T10:00:00Z`,body:`Fixture notes for ${version}.`,html_url:'https://example.invalid/r'})).reverse();
const hermes=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(releases));});
const hermesFeed=await new Promise<string>(resolve=>hermes.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+(hermes.address() as any).port+'/releases')));
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_HERMES_FEED:hermesFeed},timeout:30000});
const verified:Record<string,boolean>={};
// A passing run's data folder is deleted, so the pictures go where the desktop test logs stay.
const pictures=path.join(root,'work','desktop-tests','pictures','update-close');await fs.mkdir(pictures,{recursive:true});
// The page draws its change first: two frames and a short wait, or the picture shows the frame before.
const picture=async(name:string)=>{const page=await mainWindow(app);await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));await page.waitForTimeout(500);await fs.writeFile(path.join(pictures,name+'.png'),Buffer.from(await app.evaluate(async({BrowserWindow})=>Array.from((await BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG()))));};
try{
 const page=await mainWindow(app);await wakeWindows(app);page.setDefaultTimeout(20000);
 await app.evaluate(({BrowserWindow})=>{BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 let s=await pollState(page,s=>s.backend==='ready'&&(s.updates?.hermes.releases.length||0)>=10);
 // A fresh profile with no account opens Settings on Connections by itself, once, soon after start; it is closed first.
 await call('wizardFinish');const closeSettings=page.getByLabel('Close settings',{exact:true});
 await closeSettings.waitFor({timeout:5000}).then(()=>closeSettings.click(),()=>{});
 assert.equal(await page.locator('dialog[open]').count(),0,'no window is open to start with');
 const update=page.getByRole('dialog',{name:`Ghidorah ${s.updates!.current} is installed`,exact:true});
 // The window says what is installed and what is new, and asks nothing; its Close button closes it.
 await call('updateOpen');await update.waitFor();await update.getByText(/^new in \d/).waitFor();
 assert.equal(await update.getByRole('button',{name:'Roll in',exact:true}).count(),0,'the window holds no Hermes choices');
 assert.equal(await update.getByRole('button',{name:'Check now',exact:true}).count(),0,'the window holds no update settings');
 await update.getByRole('button',{name:'Close',exact:true}).click();await update.waitFor({state:'hidden',timeout:5000});verified.closesAlone=true;
 // The hidden window opens after the main one, as the wake-word listener does about a minute after start.
 await app.evaluate(({BrowserWindow})=>{const stand=new BrowserWindow({show:false,width:1,height:1,skipTaskbar:true});void stand.loadURL('about:blank');});
 assert.notEqual(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getURL()),await page.evaluate(()=>location.href),'the hidden window is listed before the main one');
 // A change made on the app's side reaches the main window: the app opens the window, the main window shows it.
 await call('updateOpen');await update.waitFor({timeout:5000});verified.changesReachMainWindow=true;
 await update.getByRole('button',{name:'Close update',exact:true}).click();
 await pollState(page,s=>s.updates?.show===false,5000);verified.appHidesIt=true;
 await update.waitFor({state:'hidden',timeout:5000});verified.closesBesideHiddenWindow=true;
 // Ten new releases: a dot on Settings and on Updates, and each release in Settings › Updates with Roll in and Skip.
 await page.locator('.rail-settings .rail-dot').waitFor({timeout:5000});verified.railDot=true;
 const settings=page.locator('dialog.settings-dialog');
 await page.locator('.rail-settings').click();await settings.waitFor();
 const nav=settings.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name:'Updates',exact:true});
 assert.equal(await nav.locator('.settings-nav-dot').count(),1,'the Updates page carries the dot');verified.navDot=true;
 await nav.click();const body=settings.locator('[data-settings-page="updates"]');
 await body.getByText('Hermes Agent v0.22.7',{exact:true}).waitFor();
 assert.equal(await body.getByRole('button',{name:'Roll in',exact:true}).count(),10,'ten Hermes releases wait to roll in');verified.hermesInSettings=true;
 await picture('updates-dark');
 // Notes open on a click.
 await body.getByRole('button',{name:'Notes for Hermes Agent v0.22.7',exact:true}).click();await body.getByText('Fixture notes for 0.22.7.',{exact:true}).waitFor();verified.notesOpen=true;
 // Skip one, roll in the rest; the answered ones fold into one line and the dots go.
 await body.locator('.hermes-release',{hasText:'Hermes Agent v0.22.7'}).getByRole('button',{name:'Skip',exact:true}).click();
 s=await pollState(page,s=>s.updates?.hermes.releases.find((r:any)=>r.name==='Hermes Agent v0.22.7')?.state==='skipped',5000);
 const rollIns=(count:number)=>page.waitForFunction(({count})=>document.querySelectorAll('[data-settings-page="updates"] .hermes-release button.primary').length===count,{count},{timeout:5000});
 await rollIns(9);
 for(let left=9;left>0;left--){await body.getByRole('button',{name:'Roll in',exact:true}).first().click();await rollIns(left-1);}
 s=await pollState(page,s=>!s.updates?.hermes.releases.some((r:any)=>r.state==='new'),5000);
 assert.equal(s.updates!.hermes.releases.filter((r:any)=>r.state==='roll-in').length,9,'nine to roll in');verified.answered=true;
 const fold=body.getByRole('button',{name:'9 more to roll in · v0.21.6 to v0.22.6',exact:true});await fold.waitFor({timeout:5000});verified.folded=true;
 await page.locator('.rail-settings .rail-dot').waitFor({state:'detached',timeout:5000});assert.equal(await nav.locator('.settings-nav-dot').count(),0,'the Updates dot goes once nothing is new');verified.dotsGo=true;
 await fold.click();assert.equal(await body.locator('.hermes-release').count(),10,'the fold opens every release');await body.getByRole('button',{name:'Show fewer',exact:true}).click();verified.foldOpens=true;
 // What's new in Settings › Updates opens the window beside the hidden window.
 await body.getByRole('button',{name:"What's new",exact:true}).click();await update.waitFor({timeout:5000});verified.opensBesideHiddenWindow=true;
 assert.equal(await settings.count(),0,'Settings closes as the window opens');
 await picture('window-dark');
 await page.keyboard.press('Escape');await update.waitFor({state:'hidden',timeout:5000});verified.escClosesBesideHiddenWindow=true;
 // The light theme, for the pictures.
 await page.locator('.rail-settings').click();await settings.waitFor();await settings.getByLabel('Theme',{exact:true}).selectOption('light');
 await nav.click();await body.getByText('Hermes Agent v0.22.7',{exact:true}).waitFor();await picture('updates-light');
 await body.getByRole('button',{name:"What's new",exact:true}).click();await update.waitFor({timeout:5000});await picture('window-light');
 await update.getByRole('button',{name:'Close',exact:true}).click();await update.waitFor({state:'hidden',timeout:5000});
 await page.locator('.rail-settings').click();await settings.waitFor();await settings.getByLabel('Theme',{exact:true}).selectOption('dark');
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify(verified,null,1));
 console.log('PASS update-close',JSON.stringify(verified),'pictures in',pictures);
}catch(error){console.log('FAIL update-close',JSON.stringify(verified),String(error).split('\n').slice(0,3).join(' | '));throw error;}
finally{await app.close().catch(()=>{});hermes.close();await host.stop().catch(()=>{});}
