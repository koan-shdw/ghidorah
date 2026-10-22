import {_electron as electron} from 'playwright';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PYTHON} from '../app/backend';
import {allPaneIds,findGroupOfPane} from '../app/pane-tree';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/finish-P5-')),namespace='Trismegistus/Test/'+path.basename(data);
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data}});let app=await launch();
try{
 let page=await app.firstWindow();page.setDefaultTimeout(15000);
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const until=async(check:()=>Promise<boolean>)=>{for(const end=Date.now()+30000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,100)))if(await check())return;throw Error('Chat pane state timed out');};
 const ready=async()=>{await until(async()=>(await call('state')).backend==='ready');await page.getByLabel('Close settings',{exact:true}).click();};
 const restart=async()=>{await app.close();app=await launch();await until(async()=>app.windows().some(view=>/index\.html$/.test(view.url())));page=app.windows().find(view=>/index\.html$/.test(view.url()))!;page.setDefaultTimeout(15000);await ready();};
 await ready();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1800,1100));
 const first=await call('newChat'),second=await call('newChat'),third=await call('newChat');
 for(const [chatId,name] of [[first,'First'],[second,'Second'],[third,'Third']])await call('sidebarChat',{action:'rename',chatId,name});
 await page.locator('[data-chat-id="'+first+'"] .chat-link').click();await page.getByRole('region',{name:'Main chat',exact:true}).getByLabel('Message',{exact:true}).fill('main retained');
 const open=async(id:string)=>{await page.locator('[data-chat-id="'+id+'"] .chat-link').click({button:'right'});await page.getByRole('menuitem',{name:'Open in',exact:true}).hover();await page.getByRole('menuitem',{name:'New pane',exact:true}).click();};
 await open(second);await page.getByRole('region',{name:'Chat pane: Second',exact:true}).getByLabel('Message',{exact:true}).fill('second retained');
 await open(third);await page.getByRole('region',{name:'Chat pane: Third',exact:true}).getByLabel('Message',{exact:true}).fill('third retained');
 await until(async()=>{const ids=allPaneIds((await call('state')).paneLayout);return [second,third].every(id=>ids.includes('chat:'+id));});
 await page.getByLabel('Arrange Chat · Third',{exact:true}).click();const dialog=page.getByRole('dialog',{name:'Arrange pane',exact:true});await dialog.getByLabel('Target pane',{exact:true}).selectOption('chat:'+second);await dialog.getByLabel('Pane position',{exact:true}).selectOption('center');await dialog.getByRole('button',{name:'Move pane',exact:true}).click();
 // Quit as soon as the UI action finishes: layout persistence must not need an extra settle delay.
 await restart();assert.ok(findGroupOfPane((await call('state')).paneLayout,'chat:'+second)?.panes.includes('chat:'+third));
 for(const [name,text] of [['Third','third retained'],['Second','second retained']]){await page.getByRole('tab',{name:'Chat · '+name,exact:true}).click();assert.equal(await page.getByRole('region',{name:'Chat pane: '+name,exact:true}).getByLabel('Message',{exact:true}).inputValue(),text);}
 assert.equal(await page.getByRole('region',{name:'Main chat',exact:true}).getByLabel('Message',{exact:true}).inputValue(),'main retained');
 await page.locator('[data-chat-id="'+second+'"] .chat-link').click();const main=page.getByRole('region',{name:'Main chat',exact:true});assert.equal(await main.getByLabel('Message',{exact:true}).isDisabled(),true);await main.getByRole('button',{name:'Continue here',exact:true}).click();await until(async()=>!await main.getByLabel('Message',{exact:true}).isDisabled());assert.equal(await main.getByLabel('Message',{exact:true}).inputValue(),'second retained');assert.equal(await page.getByRole('region',{name:'Chat pane: Second',exact:true}).count(),0);
 await open(first);await page.getByRole('region',{name:'Chat pane: First',exact:true}).getByLabel('Message',{exact:true}).fill('first moved');
 // Quit immediately after popping out, before waiting for renderer reconciliation.
 await call('openChatWindow',{chatId:third});await restart();
 const state=await call('state');assert.ok(state.chatWindows.includes(third));assert.ok(!allPaneIds(state.paneLayout).includes('chat:'+third));assert.ok(allPaneIds(state.paneLayout).includes('chat:'+first));
 const firstInput=page.getByRole('region',{name:'Chat pane: First',exact:true}).getByLabel('Message',{exact:true});assert.equal(await firstInput.inputValue(),'first moved');assert.ok((await firstInput.boundingBox())!.width>=200,'a narrow pane keeps room to type');
 await until(async()=>app.windows().some(view=>view.url().endsWith('#chat='+third)));const popped=app.windows().find(view=>view.url().endsWith('#chat='+third))!;assert.equal(await popped.getByLabel('Message',{exact:true}).inputValue(),'third retained');
 await page.screenshot({path:path.join(data,'restored.png')});await app.close();
 const db=new DatabaseSync(path.join(data,'chat.sqlite'));db.prepare('UPDATE records SET data=? WHERE kind=? AND id=?').run(JSON.stringify({id:'pane-layout',tree:{type:'group',id:'broken',panes:['main','main'],active:'main'}}),'settings','pane-layout');db.close();
 app=await launch();await until(async()=>app.windows().some(view=>/index\.html$/.test(view.url())));page=app.windows().find(view=>/index\.html$/.test(view.url()))!;await ready();
 await page.getByRole('region',{name:'Main chat',exact:true}).getByLabel('Message',{exact:true}).waitFor();assert.equal(await page.locator('.secondary-chat-pane').count(),0);assert.equal((await call('state')).turns.length,0);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({multipleChats:true,tabRestart:true,drafts:true,continueHere:true,immediatePopoutRestart:true,invalidLayoutFallback:true,noInference:true}));console.log(data);
}catch(error){console.error('Profile: '+data,error);const view=app.windows()[0];if(view){await view.screenshot({path:path.join(data,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(data,'failure.html'),await view.content().catch(()=>''));}throw error;
}finally{await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});}).catch(()=>{});await app.close();execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1]+'/encryption')",namespace],{windowsHide:true});}
