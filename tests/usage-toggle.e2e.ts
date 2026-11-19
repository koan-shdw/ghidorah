import {pollState} from './fixtures/poll-state';
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/usage-toggle-'));
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data},timeout:30000});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(15000);
 await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.show();window.focus();});
 await pollState(page,state=>state.backend==='ready');
 await page.getByLabel('Close settings',{exact:true}).click({timeout:90000});
 // The context ring inside the message box is the one control that opens the usage panel (Koan 2026-11-19: the
 // model line with its details arrow is gone).
 const panel=page.getByRole('dialog',{name:'Context window and usage',exact:true}),ring=page.getByRole('button',{name:'Context window and usage',exact:true});
 for(let cycle=0;cycle<3;cycle++){
  await ring.click();await panel.waitFor({state:'visible'});
  await ring.click();await panel.waitFor({state:'hidden'});
  assert.equal(await ring.getAttribute('aria-expanded'),'false');
 }
 assert.equal(await page.getByLabel('Model details',{exact:true}).count(),0);
 await ring.focus();await page.keyboard.press('Enter');await panel.waitFor({state:'visible'});
 await ring.focus();await page.keyboard.press('Space');await panel.waitFor({state:'hidden'});
 await ring.click();await panel.waitFor({state:'visible'});await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'});
 await ring.click();await panel.waitFor({state:'visible'});await page.getByLabel('Close usage',{exact:true}).click();await panel.waitFor({state:'hidden'});
 await ring.click();await panel.waitFor({state:'visible'});await page.locator('.sidebar').click({position:{x:10,y:10}});await panel.waitFor({state:'hidden'});
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({repeatedClicks:true,ring:true,keyboard:true,escape:true,close:true,outside:true}));console.log('PASS usage toggle',data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
