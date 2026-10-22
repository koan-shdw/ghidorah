import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{build}=require('esbuild'),{_electron}=require('playwright');
declare const audit:any;
const appRoot=path.resolve('.');
const here=await fs.mkdtemp(path.join(appRoot,'work','dictation-lifecycle-')),entry=path.join(here,'dictation-fixture.cjs');
await fs.writeFile(entry,"const {app,BrowserWindow}=require('electron');app.setPath('userData',__dirname);app.whenReady().then(()=>new BrowserWindow({webPreferences:{sandbox:true,contextIsolation:true}}).loadURL('about:blank'));app.on('window-all-closed',()=>app.quit());");
const component=path.join(appRoot,'app/dictation.tsx').replaceAll('\\','/');
const {outputFiles}=await build({stdin:{contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {DictationButton} from ${JSON.stringify(component)};
window.audit={stops:0,starts:0,recorders:[],calls:0,transcribed:0,aborted:0,pending:false,hold:false,fail:false};const audit=window.audit;
Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{audit.calls++;if(audit.pending)await new Promise(resolve=>audit.allow=resolve);return {getTracks:()=>[{stop:()=>audit.stops++}]};}}});
window.MediaRecorder=class {static isTypeSupported(){return true;}constructor(stream){if(audit.fail)throw Error('constructor failed');this.state='inactive';audit.recorders.push(this);}start(){this.state='recording';audit.starts++;}stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['fixture'])});void this.onstop?.();}};
const host=document.createElement('div');document.body.append(host);let root=createRoot(host);audit.unmount=()=>root.unmount();audit.mount=()=>{root=createRoot(host);root.render(<Harness/>);};
function Harness(){const [draft,setDraft]=useState('original draft'),[owner,setOwner]=useState('one'),[disabled,setDisabled]=useState(false);audit.other=()=>{setOwner('two');setDraft('other chat');};audit.disable=()=>setDisabled(true);return <><input aria-label="Draft" value={draft} onChange={e=>setDraft(e.target.value)}/><DictationButton key={owner} disabled={disabled} dictate={async(bytes,mime,signal)=>{audit.transcribed++;signal.addEventListener('abort',()=>audit.aborted++);if(audit.hold)await new Promise(resolve=>audit.finish=resolve);return 'spoken words';}} insert={text=>setDraft(draft.trim()?draft.replace(/\\s*$/,' ')+text:text)}/></>;}
root.render(<Harness/>);`,loader:'tsx',resolveDir:appRoot},bundle:true,write:false,nodePaths:[path.join(appRoot,'node_modules')],platform:'browser'});
const app=await _electron.launch({executablePath:require('electron'),args:[entry]});
try{
 const page=await app.firstWindow();await page.addScriptTag({content:outputFiles[0].text});
 const click=(name:string)=>page.getByRole('button',{name,exact:true}).click(),remount=async()=>{await page.evaluate(()=>{audit.unmount();audit.pending=false;audit.hold=false;audit.fail=false;audit.mount();});await page.getByRole('button',{name:'Dictate',exact:true}).waitFor();};
 await click('Dictate');await page.getByLabel('Draft').fill('typed while recording');await click('Stop dictation');
 await page.waitForFunction(()=>(document.querySelector('input') as HTMLInputElement).value==='typed while recording spoken words');assert.equal(await page.evaluate(()=>audit.stops),1);
 await click('Dictate');await page.evaluate(()=>audit.disable());assert.equal(await page.getByRole('button',{name:'Stop dictation',exact:true}).isEnabled(),true);await page.evaluate(()=>audit.unmount());assert.equal(await page.evaluate(()=>audit.stops),2);
 await page.evaluate(()=>{audit.pending=true;audit.mount();});await click('Dictate');const starts=await page.evaluate(()=>audit.starts);await page.evaluate(()=>{audit.unmount();audit.allow();});await page.waitForFunction(()=>audit.stops===3);assert.equal(await page.evaluate(()=>audit.starts),starts);
 await page.evaluate(()=>{audit.pending=false;audit.fail=true;audit.mount();});await click('Dictate');await page.getByRole('alert').filter({hasText:'constructor failed'}).waitFor();assert.equal(await page.evaluate(()=>audit.stops),4);
 await remount();await page.evaluate(()=>audit.hold=true);await click('Dictate');await click('Stop dictation');await page.waitForFunction(()=>!!audit.finish);await page.getByLabel('Draft').fill('typed during transcription');await page.evaluate(()=>audit.finish());await page.waitForFunction(()=>(document.querySelector('input') as HTMLInputElement).value==='typed during transcription spoken words');
 await remount();await page.evaluate(()=>{audit.hold=true;audit.finish=null;});await click('Dictate');await click('Stop dictation');await page.waitForFunction(()=>!!audit.finish);await page.evaluate(()=>audit.other());await page.getByRole('button',{name:'Dictate',exact:true}).waitFor();assert.equal(await page.evaluate(()=>audit.aborted),1);await page.evaluate(()=>audit.finish());assert.equal(await page.getByLabel('Draft').inputValue(),'other chat');
 await remount();await page.evaluate(()=>{audit.hold=true;audit.finish=null;});await click('Dictate');await click('Stop dictation');await page.waitForFunction(()=>!!audit.finish);await click('Cancel dictation');await page.evaluate(()=>audit.finish());assert.equal(await page.getByLabel('Draft').inputValue(),'original draft');assert.equal(await page.evaluate(()=>audit.aborted),2);
 console.log('PASS dictation: current draft preserved during recording/transcription; pending permission and recording cleaned on unmount; constructor failure releases microphone; Stop stays available; chat changes and Cancel abort/discard late results.');
}finally{await app.close();}
