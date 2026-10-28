import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{build}=require('esbuild'),{_electron}=require('playwright');
declare const audit:any;
// The dictation hook in a bare Chromium window with a stand-in microphone and app: live text, Done, Cancel and Esc,
// the microphone released on every way out, a late permission after unmount, microphone errors, and a chat change.
const appRoot=path.resolve('.');
const here=await fs.mkdtemp(path.join(appRoot,'work','dictation-lifecycle-')),entry=path.join(here,'dictation-fixture.cjs');
await fs.writeFile(entry,"const {app,BrowserWindow}=require('electron');app.setPath('userData',__dirname);app.whenReady().then(()=>new BrowserWindow({webPreferences:{sandbox:true,contextIsolation:true}}).loadURL('about:blank'));app.on('window-all-closed',()=>app.quit());");
const component=path.join(appRoot,'app/dictation.tsx').replaceAll('\\','/');
const {outputFiles}=await build({stdin:{contents:`
import React,{useRef,useState} from 'react';import {createRoot} from 'react-dom/client';import {useDictation,DictationControls} from ${JSON.stringify(component)};
if(!crypto.randomUUID)crypto.randomUUID=()=>'00000000-0000-4000-8000-'+String(Date.now()).padStart(12,'0').slice(-12);
window.audit={stops:0,calls:[],pending:false,fail:'',processors:[],listener:null};const audit=window.audit;
window.desktop={invoke:async(method,args)=>{audit.calls.push([method,args]);return method==='dictationStart'?{device:'cpu'}:undefined;},onDictation:handler=>{audit.listener=handler;return ()=>{if(audit.listener===handler)audit.listener=null;};}};
audit.say=(type,text)=>{const start=audit.calls.filter(c=>c[0]==='dictationStart').at(-1);audit.listener?.({id:start[1].id,type,text});};
Object.defineProperty(navigator,'mediaDevices',{value:{enumerateDevices:async()=>[],getUserMedia:async()=>{if(audit.pending)await new Promise(resolve=>audit.allow=resolve);if(audit.fail)throw Object.assign(Error('fixture'),{name:audit.fail});return {getTracks:()=>[{stop:()=>audit.stops++}],getAudioTracks:()=>[{}]};}}});
window.AudioContext=class {sampleRate=48000;destination={};createMediaStreamSource(){return {connect(){}};}createGain(){return {gain:{value:1},connect(){}};}createScriptProcessor(){const p={connect(){}};audit.processors.push(p);return p;}close(){return Promise.resolve();}};
const host=document.createElement('div');document.body.append(host);let root=createRoot(host);audit.unmount=()=>root.unmount();audit.mount=()=>{root=createRoot(host);root.render(<Harness/>);};
function Harness(){const [draft,setDraft]=useState('original draft'),[chat,setChat]=useState('one'),input=useRef(null);audit.other=()=>setChat('two');
 const dictation=useDictation({chatId:chat,draft,change:setDraft,input});
 return <><textarea ref={input} aria-label="Message" value={draft} readOnly={dictation.phase!=='idle'} placeholder={dictation.placeholder||'Message'} onFocus={()=>dictation.focus()} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>dictation.key(e)}/><DictationControls dictation={dictation} disabled={false}/></>;}
root.render(<Harness/>);`,loader:'tsx',resolveDir:appRoot},bundle:true,write:false,nodePaths:[path.join(appRoot,'node_modules')],platform:'browser'});
const app=await _electron.launch({executablePath:require('electron'),args:[entry]});
try{
 const page=await app.firstWindow();await page.addScriptTag({content:outputFiles[0].text});
 const button=(name:string)=>page.getByRole('button',{name,exact:true}),box=page.getByLabel('Message');
 const methods=()=>page.evaluate(()=>audit.calls.map((c:any)=>c[0]));
 const remount=async()=>{await page.evaluate(()=>{audit.unmount();audit.pending=false;audit.fail='';audit.mount();});await button('Dictate').waitFor();};
 // Words land where the cursor was, live; Done keeps the final words.
 await box.focus();await page.evaluate(()=>(document.querySelector('textarea') as HTMLTextAreaElement).setSelectionRange(8,8));
 await button('Dictate').click();await button('Stop dictation').waitFor();assert.equal(await box.getAttribute('placeholder'),'Listening...');
 await page.evaluate(()=>audit.say('partial','spoken'));await page.waitForFunction(()=>(document.querySelector('textarea') as HTMLTextAreaElement).value==='original spoken draft');
 await button('Finish dictation').click();assert.ok((await methods()).includes('dictationFinish'));assert.equal(await page.evaluate(()=>audit.stops),1,'the microphone closes on Done');
 await page.evaluate(()=>audit.say('final','spoken words'));await button('Dictate').waitFor();assert.equal(await box.inputValue(),'original spoken words draft');
 // Cancel and Esc put the box back as it was.
 const kept=await box.inputValue();await button('Dictate').click();await button('Stop dictation').waitFor();await page.evaluate(()=>audit.say('partial','discard me'));
 await button('Cancel dictation').click();assert.equal(await box.inputValue(),kept);assert.equal((await methods()).at(-1),'dictationCancel');
 await box.focus();await page.keyboard.press('Control+d');await button('Stop dictation').waitFor();await page.evaluate(()=>audit.say('partial','discard me too'));await page.keyboard.press('Escape');await button('Dictate').waitFor();assert.equal(await box.inputValue(),kept);
 // Unmount while listening releases the microphone and tells the app.
 await button('Dictate').click();await button('Stop dictation').waitFor();const before=await page.evaluate(()=>audit.stops);await page.evaluate(()=>audit.unmount());
 assert.equal(await page.evaluate(()=>audit.stops),before+1);assert.equal((await methods()).at(-1),'dictationCancel');
 // A permission granted after unmount is released at once and starts nothing.
 await page.evaluate(()=>{audit.pending=true;audit.mount();});await button('Dictate').click();const stops=await page.evaluate(()=>audit.stops),processors=await page.evaluate(()=>audit.processors.length);
 await page.evaluate(()=>{audit.unmount();audit.allow();});await page.waitForFunction((count:number)=>audit.stops===count+1,stops);assert.equal(await page.evaluate(()=>audit.processors.length),processors);
 // Microphone errors read like Claude's and offer Dictate again.
 await page.evaluate(()=>{audit.pending=false;audit.fail='NotAllowedError';audit.mount();});await button('Dictate').click();
 await page.getByRole('alert').filter({hasText:'Microphone access is blocked'}).waitFor();await button('Dictate again').waitFor();assert.equal(await box.inputValue(),'original draft');
 // A chat change while listening cancels and puts the box back.
 await remount();await button('Dictate').click();await button('Stop dictation').waitFor();await page.evaluate(()=>audit.say('partial','for the old chat'));await page.evaluate(()=>audit.other());
 await button('Dictate').waitFor();assert.equal(await box.inputValue(),'original draft');
 // A lost worker keeps the words so far and says so.
 await button('Dictate').click();await button('Stop dictation').waitFor();await page.evaluate(()=>{audit.say('partial','so far');audit.say('error','Dictation lost its connection.');});
 await page.getByRole('alert').filter({hasText:'Your words so far are in the message box.'}).waitFor();assert.equal(await box.inputValue(),'original draft so far');
 console.log('PASS dictation lifecycle: live words at the cursor, Done, Cancel and Esc restore, microphone released on unmount and late permission, Claude\'s error wording, chat change cancels, lost worker keeps words.');
}finally{await app.close();}
