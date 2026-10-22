import {_electron as electron} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';

// Finish plan section R in the desktop, through fakes: a worktree per chat (R2).
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','finish-R-')),namespace='Trismegistus/Test/'+path.basename(data);
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');await host.host('save_key',{key:'synthetic-deepseek-regression-credential'});
const ds=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'deepseek.jsonl')},windowsHide:true,stdio:'pipe'}),[dline]=await once(createInterface({input:ds.stdout}),'line');
const env:Record<string,string>={...process.env as Record<string,string>,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(dline).url};
// The working folder is a repository with one commit.
const folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-worktree-repo-')),git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',windowsHide:true}).trim();
git(folder,'init','-q','-b','main');await fs.writeFile(path.join(folder,'app.txt'),'main checkout\n');git(folder,'add','app.txt');git(folder,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-q','-m','start');
let instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env,timeout:30000});
try{
 let page=await instance.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(s:any)=>boolean,timeout=90000)=>{const end=Date.now()+timeout;while(Date.now()<end){const s=await call('state');if(predicate(s))return s;await page.waitForTimeout(200);}throw Error('Timed out');};
 const exists=(file:string)=>fs.stat(file).then(()=>true,()=>false);
 await wait(s=>s.backend==='ready'&&s.claude?.models?.some((m:any)=>m.id==='claude-code:haiku'));
 const closeSettings=page.getByRole('button',{name:'Close settings',exact:true});if(await closeSettings.isVisible())await closeSettings.click();
 await call('workingFolder',{folder});
 // R2: the New project button's right-click menu starts a chat in a worktree of the chosen repository.
 await page.getByRole('button',{name:'New project',exact:true}).first().click({button:'right'});
 await page.getByRole('menuitem',{name:'New chat in a worktree',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'New chat in a worktree',exact:true});await dialog.getByRole('button',{name:'Working folder',exact:true}).click();await dialog.waitFor({state:'hidden'});
 let s=await wait(s=>s.chats.some((chat:any)=>chat.title.startsWith('Worktree · ')));
 const chat=s.chats.find((chat:any)=>chat.title.startsWith('Worktree · ')),project=s.projects.find((row:any)=>row.id===chat.projectId);
 const worktree=project.worktree;assert.equal(path.dirname(worktree),path.join(folder,'.trismegistus','worktrees'));
 assert.match(git(worktree,'branch','--show-current'),/^trismegistus\/chat-/);
 const trust=await call('projectTrustReview',{chatId:chat.id});assert.equal(trust.folder.toLowerCase(),worktree.toLowerCase());
 await assert.rejects(call('workingFolder',{clear:true}),/worktree chats/);
 const sideId=await call('sideChatOpen',{chatId:chat.id});s=await call('state');
 assert.equal(s.projects.find((p:any)=>p.id===s.chats.find((c:any)=>c.id===sideId).projectId).worktree,worktree);
 await call('sideChatDiscard',{chatId:sideId});
 // The chat's model writes in the worktree (Manual asks first).
 await page.locator('[data-chat-id="'+chat.id+'"] .chat-link').click();
 await page.locator('.model-tab').filter({hasText:'DeepSeek'}).click();
 await page.getByLabel('Message',{exact:true}).fill('WRITE_FIXTURE in the worktree');await page.getByLabel('Message',{exact:true}).press('Enter');
 s=await wait(s=>s.approvals.some((row:any)=>row.chatId===chat.id&&row.status==='pending'));
 await call('approve',{id:s.approvals.find((row:any)=>row.chatId===chat.id&&row.status==='pending').id,choice:'once'});
 await wait(s=>s.turns.some((turn:any)=>turn.chatId===chat.id&&turn.status==='completed'),120000);
 assert.equal(await exists(path.join(worktree,'slice-result.txt')),true,'the model wrote in the worktree');
 assert.equal(await exists(path.join(folder,'slice-result.txt')),false,'not in the main checkout');
 // The native engine and reviewed plugin command use the same checkout.
 await call('addModel',{chatId:chat.id,model:'claude-code:haiku'});
 const complete=async(id:string)=>{const end=Date.now()+90000;while(Date.now()<end){const s=await call('state');for(const a of s.approvals.filter((a:any)=>a.turnId===id&&a.status==='pending'))await call('approve',{id:a.id,choice:'once'});const turn=s.turns.find((t:any)=>t.id===id);if(turn&&['completed','failed','interrupted'].includes(turn.status)){assert.equal(turn.status,'completed',turn.error);return turn;}await page.waitForTimeout(100);}throw Error('Turn timed out');};
 const native=crypto.randomUUID();await call('submit',{id:native,chatId:chat.id,text:'WRITE_CLAUDE',models:['claude-code:haiku']});await complete(native);
 assert.equal(await exists(path.join(worktree,'claude-result.txt')),true);assert.equal(await exists(path.join(folder,'claude-result.txt')),false);
 const review=crypto.randomUUID();await call('submit',{id:review,chatId:chat.id,text:'/review --base main',models:['deepseek-flash']});await complete(review);
 s=await call('state');assert.equal(path.resolve(s.turns.find((t:any)=>t.id===review).review.root).toLowerCase(),worktree.toLowerCase());
 assert.equal(s.tools.some((t:any)=>s.turns.some((turn:any)=>(turn.id===review||turn.parentTurnId===review)&&turn.id===t.turnId)),false,'the review fixture does not replay old write instructions');
 const plugin=path.join(data,'fixture-plugin');await fs.mkdir(plugin);await fs.writeFile(path.join(plugin,'plugin.yaml'),JSON.stringify({name:'worktree-example',version:'1'}));
 await fs.writeFile(path.join(plugin,'__init__.py'),"from pathlib import Path\ndef register(ctx):\n    def record(arg):\n        Path('plugin-here.txt').write_text(str(Path.cwd()), encoding='utf8')\n        return 'recorded'\n    ctx.register_command('record', record, description='Record working directory.')\n");
 const pluginReview=await call('pluginRepositoryReview',{repository:'fixture/plugin'});await call('nativePluginInstall',{token:pluginReview.token,values:{}});
 const pluginTurn=crypto.randomUUID();await call('submit',{id:pluginTurn,chatId:chat.id,text:'/worktree-example:record'});await complete(pluginTurn);
 assert.equal((await fs.readFile(path.join(worktree,'plugin-here.txt'),'utf8')).toLowerCase(),worktree.toLowerCase());
 assert.equal(await exists(path.join(folder,'plugin-here.txt')),false);
 // The terminal opens in the worktree.
 const terminal=await call('terminalOpen',{chatId:chat.id});
 await call('terminalWrite',{chatId:chat.id,id:terminal.id,data:"[IO.File]::WriteAllText('terminal-here.txt', (Get-Location).Path)\r"});
 const end=Date.now()+30000;while(!await exists(path.join(worktree,'terminal-here.txt'))&&Date.now()<end)await page.waitForTimeout(200);
 assert.equal((await fs.readFile(path.join(worktree,'terminal-here.txt'),'utf8')).toLowerCase(),worktree.toLowerCase());
 await call('terminalClose',{chatId:chat.id,id:terminal.id});
 assert.equal(git(folder,'status','--porcelain'),'','the main checkout is untouched');assert.equal(await fs.readFile(path.join(folder,'app.txt'),'utf8'),'main checkout\n');
 await page.screenshot({path:path.join(data,'worktree-chat.png')});
 // Restart keeps the binding. An unavailable worktree must not prevent app startup.
 await instance.close();const moved=worktree+'-temporarily-moved';await fs.rename(worktree,moved);
 instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env,timeout:30000});page=await instance.firstWindow();await wait(s=>s.backend==='ready');
 await assert.rejects(call('terminalOpen',{chatId:chat.id}),/ENOENT|exist|location/);
 await fs.rename(moved,worktree);await call('restart');await wait(s=>s.backend==='ready');
 await page.locator('[data-chat-id="'+chat.id+'"] .chat-link').click();
 // Deleting the chat keeps the folder and offers removal; Git refuses while the worktree has changes.
 await page.locator('[data-chat-id="'+chat.id+'"] .chat-link').click({button:'right'});await page.getByRole('menuitem',{name:'Delete',exact:true}).click();
 await page.getByRole('dialog').filter({hasText:'Delete chat?'}).getByRole('button',{name:'Delete',exact:true}).click();
 const kept=page.getByRole('dialog',{name:'Worktree folder',exact:true});await kept.waitFor();assert.equal(await exists(worktree),true);
 await kept.getByRole('button',{name:'Remove it',exact:true}).click();await kept.getByRole('alert').filter({hasText:'has changes'}).waitFor();
 await fs.rm(path.join(worktree,'slice-result.txt'));await fs.rm(path.join(worktree,'terminal-here.txt'));await fs.rm(path.join(worktree,'claude-result.txt'));await fs.rm(path.join(worktree,'plugin-here.txt'));
 await kept.getByRole('button',{name:'Remove it',exact:true}).click();await kept.waitFor({state:'hidden'});
 assert.equal(await exists(worktree),false);assert.equal(git(folder,'status','--porcelain'),'');
 console.log('PASS R2 worktree chat: model writes and the terminal land in the worktree; the main checkout is untouched; delete keeps the folder and offers removal');
}finally{
 await instance.close().catch(()=>{});ds.stdin.end();ds.kill();
 await host.host('delete_key',{provider:'deepseek'}).catch(()=>{});
 const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');
}
