// settings handlers: moved out of app/main.ts unchanged (SPLIT-PLAN step 7); main.ts spreads them into handlers.
import {readAlwaysOn} from '../../always-on';
import {readChatLayout} from '../../chat-layout';
import {LIVE_VOICES} from '../../gemini-voice-settings';
import {appUpdates,applyAlwaysOn,backend,chatWindows,data,discoveryRun,emit,handlers,hermesCheck,installing,jobWindows,namespace,pluginRuntime,pluginsChanging,remoteConfigChanging,remoteStart,remoteStop,requestAppExit,routinesTick,runDiscovery,screenDriver,screenEnd,speech,speechInstall,store,telegramInstall,voiceDesk,voiceWindow,wakeInstall} from '../../main';
import {paneKind,readPaneWorkspace,readTree} from '../../pane-layout';
import {allPaneIds} from '../../pane-tree';
import {Routine,nextFiring,readRoutine} from '../../routines';
import {sameApp} from '../../screen-control';
import {speechVoices} from '../../speech-voices';
import {dictationHints} from '../../speech-worker';
import {claude} from '../../main';
import {modelLabel} from '../../models';
import type {SavedApp} from '../../saved-apps';
import {connectedModels} from '../models';
import type {Chat,Turn} from '../../types';
import {alwaysOn} from '../accounts';
import {dockableJobChats} from '../apps';
import {remoteRebuildTopics,remoteSave,remoteSettings} from '../remote';
import {cronNext} from '../routines';
import {screenApps,screenSettings} from '../screen';
import {hasWork} from '../turns';
import {discoverySettings,updateSettings} from '../updates';
import {listenEndpoint,listeningKey,listeningView,speechKey,speechReady,voiceRow,voiceSettings} from '../voice';
import {isEngine,isOnline,isWaveStyle} from '../../listening';
import {checkKey} from '../../online-dictation';
import {listeningKeys,onlineDictation} from '../../main';
import {ELEVENLABS_API,elevenLabsAccount,type ElevenLabsAccount} from '../../elevenlabs-account';
import {monthUsage} from '../../usage-months';
import {voiceTestEndpoint} from '../voice';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Settings › Subscriptions. The prices the owner typed, by row id.
function typedPrices():Record<string,number>{
  const saved=store.all<any>('settings').find(row=>row.id==='subscriptions')?.prices,out:Record<string,number>={};
  if(saved&&typeof saved==='object')for(const [id,usd] of Object.entries(saved))if(/^[a-z0-9-]{1,40}$/.test(id)&&typeof usd==='number'&&Number.isFinite(usd)&&usd>=0)out[id]=usd;
  return out;
}
// The ElevenLabs account is asked for at most once in ten minutes, and again when the page asks for a fresh read.
let elevenLabsRead:{at:number;account:ElevenLabsAccount}|null=null;
async function elevenLabs(fresh:boolean){
  if(!fresh&&elevenLabsRead&&Date.now()-elevenLabsRead.at<600000)return elevenLabsRead.account;
  const account=await elevenLabsAccount(await listeningKey('elevenlabs'),voiceTestEndpoint('TRISMEGISTUS_TEST_ELEVENLABS_API')||ELEVENLABS_API);
  elevenLabsRead={at:Date.now(),account};return account;
}

export const settingsHandlers:Record<string,(args:any)=>any>={
  // What the Subscriptions page cannot build from the window's own state: the typed prices, the ElevenLabs account
  // (a read-only call with the listening key) and a month's token sums. The sums run here, over the store, because
  // a window's state lacks most job chats; they read turns only (monthUsage).
  async subscriptions({month,fresh}){
    let elevenlabs:ElevenLabsAccount|null=null,elevenlabsNote='';
    if(listeningView().connected.elevenlabs){try{elevenlabs=await elevenLabs(fresh===true);}catch(error){elevenlabsNote=backend.scrubber.text(String(error instanceof Error?error.message:error));}}
    const turns=store.all<Turn>('turn'),label=(time:number)=>{const d=new Date(time);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');};
    const months=[...new Set([label(Date.now()),...turns.map(turn=>label(turn.created))])].sort().reverse().slice(0,12);
    const picked=typeof month==='string'&&months.includes(month)?month:months[0],[year,index]=picked.split('-').map(Number);
    const apps=store.all<SavedApp>('saved-app'),usage=monthUsage({turns,chats:store.all<Chat>('chat'),apps,from:new Date(year,index-1,1).getTime(),to:new Date(year,index,1).getTime()}),chats=usage.chats.slice(0,60);
    return {prices:typedPrices(),elevenlabs,elevenlabsNote,month:picked,months,usage:{...usage,chats},apps:apps.map(app=>({id:app.id,name:app.name,chatIds:app.chatIds})),
      titles:Object.fromEntries(chats.map(row=>[row.chatId,store.find<Chat>('chat',row.chatId)?.title||'Deleted chat']))};
  },
  // A typed monthly price confirms a row; an empty one gives the row back to its list price or "amount unknown".
  subscriptionPrice({id,usd}){
    if(typeof id!=='string'||!/^[a-z0-9-]{1,40}$/.test(id))throw Error('Unknown subscription.');
    const prices=typedPrices();
    if(usd===null||usd==='')delete prices[id];
    else if(typeof usd==='number'&&Number.isFinite(usd)&&usd>=0&&usd<=100000)prices[id]=Math.round(usd*100)/100;
    else throw Error('Type the monthly price as a number.');
    store.put('settings',{id:'subscriptions',prices});return prices;
  },
  // Saved in the store, not the window's localStorage: Chromium writes that late and a quick quit loses it.
  chatLayout(args){store.put('settings',{id:'chat-layout',...readChatLayout(JSON.stringify(args||{}))});emit();},
  paneLayout({tree,workspace}){
    const jobs=new Set(dockableJobChats(store.all<Turn>('turn')).map(chat=>chat.id));
    const clean=readTree(tree,id=>{const pane=paneKind(id);return pane?.kind==='main'||pane?.kind==='workspace'||pane?.kind==='workspaceView'||pane?.kind==='chat'&&store.all<Chat>('chat').some(chat=>chat.id===pane.id&&!chat.parentChatId)&&!chatWindows.has(pane.id)||pane?.kind==='job'&&jobs.has(pane.id)&&!jobWindows.has(pane.id)||pane?.kind==='agent'&&store.all<Turn>('turn').some(turn=>turn.id===pane.id&&turn.automatic?.kind==='agent')&&!jobWindows.has('agent:'+pane.id);});
    if(!clean||!allPaneIds(clean).includes('main'))throw Error('Invalid pane layout.');
    store.put('settings',{id:'pane-layout',tree:clean,workspace:readPaneWorkspace(workspace)});emit();
  },
  // The Send now switch's start value for chats that have not set their own (Settings › General).
  sendNowDefault({enabled}){if(typeof enabled!=='boolean')throw Error('Choose on or off.');store.put('settings',{id:'send-now',enabled});emit();},
  // New Claude sessions pick it up: the session key includes it.
  claudeConnectors({enabled}){if(typeof enabled!=='boolean')throw Error('Choose on or off.');store.put('settings',{id:'claude-connectors',enabled});emit();},
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
    if(on){remoteSave({enabled:true,...(remoteSettings().topicsSince===null?{topicsSince:Date.now()}:{})});try{await remoteStart();}catch(error){remoteSave({enabled:false});emit();throw error;}}
    else{remoteSave({enabled:false});remoteStop();}
    emit();
  },
  // One thread per chat. Every chat with a message gets one; turning the switch clears a thread error.
  remoteTopics({on}){if(typeof on!=='boolean')throw Error('Invalid switch.');remoteSave({topics:on,topicError:''});emit();},
  // For a clean start, after he has cleared the bot's chat in Telegram: the threads the app knows are deleted there
  // and one per chat is made again, the oldest used first.
  remoteTopicsRebuild(){if(!remoteSettings().enabled||!remoteSettings().topics)throw Error('Turn Remote and "One topic per chat" on first.');remoteRebuildTopics();},
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
  // Dictation (R4), Claude's way: audio streams in while the owner speaks and the text comes back as they go. The
  // worker keeps the model loaded, so only a composer's first focus or press waits for it.
  // Listening engines (Koan 2026-11-15): the engine that hears dictation is the user's choice. An online engine is
  // set up by its key: the key is tried on one connection with no sound sent, then saved in Credential Manager, and
  // that engine becomes the one in use.
  async listeningKey({engine,key}){
    if(!isOnline(engine)||typeof key!=='string'||key.trim().length<8||key.trim().length>400||/\s/.test(key.trim()))throw Error('Paste the API key as its page shows it.');
    const value=key.trim();backend.scrubber.register(value);
    await checkKey(engine,value,listenEndpoint(engine));
    await backend.host('save_key',{provider:engine,key:value});listeningKeys.set(engine,value);
    store.put('settings',{...voiceRow(),[engine+'KeySaved']:true,sttEngine:engine});emit();
  },
  async listeningDisconnect({engine}){
    if(!isOnline(engine))throw Error('Choose an online listening engine.');
    await backend.host('delete_key',{provider:engine});listeningKeys.delete(engine);
    store.put('settings',{...voiceRow(),[engine+'KeySaved']:false});emit();
  },
  // The round mark: only an engine that is set up can be the one in use.
  listeningEngine({engine}){
    if(!isEngine(engine))throw Error('Choose a listening engine from the list.');
    if(!(engine==='whisper'?speechReady():listeningView().connected[engine]))throw Error('Set this engine up first.');
    store.put('settings',{...voiceRow(),sttEngine:engine});emit();
  },
  // The user's own names (apps, models) go to an online engine as key terms; each service charges for them.
  listeningHints({on}){if(typeof on!=='boolean')throw Error('Choose on or off.');store.put('settings',{...voiceRow(),sttHints:on});emit();},
  // What moves in the message box while you dictate: bars or a line.
  listeningWaves({style}){if(!isWaveStyle(style))throw Error('Choose bars or a line.');store.put('settings',{...voiceRow(),sttWaves:style});emit();},
  async dictationWarm({owner}){
    if(!Number.isInteger(owner))return;
    const engine=listeningView().engine;
    if(engine==='whisper'){if(!pluginsChanging&&!installing)await speech.start(speechKey()).catch(()=>{});}
    else if(engine)await listeningKey(engine).catch(()=>{});
  },
  async dictationStart({id,chatId,language,owner}){
    if(typeof id!=='string'||!/^[-a-f0-9]{36}$/.test(id)||typeof chatId!=='string'||!Number.isInteger(owner))throw Error('Invalid dictation request.');
    if(language!==''&&!(typeof language==='string'&&/^[a-z]{2,3}$/.test(language)))throw Error('Choose a dictation language from the list.');
    if(store.get<Chat>('chat',chatId).archived)throw Error('This chat is archived.');
    const listening=listeningView();
    if(!listening.engine)throw Error('Set up listening in Settings › Voice first.');
    // The owner's own names as hints (Koan 2026-11-14): this chat's app first, then the other apps and the model names.
    const apps=store.all<SavedApp>('saved-app'),hints=dictationHints(['Ghidorah',...apps.filter(app=>app.chatIds.includes(chatId)).map(app=>app.name),...apps.map(app=>app.name),...connectedModels().map(model=>modelLabel(model,claude.models))]);
    if(listening.engine!=='whisper'){
      // An online engine: one connection per dictation, on the user's key. Names go as key terms unless switched off.
      const key=await listeningKey(listening.engine);
      speech.release(owner);onlineDictation.open(id,owner,listening.engine,key,language,listening.hints?hints:[],listenEndpoint(listening.engine));return {device:listening.engine};
    }
    if(pluginsChanging||installing)throw Error('Wait for the current install to finish.');
    onlineDictation.release(owner);await speech.start(speechKey());speech.open(id,owner,chatId,language,hints);return {device:speech.device};
  },
  dictationAudio({id,bytes,owner}){if(!(bytes instanceof Uint8Array))throw Error('Invalid dictation audio.');(onlineDictation.has(String(id))?onlineDictation:speech).audio(String(id),owner,bytes);},
  dictationFinish({id,owner}){(onlineDictation.has(String(id))?onlineDictation:speech).finish(String(id),owner);},
  dictationCancel({id,owner}){(onlineDictation.has(String(id))?onlineDictation:speech).cancel(String(id),owner);},
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
