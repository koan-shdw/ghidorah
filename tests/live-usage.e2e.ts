import {pollState} from './fixtures/poll-state';
// Read-only live account metadata and saved chat. No model prompts.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
if(process.env.TRISMEGISTUS_LIVE_USAGE!=='1'||!process.env.TRISMEGISTUS_EXE)throw Error('Explicit live packaged usage opt-in required.');
const root=path.resolve('.'),build=JSON.parse(await fs.readFile(path.join(root,'work','live-build-review.json'),'utf8'));
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:[],timeout:30000});
try{
  await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.hide()));
  const page=await instance.firstWindow();page.setDefaultTimeout(60000);
  await pollState(page,state=>state.backend==='ready'&&!!state.codex?.connected&&!!state.claude?.models?.some(model=>model.id==='claude-code:claude-fable-5-1'));
  const state=await page.evaluate(()=>window.desktop.invoke('state'));
  const chat=state.chats.find((chat:any)=>chat.id===build.chatId);assert.ok(chat);
  await page.locator('.chat-link').filter({hasText:chat.title}).last().click();
  await page.getByRole('button',{name:'Usage for all models',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'Usage for all models',exact:true});await panel.waitFor();
  for(const name of ['DeepSeek usage','GPT-6 Sol usage','Fable 5.1 usage']){
    const region=panel.getByRole('region',{name,exact:true});await region.waitFor();assert.equal(await region.count(),1,name+'; rendered: '+await panel.locator('section').evaluateAll(items=>items.map(item=>item.getAttribute('aria-label')).join(', '))); 
    assert.match(await region.locator('.usage-context').getAttribute('title')||'',/\d[\s\S]*\//);assert.match(await region.locator('.usage-tokens').getAttribute('title')||'',/tokens/);
  }
  const claude=panel.getByRole('region',{name:'Claude Code account usage',exact:true});
  assert.match(await claude.innerText(),/5-hour limit[\s\S]*Weekly · all models/);
  assert.match(await panel.getByRole('region',{name:'OpenAI account usage',exact:true}).innerText(),/% left/);
  assert.match(await panel.getByRole('region',{name:'DeepSeek account usage',exact:true}).innerText(),/Prepaid credit/);
  await page.screenshot({path:path.join(root,'work','live-usage-models.png')});
  await panel.locator('.usage-scroll').evaluate(element=>element.scrollTop=element.scrollHeight);
  await page.screenshot({path:path.join(root,'work','live-usage-accounts.png')});
  await page.keyboard.press('Escape');assert.equal(await panel.count(),0);
  assert.ok(await page.locator('.context-ring').evaluate(element=>element===document.activeElement));
  await page.getByRole('button',{name:'Add model',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'Chat models',exact:true});await picker.waitFor();
  const anthropic=picker.getByRole('region',{name:'Anthropic models',exact:true});
  await pollState(page,state=>!!state.claude?.models?.length);
  const catalogue=(await page.evaluate(()=>window.desktop.invoke('state'))).claude.models;
  assert.equal(await anthropic.locator('.pool-pill').count(),catalogue.length);
  for(const model of catalogue){const linked=(chat.pool||[]).includes(model.id);assert.ok(await anthropic.locator('[data-model="'+model.id+'"]').getByRole('button',{name:linked?model.label+' is in this chat':'Add '+model.label+' to this chat',exact:true}).isVisible());}
  await page.screenshot({path:path.join(root,'work','live-chat-models.png')});await page.keyboard.press('Escape');
  console.log('PASS connected Claude catalogue and per-chat linked state');
  console.log('PASS packaged live shared usage: three models, native context, distinct supplier windows and credit, Escape and focus return; no model prompts');
}finally{await instance.evaluate(({app})=>app.quit());await instance.close();}
