// snapshot: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import {providerUrls} from './dispatch';
import {sideModel} from './context';
import {ToolProgram,installedChrome,programs} from '../browser-tools';
import {readChatLayout} from '../chat-layout';
import {RESULT_CUT,apiProviders,appUpdates,awakeBlocker,backend,background,balance,balanceCheckedAt,chatWindows,claude,codex,connected,contextJobs,coordination,dev,discoveryRun,discoveryStatus,gliner,goals,health,hermesStatus,jevKey,jevStatus,jobWindows,mcp,mcpError,mcpLogins,mcpRows,modelPrices,namespace,native,pluginChanges,pluginHandlers,providerStatus,remoteGateway,remoteSecret,sidebar,speechInstall,speechProgress,store,streamWindows,telegramInstall,updateRolledBack,updateShow,wizardDecided,wizardOpen,wizardStart,workspaceWindows} from '../main';
import {NativePluginInstall,sharedCommands} from '../native-plugins';
import {readPaneWorkspace} from '../pane-layout';
import {pickers} from '../pickers';
import {reviewCommands} from '../review';
import type {Routine} from '../routines';
import type {Approval,Chat,SideAnswer,ToolCall,Turn} from '../types';
import {WhatsNew,compareVersions} from '../updates';
import whatsNew from '../whats-new.json';
import {alwaysOn} from './accounts';
import {defaultFolder,defaultModels,dockableJobChats,favouriteModels,savedAppRows} from './apps';
import {availableModels,deepseekModels} from './models';
import {classifierActive,decisionEngine,jevSettings,pickerConnected,pickerSettings,pickerStatus} from './pickers';
import {remoteChats,remoteRow,remoteSettings,remoteShown,telegramInstalled} from './remote';
import {wizardRow} from './routines';
import {screenApps,screenSettings,toolAccess,toolPaths} from './screen';
import {publishing,shareView} from './sharing';
import {discoverySettings,hermesPin,updateSettings} from './updates';
import {speechInstalled,speechReady,voiceSettings,wakeSettings} from './voice';
import {BrowserWindow,app} from 'electron';

// Shows an approval. Its action steps out of the work lock until the user answers, so other chats' work goes on
// (Koan 2026-10-15: one chat waiting for Allow stalled another chat's command for ten minutes).
export function askApproval(row:Approval){store.put('approval',row);if(row.method==='approval')coordination.ask(row.turnId,row.params.description,row.params.command);}
export function snapshot(options:{tools?:boolean}={}){const base=store.snapshot(options),summaryUsage=store.all<{chatId:string;model:string;tokens:number|null}>('context-usage');base.chats=base.chats.map(chat=>({...chat,compacting:contextJobs.has(chat.id)?{done:contextJobs.get(chat.id)!.done,total:contextJobs.get(chat.id)!.total}:undefined,summarizationUsage:summaryUsage.filter(row=>row.chatId===chat.id).map(({model,tokens})=>({model,tokens}))}));const shareChats=base.chats.filter(chat=>!chat.archived&&!chat.sideSourceId),shareTargets=[...new Set(shareChats.map(chat=>chat.projectId))].map(projectId=>({projectId,title:shareChats.filter(chat=>chat.projectId===projectId).map(chat=>chat.title).join(" · ")}));return {...base,share:shareView(),sideAnswers:store.all<SideAnswer>('side-answer').slice(-300),sideAnswerModel:sideModel(),shareTargets,workspaceWindows:[...workspaceWindows.keys()],agentWindows:[...jobWindows.keys()].filter(id=>id.startsWith('agent:')).map(id=>id.slice(6)),jobWindows:[...jobWindows.keys()].filter(id=>!id.startsWith('agent:')),jobChats:dockableJobChats(base.turns),chatWindows:[...chatWindows.keys()],providerUrls:providerUrls(),chatLayout:store.all<any>('settings').find(row=>row.id==='chat-layout')||null,paneLayout:store.all<any>('settings').find(row=>row.id==='pane-layout')?.tree||null,paneWorkspace:readPaneWorkspace(store.all<any>('settings').find(row=>row.id==='pane-layout')?.workspace),publishing:publishing(),updates:{current:app.getVersion(),dev,mode:updateSettings().mode,status:appUpdates?.status||'',available:appUpdates?.available||null,downloaded:!!appUpdates?.downloaded,checking:!!appUpdates?.checking,downloading:!!appUpdates?.downloading,percent:appUpdates?.percent??null,failed:appUpdates?.failed||'',rolledBack:updateRolledBack,show:updateShow,history:(whatsNew as WhatsNew[]).filter(entry=>compareVersions(entry.version,app.getVersion())<=0).reverse(),discovery:{...discoverySettings(),status:discoveryStatus,running:!!discoveryRun,result:store.all<any>('discovery').at(-1)?.result||null},hermes:{pinned:hermesPin().version,fork:hermesPin().fork,status:hermesStatus,releases:store.all<any>('hermes-release').sort((a,b)=>b.published.localeCompare(a.published)).map(({id,...row})=>row)}},browserTools:{...screenSettings(),apps:screenApps(),chrome:!!installedChrome(),on:toolAccess().on,programs:Object.fromEntries((Object.keys(programs) as ToolProgram[]).map(program=>[program,{version:programs[program].version,installed:!!(program==='agent-browser'?toolPaths().browser:toolPaths().computer)}]))},alwaysOn:{...alwaysOn(),awake:awakeBlocker!==null},routines:store.all<Routine>('routine'),voice:{...voiceSettings(),wake:wakeSettings(),speech:speechInstalled(),ready:speechReady(),installing:!!speechInstall,progress:speechProgress},wizard:{show:wizardOpen,pending:!wizardDecided,steps:wizardRow().steps||{},start:wizardStart},remote:{...remoteSettings(),paired:!!remoteSecret,waiting:remoteShown()?.kind||null,target:remoteChats().find(chat=>chat.id===remoteSettings().chatId)?.title||remoteChats()[0]?.title||null,alerts:store.all<any>('remote-alert').slice(-10).reverse(),tokenSaved:!!remoteRow()?.tokenSaved,installed:telegramInstalled(),installing:!!telegramInstall,status:remoteGateway?.status||'off',message:(remoteGateway?.message||'').replace(/\d{5,}:[\w-]{30,}/g,'[token]'),...(namespace.startsWith('Trismegistus/Test/')?{pid:remoteGateway?.pid}:{})},keyRotation:store.all<any>('settings').find(row=>row.id==='key-rotation')?.done||{},decisionEngine:{selected:decisionEngine(),connected:classifierActive(),status:pickerStatus(decisionEngine()),pickers:pickers.map(row=>({id:row.id,label:row.label,connected:pickerConnected(row.id),status:pickerStatus(row.id)}))},gliner:gliner?.state(),pickerSettings:Object.fromEntries(pickers.filter(row=>row.id!=='jev').map(row=>[row.id,pickerSettings(row.id)])),pluginChanges:pluginChanges.rows(),savedApps:savedAppRows(base),savedAppGroups:store.all<import('../saved-apps').SavedAppGroup>('saved-app-group'),sidebar:{groups:sidebar.groups(),preferences:sidebar.preferences()},goals:goals?.rows()||[],background:[...(background?.rows()||[]),...(native?.rows()||[])],workReview:[],jev:{connected:!!jevKey,status:jevStatus,summaryModel:jevSettings().summaryModel,confidence:jevSettings().confidence,timeoutMs:jevSettings().timeoutMs},connected,backend:backend.status,defaultMode:store.defaultMode(),providerStatus,balance,balanceCheckedAt,defaultFolder:defaultFolder(),codex,claude,apiProviders:apiProviders?.rows()||[],availability:health.rows(),availableModels:availableModels(),modelPrices,deepseekModels:deepseekModels(),defaultModels:defaultModels(),favouriteModels:favouriteModels(),mcp:mcpRows.map(row=>({...row,signingIn:mcpLogins.has(row.id)})),mcpError,commands:[{name:'/handoff',description:'Write a handover so a fresh chat can carry on this work. Add a note after the command.',plugin:'Ghidorah',kind:'Command'},{name:'/compact',description:'Summarize older messages and continue in this chat. Add a focus after the command.',plugin:'Ghidorah',kind:'Command'},...reviewCommands,...sharedCommands(store.all<NativePluginInstall>('native-plugin')),...pluginHandlers.map(({name,description,plugin,kind})=>({name,description,plugin,kind}))].sort((a,b)=>a.name.localeCompare(b.name))};}
// Window refreshes carry only the tools of the chats a window shows (RUN-PLAN 3b): every tool ever recorded was
// 276 ms to build and 65 MB per window per refresh on Koan's data. A direct 'state' request still gets everything.
export function toolsForChats(state:{turns:Turn[]},chatIds:Set<string>){
 const owners=new Set(chatIds);for(const chat of store.all<Chat>('chat'))if(chat.parentChatId&&owners.has(chat.parentChatId))owners.add(chat.id);
 const own=new Set(state.turns.filter(turn=>owners.has(turn.chatId)).map(turn=>turn.id));
 return store.whereIn<ToolCall>('tool','turnId',state.turns.filter(turn=>own.has(turn.id)||turn.parentTurnId&&own.has(turn.parentTurnId)).map(turn=>turn.id));
}
export function mainShownChats(state:{chats:Chat[];turns:Turn[]}){
 const settings=store.all<any>('settings'),layout=readChatLayout(JSON.stringify(settings.find(row=>row.id==='chat-layout')||null));if(!layout.chatId)return null;
 const panes=JSON.stringify(settings.find(row=>row.id==='pane-layout')?.tree||null),shown=new Set([layout.chatId,layout.splitId,...[...panes.matchAll(/"chat:([^"]+)"/g)].map(match=>match[1])].filter(Boolean));
 // Recent and working chats too, so a chat opened between two refreshes keeps its tool rows.
 for(const chat of [...state.chats].sort((a,b)=>(b.updated||0)-(a.updated||0)).slice(0,8))shown.add(chat.id);
 for(const turn of state.turns)if(['queued','dispatching','running','waiting','stopping'].includes(turn.status))shown.add(turn.chatId);
 return shown;
}
export function mainSnapshot(state:ReturnType<typeof snapshot>){const shown=mainShownChats(state);return shown?{...state,tools:toolsForChats(state,shown)}:snapshot();}
export function cutLong(value:any,depth=0):{value:any;cut:boolean}{
  if(typeof value==='string')return value.length>RESULT_CUT?{value:value.slice(0,RESULT_CUT)+'\n… [cut here: open the row for the whole result]',cut:true}:{value,cut:false};
  if(!value||typeof value!=='object'||depth>20)return {value,cut:false};
  let cut=false;const next:any=Array.isArray(value)?[]:{};
  for(const [key,item] of Object.entries(value)){const part=cutLong(item,depth+1);next[key]=part.value;cut||=part.cut;}
  return cut?{value:next,cut}:{value,cut:false};
}
export function windowTools(state:any){
  if(!Array.isArray(state?.tools))return state;
  let changed=false;const tools=state.tools.map((tool:ToolCall)=>{const part=cutLong(tool.result);if(!part.cut)return tool;changed=true;return {...tool,result:part.value,resultCut:true};});
  return changed?{...state,tools}:state;
}
export function sendState(window:BrowserWindow,state:any){
  streamWindows.set(window,new Set((state.turns||[]).map((turn:Turn)=>turn.id)));
  window.webContents.send('state',windowTools(state));
}