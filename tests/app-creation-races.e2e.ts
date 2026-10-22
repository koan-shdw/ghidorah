import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','app-creation-races-')),namespace='Trismegistus/Test/'+path.basename(data),folder=await fs.mkdtemp(path.join(os.tmpdir(),'tris-app-races-'));await fs.mkdir(path.join(folder,'existing'));
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:[...(process.env.TRISMEGISTUS_EXE?[]:[root]),'--hidden'],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath},timeout:30000});
try{
 await app.evaluate(({app,BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.webContents.setBackgroundThrottling(false);app.on('browser-window-created',(_e,w)=>w.webContents.setBackgroundThrottling(false));BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};BrowserWindow.prototype.focus=function(){};});
 const page=await mainWindow(app),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,state=>!!state.claude?.models?.length);await call('wizardFinish');await call('workingFolder',{folder});
 const chats=[await call('newChat'),await call('newChat')];for(const chatId of chats)await call('addModel',{chatId,model:'claude-code:haiku'});
 let snapshot=await call('state');const projects=chats.map(chatId=>snapshot.chats.find((chat:any)=>chat.id===chatId).projectId);for(const projectId of projects)await call('mode',{projectId,mode:'bypass'});
 const submit=async(chatId:string,name:string,repositories?:string[])=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text:JSON.stringify({action:'mcp',server:'ghidorah',tool:'create_app',arguments:{name,description:'Request from '+chatId,...(repositories?{repositories}:{})}}),models:['claude-code:haiku']});return id;};
 for(const name of ['Concurrent existing','Concurrent new']){
  const ids=await Promise.all(chats.map(chatId=>submit(chatId,name,name.endsWith('existing')?['existing']:undefined)));
  snapshot=await pollState(page,state=>ids.every(id=>state.turns.some(turn=>turn.id===id&&turn.status==='completed')));
  const rows=snapshot.savedApps.filter((row:any)=>row.name===name);assert.equal(rows.length,1);assert.deepEqual(new Set(rows[0].chatIds),new Set(chats));
 }
 // Hold only the first realpath of the working folder. This lands inside createApp,
 // after its entry permission check and before any requested filesystem effect.
 await app.evaluate(({},{folder})=>{const scope=globalThis as any,io=process.getBuiltinModule('fs/promises') as any,realpath=io.realpath;scope.creationHeld=false;io.realpath=async(file:any,...rest:any[])=>{if(String(file).toLowerCase()===folder.toLowerCase()&&new Error().stack?.includes('createAppRecord')){io.realpath=realpath;scope.creationHeld=true;await new Promise(resolve=>scope.creationRelease=resolve);}return realpath(file,...rest);};},{folder});
 const id=await submit(chats[0],'After Plan');
 for(const end=Date.now()+30000;!await app.evaluate(()=>!!(globalThis as any).creationHeld);){if(Date.now()>end)throw Error('Creation did not reach the delayed check');await page.waitForTimeout(50);}
 await call('mode',{projectId:projects[0],mode:'plan'});await app.evaluate(()=>{(globalThis as any).creationRelease();});
 snapshot=await pollState(page,state=>state.turns.some(turn=>turn.id===id&&['completed','failed'].includes(turn.status)));
 assert.equal(snapshot.savedApps.some((row:any)=>row.name==='After Plan'),false);await assert.rejects(fs.stat(path.join(folder,'After-Plan')),error=>(error as NodeJS.ErrnoException).code==='ENOENT');
 assert.match(JSON.stringify(snapshot.tools.filter((tool:any)=>tool.turnId===id)),/permission mode changed|Plan mode/);
 // A refusal before filesystem effects must release its action automatically.
 assert.equal(snapshot.workReview.some((row:any)=>row.name==='mcp__ghidorah__create_app'&&row.args?.name==='After Plan'),false);
 await call('mode',{projectId:projects[0],mode:'bypass'});const retry=await submit(chats[0],'After Plan');snapshot=await pollState(page,state=>state.turns.some(turn=>turn.id===retry&&turn.status==='completed'));assert.equal(snapshot.savedApps.filter((row:any)=>row.name==='After Plan').length,1);
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({concurrentExisting:true,concurrentNew:true,modeChangePreventsEffects:true,noFalseHold:true,lockReleased:true,hidden:true}));
 console.log('PASS app creation races: concurrent existing/new requests share one app and both chat links; a mode change during filesystem inspection prevents effects; retry releases the lock. Profile: '+data);
}finally{await app.evaluate(()=>{(globalThis as any).creationRelease?.();}).catch(()=>{});await app.close().catch(()=>{});const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');}
