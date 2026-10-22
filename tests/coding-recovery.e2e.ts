import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','coding-recovery-')),folder=await fs.mkdtemp(path.join(root,'work','coding-project-')),namespace='Trismegistus/Test/'+path.basename(data);
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const fake=spawn(PYTHON,['tests/fake_provider.py'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','inherit']}),lines=createInterface({input:fake.stdout});
const [line]=await once(lines,'line'),env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath};
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?['--hidden']:[root,'--hidden'],env,timeout:30000});let app=await launch();
try{
 let page=await mainWindow(app);page.setDefaultTimeout(15000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready'&&s.claude?.models?.some(m=>m.id==='claude-code:haiku')===true);await call('wizardFinish');await call('workingFolder',{folder});
 const chatId=await call('newChat');let state=await call('state');await call('mode',{projectId:state.chats.find((c:any)=>c.id===chatId).projectId,mode:'bypass'});await call('addModel',{chatId,model:'claude-code:haiku'});
 const temporary=path.join(folder,'temporary.png'),target=path.join(folder,'native-result.txt');await fs.writeFile(temporary,'temporary copy');
 const nativeId=crypto.randomUUID();await call('submit',{id:nativeId,chatId,models:['claude-code:haiku'],text:JSON.stringify({action:'recovery',temporary,path:target,command:'remove the temporary icon then check whether it exists'})});
 // The native protocol fixture asks explicitly, even with the real CLI in Bypass.
 // Approve only the expected synthetic actions in this isolated workspace.
 for(const deadline=Date.now()+90000;Date.now()<deadline;await page.waitForTimeout(100)){
  state=await call('state');
  for(const approval of state.approvals.filter((a:any)=>a.turnId===nativeId&&a.status==='pending')){
   const match=/^(Bash|Write|Edit)\n([\s\S]+)$/.exec(approval.params.description);assert.ok(match);const args=JSON.parse(match[2]);
   if(match[1]==='Bash')assert.equal(args.command,'remove the temporary icon then check whether it exists');else assert.equal(path.normalize(args.file_path),path.normalize(target));
   await call('approve',{id:approval.id,choice:'once'});
  }
  if(state.turns.some((t:any)=>t.id===nativeId&&['completed','failed','interrupted'].includes(t.status)))break;
 }
 assert.equal(state.turns.find((t:any)=>t.id===nativeId).status,'completed');assert.equal(await fs.readFile(target,'utf8'),'Recovered and edited twice after the failed cleanup check.');assert.equal(await fs.stat(temporary).then(()=>true,()=>false),false);
 assert.ok(state.tools.some((t:any)=>t.turnId===nativeId&&t.name==='Bash'&&t.status==='failed'));assert.equal(state.workReview.length,0);
 const hermesId=crypto.randomUUID(),hermesTarget=path.join(folder,'hermes-result.txt');await call('submit',{id:hermesId,chatId,models:['deepseek-flash'],text:'RECOVERY_FIXTURE '+JSON.stringify({command:'"'+PYTHON+'" -c "import sys; sys.exit(2)"',path:hermesTarget})});
 state=await pollState(page,s=>s.turns.some(t=>t.id===hermesId&&['completed','failed','interrupted'].includes(t.status)));assert.equal(state.turns.find((t:any)=>t.id===hermesId).status,'completed',state.turns.find((t:any)=>t.id===hermesId).error);assert.match(await fs.readFile(hermesTarget,'utf8'),/Hermes continued/);assert.equal(state.workReview.length,0);
 const appId=crypto.randomUUID();await call('submit',{id:appId,chatId,models:['claude-code:haiku'],text:JSON.stringify({action:'mcp',server:'ghidorah',tool:'create_app',requiredTools:['create_app','list_apps','add_app_todo','inspect_action'],arguments:{name:'Recovery app',repositories:[folder]}})});
 state=await pollState(page,s=>s.turns.some(t=>t.id===appId&&['completed','failed','interrupted'].includes(t.status)));assert.ok(state.savedApps.some((app:any)=>app.name==='Recovery app'),'Native app tools must be exposed and usable after recovery');
 // Resize the real renderer while keeping every test window hidden.
 await page.locator('.chat-link').last().click();const handle=page.getByRole('separator',{name:'Resize sidebar',exact:true}),sidebar=page.locator('aside.sidebar');
 const width=async()=>Math.round((await sidebar.boundingBox())!.width),start=await width(),box=(await handle.boundingBox())!;
 await page.mouse.move(box.x+box.width/2,box.y+100);await page.mouse.down();await page.mouse.move(box.x+box.width/2+92,box.y+100,{steps:6});await page.mouse.up();assert.equal(await width(),start+92);
 await handle.focus();await page.keyboard.press('ArrowRight');assert.equal(await width(),start+108);const saved=await width();
 await page.getByRole('button',{name:'Sidebar',exact:true}).click();assert.equal(await sidebar.isVisible(),false);await page.getByRole('button',{name:'Sidebar',exact:true}).click();assert.equal(await width(),saved);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>/index\.html$/.test(w.webContents.getURL()))!.setSize(650,650));await page.waitForTimeout(150);assert.ok(await width()<=250);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>/index\.html$/.test(w.webContents.getURL()))!.setSize(1280,850));await page.waitForTimeout(150);assert.equal(await width(),saved);
 const capture=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows().find(w=>/index\.html$/.test(w.webContents.getURL()))!.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));await fs.writeFile(path.join(data,'sidebar.png'),Buffer.from(capture,'base64'));assert.deepEqual(errors,[]);await app.evaluate(({app})=>app.quit());await app.close();app=await launch();page=await mainWindow(app);await pollState(page,s=>s.backend==='ready');
 assert.equal(Math.round((await page.locator('aside.sidebar').boundingBox())!.width),saved);assert.equal((await call('state')).workReview.length,0);
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false,'Tests must not open another visible Trismegistus');
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({nativeRecovery:true,hermesRecovery:true,failedToolVisible:true,noUnknownHold:true,sidebarDrag:true,sidebarKeyboard:true,collapseRestore:true,narrowWindow:true,restart:true,hidden:true},null,2));console.log('PASS native/Hermes command recovery and sidebar resizing; '+data);
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});fake.stdin.end('\n');lines.close();await host.host('delete_key');}
