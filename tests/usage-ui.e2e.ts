import {pollState} from './fixtures/poll-state';
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','usage-ui-'));
await fs.writeFile(path.join(data,'health.json'),JSON.stringify({claude:'ready'}));
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath},timeout:30000});
try{
  const page=await instance.firstWindow();page.setDefaultTimeout(15000);
  await pollState(page,state=>state.claude?.status==='Signed in');
  await page.evaluate(()=>window.desktop.invoke('claudeCheck'));
  const state=await page.evaluate(()=>window.desktop.invoke('state'));
  assert.equal(state.claude.connected,true);assert.ok(state.claude.windows.length);
  assert.equal(state.claude.windows[0].usedPercent,12);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Usage for all models',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'Usage for all models',exact:true});
  const account=panel.getByRole('region',{name:'Claude Code account usage',exact:true});
  await account.waitFor();
  // Allow refresh to finish, and compare the displayed values with the protocol fixture result.
  await pollState(page,state=>state.claude?.status==='Signed in');
  const checked=await page.evaluate(()=>window.desktop.invoke('state'));
  for(const window of checked.claude.windows){
    assert.ok((await account.innerText()).includes(window.label));
    if(window.usedPercent!=null)assert.ok((await account.innerText()).includes(Math.max(0,100-window.usedPercent).toLocaleString()+'% left'));
  }
  await page.screenshot({path:path.join(root,'work','claude-fixture-usage.png')});
  await page.locator('.titlebar').click();assert.equal(await panel.count(),0);
  console.log('PASS fixture Claude Code usage reaches shared panel; model-specific windows, refresh and outside dismissal');
}finally{await instance.evaluate(({app})=>app.quit());await instance.close();}
