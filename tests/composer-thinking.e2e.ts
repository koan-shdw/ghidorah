import {_electron as electron,type Page} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {Backend,PYTHON} from '../app/backend';

const root=process.cwd(),data=await fs.mkdtemp(path.join(root,'work','composer-thinking-')),namespace='Trismegistus/Test/'+path.basename(data),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-thinking-'));
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath}});
try{
 const main=await app.firstWindow(),errors:string[]=[];main.on('pageerror',e=>errors.push(e.message));
 const call=(method:string,args:any={})=>main.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 async function wait(predicate:(s:any)=>boolean){for(let i=0;i<900;i++){const s=await call('state');if(predicate(s))return s;await main.waitForTimeout(100);}throw Error('State timed out');}
 await wait(s=>s.claude?.models?.length);await call('wizardFinish');await call('workingFolder',{folder});
 const chatId=await call('newChat');await call('addModel',{chatId,model:'claude-code:haiku'});
 if(await main.getByLabel('Close settings',{exact:true}).isVisible())await main.getByLabel('Close settings',{exact:true}).click();
 await main.locator('[data-chat-id="'+chatId+'"] .chat-link').click();
 const state=await call('state');await call('mode',{projectId:state.chats.find((c:any)=>c.id===chatId).projectId,mode:'bypass'});
 const start=async(page=main)=>{const id=crypto.randomUUID();await page.evaluate(args=>window.desktop.invoke('submit',args),{id,chatId,text:JSON.stringify({action:'thinking'}),models:['claude-code:haiku']});await wait(s=>s.turns.find((t:any)=>t.id===id)?.reasoning.length>150);return id;};
 async function observe(page:Page,value:string){
  await page.evaluate('globalThis.__name = target => target');
  await page.getByRole('combobox',{name:'Message',exact:true}).fill(value);
  await page.waitForTimeout(120);
  return page.evaluate(()=>{
   const input=document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!,initial=input.getBoundingClientRect(),value=input.value;
   let frames=0,changed=0,replaced=0,moved=0,lostFocus=0,maxGap=0;
   const placeholders=new Set<string>();const start=performance.now();
   return new Promise<any>(resolve=>{function sample(){
    const current=document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]'),r=input.getBoundingClientRect(),scroll=document.querySelector<HTMLElement>('.transcript');frames++;
    if(current!==input)replaced++;if(input.value!==value)changed++;if(document.activeElement!==input)lostFocus++;
    if(Math.abs(r.y-initial.y)>.5||r.height!==initial.height)moved++;
    placeholders.add(input.placeholder);if(scroll)maxGap=Math.max(maxGap,scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight);
    if(performance.now()-start<2200)requestAnimationFrame(sample);else resolve({frames,changed,replaced,moved,lostFocus,maxGap,placeholders:[...placeholders]});
   }requestAnimationFrame(sample);});
  });
 }
 const results:any[]=[];
 for(const value of ['', 'Keep this follow-up while you think']){
  await main.getByLabel('Chat view',{exact:true}).selectOption('thinking');const id=await start();const result=await observe(main,value);results.push({view:'main',value,...result});
  assert.ok(result.frames>20);assert.equal(result.changed,0);assert.equal(result.replaced,0);assert.equal(result.moved,0);assert.equal(result.lostFocus,0);assert.deepEqual(result.placeholders,['Message']);assert.ok(result.maxGap<3,JSON.stringify(result));
  await wait(s=>s.turns.find((t:any)=>t.id===id)?.status==='completed');
 }
 // Reading earlier output must remain under the user's control during streaming.
 await main.getByRole('combobox',{name:'Message',exact:true}).fill('');let id=await start();
 await main.locator('.primary-chat-pane .transcript').evaluate(element=>element.scrollTop=0);await main.waitForTimeout(800);
 assert.equal(await main.locator('.primary-chat-pane .transcript').evaluate(element=>element.scrollTop),0);await call('stop',{chatId});await wait(s=>s.turns.find((t:any)=>t.id===id)?.status==='stopped');
 const windowOpened=app.waitForEvent('window');await call('openChatWindow',{chatId});const detached=await windowOpened;await detached.waitForLoadState();await detached.getByLabel('Chat view',{exact:true}).selectOption('thinking');
 id=await start(detached);const result=await observe(detached,'Window draft stays put');results.push({view:'window',...result});assert.equal(result.changed,0);assert.equal(result.replaced,0);assert.equal(result.moved,0);assert.equal(result.lostFocus,0);assert.deepEqual(result.placeholders,['Message']);
 await wait(s=>s.turns.find((t:any)=>t.id===id)?.status==='completed');
 await detached.locator('.chat-window-composer').screenshot({path:path.join(data,'composer.png')});await fs.writeFile(path.join(data,'frames.json'),JSON.stringify(results,null,2));assert.deepEqual(errors,[]);
 console.log('PASS thinking stream: stable empty/typed composer, focus, bounds, placeholder and bottom follow; scroll-up preserved; detached draft stable. '+data);
}finally{await app.close().catch(()=>{});execFileSync(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});}
