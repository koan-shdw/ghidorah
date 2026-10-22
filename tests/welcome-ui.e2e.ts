import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','welcome-ui-'));
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data},timeout:30000});
try{
  await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.hide()));
 const page=await instance.firstWindow();page.setDefaultTimeout(20000);
 await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();await page.keyboard.press('Escape');
 await page.context().setOffline(true);
 const art=page.getByRole('img',{name:'Ghidorah',exact:true});await art.waitFor();
 assert.equal(await art.getAttribute('data-font'),'PE Red');
 assert.equal(await page.getByText('What shall we build?',{exact:true}).count(),0);
 assert.ok(await art.locator('text').count()>500);
 assert.ok(await art.locator('text[fill="#FF5555"]').count()>0);
 const bounds=await art.boundingBox(),area=await page.locator('.empty').boundingBox();assert.ok(bounds&&area);
 assert.ok(Math.abs(bounds.x+bounds.width/2-(area.x+area.width/2))<2,'artwork centred horizontally');
 await page.screenshot({path:path.join(root,'work','welcome-pe-red.png')});
 await page.locator('.settings-link').click();await page.getByLabel('Opening artwork font',{exact:true}).selectOption('PE Cyan');await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.querySelector('.welcome-art')?.getAttribute('data-font')==='PE Cyan'&&document.querySelectorAll('.welcome-art text[fill="#55FFFF"]').length>0);
 await page.reload();await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();await page.keyboard.press('Escape');await art.waitFor();assert.equal(await art.getAttribute('data-font'),'PE Cyan');
 await assert.rejects(page.evaluate(()=>window.desktop.invoke('artFont',{font:'../../secret'})),/Unknown artwork font/);
 console.log('PASS offline local TheDraw artwork, PE Red default, centred layout, font switch persists, unknown font path rejected');
}finally{await instance.evaluate(({app})=>app.quit());await instance.close();}
