import {pollState} from './fixtures/poll-state';
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/sidebar-reference-')),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-app-reference-'));
const env={...process.env,TRISMEGISTUS_TEST_DATA:data};
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env,timeout:30000});
let app=await launch();
try{
 let page=await app.firstWindow();page.setDefaultTimeout(30000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await page.waitForFunction(()=>document.querySelector('.sidebar'));
 await pollState(page,state=>state.backend==='ready');await page.getByLabel('Close settings',{exact:true}).waitFor({timeout:60000});await page.getByLabel('Close settings',{exact:true}).click();
 await call('workingFolder',{folder});const first=await call('newChat'),second=await call('newChat');
 await call('sidebarChat',{action:'rename',chatId:first,name:'Studio app — implement the complete navigation and hover interactions'});
 await call('sidebarChat',{action:'rename',chatId:second,name:'Studio release and open questions'});
 const group=await call('sidebarGroup',{action:'create',name:'Development'});
 await call('sidebarChat',{action:'move',chatId:first,groupId:group.id});
 const row=page.locator(`[data-chat-id="${first}"]`);await row.hover();await page.getByRole('tooltip').waitFor();assert.match(await page.getByRole('tooltip').innerText(),/complete navigation/);await page.screenshot({path:path.join(data,'hover.png')});
 await row.click({button:'right'});const menu=page.getByRole('menu',{name:'Chat actions',exact:true});await menu.waitFor();assert.equal(await menu.locator('svg').count()>8,true);assert.equal(await menu.getByRole('menuitem',{name:'Rename',exact:true}).getAttribute('aria-keyshortcuts'),'R');
 await menu.getByRole('menuitem',{name:'Move to folder',exact:true}).hover();const sub=page.getByRole('menu',{name:'Move to folder',exact:true});await sub.waitFor();await sub.getByRole('menuitem',{name:'Ungrouped',exact:true}).hover();await page.waitForTimeout(250);assert.equal(await sub.isVisible(),true);await page.screenshot({path:path.join(data,'submenu.png')});await sub.getByRole('menuitem',{name:'Ungrouped',exact:true}).click();assert.equal((await call('state')).chats.find((c:any)=>c.id===first).groupId,null);
 await row.click({button:'right'});await page.keyboard.press('r');await page.getByLabel('Name',{exact:true}).waitFor();await page.keyboard.press('Escape');
 await row.click({button:'right'});await menu.getByRole('menuitem',{name:'Move to folder',exact:true}).focus();await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Ungrouped');assert.equal(await page.locator(':focus').getAttribute('aria-label'),'Ungrouped');await page.keyboard.press('ArrowLeft');assert.equal(await page.locator(':focus').getAttribute('aria-label'),'Move to folder');await page.keyboard.press('Escape');
 await page.locator('.model-tab').first().hover();await page.getByRole('tooltip').filter({hasText:'Tokens unavailable'}).waitFor();await page.getByLabel('Model details',{exact:true}).click();await page.getByRole('dialog',{name:'Context window and usage',exact:true}).waitFor();await page.getByLabel('Model details',{exact:true}).click();
 await page.getByLabel('Activity view',{exact:true}).click();assert.equal(await page.getByLabel('Activity view',{exact:true}).getAttribute('aria-pressed'),'true');await page.keyboard.press('Control+Alt+u');assert.equal(await page.getByLabel('Activity view',{exact:true}).getAttribute('aria-pressed'),'false');
 for(const name of ['Plugins','Skills','Models']){await page.getByRole('navigation',{name:'App navigation'}).getByRole('button',{name,exact:true}).click();await page.getByRole('dialog').waitFor();if(name==='Skills')await page.getByLabel('Skills Hub search').waitFor();await page.getByLabel('Close settings',{exact:true}).click();}
 // Apps are the app page's (app-page.e2e). Here: the activity view survives a restart; narrow and light still fit.
 await page.getByLabel('Activity view',{exact:true}).click();
 await app.evaluate(({app})=>app.quit());await app.close();app=await launch();page=await app.firstWindow();page.setDefaultTimeout(30000);await pollState(page,state=>state.backend==='ready');await page.getByLabel('Close settings',{exact:true}).waitFor({timeout:60000});await page.getByLabel('Close settings',{exact:true}).click();
 assert.equal(await page.getByLabel('Activity view',{exact:true}).getAttribute('aria-pressed'),'true');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(760,800));await page.screenshot({path:path.join(data,'narrow.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.getByRole('navigation',{name:'App navigation'}).getByRole('button',{name:'Settings',exact:true}).click();await page.getByLabel('Theme',{exact:true}).selectOption('light');await page.getByLabel('Close settings',{exact:true}).click();await page.screenshot({path:path.join(data,'light.png')});
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({hover:true,submenuPointer:true,submenuKeyboard:true,accelerators:true,rail:true,activity:true,restart:true,narrow:true},null,2));console.log('PASS reference interactions');console.log(data);
}catch(error){const failure=await app.firstWindow();console.log('FAILURE UI',await failure.locator('.modal-backdrop').innerText().catch(()=>''));await failure.screenshot({path:path.join(data,'failure.png')});console.log(data);throw error;}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
