import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
const root=path.resolve('.');const data=path.join(root,'work','desktop-test-'+Date.now());
await fs.mkdir(data,{recursive:true});
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data},timeout:30000});
try{
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.hide()));
 const page=await instance.firstWindow();page.on('console',m=>console.log('UI:',m.type(),m.text()));page.on('pageerror',e=>console.log('UI ERROR:',e.message));
 await page.waitForFunction(()=>Boolean(window.desktop),{timeout:15000});
 const deadline=Date.now()+100000;
 while(Date.now()<deadline){const s=await page.evaluate(()=>window.desktop.invoke('state'));if(['ready','failed'].includes(s.backend))break;await page.waitForTimeout(400);}
 const state=await page.evaluate(()=>window.desktop.invoke('state'));console.log(JSON.stringify({backend:state.backend,providerStatus:state.providerStatus}));
 await page.screenshot({path:path.join(root,'work','desktop-start.png')});
 assert.equal(state.backend,'ready',state.providerStatus);
 await page.getByRole('img',{name:'Ghidorah',exact:true}).waitFor();
 if(!await page.getByRole('dialog').count())await page.locator('.settings-link').click();
 assert.equal(await page.getByLabel('DeepSeek API key').count(),1);
 await page.screenshot({path:path.join(root,'work','desktop-settings.png')});
 await page.keyboard.press('Escape');
 assert.equal(await page.getByRole('dialog').count(),0);
 const project=path.join(data,'ui-project');await fs.mkdir(project,{recursive:true});
 const chatId=await page.evaluate(folder=>window.desktop.invoke('addProject',{folder}),project);
 await page.getByLabel('Message',{exact:true}).fill('Draft survives navigation and restart');
 const state2=await page.evaluate(()=>window.desktop.invoke('state'));
 await page.evaluate(projectId=>window.desktop.invoke('newChat',{projectId}),state2.projects[0].id);
 await page.locator('.chat-link').first().click();
 assert.equal(await page.getByLabel('Message',{exact:true}).inputValue(),'Draft survives navigation and restart');
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(720,620));
 await page.screenshot({path:path.join(root,'work','desktop-narrow.png')});
 assert.ok(await page.getByLabel('Send',{exact:true}).isVisible());
 assert.ok(await page.getByLabel('Permission mode',{exact:true}).first().isVisible());
 await page.getByRole('button',{name:'Browse skills and commands',exact:true}).click();
 assert.ok(await page.getByText('/review',{exact:true}).count()>0,'Built-in review commands are always listed');
 await page.getByRole('button',{name:'Manage plugins',exact:true}).click();assert.equal(await page.getByRole('heading',{name:'Plugins',exact:true}).count(),1);
 console.log('PASS draft navigation, keyboard dialog close and narrow-window controls');
 console.log('PASS Electron startup, isolated real Hermes, settings form');
}finally{await instance.evaluate(({app})=>app.quit());await instance.close();}
