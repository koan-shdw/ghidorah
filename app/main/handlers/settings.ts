// settings handlers: moved out of app/main.ts unchanged (SPLIT-PLAN step 7); main.ts spreads them into handlers.
import {readAlwaysOn} from '../../always-on';
import {readChatLayout} from '../../chat-layout';
import {LIVE_VOICES} from '../../gemini-voice-settings';
import {appUpdates,applyAlwaysOn,backend,chatWindows,data,dictations,discoveryRun,emit,handlers,hermesCheck,installing,jobWindows,namespace,pluginRuntime,pluginsChanging,remoteConfigChanging,remoteStart,remoteStop,requestAppExit,routinesTick,runDiscovery,screenDriver,screenEnd,speechInstall,store,telegramInstall,voiceDesk,voiceWindow,wakeInstall} from '../../main';
import {paneKind,readPaneWorkspace,readTree} from '../../pane-layout';
import {allPaneIds} from '../../pane-tree';
import {Routine,nextFiring,readRoutine} from '../../routines';
import {sameApp} from '../../screen-control';
import {speechVoices} from '../../speech-voices';
import type {Chat,Turn} from '../../types';
import {alwaysOn} from '../accounts';
import {dockableJobChats} from '../apps';
import {remoteSave} from '../remote';
import {cronNext} from '../routines';
import {screenApps,screenSettings} from '../screen';
import {hasWork} from '../turns';
import {discoverySettings,updateSettings} from '../updates';
import {speechReady,voiceRow,voiceSettings} from '../voice';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const settingsHandlers:Record<string,(args:any)=>any>={
  // Saved in the store, not the window's localStorage: Chromium writes that late and a quick quit loses it.
  chatLayout(args){store.put('settings',{id:'chat-layout',...readChatLayout(JSON.stringify(args||{}))});emit();},
  paneLayout({tree,workspace}){
    const jobs=new Set(dockableJobChats(store.all<Turn>('turn')).map(chat=>chat.id));
    const clean=readTree(tree,id=>{const pane=paneKind(id);return pane?.kind==='main'||pane?.kind==='workspace'||pane?.kind==='workspaceView'||pane?.kind==='chat'&&store.all<Chat>('chat').some(chat=>chat.id===pane.id&&!chat.parentChatId)&&!chatWindows.has(pane.id)||pane?.kind==='job'&&jobs.has(pane.id)&&!jobWindows.has(pane.id)||pane?.kind==='agent'&&store.all<Turn>('turn').some(turn=>turn.id===pane.id&&turn.automatic?.kind==='agent')&&!jobWindows.has('agent:'+pane.id);});
    if(!clean||!allPaneIds(clean).includes('main'))throw Error('Invalid pane layout.');
    store.put('settings',{id:'pane-layout',tree:clean,workspace:readPaneWorkspace(workspace)});emit();
  },
  alwaysOn(patch){const before=alwaysOn(),next=readAlwaysOn({...before,...patch});applyAlwaysOn(next.startWithWindows!==before.startWithWindows,next);store.put('settings',{id:'always-on',...next});emit();},
  async screenSettingsSave(patch){
    if(hasWork())throw Error('Wait for active work before changing screen control.');
    const next={...screenSettings(),...(typeof patch?.screen==='boolean'?{screen:patch.screen}:{}),...(typeof patch?.ownChrome==='boolean'?{ownChrome:patch.ownChrome}:{})};
    store.put('settings',{id:'browser-tools',...next});if(!next.screen){screenDriver.stop();screenEnd();}emit();await handlers.restart({});
  },
  screenAppRemove({app}){store.put('settings',{id:'screen-apps',apps:screenApps().filter(name=>!sameApp(name,String(app)))});emit();},
  updateSettings({mode}){if(!['manual','automatic'].includes(mode))throw Error('Choose Manual or Automatic.');store.put('settings',{id:'updates',...updateSettings(),mode});emit();},
  async updateCheck(){await appUpdates?.check();},
  async updateDownload(){await appUpdates?.download();},
  updateRestart(){void requestAppExit(true);},
  discoverySettings(patch){const next={...discoverySettings(),...patch};if(!['manual','session'].includes(next.mode)||typeof next.model!=='string')throw Error('Check the new-model check settings.');store.put('settings',{id:'model-discovery',...next});emit();},
  async discoveryCheck(){await runDiscovery();},
  discoveryCancel(){discoveryRun?.abort();},
  async hermesCheck(){await hermesCheck();},
  hermesRelease({tag,state}){if(!['roll-in','skipped'].includes(state))throw Error('Roll in or skip.');store.update<any>('hermes-release',tag,{state});emit();},
  keyRotation({id,done,reset}){const rows=reset?{}:{...store.all<any>('settings').find(row=>row.id==='key-rotation')?.done};if(!reset){if(typeof id!=='string'||!id)throw Error('Unknown supplier.');if(done)rows[id]=Date.now();else delete rows[id];}store.put('settings',{id:'key-rotation',done:rows});emit();},
  async remoteSwitch({on}){
    if(on&&remoteConfigChanging)throw Error('Wait for Remote account or authenticator changes to finish.');
    if(on){remoteSave({enabled:true});try{await remoteStart();}catch(error){remoteSave({enabled:false});emit();throw error;}}
    else{remoteSave({enabled:false});remoteStop();}
    emit();
  },
  remoteInstallCancel(){telegramInstall?.abort();},
  wakeInstallCancel(){wakeInstall?.abort();},
  async voiceFreeKey({key,useGemini,freeTierConfirmed}){
    if(freeTierConfirmed!==true)throw Error('Confirm that this key’s project is on Google’s Free tier.');
    if(useGemini===true)key=(await backend.host('read_key',{provider:'gemini'})).key;
    if(typeof key!=='string'||!key.trim()||key.length>4096||/\s/.test(key.trim()))throw Error('Enter your Google Free tier API key.');
    voiceDesk?.interrupt();backend.scrubber.register(key.trim());
    await backend.host('save_key',{provider:'gemini-voice-free',key:key.trim()});
    store.put('settings',{...voiceRow(),freeKeySaved:true,freeTierConfirmed:true});emit();
  },
  async voiceFreeDisconnect(){
    voiceDesk?.interrupt();await backend.host('delete_key',{provider:'gemini-voice-free'});store.put('settings',{...voiceRow(),freeKeySaved:false,freeTierConfirmed:false});emit();
  },
  voiceSettings(patch){
    if(speechInstall)throw Error('Wait for the speech install to finish.');
    if(!patch||Object.keys(patch).some(key=>!['sttModel','helperModel','edgeVoice','replyVoice','liveVoice','liveReplyVoice','echoDelay','threshold','silenceMs'].includes(key)))throw Error('Invalid voice settings.');
    const current=voiceSettings();if(patch.sttModel!==undefined&&!current.models.includes(patch.sttModel))throw Error('Choose a speech model from the list.');
    if(patch.helperModel!==undefined&&!current.helperModels.includes(patch.helperModel))throw Error('Choose an available helper model.');
    for(const key of ['edgeVoice','replyVoice'])if(patch[key]!==undefined&&!Object.hasOwn(speechVoices,patch[key]))throw Error('Choose a voice from the list.');
    for(const key of ['liveVoice','liveReplyVoice'])if(patch[key]!==undefined&&!Object.hasOwn(LIVE_VOICES,patch[key]))throw Error('Choose a Google voice from the list.');
    if((patch.liveVoice??current.liveVoice)===(patch.liveReplyVoice??current.liveReplyVoice))throw Error('Choose different voices for the helper and main model replies.');
    for(const [key,min,max] of [['echoDelay',300,3000],['threshold',.001,.2],['silenceMs',240,2000]] as const)if(patch[key]!==undefined&&(!Number.isFinite(patch[key])||patch[key]<min||patch[key]>max))throw Error('Invalid microphone setting.');
    voiceDesk?.interrupt();voiceWindow?.webContents.send('select-chat',voiceDesk?.state().chatId);store.put('settings',{...voiceRow(),...patch});emit();
  },
  speechInstallCancel(){speechInstall?.abort();},
  dictationCancel({id,chatId,owner}){const pending=dictations.get(id);if(pending&&pending.owner===owner&&pending.chatId===chatId)pending.controller.abort();},
  async dictate({id,chatId,bytes,mime,owner}){
    if(typeof id!=='string'||!/^[-a-f0-9]{36}$/.test(id)||typeof chatId!=='string'||!Number.isInteger(owner))throw Error('Invalid dictation request.');
    if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>50*1024*1024)throw Error('That recording is empty or too long.');
    if(!['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/wav'].includes(mime))throw Error('Unsupported recording format.');
    if(store.get<Chat>('chat',chatId).archived)throw Error('This chat is archived.');
    if(dictations.size)throw Error('Wait for the other dictation to finish.');
    if(pluginsChanging||installing)throw Error('Wait for the current install to finish.');
    if(!speechReady())throw Error('Install speech on the Voice page first.');
    const controller=new AbortController(),model=voiceSettings().sttModel,runtime=pluginRuntime();dictations.set(id,{owner,chatId,controller});
    let file:string|undefined;
    try{
      const folder=path.join(data,'dictation');await fs.mkdir(folder,{recursive:true});
      if((await fs.realpath(folder)).toLowerCase()!==path.resolve(folder).toLowerCase())throw Error('The dictation folder must stay inside the app data folder.');
      file=path.join(folder,randomUUID()+(mime==='audio/wav'?'.wav':mime.includes('ogg')?'.ogg':'.webm'));await fs.writeFile(file,bytes,{flag:'wx'});
      const result=await backend.host('transcribe',{file,model,runtime},controller.signal);
      if(controller.signal.aborted||store.get<Chat>('chat',chatId).archived)throw Error('Dictation cancelled.');
      return String(result.text||'');
    }finally{dictations.delete(id);if(file)await fs.rm(file,{force:true});}
  },
  async routineSave(input){
    const routine=readRoutine(input);if(!store.all<Chat>('chat').some(chat=>chat.id===routine.chatId&&!chat.archived&&!chat.parentChatId))throw Error('Choose a chat for the routine.');
    const before=input?.id?store.get<Routine>('routine',input.id):undefined,id=before?.id||randomUUID();
    const next=routine.enabled?await nextFiring(routine,Date.now(),cronNext):null;
    if(JSON.stringify(store.all<Routine>('routine').find(row=>row.id===id))!==JSON.stringify(before))throw Error('The routine changed. Review it before saving again.');
    store.put('routine',{...routine,id,nextFiring:next});void routinesTick();return id;
  },
  async routineSwitch({id,enabled}){const routine=store.get<Routine>('routine',id),next=enabled?await nextFiring(routine,Date.now(),cronNext):null;if(JSON.stringify(store.all<Routine>('routine').find(row=>row.id===id))!==JSON.stringify(routine))throw Error('The routine changed. Review it before changing its schedule.');store.put('routine',{...routine,enabled:!!enabled,nextFiring:next});void routinesTick();},
  routineDelete({id}){store.remove('routine',id);emit();},
  // Tests move the clock for routines; only under the test key namespace.
  async routineTick({now}){if(!namespace.startsWith('Trismegistus/Test/')||!Number.isSafeInteger(now))throw Error('Request refused');await routinesTick(now);}
};
