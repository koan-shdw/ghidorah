import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {PYTHON} from '../app/backend';
const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/file-mentions-')),folder=data+'-workspace';await fs.mkdir(folder);
await fs.mkdir(path.join(folder,'folder space'),{recursive:true});await fs.writeFile(path.join(folder,'folder space','hello world.ts'),'export const value=1;');await fs.writeFile(path.join(folder,'readme.md'),'fixture');
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data}});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(15000);
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await page.getByLabel('Close settings',{exact:true}).click();await call('workingFolder',{folder});await call('newChat');await page.locator('.chat-link').last().click();
 const input=page.getByLabel('Message',{exact:true}),picker=page.getByRole('region',{name:'Workspace file mentions'});
 await input.fill('Inspect @folder');await input.press('End');await page.getByRole('option',{name:'folder space/',exact:false}).waitFor();await input.press('Tab');
 await page.getByRole('option',{name:'hello world.ts',exact:false}).waitFor();await input.press('Enter');
 assert.equal(await input.inputValue(),'Inspect @"folder space/hello world.ts" ');
 assert.equal((await call('state')).turns.length,0);
 await input.fill('Inspect @missing');await input.press('End');await page.getByText('No matching files.',{exact:true}).waitFor();await input.press('Enter');assert.equal((await call('state')).turns.length,0);
 await input.press('Escape');await picker.waitFor({state:'hidden'});
 await input.fill('Inspect @read');await input.press('End');await page.getByRole('option',{name:'readme.md',exact:false}).click();assert.equal(await input.inputValue(),'Inspect @"readme.md" ');
 await input.fill('@../');await input.press('End');await picker.getByRole('alert').waitFor();assert.match(await picker.innerText(),/inside the working folder/);
 await input.fill('@');await input.press('End');await page.getByRole('option',{name:'readme.md',exact:false}).waitFor();await page.screenshot({path:path.join(data,'mentions.png')});
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({nestedSpaces:true,tab:true,enterDoesNotSend:true,mouse:true,escape:true,missingFile:true,outsideRootRejected:true}));console.log(data);
}finally{await app.close();execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",'Trismegistus/Test/'+path.basename(data)+'/encryption'],{windowsHide:true});}
