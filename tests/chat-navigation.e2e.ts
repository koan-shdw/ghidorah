import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {PYTHON} from '../app/backend';

async function main(){
const root=process.cwd();
const data=await fs.mkdtemp(path.join(root,'work/chat-navigation-'));
const folder=await fs.mkdtemp(path.join(path.dirname(data),'navigation-repo-'));await fs.writeFile(path.join(folder,'note.txt'),'new review text\n');
execFileSync('git',['init','-q',folder],{windowsHide:true});
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data}});
try {
  const page=await app.firstWindow();
  const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
  const until=async(check:(s:any)=>boolean)=>{
    for(const end=Date.now()+30000;Date.now()<end;){const s=await call('state');if(check(s))return s;await new Promise(r=>setTimeout(r,100));}
    throw Error('Timed out waiting for app state');
  };
  await until(s=>s.backend==='ready');
  const close=page.getByRole('button',{name:'Close settings',exact:true});
  await close.click();
  const first=await call('newChat'),second=await call('newChat');
  await page.locator('[data-chat-id="'+second+'"] .chat-link').click();
  await until(s=>s.chatLayout?.chatId===second);
  const composer=page.getByRole('region',{name:'Main chat',exact:true}).getByLabel('Message',{exact:true});
  await composer.fill('second draft must stay here');
  await until(s=>s.chats.find((c:any)=>c.id===second)?.draft==='second draft must stay here');
  await app.evaluate(({ipcMain})=>{
    const handler=(ipcMain as any)._invokeHandlers.get('app');
    (globalThis as any).auditStateGate={hold:true,waiting:0,releases:[]};
    ipcMain.removeHandler('app');
    ipcMain.handle('app',async(event,method,args)=>{
      const result=await handler(event,method,args),gate=(globalThis as any).auditStateGate;
      if(method==='addProject')gate.created=result;
      if(method==='state'&&gate.hold){gate.waiting++;await new Promise(resolve=>gate.releases.push(resolve));}
      return result;
    });
  });
  await page.locator('[data-chat-id="'+first+'"] .chat-link').click();
  await composer.fill('typed immediately after selecting first');
  await app.evaluate(()=>{const gate=(globalThis as any).auditStateGate;gate.hold=false;for(const resolve of gate.releases)resolve();});
  await until(s=>s.chatLayout?.chatId===first);
  const s=await call('state'),result={data,first:s.chats.find((c:any)=>c.id===first)?.draft,second:s.chats.find((c:any)=>c.id===second)?.draft,visible:await composer.inputValue()};
  console.log(JSON.stringify(result));
  assert.equal(result.first,'typed immediately after selecting first','Navigation must immediately bind typing to the chosen chat');
  assert.equal(result.second,'second draft must stay here','Navigation must preserve the previous chat draft');
  assert.equal(result.visible,result.first,'The composer keeps the new typing after the response arrives');
  await app.evaluate(()=>{const gate=(globalThis as any).auditStateGate;gate.hold=true;gate.releases=[];});
  await page.locator('[data-chat-id="'+second+'"] .chat-link').click();
  await page.locator('[data-chat-id="'+first+'"] .chat-link').click();
  await composer.fill('latest selection and edit survive reordered responses');
  await app.evaluate(()=>{const gate=(globalThis as any).auditStateGate;gate.hold=false;for(const resolve of gate.releases.reverse())resolve();});
  await until(s=>s.chatLayout?.chatId===first&&s.chats.find((c:any)=>c.id===first)?.draft==='latest selection and edit survive reordered responses');
  assert.equal(await composer.inputValue(),'latest selection and edit survive reordered responses');
  assert.equal((await call('state')).chats.find((c:any)=>c.id===second)?.draft,'second draft must stay here');

  await call('workingFolder',{folder});
  const diff=await call('workspaceChanges',{file:'note.txt'});
  await app.evaluate(()=>{const gate=(globalThis as any).auditStateGate;gate.hold=true;gate.releases=[];});
  await page.locator('[data-chat-id="'+second+'"] .chat-link').click();
  await app.evaluate(async()=>{const gate=(globalThis as any).auditStateGate;for(let n=0;n<100;n++){if(gate.releases.length)return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Navigation did not reach the response gate');});
  await call('reviewDraft',{chatId:second,file:'note.txt',root:diff.root,revision:diff.revision});
  await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('.primary-chat-pane [aria-label="Message"]')?.value.includes('Review the'));
  const review=await composer.inputValue();
  await app.evaluate(()=>{const gate=(globalThis as any).auditStateGate;gate.hold=false;for(const resolve of gate.releases)resolve();});
  await call('state');await page.waitForTimeout(100);
  assert.equal(await composer.inputValue(),review,'A late navigation response must not erase a review added to the draft');

  await app.evaluate(()=>{const gate=(globalThis as any).auditStateGate;gate.hold=true;gate.releases=[];gate.created=null;});
  await page.locator('.sidebar-tools button.nav').filter({hasText:'New project'}).click();
  const created=await app.evaluate(async()=>{const gate=(globalThis as any).auditStateGate;for(let n=0;n<300;n++){if(gate.created&&gate.releases.length)return gate.created;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('New chat did not reach the response gate');});
  await page.locator('[data-chat-id="'+created+'"] .chat-link[aria-current="page"]').waitFor();
  await app.evaluate(()=>{const gate=(globalThis as any).auditStateGate;gate.hold=false;for(const resolve of gate.releases)resolve();});
  await until(s=>s.chatLayout?.chatId===created);
  assert.equal(await composer.inputValue(),'','A new project stays selected while its state response arrives');

} finally {
  await app.close();
  execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1]+'/encryption')",'Trismegistus/Test/'+path.basename(data)],{cwd:root,windowsHide:true});
}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
