import {_electron as electron} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Backend,PYTHON} from '../app/backend';

// Finish plan section 4 in the desktop, through fakes: share with another project (4b), publishing (4c), Chrome and computer use (4e).
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','finish-4-')),namespace='Trismegistus/Test/'+path.basename(data);
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const ds=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'deepseek.jsonl'),FIXTURE_AUX_RECORDS:path.join(data,'aux.jsonl'),FIXTURE_DEEPSEEK_MODELS:JSON.stringify(['deepseek-flash','deepseek-audit-parallel'])},windowsHide:true,stdio:'pipe'}),[dline]=await once(createInterface({input:ds.stdout}),'line');
// The publish remote is a local bare repository; a small server reads the pushed branch as the site would.
const remote=path.join(data,'pages.git'),folder=await fs.mkdtemp(path.join(root,'work','finish-4-workspace-'));execFileSync('git',['init','-q','--bare',remote],{windowsHide:true});
const site=createServer((req,res)=>{try{const file=decodeURIComponent((req.url||'').slice(1));res.end(execFileSync('git',['--git-dir',remote,'show','main:'+file],{windowsHide:true,stdio:['ignore','pipe','ignore']}));}catch{res.writeHead(404).end();}});
const siteUrl=await new Promise<string>(resolve=>site.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+(site.address() as any).port)));
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(dline).url,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.invalid'};
// agent-browser from the scratch folder (section 4's download), placed where the app's own install puts it.
const scratch=path.join(root,'work','agent-browser-scratch','node_modules','agent-browser','bin','agent-browser-win32-x64.exe');
await fs.access(scratch).catch(()=>{throw Error('Missing '+scratch+': npm install --ignore-scripts agent-browser@0.38.2 into work/agent-browser-scratch first.');});
assert.equal(createHash('sha256').update(await fs.readFile(scratch)).digest('hex'),'a6a9a3654c41ee19c05961b73489db98cff9eae88a77436986df08a7a7a73786','the fixture executable must match the independently verified npm package');
await fs.mkdir(path.join(data,'tools','agent-browser','0.38.2','bin'),{recursive:true});await fs.copyFile(scratch,path.join(data,'tools','agent-browser','0.38.2','bin','agent-browser.exe'));
const pageServer=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<title>Fixture Page</title><h1>Fixture heading</h1>');});
const pageUrl=await new Promise<string>(resolve=>pageServer.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+(pageServer.address() as any).port+'/')));
Object.assign(env,{TRISMEGISTUS_TEST_CUA_DRIVER:path.join(root,'tests','fixtures','fake-cua-driver.cmd'),TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests','fixtures','claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath});
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env,timeout:30000});
try{
 const page=await instance.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(s:any)=>boolean)=>{const end=Date.now()+90000;while(Date.now()<end){const s=await call('state');if(predicate(s))return s;await page.waitForTimeout(150);}throw Error('Timed out: '+JSON.stringify((await call('state')).turns.slice(-2)));};
 const send=async(chatId:string,text:string)=>{await call('modelSelection',{chatId,model:'deepseek-flash',selected:true});const id=crypto.randomUUID();await call('submit',{id,chatId,text});const s=await wait(s=>s.turns.some((t:any)=>t.id===id&&['completed','failed','interrupted'].includes(t.status)));const turn=s.turns.find((t:any)=>t.id===id);assert.equal(turn.status,'completed',turn.error);return turn;};
 const memory=async(chatId:string)=>{const s=await call('state'),project=s.projects.find((p:any)=>p.id===s.chats.find((c:any)=>c.id===chatId).projectId);return JSON.stringify(await host.host('project_memory',{profile:project.profile,name:'read_project_memory'}));};
 await wait(s=>s.backend==='ready'&&s.availableModels.includes('deepseek-flash'));
 if(await page.getByRole('button',{name:'Close settings',exact:true}).count())await page.getByRole('button',{name:'Close settings',exact:true}).click();
 const a=await call('addProject'),b=await call('addProject'),targetProject=(await call('state')).chats.find((chat:any)=>chat.id===b).projectId;
 const sourceTurn=await send(a,'ALPHA_PRIVATE_HISTORY the build listens on port 8080');await call('sidebarChat',{action:'rename',chatId:a,name:'Source project'});
 await assert.rejects(call('shareToProject',{chatId:a,turnId:sourceTurn.id,projectId:targetProject,text:'Unapproved',sourceTitle:'Old title',date:new Date().toISOString().slice(0,10)}),/origin changed/);
 await page.locator('[data-chat-id="'+a+'"] .chat-link').click();
 const message=page.locator('article.turn').last();await message.waitFor();
 await message.locator('.user-message').click({button:'right'});
 await page.getByRole('menuitem',{name:'Share with…',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Share with another project'});await dialog.waitFor();
 await page.waitForFunction(()=>!!document.querySelector<HTMLTextAreaElement>('[aria-label="Shared text"]')?.value);
 assert.ok((await dialog.getByLabel('Shared text').inputValue()).length>0,'an AI summary fills the text when nothing is selected');
 await dialog.getByLabel('Share with project').selectOption(targetProject);
 await dialog.getByLabel('Shared text').fill('Shared fact: the build listens on port 8080.');
 await page.screenshot({path:path.join(data,'share.png')});
 await dialog.getByRole('button',{name:'Share',exact:true}).click();await dialog.waitFor({state:'hidden'});
 const shared=await memory(b);assert.match(shared,/Shared fact: the build listens on port 8080\./);assert.match(shared,/From \\"Source project\\" in another project, \d{4}-\d{2}-\d{2}:/);
 assert.doesNotMatch(shared,/ALPHA_PRIVATE_HISTORY/,'nothing else from the source project moves');
 assert.doesNotMatch(await memory(a),/Shared fact/,'the source project keeps its own memory');
 const selectionBox=await page.evaluate(()=>{const target=[...document.querySelectorAll('article.turn .user-message')].at(-1)!.firstChild!;const range=document.createRange();range.setStart(target,0);range.setEnd(target,21);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);const rect=range.getBoundingClientRect();return {x:rect.left+Math.min(20,rect.width/2),y:rect.top+rect.height/2};});
 await page.mouse.click(selectionBox.x,selectionBox.y,{button:'right'});await page.getByRole('menuitem',{name:'Share with…',exact:true}).click();
 assert.equal(await dialog.getByLabel('Shared text').inputValue(),'ALPHA_PRIVATE_HISTORY','the selected text fills the dialog');
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 console.log('PASS 4b share: a summary or the selected text goes to the other project\'s memory with its origin, and nothing else');

 // Detached windows receive destination titles, while retaining their source-chat boundary.
 await call('openChatWindow',{chatId:a});let detached;
 for(let attempt=0;attempt<100&&!detached;attempt++){detached=instance.windows().find(window=>window.url().endsWith('#chat='+a));if(!detached)await page.waitForTimeout(50);}
 assert.ok(detached);await detached.waitForLoadState('domcontentloaded');
 const detachedCall=(method:string,args:any={})=>detached!.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const isolated=await detachedCall('state');assert.ok(!isolated.chats.some((chat:any)=>chat.id===b));assert.ok(isolated.shareTargets.some((target:any)=>target.projectId===targetProject));
 await assert.rejects(detachedCall('shareSummary',{chatId:b,turnId:'wrong'}),/another chat/);
 await detached.locator('article.turn .user-message').last().click({button:'right'});await detached.getByRole('menuitem',{name:'Share with…',exact:true}).click();
 const detachedDialog=detached.getByRole('dialog',{name:'Share with another project'});await detachedDialog.getByLabel('Share with project').selectOption(targetProject);await detachedDialog.getByLabel('Shared text').fill('Shared from the detached window.');await detachedDialog.getByRole('button',{name:'Share',exact:true}).click();await detachedDialog.waitFor({state:'hidden'});assert.match(await memory(b),/Shared from the detached window/);
 // Receive the reply in the surviving main window; this action closes the detached renderer.
 await call('openMainChat',{chatId:a});
 // A parent parallel message has no own answer text; both model replies must reach its summary.
 await wait(s=>s.availableModels.includes('deepseek-audit-parallel'));await call('addModel',{chatId:a,model:'deepseek-audit-parallel'});
 const parallel=crypto.randomUUID();await call('submit',{id:parallel,chatId:a,text:'PARALLEL_SHARE_FIXTURE reply from each model',models:['deepseek-flash','deepseek-audit-parallel']});
 const parallelState=await wait(s=>s.turns.some((turn:any)=>turn.id===parallel&&turn.status==='completed'));
 assert.equal(parallelState.turns.find((turn:any)=>turn.id===parallel).jobs.length,2);await call('shareSummary',{chatId:a,turnId:parallel});
 const auxiliary=(await fs.readFile(path.join(data,'aux.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)),summary=auxiliary.findLast(row=>JSON.stringify(row).includes('Summarize this message'));
 assert.match(JSON.stringify(summary),/deepseek-flash \(completed\)/);assert.match(JSON.stringify(summary),/deepseek-audit-parallel \(completed\)/);
 const originSecret='sk-proj-'+'SyntheticOriginSecret'.repeat(3);await call('sidebarChat',{action:'rename',chatId:a,name:originSecret});
 const reviewedTitle=(await call('state')).chats.find((chat:any)=>chat.id===a).title;assert.notEqual(reviewedTitle,originSecret,'renaming already strips credential patterns');
 await call('shareToProject',{chatId:a,turnId:sourceTurn.id,projectId:targetProject,text:'Safe origin regression.',sourceTitle:reviewedTitle,date:new Date().toISOString().slice(0,10)});assert.ok(!(await memory(b)).includes(originSecret),'credentials do not reach memory through origin metadata');await call('sidebarChat',{action:'rename',chatId:a,name:'Source project'});
 console.log('PASS 4b detached sharing preserves window ownership; parallel summaries include both replies');
 await assert.rejects(call('publishingSave',{repository:'https://synthetic-token@example.invalid/pages.git'}),/credentials/);
 await assert.rejects(call('publishingSave',{branch:'main..other'}),/valid publishing branch/);
 await call('workingFolder',{folder});await fs.mkdir(path.join(folder,'site'));
 await fs.writeFile(path.join(folder,'site','page.html'),'<link rel="stylesheet" href="style.css"><h1>Published page</h1>');await fs.writeFile(path.join(folder,'site','style.css'),'h1{color:teal}');
 await fs.writeFile(path.join(folder,'site','keys.txt'),'sk-'+'synthetic0publish0key0'.repeat(2));
 await assert.rejects(call('publishPreview',{chatId:a}),/HTML file/);
 await call('publishingSave',{destination:'cloudflare',repository:remote,branch:'main',site:siteUrl});
 await call('previewOpen',{chatId:a,file:'site/page.html'});
 const published=await call('publishPreview',{chatId:a});assert.equal(published.live,true);assert.match(published.url,new RegExp('^'+siteUrl+'/page-[0-9a-f]{6}/page\\.html$'));
 const tree=execFileSync('git',['--git-dir',remote,'ls-tree','-r','--name-only','main'],{windowsHide:true}).toString().trim().split('\n');
 assert.deepEqual(tree.map(file=>file.split('/').slice(1).join('/')).sort(),['page.html','style.css'],'the page and what it links to, not the key file next to it');
 assert.match(await (await fetch(published.url)).text(),/Published page/);
 await fs.writeFile(path.join(folder,'site','leaky.html'),'<link rel="stylesheet" href="keys.txt">');await call('previewOpen',{chatId:a,file:'site/leaky.html'});
 await assert.rejects(call('publishPreview',{chatId:a}),/keys\.txt holds a credential/);
 const tool=crypto.randomUUID();await call('modelSelection',{chatId:a,model:'deepseek-flash',selected:true});await call('submit',{id:tool,chatId:a,text:'MCP_FIXTURE '+JSON.stringify({name:'publish_page',arguments:{path:'site/page.html'}})});
 const asking=await wait(s=>s.approvals.some((row:any)=>row.turnId===tool&&row.status==='pending'));await call('approve',{id:asking.approvals.find((row:any)=>row.turnId===tool&&row.status==='pending').id,choice:'once'});
 const told=(await wait(s=>s.turns.some((t:any)=>t.id===tool&&t.status==='completed'))).turns.find((t:any)=>t.id===tool);assert.match(told.text,/page-[0-9a-f]{6}\/page\.html/);
 console.log('PASS 4c publishing: the preview button and the publish_page tool (after approval) push the page and its linked files, never a key file, and the link comes back');

 let s=await call('state');assert.deepEqual(s.browserTools.on.sort(),['browser','computer_use']);assert.equal(s.browserTools.choice,'hermes');
 const act=async(text:string,approve:'once'|'deny'|null)=>{const id=crypto.randomUUID();await call('submit',{id,chatId:b,text});
  if(approve){const asking=await wait(s=>{const turn=s.turns.find((row:any)=>row.id===id);assert.ok(!turn||!['completed','failed','interrupted'].includes(turn.status),'Expected approval before completion: '+JSON.stringify(turn));return s.approvals.some((row:any)=>row.turnId===id&&row.status==='pending');});await assert.rejects(call('browserToolsSave',{choice:'claude'}),/active work/);assert.equal((await call('state')).browserTools.choice,'hermes');await call('approve',{id:asking.approvals.find((row:any)=>row.turnId===id&&row.status==='pending').id,choice:approve});}
  const done=(await wait(s=>s.turns.some((t:any)=>t.id===id&&['completed','failed','interrupted'].includes(t.status)))).turns.find((t:any)=>t.id===id);assert.equal(done.status,'completed',done.error);
  return {done,asked:(await call('state')).approvals.filter((row:any)=>row.turnId===id).length};};
 await call('modelSelection',{chatId:b,model:'deepseek-flash',selected:true});
 let result=await act('MCP_FIXTURE '+JSON.stringify({name:'browser_navigate',arguments:{url:pageUrl}}),'once');assert.match(result.done.text,/Fixture/);assert.equal(result.asked,1,'Manual asks');
 await fs.access(path.join(data,'hermes','browser-profile'));
 const project=(await call('state')).chats.find((c:any)=>c.id===b).projectId;await call('mode',{projectId:project,mode:'bypass'});
 result=await act('MCP_FIXTURE '+JSON.stringify({name:'browser_navigate',arguments:{url:pageUrl}}),null);assert.match(result.done.text,/Fixture/);assert.equal(result.asked,0,'Bypass runs');
 await call('mode',{projectId:project,mode:'manual'});
 result=await act('MCP_FIXTURE '+JSON.stringify({name:'computer_use',arguments:{action:'capture'}}),'deny');assert.equal(result.asked,1,'computer use reaches the approval card under Manual');
 console.log('PASS 4e Hermes drives the installed Chrome on the app\'s own profile: Manual asks, Bypass runs; computer use reaches the approval card');
 await call('browserToolsSave',{choice:'claude'});s=await wait(s=>s.backend==='ready'&&s.browserTools.choice==='claude');assert.deepEqual(s.browserTools.on,[]);
 await call('addModel',{chatId:b,model:'claude-code:haiku'});await call('modelSelection',{chatId:b,model:'deepseek-flash',selected:false});await call('modelSelection',{chatId:b,model:'claude-code:haiku',selected:true});
 await act(JSON.stringify({action:'reply'}),null);
 const launched=JSON.parse((await fs.readFile(path.join(data,'claude-requests.jsonl'),'utf8')).trim().split('\n').at(-1)!);assert.ok(launched.args.includes('--chrome'));
 console.log('PASS 4e the Claude choice turns the Hermes tools off and starts Claude Code with --chrome');
}finally{
 pageServer.closeAllConnections();pageServer.close();site.closeAllConnections();site.close();await instance.close().catch(()=>{});ds.stdin.end();ds.kill();
 await host.host('delete_key',{provider:'deepseek'}).catch(()=>{});
 const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');
}
