import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {PYTHON} from '../app/backend';
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/shortcut-help-'));
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data}});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(20000);
 await page.getByLabel('Close settings',{exact:true}).click();
 await page.getByLabel('Open files',{exact:true}).focus();
 await page.keyboard.press('F1');
 const help=page.getByRole('dialog',{name:'Keyboard shortcuts',exact:true});await help.waitFor();
 assert.equal(await page.locator(':focus').getAttribute('aria-label'),'Close keyboard shortcuts');
 await page.keyboard.press('Shift+Tab');assert.ok(await help.evaluate(el=>el.contains(document.activeElement)));
 await page.keyboard.press('Tab');assert.ok(await help.evaluate(el=>el.contains(document.activeElement)));
 await page.keyboard.press('Control+Backquote');assert.equal(await page.locator('.workspace-panel').isVisible(),false);
 await page.screenshot({path:path.join(data,'help.png')});
 await page.keyboard.press('Escape');await help.waitFor({state:'hidden'});
 assert.equal(await page.locator(':focus').getAttribute('aria-label'),'Open files');
 await page.keyboard.press('Control+/');await help.waitFor();await page.keyboard.press('Escape');await help.waitFor({state:'hidden'});
 await page.getByRole('button',{name:'Chat menu',exact:true}).first().click();await page.getByRole('menuitem',{name:'Keyboard shortcuts',exact:true}).click();await help.waitFor();
 await page.setViewportSize({width:650,height:500});
 assert.ok(await help.evaluate(el=>el.scrollWidth<=el.clientWidth));
 assert.ok(await help.evaluate(el=>el.getBoundingClientRect().height<=window.innerHeight));
 await page.screenshot({path:path.join(data,'help-narrow.png')});
 await page.getByLabel('Close keyboard shortcuts',{exact:true}).click();await help.waitFor({state:'hidden'});
 assert.equal(await page.locator(':focus').getAttribute('aria-label'),'Chat menu');
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({f1:true,ctrlSlash:true,button:true,escape:true,focusReturn:true,focusTrap:true,modalShortcutIsolation:true}));console.log(data);
}finally{await app.close();execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",'Trismegistus/Test/'+path.basename(data)+'/encryption'],{windowsHide:true});}

