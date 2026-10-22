import {_electron as electron,type Page} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {mainWindow,pollState} from './fixtures/poll-state';
import {speechClip} from './speech-clips';
import model from '../backend/wake-model.json';

// Real pinned detector + recorded speech through Chromium; isolated vault, no account or physical mic.
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','finish-wake-')),namespace='Trismegistus/Test/'+path.basename(data),clip=await speechClip(path.join(root,'work/test-assets'),'0.wav');
const host=new Backend(root,data,namespace,()=>{});await host.host('initialize');
const app=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:[...(process.env.TRISMEGISTUS_EXE?[]:[root]),'--mute-audio','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+clip.file],env:{...process.env,TRISMEGISTUS_TEST_DATA:data},timeout:30000});
try{
 const page=await mainWindow(app),call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 await pollState(page,state=>state.backend==='ready');await call('wizardFinish');
 assert.equal((await call('state')).voice.wake.enabled,false);assert.equal(app.windows().some(page=>page.url().endsWith('#wake')),false);
 await assert.rejects(call('wakeSave',{phrase:'こんにちは'}),/English words/);await assert.rejects(call('wakeSave',{enabled:true}),/Install wake-word/);
 const a=await call('newChat'),b=await call('newChat');await call('sidebarChat',{action:'rename',chatId:a,name:'Wake alpha'});await call('sidebarChat',{action:'rename',chatId:b,name:'Wake beta'});
 const close=page.getByRole('button',{name:'Close settings',exact:true});if(await close.isVisible())await close.click();
 await page.locator('[data-chat-id="'+b+'"] .chat-link').click();await call('wakeSave',{phrase:'light up'});
 await call('wakeInstall');assert.equal((await call('state')).voice.wake.installed,true);
 await call('wakeSave',{enabled:true});await pollState(page,state=>state.voice?.wake.status==='Listening');
 let capture=app.windows().find(page=>page.url().endsWith('#wake'))!;assert.ok(capture);assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(window=>window.webContents.getURL().endsWith('#wake')).every(window=>!window.isVisible())),true);
 await assert.rejects(capture.evaluate(()=>window.desktop.invoke('submit',{chatId:'bad',text:'forged'})),/unavailable in wake-word/);await assert.rejects(call('wakeFeed',{bytes:new Uint8Array(2560)}),/refused/);
 const popup=async()=>{const end=Date.now()+45000;while(Date.now()<end){const voice=app.windows().find(page=>page.url().endsWith('#voice'));if(voice){await voice.getByLabel('Voice destination').waitFor();return voice;}await page.waitForTimeout(100);}throw Error('Wake did not open voice: '+JSON.stringify((await call('state')).voice.wake));};
 let voice:Page=await popup();assert.equal(await voice.getByLabel('Voice destination').inputValue(),b);await voice.getByText('Listening…',{exact:true}).waitFor();await voice.getByRole('button',{name:'Stop speaking and listening'}).click();
 await pollState(page,state=>state.voice?.wake.status==='Paused while voice is open');assert.equal(capture.isClosed(),true);await page.waitForTimeout(1500);assert.equal(app.windows().filter(page=>page.url().endsWith('#voice')).length,1);
 const firstClose=voice.waitForEvent('close');await voice.getByRole('button',{name:'Close voice'}).click();await firstClose;
 await pollState(page,state=>state.voice?.wake.status==='Listening');
 const popped=app.waitForEvent('window');await call('openChatWindow',{chatId:a});const chat=await popped;await chat.waitForURL(url=>url.hash==='#chat='+a);await chat.bringToFront();
 voice=await popup();assert.equal(await voice.getByLabel('Voice destination').inputValue(),a);await voice.getByRole('button',{name:'Stop speaking and listening'}).click();
 await call('wakeSave',{enabled:false});const secondClose=voice.waitForEvent('close');await voice.getByRole('button',{name:'Close voice'}).click();await secondClose;await page.waitForTimeout(1200);
 assert.equal((await call('state')).voice.wake.status,'Off');assert.equal(app.windows().some(page=>page.url().endsWith('#wake')),false);assert.equal((await call('state')).turns.length,0);
 // Every enable rechecks bytes. No stale Installed label bypasses the check.
 const tokens=path.join(data,'models/wake',model.sha256,'tokens.txt'),original=await fs.readFile(tokens);await fs.writeFile(tokens,'corrupt');
 await assert.rejects(call('wakeSave',{enabled:true}),/missing or changed/);assert.equal((await call('state')).voice.wake.enabled,false);await fs.writeFile(tokens,original);
 await call('wakeSave',{enabled:true});await pollState(page,state=>state.voice?.wake.status==='Listening');await call('restart');await pollState(page,state=>state.voice?.wake.status==='Listening');
 await call('wakeSave',{enabled:false});
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({hiddenCapture:true,realDetector:true,frontMainChat:true,popoutChat:true,pause:true,resume:true,autoListen:true,noImplicitSend:true,modelRechecked:true,backendRestart:true}));
 console.log('PASS wake: pinned install, real recorded-audio detector, hidden PCM capture, front main/popout destination, automatic listening, pause/resume, off, scoped IPC, changed-model refusal and backend restart. Profile: '+data);
}catch(error){console.error('Profile: '+data);throw error;}
finally{await app.close().catch(()=>{});const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');}
