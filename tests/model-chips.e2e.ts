// The message box's model chips on a test copy with the stand-in Claude: at any window width every model of the chat
// is a chip inside the box (they wrap onto more lines, none hidden or folded away), and send stays inside it too.
// No real account is used.
import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {mainWindow,pollState,wakeWindows} from './fixtures/poll-state';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','model-chips-')),folder=await fs.mkdtemp(path.join(root,'work','workspace-model-chips-'));
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden','--disable-gpu']:[root,'--hidden','--disable-gpu'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath},timeout:60000});
try{
 const page=await mainWindow(app);await wakeWindows(app);page.setDefaultTimeout(20000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const click=(locator:any)=>locator.first().evaluate((element:HTMLElement)=>element.click());
 const state=await pollState(page,s=>s.backend==='ready'&&!!s.claude?.models?.length);await call('wizardFinish');await call('workingFolder',{folder});
 const chatId=await call('addProject',{folder}) as string;for(const model of state.availableModels||[])await call('addModel',{chatId,model}).catch(()=>{});
 if(await page.getByLabel('Close settings',{exact:true}).count())await click(page.getByLabel('Close settings',{exact:true}));
 await click(page.locator('[data-chat-id="'+chatId+'"] .chat-link'));await page.locator('.dock-setup .model-tab').first().waitFor();
 const pool=(await pollState(page,s=>(s.chats.find(c=>c.id===chatId)?.pool?.length||0)>1)).chats.find(c=>c.id===chatId)!.pool!;
 // Where each chip and send sit against the message box. `extra` stands in for a chat with more models: copies of
 // the last chip, there for the measurement and the picture only.
 const layout=(extra:number)=>page.evaluate(extra=>{
  const row=document.querySelector('.dock-setup .model-pills')!,copies=Array.from({length:extra},()=>row.appendChild(row.lastElementChild!.cloneNode(true) as HTMLElement));
  const box=document.querySelector('.composer-box')!.getBoundingClientRect(),chips=[...document.querySelectorAll('.dock-setup .model-pill:not(.jev)')];
  // No named function in here: the test loader wraps one in a helper the page does not have.
  const seen={chips:chips.length,inside:[...chips,document.querySelector('.composer-toolbar>.send')!].every(element=>{const r=element.getBoundingClientRect();return r.width>0&&r.left>=box.left&&r.right<=box.right+1&&r.top>=box.top&&r.bottom<=box.bottom+1;}),lines:new Set(chips.map(chip=>Math.round(chip.getBoundingClientRect().top))).size,box:Math.round(box.width)};
  return new Promise<typeof seen&{copies:number}>(done=>requestAnimationFrame(()=>setTimeout(()=>{copies.forEach(copy=>copy.remove());done({...seen,copies:copies.length});},extra?400:0)));
 },extra);
 for(const width of [1400,760,450])for(const extra of [0,6]){
  await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(w=>/index\.html$/.test(w.webContents.getURL()))!.setBounds({x:0,y:0,width,height:800}),width);await page.waitForTimeout(300);
  const [seen]=await Promise.all([layout(extra),extra?page.waitForTimeout(150).then(()=>page.screenshot({path:path.join(data,'chips-'+width+'.png')})):null]);
  assert.equal(seen.chips,pool.length+extra,'every model is a chip at '+width);assert.ok(seen.inside,'the chips and send stay inside the message box at '+width+': '+JSON.stringify(seen));
  console.log('at '+width+': '+JSON.stringify(seen));
 }
 // In the narrow box a chip on a later line still picks its model, and the + menu still opens at its button.
 await click(page.locator('.dock-setup .model-tab').last());await pollState(page,s=>!!s.chats.find(c=>c.id===chatId)?.selectedModels?.includes(pool.at(-1)!));
 const add=page.getByLabel('Add',{exact:true}).first();await click(add);const menu=page.getByRole('menu',{name:'Add',exact:true});await menu.waitFor();
 const at=await add.boundingBox(),shown=await menu.boundingBox();await page.screenshot({path:path.join(data,'add-menu.png')});
 assert.ok(at&&shown&&Math.abs(shown.x-at.x)<16&&shown.y+shown.height<=at.y+1,'the + menu opens above its button: '+JSON.stringify({at,shown}));await page.keyboard.press('Escape');
 assert.deepEqual(errors,[]);
 console.log('PASS model chips: every model stays a chip inside the message box at any width · '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});await fs.rm(folder,{recursive:true,force:true});}
