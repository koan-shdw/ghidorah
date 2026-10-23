// voice: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import whisperModels from '../../backend/whisper-models.json';
import {readChatLayout} from '../chat-layout';
import {liveVoiceSettings} from '../gemini-voice-settings';
import {backend,chatWindows,closeWakeCapture,jobWindows,namespace,openVoice,store,voiceDesk,voiceFront,voiceListenOnOpen,voiceMainChat,voiceMethods,voiceWindow,wakeArmed,wakeFailure,wakeFault,wakeInstall,wakeStatus,win,workspaceWindows} from '../main';
import {providerFor} from '../models';
import {savedSpeechVoices} from '../speech-voices';
import type {Chat,Turn} from '../types';
import {visibleWindowBounds} from '../window-layout';
import {availableModels} from './models';
import {featureInstalled} from './remote';
import {screen} from 'electron';

export function voiceRow(){return store.all<any>('settings').find(row=>row.id==='voice')||{id:'voice'};}
export function voiceSettings(){
  const models=Object.entries(whisperModels as Record<string,{test?:boolean}>).filter(([,model])=>!model.test||namespace.startsWith('Trismegistus/Test/')).map(([name])=>name),row=voiceRow();
  const helperModels=availableModels().filter(model=>providerFor(model)!=='claude-code');
  return {...liveVoiceSettings(row),helperModel:helperModels.includes(row.helperModel)?row.helperModel:helperModels.includes('deepseek-flash')?'deepseek-flash':helperModels[0]||'',helperModels,...savedSpeechVoices(row),echoDelay:Number.isFinite(row.echoDelay)?Math.max(300,Math.min(3000,row.echoDelay)):800,threshold:Number.isFinite(row.threshold)?Math.max(.001,Math.min(.2,row.threshold)):.015,silenceMs:Number.isFinite(row.silenceMs)?Math.max(240,Math.min(2000,row.silenceMs)):640,sttModel:models.includes(row.sttModel)?row.sttModel as string:'large-v3',installed:(Array.isArray(row.installed)?row.installed:[]).filter((name:string)=>models.includes(name)) as string[],models};
}
export async function freeVoiceKey(){
  const settings=voiceSettings();if(!settings.freeKeySaved||!settings.freeTierConfirmed)throw Error('Add a Google Free tier key in Settings → Voice.');
  const saved=await backend.host('read_key',{provider:'gemini-voice-free'});if(!saved.key)throw Error('Add a Google Free tier key in Settings → Voice.');
  backend.scrubber.register(saved.key);return saved.key as string;
}
export function voiceTestEndpoint(name:string){
  const value=namespace.startsWith('Trismegistus/Test/')?process.env[name]:undefined;if(!value)return undefined;
  const url=new URL(value);if(url.hostname!=='127.0.0.1'||!['ws:','http:'].includes(url.protocol))throw Error('Invalid voice test endpoint.');return value;
}
export function voiceRequest(method:string,args:any){
  if(!voiceDesk||!voiceWindow||!voiceMethods.has(method))throw Error('This action is unavailable in voice.');
  switch(method){
    case 'voiceState':return {state:voiceDesk.state(),settings:{...voiceSettings(),autoListen:voiceListenOnOpen}};
    case 'voiceSelect':return voiceDesk.select(args.chatId);
    case 'voiceEdit':return voiceDesk.edit(args.identity,args.text);
    case 'voiceRead':return voiceDesk.read();
    case 'voiceLiveStart':return voiceDesk.start();
    case 'voiceLiveFeed':return voiceDesk.feed(args.id,args.bytes);
    case 'voiceCaptureStart':return voiceDesk.begin();
    case 'voiceConfirm':return voiceDesk.confirm(args.ticket,args.bytes);
    case 'voicePlaybackEnd':return voiceDesk.finished(args.id,args.ticket,args.completed);
    case 'voiceInterrupt':return voiceDesk.interrupt();
    case 'voicePoll':return voiceDesk.poll();
    case 'voiceSize':{if(typeof args.large!=='boolean')throw Error('Invalid window size.');const bounds=voiceWindow.getBounds(),next=visibleWindowBounds({...bounds,width:args.large?780:440,height:args.large?780:560},screen.getDisplayMatching(bounds).workArea);voiceWindow.setBounds(next);return;}
    case 'voiceClose':voiceWindow.close();return;
  }
}
export function wakeSettings(){const row=voiceRow();return {enabled:row.wakeEnabled===true,phrase:typeof row.wakePhrase==='string'?row.wakePhrase:'Hey Hermes',installed:row.wakeInstalled===true,installing:!!wakeInstall,status:wakeStatus};}
export function wakeDetected(){
 if(!wakeSettings().enabled||wakeFailure||voiceWindow||!wakeArmed||backend.status!=='ready')return;
 closeWakeCapture();
 const owner=voiceFront&&!voiceFront.isDestroyed()?voiceFront:win;
 const chat=[...chatWindows].find(([,window])=>window===owner)?.[0],job=[...jobWindows].find(([,window])=>window===owner)?.[0],workspace=[...workspaceWindows.values()].find(entry=>entry.window===owner)?.info.chatId;
 let id=chat||workspace||(job?.startsWith('agent:')?store.get<Turn>('turn',job.slice(6)).chatId:job)||voiceMainChat||readChatLayout(JSON.stringify(store.all<any>('settings').find(row=>row.id==='chat-layout')||{})).chatId;
 if(!id)id=store.all<Chat>('chat').find(chat=>!chat.archived&&!chat.parentChatId)?.id||'';
 try{const target=store.get<Chat>('chat',id);openVoice(target.parentChatId||id,owner,true);}catch(error){wakeFault(error);}
}
export function speechInstalled(){return featureInstalled('speech');}
export function speechReady(){const voice=voiceSettings();return speechInstalled()&&voice.installed.includes(voice.sttModel);}
