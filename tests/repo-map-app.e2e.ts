import {_electron as electron,chromium,type Browser} from 'playwright';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {getCurrentFuseWire,FuseV1Options} from '@electron/fuses';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {mainWindow,pollState} from './fixtures/poll-state';

const root=process.cwd(),work=await fs.mkdtemp(path.join(root,'work/repo-map-app-'));
const data=path.join(work,'data'),repository=path.join(work,'repository'),other=path.join(work,'other');
await fs.mkdir(repository);await fs.mkdir(other);
await fs.mkdir(path.join(repository,'src'));await fs.mkdir(path.join(repository,'tests'));
await fs.writeFile(path.join(repository,'src/voice.ts'),'export function transcribeVoice(input: string) {return input;}\n');
await fs.writeFile(path.join(repository,'tests/voice.test.ts'),"import {transcribeVoice} from '../src/voice';\n");
await fs.writeFile(path.join(repository,'helper.py'),'def python_helper():\n    return 1\n');
await fs.writeFile(path.join(other,'other.ts'),'export function otherEntry() {}\n');
const temp=path.join(work,'temp');await fs.mkdir(temp);
const executable=process.env.TRISMEGISTUS_EXE,env={...process.env,TEMP:temp,TMP:temp,TRISMEGISTUS_TEST_DATA:data};
let child:ChildProcess|undefined,browser:Browser|undefined;
const app=executable?undefined:await electron.launch({args:[root,'--hidden'],env,timeout:60000});
try{
 if(executable){
  assert.equal((await getCurrentFuseWire(executable))[FuseV1Options.RunAsNode],48,'Test the hardened release with RunAsNode disabled');
  child=spawn(executable,['--remote-debugging-port=0'],{env,windowsHide:true,stdio:['ignore','ignore','pipe']});
  const endpoint=await new Promise<string>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Packaged app did not expose its test browser endpoint.')),60000);
   child!.once('error',error=>{clearTimeout(timer);reject(error);});child!.once('exit',code=>{clearTimeout(timer);reject(Error('Packaged app exited: '+code));});
   let output='';child!.stderr!.on('data',chunk=>{output=(output+chunk).slice(-16000);const match=/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/.exec(output);if(match){clearTimeout(timer);resolve(match[1]);}});
  });
  browser=await chromium.connectOverCDP(endpoint);
 }else await app!.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.webContents.setBackgroundThrottling(false);});
 const page=browser?browser.contexts()[0].pages().find(page=>page.url().endsWith('index.html'))||await browser.contexts()[0].waitForEvent('page'):await mainWindow(app!);page.setDefaultTimeout(30000);
 await page.waitForURL(/index\.html$/);
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,s=>s.backend==='ready');await call('wizardFinish');
 if(await page.getByLabel('Close settings',{exact:true}).isVisible())await page.getByLabel('Close settings',{exact:true}).click();
 const saved=await call('savedAppSave',{name:'Repo map regression',repositories:[repository,other]});
 assert.deepEqual((await call('state')).savedApps.find((a:any)=>a.id===saved.id).repositories,[repository,other]);
 // Exercise the real preload, IPC handler and bundled worker before checking the UI.
 const first=await call('savedAppMap',{id:saved.id,repository});
 assert.equal(first.partial,false,JSON.stringify(first.issues));
 assert.ok(first.files.some((f:any)=>f.symbols.some((s:any)=>s.name==='python_helper')));
 assert.ok(first.edges.some((e:any)=>e.from==='tests/voice.test.ts'&&e.to==='src/voice.ts'));
 await fs.writeFile(path.join(repository,'REPO-MAP-NOTES.json'),JSON.stringify({claims:[{kind:'flow',text:'Voice transcription starts in transcribeVoice.',evidence:[{path:'src/voice.ts',line:1,hash:first.files.find((f:any)=>f.path==='src/voice.ts').hash}]}]}));
 await assert.rejects(call('savedAppMap',{id:saved.id,repository:work}),/belonging to this app/);
 await page.getByLabel('Show chats for Repo map regression',{exact:true}).click();
 const panel=page.getByRole('region',{name:'Repository map',exact:true});
 assert.equal(await panel.evaluate(element=>element===element.parentElement?.lastElementChild),true,'Repository map belongs below the app page content');
 await page.screenshot({path:path.join(work,'app-page-top.png')});
 await panel.getByLabel('Find map idea').waitFor();
 await panel.getByRole('region',{name:'Repository knowledge'}).getByText('Voice transcription starts in transcribeVoice.',{exact:true}).waitFor();
 await panel.getByRole('button',{name:'src/voice.ts:1',exact:true}).click();
 assert.match(await panel.locator('pre').innerText(),/transcribeVoice/);
 await panel.getByLabel('Show all map areas').click();
 const beforeZoom=await panel.locator('canvas').evaluate(e=>(e as HTMLCanvasElement).toDataURL());
 await panel.getByLabel('Map zoom',{exact:true}).focus();await page.keyboard.press('ArrowRight');
 assert.notEqual(await panel.locator('canvas').evaluate(e=>(e as HTMLCanvasElement).toDataURL()),beforeZoom);
 await panel.getByRole('button',{name:'3D',exact:true}).click();
 assert.equal(await panel.getByRole('button',{name:'3D',exact:true}).getAttribute('aria-pressed'),'true');
 await panel.getByLabel('Rotate',{exact:true}).check();
 assert.equal(await panel.getByLabel('Rotate',{exact:true}).isChecked(),true);
 await panel.getByLabel('Find map idea').fill('transcribe');
 await panel.getByRole('button',{name:'src · 1 files',exact:true}).click();
 await panel.getByRole('button',{name:/^src\/voice.ts ·/}).click();
 assert.match(await panel.locator('pre').innerText(),/transcribeVoice/);
 assert.match(await panel.locator('pre').innerText(),/tests\/voice.test.ts/);
 await panel.getByRole('button',{name:'2D',exact:true}).click();
 assert.equal(await panel.getByLabel('Rotate',{exact:true}).isDisabled(),true);
 await fs.writeFile(path.join(repository,'src/voice.ts'),'export function changedVoice() {}\n');
 await panel.getByRole('button',{name:'Refresh map',exact:true}).click();
 await panel.getByRole('button',{name:'Refresh map',exact:true}).waitFor();
 await panel.getByLabel('Find map idea').fill('changedVoice');
 await panel.getByRole('button',{name:'src · 1 files',exact:true}).click();
 await panel.getByRole('button',{name:/^src\/voice.ts ·/}).click();
 assert.match(await panel.locator('pre').innerText(),/changedVoice/);
 await panel.getByText('flow · stale evidence',{exact:true}).waitFor();
 const refreshed=JSON.parse(await fs.readFile(path.join(repository,'.repo-map/index.json'),'utf8'));
 assert.notEqual(refreshed.fingerprint,first.fingerprint);
 await panel.getByLabel('Map repository').selectOption(other);
 await panel.getByLabel('Find map idea').waitFor();
 await panel.getByLabel('Find map idea').fill('otherEntry');
 await panel.getByRole('button',{name:'(root) · 1 files',exact:true}).click();
 await panel.getByRole('button',{name:/other.ts/}).click();
 assert.match(await panel.locator('pre').innerText(),/otherEntry/);
 assert.equal(await panel.getByRole('alert').count(),0);assert.deepEqual(errors,[]);
 await page.screenshot({path:path.join(work,'app-map.png')});
 const packaged=browser?/\/resources\/app\.asar\/dist\/index\.html$/.test(page.url()):await app!.evaluate(({app})=>app.isPackaged);
 if(executable)assert.equal(packaged,true,'The tested renderer must come from the packaged ASAR');
 await fs.writeFile(path.join(work,'verified.json'),JSON.stringify({packaged,bottomOfPage:true,preload:true,worker:true,python:true,repositoryBoundary:true,controls:true,zoom:true,knowledge:true,staleEvidence:true,refresh:true,repositorySwitch:true},null,2));
 console.log('PASS real Electron Apps map: preload, worker, Python, boundary, graph controls, refresh and repository switching. packaged='+packaged+' '+work);
}finally{
 if(app){await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
 await browser?.close().catch(()=>{});
 if(child?.pid&&child.exitCode===null)try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}
}
