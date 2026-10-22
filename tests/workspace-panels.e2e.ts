import {_electron as electron} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work/workspace-panels-')),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-workspace-'));
const git=(...args:string[])=>execFileSync('git',['-C',folder,...args],{encoding:'utf8',windowsHide:true}).trim();
git('init','-q','-b','main');git('config','core.autocrlf','false');await fs.writeFile(path.join(folder,'calc.py'),'def add(a, b):\n    return a + b\n');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','base');
await fs.writeFile(path.join(folder,'calc.py'),'def add(a, b):\n    return a - b\n');
await fs.writeFile(path.join(folder,'.gitattributes'),'*.py filter=trip diff=trip\n');
const helper=path.join(folder,'helper-ran.txt').replaceAll('\\','/'),canary=`echo forbidden > '${helper}'`;
for(const key of ['filter.trip.clean','filter.trip.process','diff.trip.textconv','diff.external','core.fsmonitor','core.pager'])git('config',key,canary);git('config','filter.trip.required','true');
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,UNRELATED_SECRET:'synthetic-not-for-terminal'}});
let killed=false;
try{
  const page=await instance.firstWindow();page.setDefaultTimeout(15000);await instance.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.setSize(1460,900);win.show();});
  const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
  async function until(fn:()=>Promise<boolean>,label:string,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,120));}throw Error('Timed out: '+label);}
  await until(async()=>(await call('state')).backend==='ready','backend',90000);await page.getByLabel('Close settings',{exact:true}).click();
  await call('workingFolder',{folder});const chatId=await call('newChat');await page.locator('[data-chat-id="'+chatId+'"] .chat-link').click();
  await page.getByLabel('Open files',{exact:true}).click();await page.locator('.workspace-files button').filter({hasText:'calc.py'}).click();
  const editor=page.getByRole('textbox',{name:'File contents'});await editor.fill('def add(a, b):\n    return a * b\n');
  await page.getByRole('button',{name:'Save',exact:true}).click();await until(async()=>(await fs.readFile(path.join(folder,'calc.py'),'utf8')).includes('a * b'),'editor save');
  await page.screenshot({path:path.join(data,'editor.png')});
  await editor.fill('keep my unsaved draft\n');await fs.writeFile(path.join(folder,'calc.py'),'external change\n');await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'changed on disk'}).waitFor();assert.equal(await editor.textContent(),'keep my unsaved draft');assert.equal(await fs.readFile(path.join(folder,'calc.py'),'utf8'),'external change\n');
  await assert.rejects(call('workingFolder',{clear:true}),/Save or discard/);
  await instance.evaluate(({dialog,app})=>{const original=dialog.showMessageBox;dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});app.quit();dialog.showMessageBox=original;});assert.equal(await editor.textContent(),'keep my unsaved draft');
  await page.getByRole('button',{name:'Discard',exact:true}).click();await page.getByRole('button',{name:'Discard draft',exact:true}).click();await until(async()=>(await editor.textContent())==='external change','discard reload');
  await page.getByRole('button',{name:'Changes',exact:true}).click();await page.getByRole('button',{name:'Working',exact:true}).click();await page.getByLabel('Git diff').filter({hasText:'+external change'}).waitFor();
  assert.equal(await fs.stat(path.join(folder,'helper-ran.txt')).then(()=>true,()=>false),false);console.log('PASS editor Save/Discard, stale save preserves external changes, actual Git diff executes no repository helpers');
  await page.screenshot({path:path.join(data,'changes.png')});
  await page.keyboard.press('Control+Backquote');await until(async()=>(await call('terminalList',{chatId})).length===1,'shortcut terminal');const terminal=(await call('terminalList',{chatId}))[0];
  await call('terminalWrite',{chatId,id:terminal.id,data:"[IO.File]::WriteAllText('terminal-cwd.txt', (Get-Location).Path); [IO.File]::WriteAllText('terminal-env.txt', [string]$env:UNRELATED_SECRET)\r"});
  await until(async()=>fs.stat(path.join(folder,'terminal-cwd.txt')).then(()=>true,()=>false),'terminal cwd');assert.equal(await fs.readFile(path.join(folder,'terminal-cwd.txt'),'utf8'),folder);assert.equal(await fs.readFile(path.join(folder,'terminal-env.txt'),'utf8'),'');
  await page.locator('.terminal-instance.active .xterm-helper-textarea').focus();await page.keyboard.type("[IO.File]::WriteAllText('ui-input.txt', 'typed in xterm')",{delay:2});await page.keyboard.press('Enter');await until(async()=>fs.stat(path.join(folder,'ui-input.txt')).then(()=>true,()=>false),'xterm keyboard input');
  await page.getByLabel('Hide workspace').click();await page.locator('[data-chat-id="'+chatId+'"] .chat-link').click({button:'right'});await page.getByRole('menuitem',{name:'Open in',exact:true}).click();await page.getByRole('menuitem',{name:'Open in terminal',exact:true}).click();assert.equal((await call('terminalList',{chatId}))[0].id,terminal.id);
  const other=await call('newChat');await assert.rejects(call('terminalWrite',{chatId:other,id:terminal.id,data:'anything'}),/another chat/);await assert.rejects(call('workingFolder',{clear:true}),/Close open terminals/);
  await page.locator('[data-chat-id="'+chatId+'"] .chat-link').click();await page.reload();await until(async()=>(await call('state')).backend==='ready','reload');await page.getByLabel('Close settings',{exact:true}).click();await page.locator('[data-chat-id="'+chatId+'"] .chat-link').click();await page.keyboard.press('Control+Backquote');assert.equal((await call('terminalList',{chatId}))[0].id,terminal.id);
  await call('terminalResize',{chatId,id:terminal.id,cols:82,rows:24});
  const listener=net.createServer();await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=(listener.address() as net.AddressInfo).port;await new Promise<void>(resolve=>listener.close(()=>resolve()));
  const server=path.join(folder,'server.cjs');await fs.writeFile(server,`require('http').createServer((q,s)=>s.end('test')).listen(${port},'127.0.0.1')`);
  const running=async()=>fetch('http://127.0.0.1:'+port,{signal:AbortSignal.timeout(500)}).then(()=>true,()=>false);
  await call('terminalWrite',{chatId,id:terminal.id,data:"node .\\server.cjs\r"});await until(running,'terminal child');const beforeInterrupt=(await call('terminalRead',{chatId,id:terminal.id,after:0})).offset;await call('terminalWrite',{chatId,id:terminal.id,data:'\x03'});await until(async()=>!await running(),'Ctrl+C stops child');await until(async()=>/PS [^\r\n]*> /.test((await call('terminalRead',{chatId,id:terminal.id,after:beforeInterrupt})).data),'PowerShell prompt after Ctrl+C');
  await call('terminalWrite',{chatId,id:terminal.id,data:"node .\\server.cjs\r"});try{await until(running,'second terminal child');}catch(error){await fs.writeFile(path.join(data,'terminal-failure.json'),JSON.stringify(await call('terminalRead',{chatId,id:terminal.id,after:0}),null,2));throw error;}
  await page.screenshot({path:path.join(data,'terminal.png')});await page.getByLabel('Close terminal 1',{exact:true}).click();await until(async()=>!await running(),'close stops child');
  const crashTerminal=await call('terminalOpen',{chatId});await call('terminalWrite',{chatId,id:crashTerminal.id,data:"node .\\server.cjs\r"});await until(running,'crash terminal child');
  const pid=await instance.evaluate(()=>process.pid);console.log('Crash identities',JSON.stringify({main:pid,launcher:instance.process().pid,port}));process.kill(pid,'SIGKILL');killed=true;await until(async()=>!await running(),'main crash ends terminal',15000);
  await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({editor:true,staleSave:true,gitHelpersSuppressed:true,interactiveTerminal:true,root:true,environment:true,chatOwnership:true,reload:true,ctrlC:true,closeTree:true,crash:true,folder},null,2));
  console.log('PASS real PowerShell input/cwd, clean environment, chat ownership, tab/reload retention, resize, Ctrl+C, close and main crash cleanup');console.log(data);
}finally{
  if(!killed)await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});
  execFileSync(path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe'),['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as vault;vault.delete(sys.argv[1])",'Trismegistus/Test/'+path.basename(data)+'/encryption'],{cwd:root,windowsHide:true});
}
