import {_electron as electron,type ElectronApplication,type Page} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/sidebar-drag-'));
let app!:ElectronApplication,page!:Page;
const errors:string[]=[];
async function launch(){
 app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:[...(process.env.TRISMEGISTUS_EXE?[]:[root]),'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data}});
 await app.evaluate(({app,BrowserWindow})=>{
  for(const window of BrowserWindow.getAllWindows())window.webContents.setBackgroundThrottling(false);
  app.on('browser-window-created',(_event,window)=>window.webContents.setBackgroundThrottling(false));
  BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};
 });
 page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
 await page.emulateMedia({reducedMotion:'reduce'});
 await until(async()=>(await call('state')).backend==='ready',900);
}
const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
async function until(check:()=>Promise<boolean>,limit=150){for(let i=0;i<limit;i++){if(await check())return;await page.waitForTimeout(100);}throw Error('State did not update');}
async function capture(name:string){const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));await fs.writeFile(path.join(data,name+'.png'),Buffer.from(png,'base64'));}
try{
 await launch();await page.getByLabel('Close settings',{exact:true}).click();
 const ids:string[]=[];
 for(const name of ['Alpha','Bravo','Charlie']){const id=await call('newChat');ids.push(id);await call('sidebarChat',{action:'rename',chatId:id,name});}
 await call('sidebarSettings',{sort:'name',groupBy:'folders'});
 const folder=await call('sidebarGroup',{action:'create',name:'Design'});
 const first=await call('savedAppSave',{name:'Video Dancer'}),second=await call('savedAppSave',{name:'Sprite Dancer'});
 const row=(i:number)=>page.locator('[data-chat-id="'+ids[i]+'"]');
 const pinned=page.getByRole('region',{name:'Pinned chats'});
 const pinState=async(i:number)=>(await call('state')).chats.find((chat:any)=>chat.id===ids[i]);
 const linked=async(id:string)=>(await call('state')).savedApps.find((entry:any)=>entry.id===id).chatIds;
 await row(0).dragTo(pinned);await until(async()=>(await pinState(0)).pinned===true);
 await pinned.locator('[data-chat-id="'+ids[0]+'"]').waitFor();
 await row(1).dragTo(row(0));await until(async()=>(await pinState(1)).pinned===true);
 assert.equal((await pinState(0)).pinned,true,'Dropping on a pinned row must keep it pinned');await pinned.locator('[data-chat-id="'+ids[1]+'"]').waitFor();
 await row(2).locator('.chat-link').click();await row(1).locator('.chat-link').click({modifiers:['Control']});
 await row(2).dragTo(pinned);await until(async()=>(await pinState(2)).pinned===true);await pinned.locator('[data-chat-id="'+ids[2]+'"]').waitFor();
 assert.equal((await call('state')).sidebar.preferences.sort,'name','Moving chats must preserve the chosen sort');
 await call('sidebarSettings',{sort:'manual'});
 await row(2).dragTo(row(0));await until(async()=>{const state=await call('state');return state.chats.find((c:any)=>c.id===ids[2]).position<state.chats.find((c:any)=>c.id===ids[0]).position;});
 assert.equal((await pinState(2)).pinned,true,'Reordering pins must not unpin');console.log('Pin and reorder checks passed');
 await row(0).locator('.chat-link').click();await row(1).locator('.chat-link').click({modifiers:['Control']});
 await row(0).dragTo(page.getByRole('button',{name:'Show chats for Video Dancer',exact:true}));
 await until(async()=>(await linked(first.id)).length===2);
 assert.deepEqual(new Set(await linked(first.id)),new Set(ids.slice(0,2)));
 assert.equal((await pinState(0)).pinned,true,'App links must preserve pin state');
 await row(0).dragTo(page.getByRole('button',{name:'Show chats for Video Dancer',exact:true}));
 assert.equal((await linked(first.id)).length,2,'Repeated drops must not duplicate links');
 await row(0).dragTo(page.getByRole('button',{name:'Show chats for Sprite Dancer',exact:true}));
 await until(async()=>(await linked(second.id)).includes(ids[0]));
 assert.equal((await linked(first.id)).length,2,'Adding another app must preserve existing links');
 await page.getByRole('button',{name:'Show chats for Video Dancer',exact:true}).click();
 await row(0).waitFor();await row(1).waitFor();await row(2).waitFor({state:'detached'});
 await page.getByRole('button',{name:/Show all chats/}).click();
 await row(0).locator('.chat-link').click();await row(1).locator('.chat-link').click({modifiers:['Control']});
 await row(0).dragTo(page.locator('[data-group-id="'+folder.id+'"] .sidebar-group-heading'));
 await until(async()=>{const state=await call('state');return ids.slice(0,2).every(id=>state.chats.some((chat:any)=>chat.id===id&&chat.groupId===folder.id&&!chat.pinned));});
 assert.equal((await linked(first.id)).length,2,'Folder moves preserve app links');console.log('App links, filters and folder move passed');
 await call('sidebarSettings',{sort:'updated'});
 await row(2).dragTo(row(0));await until(async()=>(await pinState(2)).groupId===folder.id);
 assert.equal((await call('state')).sidebar.preferences.sort,'updated','Dropping on a folder chat must preserve last-activity order');
 const recentIds=await page.locator('[data-group-id="'+folder.id+'"] [data-chat-id]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-chat-id')));
 assert.deepEqual(recentIds,[...ids].reverse(),'Latest chats appear first within the folder');
 await row(2).dragTo(pinned);await until(async()=>(await pinState(2)).pinned===true);
 // Files and malformed payloads are not chat drops.
 const transfer=await page.evaluateHandle(()=>{const data=new DataTransfer();data.setData('text/plain','Alpha');return data;});
 await pinned.dispatchEvent('drop',{dataTransfer:transfer});await transfer.dispose();
 const invalid=await page.evaluateHandle(()=>{const data=new DataTransfer();data.setData('application/x-trismegistus-chats','{invalid');return data;});
 await pinned.dispatchEvent('drop',{dataTransfer:invalid});await invalid.dispose();
 assert.equal((await pinState(0)).pinned,false);
 // Exercise highlighting with actual native dragging, and cancellation without mutation.
 const source=await row(0).boundingBox(),target=await page.getByRole('button',{name:'Show chats for Sprite Dancer',exact:true}).boundingBox();assert.ok(source&&target);
 await page.mouse.move(source.x+30,source.y+15);await page.mouse.down();await page.mouse.move(target.x+30,target.y+30,{steps:12});await page.mouse.move(target.x+31,target.y+31);
 await page.locator('.saved-app-tile[data-drop-active="true"]').waitFor();console.log('Native app drop highlight verified');
 await page.keyboard.press('Escape');await page.mouse.up();await until(async()=>await page.locator('[data-drop-active="true"]').count()===0);
 await capture('sidebar');
 await app.close();await launch();
 assert.equal((await pinState(2)).pinned,true);assert.equal((await pinState(0)).groupId,folder.id);
 assert.deepEqual(new Set(await linked(first.id)),new Set(ids.slice(0,2)));assert.deepEqual(await linked(second.id),[ids[0]]);
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({emptyPinned:true,pinDrop:true,pinnedRow:true,multiselect:true,pinReorder:true,appDrop:true,idempotent:true,appFilter:true,folderMove:true,invalidDrop:true,dropHighlight:true,cancel:true,restart:true,hiddenWindows:await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(window=>!window.isVisible()))},null,2));
 console.log(data);
}catch(error){console.error(error);console.log(data);if(page!&&!page.isClosed()){await page.mouse.up().catch(()=>{});}throw error;}
finally{await app!?.close();}
