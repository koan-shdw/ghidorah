// Preview pages (FEATURE-SPECS 4), like Claude Code's artifacts, end to end without Cloudflare: the fake wrangler and
// the real Worker code Tris staged, run locally. A model publishes a page without asking; it is private; the card under
// the reply opens it in the preview pane as Koan; the viewer's menu renames, shares, duplicates and deletes; notes made
// in the sandboxed page come back to the chat; the same file published again keeps the link while a duplicate keeps
// the old version; the tool lists, reads and (after asking) deletes.
import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';
import {shareSite} from './fixtures/fake-share-site';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','pages-')),namespace='Trismegistus/Test/'+path.basename(data),folder=await fs.mkdtemp(path.join(root,'work','workspace-pages-'));
await fs.mkdir(path.join(folder,'mock'));
const mock=(version:string)=>fs.writeFile(path.join(folder,'mock','index.html'),`<!doctype html><html><head><title>Mock</title></head><body style="font-family:sans-serif"><h1>Video Editor ${version}</h1><img src="shot.svg" alt="shot" width="120"><h2>Header</h2><p>Takes are a library.</p><script>let kept='none';try{localStorage.setItem('x','1');kept='yes';}catch{kept='sandboxed';}document.body.dataset.storage=kept;</script></body></html>`);
await mock('V1');await fs.writeFile(path.join(folder,'mock','shot.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
const site=await shareSite(path.join(data,'share-site'));
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');
const app=await electron.launch({args:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath,TRISMEGISTUS_TEST_WRANGLER:path.join(root,'tests/fixtures/fake-wrangler.cmd'),FAKE_SHARE_URL:site.url,FAKE_WRANGLER_LOG:path.join(data,'wrangler.log'),FAKE_WRANGLER_STATE:path.join(data,'wrangler.json')}});
try{
 await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.webContents.setBackgroundThrottling(false);BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
 const page=await mainWindow(app),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,state=>state.backend==='ready'&&!!state.claude?.models?.length);await call('wizardFinish');await call('workingFolder',{folder});
 const get=async(url:string,init?:RequestInit)=>{const response=await fetch(url,{redirect:'manual',...init});return {status:response.status,text:await response.text(),headers:response.headers};};
 const until=async(check:()=>Promise<boolean>,timeout=30000)=>{for(const end=Date.now()+timeout;Date.now()<end;await page.waitForTimeout(150))if(await check())return;throw Error('Timed out');};
 const row=(id:string)=>site.db()!.prepare('SELECT * FROM pages WHERE id = ?').get(id) as any;
 await call('shareSetup');await pollState(page,state=>state.share?.ready===true,60000);

 // 1. A model publishes a page; private pages need no question, even in Manual.
 const chatId=await call('newChat');await call('addModel',{chatId,model:'claude-code:haiku'});
 await call('openMainChat',{chatId});await page.locator(`[data-chat-id="${chatId}"] .chat-link[aria-current="page"]`).waitFor();
 const projectId=(await call('state')).chats.find((chat:any)=>chat.id===chatId).projectId;await call('mode',{projectId,mode:'manual'});
 const tool=async(args:any,approve=false)=>{
  const id=crypto.randomUUID();await call('submit',{id,chatId,text:JSON.stringify({action:'mcp',server:'ghidorah',tool:'preview_page',arguments:args}),models:['claude-code:haiku']});
  const done=(state:any)=>['completed','failed','interrupted'].includes(state.turns.find((turn:any)=>turn.id===id)?.status);
  const state:any=await pollState(page,(state:any)=>done(state)||state.approvals.some((row:any)=>row.turnId===id&&row.status==='pending'),60000);
  const ask=state.approvals.find((row:any)=>row.turnId===id&&row.status==='pending');
  assert.equal(!!ask,approve,'asked: '+JSON.stringify(ask?.params));
  if(ask)await call('approve',{id:ask.id,choice:'once'});
  const turn=(await pollState(page,done,60000) as any).turns.find((turn:any)=>turn.id===id);
  const result=JSON.parse(JSON.parse(turn.text).result.content[0].text);return {turn,result,ask};
 };
 const guide=await tool({action:'guide'});assert.match(guide.result.guide,/"Now" first/);
 // A site set up before preview pages has no owner key yet: the first publish sends it along.
 await fs.rm(path.join(data,'share-site','public','_owner.json'));
 const first=await tool({action:'publish',path:'mock/index.html',title:'Video Editor Redesign',description:'Both editors in one frame'});
 const link=first.result.link,id=link.split('/').at(-2);
 assert.match(link,/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{22}\/$/);assert.equal(first.result.version,1);assert.deepEqual(first.result.files.sort(),['index.html','shot.svg']);
 assert.equal(row(id).access,'private');assert.equal(row(id).title,'Video Editor Redesign');assert.equal(row(id).chat_id,chatId);assert.match(row(id).model,/Haiku/);
 const stranger=await get(link);assert.equal(stranger.status,403);assert.match(stranger.text,/This page is private/);
 assert.equal((await get(link+'shot.svg')).status,403,'no file of a private page is open to anyone');

 // 2. The card under the reply opens the page in the preview pane, as Koan.
 const card=page.locator('.page-card').last();await card.waitFor();assert.match(await card.innerText(),/Video Editor Redesign[\s\S]*Page · version 1/);
 await card.getByRole('button',{name:'Open',exact:true}).click();
 await until(async()=>{const preview=await call('previewState',{chatId});return preview.url===link&&preview.title==='Video Editor Redesign';});
 const pane=(script:string,frame=false)=>app.evaluate(async({webContents},{link,script,frame})=>{const web=webContents.getAllWebContents().find(w=>w.getURL().startsWith(link));if(!web)return null;return frame?web.mainFrame.frames[0]?.executeJavaScript(script):web.executeJavaScript(script);},{link,script,frame});
 for(const end=Date.now()+20000;Date.now()<end&&await pane('document.body?.dataset.storage||""',true)!=='sandboxed';)await page.waitForTimeout(200);
 assert.equal(await pane('document.querySelector("h1").textContent',true),'Video Editor V1','the page runs in its frame');
 assert.equal(await pane('document.body.dataset.storage',true),'sandboxed','the page has no origin of its own (no storage, no cookies)');
 assert.doesNotMatch(await pane('document.querySelector("iframe").getAttribute("sandbox")'),/allow-same-origin/);
 await page.screenshot({path:path.join(data,'pages-pane.png')});
 // The viewer's Chat button opens the chat that made the page.
 const other=await call('newChat');await app.evaluate(({BrowserWindow},other)=>BrowserWindow.getAllWindows().find(w=>/index.html$/.test(w.webContents.getURL()))!.webContents.send('select-chat',other),other);
 await until(async()=>await page.locator('.page-card').count()===0,15000);
 await pane('document.querySelector("a.chat").click()');
 await until(async()=>await page.locator('.page-card').count()>0,15000);

 // 3. The viewer in Koan's browser: the menu, notes in the sandboxed page, rename, share, duplicate, delete.
 const db=new DatabaseSync(path.join(data,'chat.sqlite'),{readOnly:true}),ownerKey=JSON.parse((db.prepare("SELECT data FROM records WHERE kind='settings' AND id='share'").get() as any).data).ownerKey;db.close();
 assert.match(ownerKey,/^[A-Za-z0-9_-]{22}$/);assert.ok(!JSON.stringify(await call('state')).includes(ownerKey),'the windows never see the owner key');
 assert.ok(!JSON.stringify(first.turn).includes(ownerKey),'nor does the model');
 const signIn=(await (await fetch(site.url+'/api/login',{method:'POST',headers:{authorization:'Bearer '+ownerKey}})).json()).code;
 await app.evaluate(({BrowserWindow},url)=>{const w=new BrowserWindow({width:1200,height:820,show:false,webPreferences:{backgroundThrottling:false}});void w.loadURL(url);},link+'?login='+signIn+'&w=koan');
 const koan=await (async()=>{for(const end=Date.now()+20000;Date.now()<end;){const found=app.windows().find(p=>p.url()===link+'?w=koan');if(found)return found;await page.waitForTimeout(100);}throw Error('No viewer window');})();
 await koan.getByRole('button',{name:'Video Editor Redesign'}).click();
 const menu=koan.getByRole('menu');await menu.waitFor();
 assert.match(await menu.innerText(),/By .*Haiku.* in [\s\S]*Updated just now[\s\S]*Export[\s\S]*Copy as Markdown[\s\S]*Install page[\s\S]*Rename[\s\S]*Duplicate[\s\S]*Share[\s\S]*Refresh[\s\S]*Pin[\s\S]*All pages[\s\S]*Delete page/);
 await koan.screenshot({path:path.join(data,'pages-menu.png')});
 await menu.getByRole('menuitem',{name:'Rename'}).click();
 const rename=koan.getByRole('dialog',{name:'Rename'});await rename.getByLabel('Title').fill('Video Editor V2');await rename.getByRole('button',{name:'Save',exact:true}).click();
 await rename.waitFor({state:'hidden'});assert.equal(await koan.title(),'Video Editor V2');assert.equal(row(id).title,'Video Editor V2');
 const frame=koan.frameLocator('iframe');
 // A never-shown test window sometimes hands its first click to the frame element instead of into the sandboxed
 // page (Chromium's routing to an isolated frame before it has painted); a person's visible window does not.
 const pasteBox=frame.getByLabel('Notes to paste',{exact:true});
 for(let i=0;i<5&&!await pasteBox.isVisible();i++){await frame.getByRole('button',{name:'Paste notes',exact:true}).click();await koan.waitForTimeout(400);}
 await frame.getByLabel('Notes to paste',{exact:true}).fill('Header: bigger logo');await frame.locator('.pastebox').getByLabel('Your name',{exact:true}).fill('Koan');
 await frame.getByRole('button',{name:'Send notes',exact:true}).click();await frame.getByRole('button',{name:'Notes · 1',exact:true}).waitFor();
 await koan.locator('header .count').filter({hasText:'1'}).waitFor();
 const note=site.db()!.prepare("SELECT * FROM notes WHERE name='Koan'").get() as any;assert.equal(note.page,'/'+id+'/');assert.equal(note.version,1);assert.match(note.anchor,/h2:nth-of-type\(1\)$/);
 await koan.getByRole('button',{name:'Share'}).first().click();
 const share=koan.getByRole('dialog',{name:'Share'});await share.getByText('Anyone with the link',{exact:true}).click();
 await koan.screenshot({path:path.join(data,'pages-share.png')});
 await share.getByRole('button',{name:'Save',exact:true}).click();await koan.getByText('Anyone with the link can open it.').waitFor();
 assert.equal(row(id).access,'link');assert.equal((await get(link)).status,200,'shared: the link opens for anyone');
 await koan.getByRole('button',{name:'Video Editor V2'}).click();await menu.getByRole('menuitem',{name:'Duplicate'}).click();
 await koan.waitForFunction(id=>!location.pathname.includes(id),id);const copyId=new URL(koan.url()).pathname.split('/')[1];
 assert.equal(row(copyId).title,'Video Editor V2 (copy)');assert.equal(row(copyId).folder,id,'the copy shows its source’s files until Tris copies them');
 await koan.getByRole('button',{name:'Video Editor V2 (copy)'}).click();await menu.getByRole('menuitem',{name:'Delete page'}).click();
 await koan.getByRole('dialog',{name:'Delete page'}).getByRole('button',{name:'Delete',exact:true}).click();
 await koan.waitForURL(/\/pages$/);assert.match(await koan.locator('main').innerText(),/All pages[\s\S]*Video Editor V2[\s\S]*Anyone with the link/);assert.doesNotMatch(await koan.locator('main').innerText(),/\(copy\)/);
 assert.equal(row(copyId).deleted,1);

 // 4. The notes come back to the chat that made the page; Send to the model.
 assert.ok(await call('shareCheck')>=1);let state:any=await call('state');
 assert.ok(state.share.alerts.some((line:string)=>line==='Video Editor Redesign: Koan left 1 note on the page'),JSON.stringify(state.share.alerts));
 const notesCard=page.getByRole('region',{name:'Notes on Video Editor Redesign'});await notesCard.waitFor();
 const before=state.turns.length;await notesCard.getByRole('button',{name:'Send to the model',exact:true}).click();
 state=await pollState(page,(state:any)=>state.turns.length>before);
 assert.equal(state.turns.at(-1).prompt,'Notes on '+link+' (version 1):\n- Koan: Header: bigger logo');
 await pollState(page,(state:any)=>['completed','failed'].includes(state.turns.at(-1).status),60000);

 // 5. The same file again keeps the link; a duplicate made before keeps the old version.
 const kept=await fetch(site.url+'/api/pages/'+id+'/duplicate',{method:'POST',headers:{authorization:'Bearer '+ownerKey}}).then(r=>r.json());
 await mock('V2');
 const second=await tool({action:'publish',path:'mock/index.html',title:'Video Editor V2'});
 assert.equal(second.result.link,link,'same file, same chat: same link');assert.equal(second.result.version,2);assert.equal(row(id).version,2);
 assert.equal(row(kept.id).folder,kept.id,'the duplicate got its own folder before the new version went up');
 assert.match(await fs.readFile(path.join(data,'share-site','public',kept.id,'index.html'),'utf8'),/Video Editor V1/,'and kept the old version');
 assert.equal(row(id).access,'link','Koan’s sharing stays');
 const listed=(await tool({action:'list'})).result;assert.deepEqual(listed.map((page:any)=>page.title).sort(),['Video Editor V2','Video Editor V2 (copy)']);
 assert.equal(listed.find((page:any)=>page.link===link).fromThisChat,true);
 assert.match((await tool({action:'read',link})).result.html,/Video Editor V2/);
 await assert.rejects(call('pageOpen',{chatId,url:'https://example.com/AbCdEfGhIjKlMnOpQrStUv/'}),/not one of your pages/);

 // 6. A page deleted on the web stays deleted: the same file makes a new, private page. Deleting with the tool asks.
 assert.equal((await fetch(site.url+'/api/pages/'+id,{method:'DELETE',headers:{authorization:'Bearer '+ownerKey}})).status,200);
 const third=await tool({action:'publish',path:'mock/index.html',title:'Video Editor V3'}),thirdLink=third.result.link;
 assert.notEqual(thirdLink,link,'not brought back');assert.equal(row(thirdLink.split('/').at(-2)).access,'private');assert.equal((await get(link)).status,404);
 const gone=await tool({action:'delete',link:thirdLink},true);assert.match(gone.ask.params.description,/^Delete a preview page\n/);assert.equal(gone.result.deleted,true);
 assert.equal((await get(thirdLink)).status,404);
 console.log('PASS preview pages: publish without asking, private by default, card opens it in the pane as Koan, sandboxed page, Chat button, menu, rename, notes in the page, share, duplicate, delete, notes back to the model, same link for the same file, duplicate keeps its version, list, read, deleted stays deleted, delete asks, first publish on an older site. '+data);
}finally{await app.close().catch(()=>{});await site.close();await fs.rm(folder,{recursive:true,force:true});const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');}
