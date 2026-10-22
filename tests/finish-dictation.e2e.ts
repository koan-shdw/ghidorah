import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {speechClip} from './speech-clips';

// Real local speech packages, tiny model and Chromium recorder; no live accounts or physical microphone.
const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','finish-dictation-')),namespace='Trismegistus/Test/'+path.basename(data);
const host=new Backend(root,data,namespace,()=>{}),clip=await speechClip(path.join(root,'work','test-assets'),'0.wav');
await host.host('initialize');
const instance=await electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:[...(process.env.TRISMEGISTUS_EXE?[]:[root]),'--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+clip.file],env:{...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_CLAUDE:path.join(root,'tests/fixtures/claude-cli.mjs'),TRISMEGISTUS_TEST_CLAUDE_NODE:process.execPath},timeout:30000});
try{
 const page=await instance.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(s:any)=>boolean,timeout=90000)=>{const end=Date.now()+timeout;while(Date.now()<end){const s=await call('state');if(predicate(s))return s;await page.waitForTimeout(200);}throw Error('Timed out');};
 await wait(s=>s.claude?.models?.length);await call('wizardFinish');
 const closeSettings=page.getByRole('button',{name:'Close settings',exact:true});if(await closeSettings.isVisible())await closeSettings.click();
 const chatId=await call('newChat');await page.locator('[data-chat-id="'+chatId+'"] .chat-link').click();
 await call('voiceSettings',{sttModel:'tiny'});await page.locator('.settings-link').click();await page.getByRole('button',{name:'Voice',exact:true}).click();
 await page.getByRole('button',{name:'Install speech',exact:true}).click();await wait(s=>s.voice.installing||s.voice.ready);
 await assert.rejects(call('remoteInstall'),/current install/);
 await assert.rejects(call('voiceSettings',{sttModel:'small'}),/speech install/);
 const installed=await wait(s=>!s.voice.installing,1200000);assert.equal(installed.voice.ready,true,await page.locator('.voice-settings [role=alert]').textContent().catch(()=>'')||'Speech installation failed.');
 await page.screenshot({path:path.join(data,'speech-installed.png')});await closeSettings.click();
 // Camera access is refused by the app permission handler, even in its trusted renderer.
 assert.equal(await page.evaluate(async()=>{try{const stream=await navigator.mediaDevices.getUserMedia({video:true});stream.getTracks().forEach(t=>t.stop());return false;}catch{return true;}}),true);
 await page.getByRole('button',{name:'Dictate',exact:true}).click();await page.getByRole('button',{name:'Stop dictation',exact:true}).waitFor();
 const box=page.getByLabel('Message',{exact:true});await box.fill('Keep my typed text.');
 await page.waitForTimeout(7500);await page.getByRole('button',{name:'Stop dictation',exact:true}).click();
 await page.waitForFunction(()=>/yellow/i.test((document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement)?.value),{},{timeout:180000});
 const typed=await box.inputValue();assert.ok(typed.startsWith('Keep my typed text.'));assert.match(typed.toLowerCase(),/yellow lamps?/,'Clip: '+clip.text);assert.match(typed.toLowerCase(),/light up/);
 assert.equal((await call('state')).turns.some((turn:any)=>turn.chatId===chatId),false);assert.deepEqual(await fs.readdir(path.join(data,'dictation')),[]);
 await page.screenshot({path:path.join(data,'dictation.png')});
 // Start another real decode, cancel it, and confirm cleanup and unchanged text.
 await page.getByRole('button',{name:'Dictate',exact:true}).click();await page.waitForTimeout(2500);await page.getByRole('button',{name:'Stop dictation',exact:true}).click();await page.getByRole('button',{name:'Cancel dictation',exact:true}).click();
 await page.waitForFunction(()=>!!document.querySelector('button[aria-label="Dictate"]'));assert.equal(await box.inputValue(),typed);
 const end=Date.now()+20000;while((await fs.readdir(path.join(data,'dictation'))).length&&Date.now()<end)await page.waitForTimeout(100);assert.deepEqual(await fs.readdir(path.join(data,'dictation')),[]);
 const popupPromise=instance.waitForEvent('window');await call('openChatWindow',{chatId});const popup=await popupPromise;
 await popup.getByRole('button',{name:'Dictate',exact:true}).waitFor();
 await assert.rejects(popup.evaluate(()=>window.desktop.invoke('dictate',{chatId:'another-chat'})),/another chat/);
 await assert.rejects(call('dictate',{chatId}),/open window/);
 await popup.getByRole('button',{name:'Dictate',exact:true}).click();await popup.getByRole('button',{name:'Stop dictation',exact:true}).waitFor();
 const closed=popup.waitForEvent('close');void popup.evaluate(()=>window.desktop.invoke('window',{action:'close'})).catch(()=>{});await closed;
 console.log('PASS dictation: verified speech install, install serialization, camera denied, real recorder/local CPU transcript, typed draft preserved without sending, cancellation cleans audio, chat-window ownership and microphone close. Profile: '+data);
}catch(error){const page=instance.windows()[0];if(page){await page.screenshot({path:path.join(data,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(data,'failure.html'),await page.content().catch(()=>''));}console.error('Profile: '+data);throw error;
}finally{
 await instance.close().catch(()=>{});
 const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');
}
