// Share work with clients, the Tris side (FEATURE-SPECS 3), end to end without Cloudflare: a fake wrangler (signed out
// at first) and the real Worker code Tris staged, run locally. Setup signs in, makes the notes database, deploys and
// proves a test note comes back; a model shares a page with the client after asking; Koan reviews and approves the AI
// page; a client pastes "Section: note" lines on the real notes layer; Tris collects them, tells Koan and sends them
// to the model on his click; a new version keeps the link and marks old notes; a password locks page, notes and AI
// address while the AI key still works.
import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';
import {shareSite} from './fixtures/fake-share-site';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','share-')),namespace='Trismegistus/Test/'+path.basename(data),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-share-'));
await fs.mkdir(path.join(folder,'site'));
await fs.writeFile(path.join(folder,'site','index.html'),'<!doctype html><html><head><title>Davan</title></head><body style="font-family:sans-serif"><h1>Home</h1><img src="logo.svg" alt="logo" width="80"><h2>Header</h2><p>Intro text.</p><h2>Pricing</h2><p>Monthly only.</p><div style="height:1200px"></div></body></html>');
await fs.writeFile(path.join(folder,'site','logo.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
const site=await shareSite(path.join(data,'share-site')),log=path.join(data,'wrangler.log');
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');
const app=await electron.launch({args:[root,'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath,TRISMEGISTUS_TEST_WRANGLER:path.join(root,'tests/fixtures/fake-wrangler.cmd'),FAKE_SHARE_URL:site.url,FAKE_WRANGLER_STATE:path.join(data,'wrangler-state.json'),FAKE_WRANGLER_LOG:log},timeout:30000});
try{
 // Hidden windows, never throttled: the main window is often made after this runs, so later windows are covered too.
 await app.evaluate(({app,BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.webContents.setBackgroundThrottling(false);app.on('browser-window-created',(_event,w)=>w.webContents.setBackgroundThrottling(false));BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
 const page=await mainWindow(app),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,state=>state.backend==='ready'&&!!state.claude?.models?.length);await call('wizardFinish');await call('workingFolder',{folder});
 const get=async(url:string,init?:RequestInit)=>{const response=await fetch(url,{redirect:'manual',...init});return {status:response.status,text:await response.text(),headers:response.headers};};
 const wrangler=async()=>(await fs.readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line).args.join(' '));

 // The window stays hidden (it never takes his screen); hidden windows can stop drawing, so buttons get a dispatched
 // click (the same handler a real click reaches).
 // 1. Setup from Settings: signs in, makes the notes database, stages and deploys, proves a test note comes back.
 await page.locator('.settings-link').dispatchEvent('click');const dialog=page.getByRole('dialog',{name:'Settings',exact:true});
 await dialog.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name:'Share with clients',exact:true}).dispatchEvent('click');
 await page.locator('[data-settings-page="sharing"]').waitFor();assert.match(await dialog.locator('.settings-body').innerText(),/In the future you can publish work in progress and send it to people for notes/);
 await dialog.getByRole('button',{name:'Set it up',exact:true}).dispatchEvent('click');
 let state:any=await pollState(page,state=>state.share?.ready===true,60000);
 assert.equal(state.share.site,site.url);assert.equal(state.share.status,'Ready');
 assert.deepEqual(await wrangler(),['whoami','login','d1 list --json','d1 create koan-share-notes','d1 execute koan-share-notes --remote --file schema.sql --yes','d1 execute koan-share-notes --remote --file migrate.sql --yes','deploy']);
 assert.ok(site.db()!.prepare("SELECT * FROM notes WHERE text='Setup test note'").all().length>=1,'the test note reached the site and came back');
 await page.screenshot({path:path.join(data,'share-settings.png')});
 // Again: the database is found, the column already there is fine.
 await call('shareSetup');assert.equal((await wrangler()).filter(line=>line.startsWith('d1 create')).length,1);
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});

 // 2. A model shares the page with the client, after asking.
 const chatId=await call('newChat');await call('addModel',{chatId,model:'claude-code:haiku'});
 await call('openMainChat',{chatId});await page.locator(`[data-chat-id="${chatId}"] .chat-link[aria-current="page"]`).waitFor();
 const projectId=(await call('state')).chats.find((chat:any)=>chat.id===chatId).projectId;await call('mode',{projectId,mode:'manual'});
 const shareTurn=async()=>{
  const id=crypto.randomUUID();await call('submit',{id,chatId,text:JSON.stringify({action:'mcp',server:'ghidorah',tool:'publish_page',arguments:{path:'site/index.html',client:true}}),models:['claude-code:haiku']});
  const ask:any=(await pollState(page,state=>state.approvals.some((row:any)=>row.turnId===id&&row.status==='pending'),30000) as any).approvals.find((row:any)=>row.turnId===id&&row.status==='pending');
  assert.match(ask.params.description,/^Share a page with the client at a private link\nsite\/index\.html to http:\/\/127\.0\.0\.1:\d+/);
  await call('approve',{id:ask.id,choice:'once'});
  return pollState(page,(state:any)=>['completed','failed','interrupted'].includes(state.turns.find((turn:any)=>turn.id===id)?.status),60000).then((state:any)=>state.turns.find((turn:any)=>turn.id===id));
 };
 let turn=await shareTurn();assert.equal(turn.status,'completed');
 state=await pollState(page,state=>state.share?.projects[0]?.draft?.status==='ready',60000);
 let project=state.share.projects[0];
 assert.equal(project.version,1);assert.deepEqual(project.sections,['Home','Header','Pricing']);assert.match(project.link,/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{22}\/$/);
 assert.ok(JSON.stringify(turn).includes(project.link),'the model got the link back');assert.equal(project.password,false);assert.ok(!('aiKey' in project),'the windows never get the key on its own');
 let shared=await get(project.link);assert.equal(shared.status,200);assert.match(shared.text,/data-version="1"/);
 assert.equal((await get(project.link+'logo.svg')).status,200,'the files the page links to go with it');
 assert.equal((await get(project.link+'_share.json')).status,404);
 assert.equal((await get(project.link+'for-ai')).status,404,'the AI page is not live before Koan approves it');

 // 3. The card in the chat; Koan reviews, edits and approves the AI page.
 const card=page.locator('.share-card');await card.waitFor();assert.match(await card.innerText(),/Shared with the client · version 1[\s\S]*The AI page for version 1 is ready for you/);
 await card.getByRole('button',{name:'Review',exact:true}).dispatchEvent('click');
 const review=page.getByRole('dialog',{name:/^AI page for /});await review.waitFor();
 const text=review.getByLabel('AI page text',{exact:true});assert.match(await text.inputValue(),/^WHAT THIS PROJECT IS\nFixture project .*, version 1\./);
 await text.fill((await text.inputValue())+'\nOPEN QUESTIONS\nYearly pricing?');
 await review.getByRole('button',{name:'Approve and publish',exact:true}).dispatchEvent('click');
 await review.getByText('A message for the client:').waitFor();await page.screenshot({path:path.join(data,'share-ai-approved.png')});
 state=await call('state');project=state.share.projects[0];
 const ai=await get(project.aiAddress);assert.equal(ai.status,200);assert.match(ai.headers.get('content-type')!,/^text\/plain/);
 assert.match(ai.text,/Fixture project[\s\S]*OPEN QUESTIONS\nYearly pricing\?\n\nHOW TO WRITE NOTES\nWrite one line per note, as: Section: note\nSections on this page: Home; Header; Pricing\n/);
 assert.equal(project.message,'Read '+project.aiAddress+' and help me give notes on '+project.link+'.');
 await review.getByRole('button',{name:'Close',exact:true}).dispatchEvent('click');

 // 4. A client pastes their AI's lines on the real notes layer.
 await app.evaluate(({BrowserWindow},url)=>{const w=new BrowserWindow({width:1100,height:800,show:false});void w.loadURL(url);},project.link);
 const client=await (async()=>{for(const end=Date.now()+20000;Date.now()<end;){const found=app.windows().find(p=>p.url().startsWith(project.link));if(found)return found;await page.waitForTimeout(100);}throw Error('No client window');})();
 await client.getByRole('button',{name:'Paste notes',exact:true}).dispatchEvent('click');
 await client.getByLabel('Notes to paste',{exact:true}).fill('Header: bigger logo\nPricing: add yearly\nJust a thought');
 await client.locator('.pastebox').getByLabel('Your name',{exact:true}).fill('Ana');
 await client.getByRole('button',{name:'Send notes',exact:true}).dispatchEvent('click');
 await client.getByRole('button',{name:'Notes · 3',exact:true}).waitFor();
 const rows=site.db()!.prepare("SELECT * FROM notes WHERE name='Ana' ORDER BY created").all() as any[];
 assert.deepEqual(rows.map(row=>row.text),['Header: bigger logo','Pricing: add yearly','Just a thought']);
 assert.match(rows[0].anchor,/h2:nth-of-type\(1\)$/);assert.match(rows[1].anchor,/h2:nth-of-type\(2\)$/);assert.equal(rows[2].anchor,null,'a line with no section sits at the top');
 assert.deepEqual(rows.map(row=>row.version),[1,1,1]);
 await client.screenshot({path:path.join(data,'share-client-notes.png')});

 // 5. Tris collects them, tells Koan, and sends them to the model when he says.
 assert.equal(await call('shareCheck'),3);state=await call('state');
 assert.ok(state.share.alerts.some((line:string)=>/: Ana left 3 notes on the page$/.test(line)),JSON.stringify(state.share.alerts));
 assert.equal(await call('shareCheck'),0,'each note comes back once');
 await card.getByText('3 new notes from Ana').waitFor();
 const before=state.turns.length;await card.getByRole('button',{name:'Send to the model',exact:true}).dispatchEvent('click');
 state=await pollState(page,(state:any)=>state.turns.length>before);
 assert.equal(state.turns.at(-1).prompt,'Client notes on '+project.link+' (version 1):\n- Ana: Header: bigger logo\n- Ana: Pricing: add yearly\n- Ana: Just a thought');
 await pollState(page,(state:any)=>['completed','failed'].includes(state.turns.at(-1).status),60000);

 // 6. A new version keeps the link and the notes; old notes are marked; the live AI page waits for approval.
 turn=await shareTurn();assert.equal(turn.status,'completed');
 state=await pollState(page,state=>state.share?.projects[0]?.version===2&&state.share.projects[0].draft?.status==='ready',60000);
 assert.equal(state.share.projects[0].link,project.link,'same link for every version');assert.equal(state.share.projects[0].ai.version,1);
 assert.match((await get(project.aiAddress)).text,/version 1\./,'the approved AI page stays until Koan approves the new one');
 await client.reload();await client.getByRole('button',{name:'Notes · 3',exact:true}).waitFor();
 assert.equal(await client.locator('.pin.old').count(),3,'notes on version 1 are marked as an earlier version');
 await client.getByRole('button',{name:'Notes · 3',exact:true}).dispatchEvent('click');assert.match(await client.locator('.panel').first().innerText(),/earlier version/);

 // 7. A password locks the page, its notes and its AI address; the AI key and Tris still get in.
 await call('sharePassword',{id:project.id,password:'open sesame'});state=await call('state');project=state.share.projects[0];
 assert.equal(project.password,true);assert.match(project.aiAddress,/\/for-ai\?key=[A-Za-z0-9_-]{22}$/);
 assert.equal((await get(project.link)).status,401);assert.equal((await get(project.link.replace(/\/$/,'')+'/for-ai')).status,401);
 assert.equal((await get(project.aiAddress)).status,200,'the AI address carries its own key');
 assert.equal(await call('shareCheck'),0,'Tris still reads the notes');
 await client.reload();await client.getByLabel('This page is private. Enter its password.').fill('open sesame');
 await client.getByRole('button',{name:'Open',exact:true}).dispatchEvent('click');await client.getByRole('button',{name:'Notes · 3',exact:true}).waitFor();
 await call('sharePassword',{id:project.id,password:null});assert.equal((await get(project.link)).status,200);
 await assert.rejects(call('sharePassword',{id:project.id,password:'abc'}),/4 to 200 characters/);
 await assert.rejects(call('shareAiApprove',{id:project.id,text:''}),/Write the AI page first/);
 console.log('PASS share with clients: setup (sign-in, database, deploy, test note), share after asking, AI page approved, pasted notes pinned by section, notes collected and sent on click, new version keeps link and marks old notes, password with AI key. '+data);
}finally{await app.close().catch(()=>{});await site.close();const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');}
