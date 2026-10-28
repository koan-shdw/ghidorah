import {_electron as electron} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,PYTHON} from '../app/backend';
import {speechClip} from './speech-clips';

// Dictation, Claude's one for one, through real local speech packages, the tiny model and Chromium's fake microphone
// playing a real spoken clip: live text while speaking, Done, Cancel, Esc, Enter, Ctrl+D, hold to talk, and windows
// that own their dictation. No live accounts or physical microphone.
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
 await call('voiceSettings',{sttModel:'tiny'});await page.locator('.rail-settings').click();await page.getByRole('button',{name:'Voice',exact:true}).click();
 await page.getByRole('button',{name:'Install speech',exact:true}).click();await wait(s=>s.voice.installing||s.voice.ready);
 await assert.rejects(call('remoteInstall'),/current install/);
 await assert.rejects(call('voiceSettings',{sttModel:'small'}),/speech install/);
 const installed=await wait(s=>!s.voice.installing,1200000);assert.equal(installed.voice.ready,true,await page.locator('.voice-settings [role=alert]').textContent().catch(()=>'')||'Speech installation failed.');
 await page.screenshot({path:path.join(data,'speech-installed.png')});await closeSettings.click();
 // Camera access is refused by the app permission handler, even in its trusted renderer.
 assert.equal(await page.evaluate(async()=>{try{const stream=await navigator.mediaDevices.getUserMedia({video:true});stream.getTracks().forEach(t=>t.stop());return false;}catch{return true;}}),true);
 const box=page.getByLabel('Message',{exact:true}),dictate=page.getByRole('button',{name:'Dictate',exact:true}),stop=page.getByRole('button',{name:'Stop dictation',exact:true});
 const value=()=>box.inputValue(),idle=()=>dictate.waitFor({timeout:120000});
 const heard=(pattern:RegExp)=>page.waitForFunction(source=>new RegExp(source,'i').test((document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement)?.value||''),pattern.source,{timeout:120000});
 // Tap: the words arrive while the microphone is still listening (live text), then Done keeps them, unsent.
 await box.fill('Keep my typed text.');await box.press('End');
 const started=Date.now();await dictate.click();await stop.waitFor();
 await page.getByRole('button',{name:'Cancel dictation',exact:true}).waitFor();
 await heard(/yellow|light|squalid|nightfall|brothels/);assert.equal(await stop.isVisible(),true,'text appears while still listening');const live=Date.now()-started;
 // The fake microphone loops the clip from wherever it is; listen until the whole phrase has been said.
 await heard(/yellow lamps?/);await heard(/light up/);
 assert.equal(await box.getAttribute('readonly'),'','the box is held while dictating');
 await page.getByRole('button',{name:'Finish dictation',exact:true}).click();await idle();
 const typed=await value();assert.ok(typed.startsWith('Keep my typed text. '),typed);assert.match(typed.toLowerCase(),/yellow lamps?/,'Clip: '+clip.text);assert.match(typed.toLowerCase(),/light up/);
 await page.screenshot({path:path.join(data,'dictation.png')});
 // Ctrl+D starts in the box you are typing in; Esc cancels and puts the box back.
 await box.focus();await page.keyboard.press('Control+d');await stop.waitFor();
 await page.waitForFunction(()=>(document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement).placeholder==='Listening...',null,{timeout:30000});
 await page.waitForFunction(before=>(document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement).value.length>before.length,typed,{timeout:120000});
 await page.keyboard.press('Escape');await idle();assert.equal(await value(),typed,'Esc puts the box back as it was');
 // Enter finishes, never sends.
 await box.focus();await page.keyboard.press('Control+d');await stop.waitFor();
 await page.waitForFunction(before=>(document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement).value.length>before.length,typed,{timeout:120000});
 await page.keyboard.press('Enter');await idle();const entered=await value();assert.ok(entered.length>typed.length&&entered.startsWith(typed));
 // Hold to talk: a press held past half a second finishes when let go.
 const mic=await dictate.boundingBox();await page.mouse.move(mic!.x+mic!.width/2,mic!.y+mic!.height/2);
 await page.mouse.down();await stop.waitFor();await page.waitForFunction(before=>(document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement).value.length>before.length,entered,{timeout:120000});
 await page.mouse.up();await idle();assert.ok((await value()).length>entered.length,'letting go of a held press finishes and keeps the words');
 assert.equal((await call('state')).turns.some((turn:any)=>turn.chatId===chatId),false,'dictation never sends');
 // A window owns its dictation: another chat's window cannot start one here, and an open chat window keeps its own.
 const popupPromise=instance.waitForEvent('window');await call('openChatWindow',{chatId});const popup=await popupPromise;
 await popup.getByRole('button',{name:'Dictate',exact:true}).waitFor();
 await assert.rejects(popup.evaluate(()=>window.desktop.invoke('dictationStart',{id:crypto.randomUUID(),chatId:'another-chat',language:''})),/another chat/);
 await assert.rejects(call('dictationStart',{id:crypto.randomUUID(),chatId,language:''}),/open window/);
 await assert.rejects(call('dictationStart',{id:'not-an-id',chatId:'x',language:''}),/Invalid dictation request/);
 await popup.getByRole('button',{name:'Dictate',exact:true}).click();await popup.getByRole('button',{name:'Stop dictation',exact:true}).waitFor();
 const closed=popup.waitForEvent('close');void popup.evaluate(()=>window.desktop.invoke('window',{action:'close'})).catch(()=>{});await closed;
 console.log('PASS dictation: verified speech install, camera denied, live text while listening (first words after '+live+' ms), Done keeps typed text unsent, Ctrl+D and Esc, Enter, hold to talk, window ownership. Profile: '+data);
}catch(error){const page=instance.windows()[0];if(page){await page.screenshot({path:path.join(data,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(data,'failure.html'),await page.content().catch(()=>''));}console.error('Profile: '+data);throw error;
}finally{
 await instance.close().catch(()=>{});
 const cleanup=spawn(PYTHON,['-c',"import sys;sys.path.insert(0,'backend');import windows_credentials as v;v.delete(sys.argv[1])",namespace+'/encryption'],{windowsHide:true,stdio:'ignore'});await once(cleanup,'close');
}
