// dispatch: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import {attachmentContent,attachmentMismatch,conversationAttachments} from '../attachments';
import {blockedFor} from '../availability';
import {backgroundProcess} from '../background-work';
import {clearHistoryReads,readRuntimeHistory,shouldAutoCompact} from '../chat-context';
import {chatToolCall} from '../chat-coordination';
import {saveChatOutput} from '../chat-files';
import type {ClaudeResult,ClaudeRun} from '../claude';
import {claudeTurnUsage} from '../claude-turn';
import {documentMutations,documentToolCall} from '../documents';
import {handover,managementText} from '../history';
import {imageToolCall} from '../images';
import {apiChanging,apiProviders,backend,background,bindClaude,checkpointChanging,claude,claudeAutomatic,claudeControllers,claudeExecutable,commandTurns,connected,coordination,data,emit,folderRecoveryRequired,gitOperation,goals,handlers,health,hermesFixed,hermesModels,hermesQueued,hermesSent,hermesSessionRows,hermesStarted,hermesTurns,hermesWaiting,holds,mcp,mcpToolRequests,memoryCache,modeChanges,namespace,native,pluginGate,pluginRuntime,pluginsChanging,preparing,quitting,requests,root,routeTurn,runAgain,runningChats,runtimeChecked,store,taskScratchHint,testHang,visionModels} from '../main';
import {modelLabel,providerFor,wireModel} from '../models';
import {NativePluginInstall,checkRuntimeOnChange,hermesPluginCopies,nativePluginDirectories,pluginCommand,verifyPlugins} from '../native-plugins';
import {createParallel,parallelContext} from '../parallel';
import {memoryContext} from '../project-memory';
import type {ProjectSourceGrant,ProjectTrustReview} from '../project-trust';
import {redactPastedKeys} from '../redaction';
import {reviewFocus,reviewMessages,reviewRequest,reviewTarget} from '../review';
import {rlmContext} from '../rlm-history';
import {appChatContext} from '../saved-apps';
import {hermesScreenTarget} from '../screen-control';
import {resetJoinedText} from '../turn-joins';
import type {Approval,Chat,McpConnection,Project,ToolCall,Turn} from '../types';
import {researchTool} from '../web-research';
import {fixtureClaudeArgs,projectSettingsReview,trustRecord} from './accounts';
import {session} from './backend';
import {applyReadyDraft,compactForTurn,compactInBackground,dispatchPluginCommand,queryHistory,submitTurn} from './context';
import {availableModels,checkDispatch,inputMismatch,loadInputCapabilities,unavailableMessage} from './models';
import {addAppTask,createApp,linkCurrentApp,listAppTasks,projectFor,updateApp,updateAppTask,workingDirectory} from './projects';
import {claudeScreenEnv,screenContext,screenSettings,screenStep} from './screen';
import {previewTool_,publish,shareWithClient} from './sharing';
import {askApproval} from './snapshot';
import {hermesAccepted,releaseHermesSession,resendFixed} from './turns';
import {randomUUID} from 'node:crypto';
import {appendFileSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

// Each supplier's live address: what routing sends to, and what the expanded model bar shows.
export function providerUrls():Record<string,string>{return {deepseek:process.env.TRISMEGISTUS_TEST_PROVIDER_URL||'https://api.deepseek.com/v1','openai-codex':process.env.TRISMEGISTUS_TEST_CODEX_URL||'https://chatgpt.com/backend-api/codex',...apiProviders?.urls()};}
export function stateProviderInChat(provider:string,chat:Chat){return (chat.pool||['deepseek-flash']).some(model=>providerFor(model)===provider);}
export function engineState(chatId:string){return [preparing.has(chatId)&&'preparing='+preparing.get(chatId)!.turnId,commandTurns.has(chatId)&&'command='+commandTurns.get(chatId),hermesTurns.has(chatId)&&'hermes='+hermesTurns.get(chatId),hermesWaiting(chatId)>0&&'hermes-waiting='+hermesWaiting(chatId),...(native?.processingReasons(chatId)||[])].filter(Boolean).join(' ')||'idle';}
export function hold(chatId:string,turn:Turn|undefined,reason:string){
  if(turn&&(turn.hold||'')!==reason){try{store.update<Turn>('turn',turn.id,{hold:reason||undefined});setImmediate(emit);}catch{}}
  const previous=holds.get(chatId),line=turn&&reason?`turn=${turn.id} held: ${reason} | engine: ${engineState(chatId)}`:'';
  if(line===(previous?.line||''))return;
  if(line)holds.set(chatId,{turn:turn!.id,line});else holds.delete(chatId);
  try{appendFileSync(path.join(data,'queue.log'),`${new Date().toISOString()} chat=${chatId} ${line||`turn=${previous?.turn||'-'} released`}\n`);}catch{}
}
export function wake(chatId:string){if(quitting||!store)return;if(runningChats.has(chatId)){runAgain.add(chatId);return;}void runChat(chatId);}
export async function runChat(chatId:string){
  runningChats.add(chatId);
  try{do{runAgain.delete(chatId);while(!quitting&&await runStep(chatId));}while(runAgain.has(chatId)&&!quitting);}
  catch(error){try{appendFileSync(path.join(data,'queue.log'),`${new Date().toISOString()} chat=${chatId} runner error: ${backend.scrubber.text(String(error))}\n`);}catch{}}
  finally{runningChats.delete(chatId);}
}
export function waitingFor(chatId:string){if(!hermesSent.has(chatId))hermesSent.set(chatId,new Set());return hermesSent.get(chatId)!;}
// A turn Hermes starts by itself (a background job's completion, a goal step, a wake-up): its own automatic row.
export function automaticHermes(chat:Chat,sid:string){
  const rows=store.where<Turn>('turn','chatId',chat.id).sort((a,b)=>a.created-b.created),origin=rows.filter(t=>!t.model.startsWith('claude-code:')&&!t.command).at(-1);
  const turn:Turn={id:randomUUID(),chatId:chat.id,automatic:{originTurnId:origin?.id||'',taskId:'',runtimeId:sid,source:'self'},prompt:'',text:'',reasoning:'',model:hermesModels.get(sid)||origin?.model||chat.model,effort:origin?.effort,status:'running',activity:'Waiting for model',usage:null,error:null,created:Date.now()};
  store.put('turn',turn);hermesStarted.add(turn.id);return turn.id;
}
export function waitingRow(chatId:string){return store.where<Turn>('turn','chatId',chatId).filter(t=>['queued','needs-model'].includes(t.status)&&!t.paused).sort((a,b)=>a.created-b.created)[0];}
// Messages typed behind a message while it is prepared join it and reach the model as one message (Koan 10-01, 10-16).
// Only the next run of his plain messages with the same model choice joins, so nothing is reordered or rerouted.
export const plainMessage=(t:Turn)=>t.status==='queued'&&!t.paused&&!t.command&&!t.contextCommand&&!t.prompt.trimStart().startsWith('/')&&!t.goal&&!t.remote&&!t.routine&&!t.voice&&!t.handoff&&!t.review&&!t.automatic&&!t.parentTurnId&&!t.jobs?.length;
export const modelChoice=(t:Turn)=>JSON.stringify([t.model,t.models||null,t.requestedModels||null,!!t.routePending,t.effort,t.efforts]);
export async function joinWaiting(turn:Turn,choice:string,signal:AbortSignal){
  if(!plainMessage({...turn,status:'queued'}))return;
  let later:Turn[]=[],files=turn.attachments?.length||0;
  for(const t of store.where<Turn>('turn','chatId',turn.chatId).filter(t=>t.id!==turn.id&&t.created>=turn.created&&['queued','needs-model'].includes(t.status)).sort((a,b)=>a.created-b.created)){
    files+=t.attachments?.length||0;if(!plainMessage(t)||modelChoice(t)!==choice||files>10)break;later.push(t);
  }
  if(!later.length)return;
  // An image or PDF joins only if the picked model reads it.
  await loadInputCapabilities(later.at(-1)!,signal);
  // Stop, or his remove button on a waiting message, may have acted meanwhile.
  if(signal.aborted||store.get<Turn>('turn',turn.id).status==='stopping')return;
  later=later.filter(t=>store.find<Turn>('turn',t.id)?.status==='queued');
  const earlier=conversationAttachments(store.all<Turn>('turn'),turn),fits=()=>(turn.models||[turn.model]).every(model=>!attachmentMismatch([...earlier,...later.flatMap(t=>t.attachments||[])],visionModels[model]===true,model));
  while(later.length&&!fits())later.pop();
  if(!later.length)return;
  // A removal marker keeps a repeated send of a joined message from creating it again.
  store.transaction(()=>{store.update<Turn>('turn',turn.id,{prompt:[turn,...later].map(t=>t.prompt).filter(text=>text.trim()).join('\n\n'),attachments:[...(turn.attachments||[]),...later.flatMap(t=>t.attachments||[])]});for(const t of later){store.put('turn-removed',{id:t.id,chatId:turn.chatId,mergedInto:turn.id});store.remove('turn',t.id);}});
  Object.assign(turn,store.get<Turn>('turn',turn.id));emit();
}
// One step: the first waiting message goes out (true: look again), or names what it waits for (false).
export async function runStep(chatId:string){
  let chat:Chat;try{chat=store.get<Chat>('chat',chatId);}catch{return false;}
  const turn=waitingRow(chatId);
  if(!turn){hold(chatId,undefined,'');return false;}
  if(turn.status==='needs-model'){hold(chatId,turn,'Choose a model');return false;}
  const reason=holdReason(chat,turn);hold(chatId,turn,reason);if(reason)return false;
  await dispatch(chat,turn);return true;
}
export function holdReason(chat:Chat,turn:Turn){
  if(folderRecoveryRequired)return 'Waiting for the backend restart that restores the working folder';
  if(checkpointChanging)return 'Waiting for the file restore to finish';
  if(gitOperation)return 'Waiting for the Git action to finish';
  if(apiChanging)return 'Waiting for the connection change to finish';
  if(pluginsChanging)return 'Waiting for the plugin change to finish';
  if(modeChanges.has(chat.projectId))return 'Waiting for the permission mode change';
  const hermes=backend?.status==='ready';
  if((turn.command||turn.routePending||turn.contextCommand)&&!hermes)return 'Waiting for the backend to start';
  if(!turn.command&&!turn.routePending&&!turn.contextCommand){const ready=new Set(availableModels()),missing=(turn.models||[turn.model]).find(model=>!ready.has(model)||!hermes&&!model.startsWith('claude-code:'));if(missing)return 'Waiting for '+modelLabel(missing,claude.models)+' to connect';}
  return switchReason(chat,turn);
}
// The one wait the engines need from Tris: a switch of engine or model, released by the engine's own idle.
export function switchReason(chat:Chat,turn:Turn){
  const label=(model:string)=>modelLabel(model,claude.models),command=commandTurns.get(chat.id),hermesRow=hermesTurns.get(chat.id)||[...(hermesSent.get(chat.id)||[])][0],claudeBusy=!!native?.processing(chat.id);
  if(command)return 'Waiting for '+(store.get<Turn>('turn',command).jobs?.length?'the parallel jobs':'the command')+' to finish';
  const claudeLabel=label('claude-code:'+(native.liveModel(chat.id)||'')),hermesLabel=hermesRow?label(store.get<Turn>('turn',hermesRow).model):'';
  // A plugin command, a summary, a review or parallel jobs need the chat to themselves.
  const alone=!!(turn.command||turn.contextCommand||(turn.models?.length||0)>1||!turn.parentTurnId&&reviewRequest(turn.prompt));
  if(alone&&(hermesRow||claudeBusy))return 'Waiting for '+(hermesRow?hermesLabel:claudeLabel)+' to finish';
  // A command or summary row has no engine of its own; routing picks one in preparation.
  if(turn.command||turn.contextCommand||turn.routePending)return '';
  if(providerFor(turn.model)==='claude-code'){
    if(hermesRow)return `Waiting for ${hermesLabel} to finish before ${label(turn.model)} takes over`;
    if(claudeBusy&&'claude-code:'+native.liveModel(chat.id)!==turn.model)return `Waiting for ${claudeLabel} to finish before ${label(turn.model)} takes over`;
    return '';
  }
  if(claudeBusy)return `Waiting for ${claudeLabel} to finish before ${label(turn.model)} takes over`;
  if(hermesRow&&store.get<Turn>('turn',hermesRow).model!==turn.model)return `Waiting for ${hermesLabel} to finish before ${label(turn.model)} takes over`;
  return '';
}
// TRIS-TODO 1.11: a preparation step with no time limit of its own ends its message after this long, naming itself.
export const prepareLimit=()=>namespace.startsWith('Trismegistus/Test/')&&Number(process.env.TRISMEGISTUS_TEST_PREPARE_LIMIT)>0?Number(process.env.TRISMEGISTUS_TEST_PREPARE_LIMIT):60000;
// Prepares one message and hands it to its engine. Returns once the engine has it (or it failed); the reply is the
// engine's business. A preparation step past its limit ends the message and frees the chat (TRIS-TODO 1.11).
export async function dispatch(chat:Chat,turn:Turn){
  const chatId=chat.id,p=projectFor(chat),controller=new AbortController(),signal=controller.signal;preparing.set(chatId,{turnId:turn.id,controller});
  let phase='Preparing reply',stepStarted=Date.now(),logged=false,stuck='',release=()=>{};const steps:string[]=[],dispatchStarted=stepStarted,released=new Promise<void>(resolve=>{release=resolve;});
  const step=(name:string)=>{signal.throwIfAborted();const now=Date.now();steps.push(phase+' '+(now-stepStarted)+'ms');phase=name;stepStarted=now;};
  const preparingStep=(value:string,name=value)=>{step(name);store.update<Turn>('turn',turn.id,{preparation:value});emit();};
  const done=()=>{if(preparing.get(chatId)?.controller===controller)preparing.delete(chatId);};
  let watch:ReturnType<typeof setInterval>|undefined;
  const finish=(result:string)=>{clearInterval(watch);if(logged)return;logged=true;steps.push(phase+' '+(Date.now()-stepStarted)+'ms');try{appendFileSync(path.join(data,'prepare.log'),`${new Date().toISOString()} chat=${chatId} turn=${turn.id} model=${turn.model} ${result} total=${Date.now()-dispatchStarted}ms steps=${steps.join(', ')}\n`);}catch{}};
  const limit=prepareLimit();
  watch=setInterval(()=>{
    if(stuck||signal.aborted||phase==='Summarising earlier messages')return;
    // His own approval (a project settings review) is not Tris being stuck.
    if(store.get<Turn>('turn',turn.id).status==='waiting'){stepStarted=Date.now();return;}
    if(Date.now()-stepStarted<limit)return;
    stuck=phase;finish('stuck: '+phase);
    store.update<Turn>('turn',turn.id,{status:'interrupted',error:'Tris got stuck on "'+phase+'" for '+Math.round(limit/1000)+' s, so nothing was sent to the model. Send your message again.'});
    controller.abort();claudeControllers.get(turn.id)?.abort();if(hermesTurns.get(chatId)===turn.id)hermesTurns.delete(chatId);done();emit();release();
  },500);
  store.update<Turn>('turn',turn.id,{status:'dispatching',hold:undefined});emit();
  const work=(async()=>{
    try{
      if(turn.command){finish('plugin command');commandTurns.set(chatId,turn.id);done();void dispatchPluginCommand(chat,turn,p);return;}
      if(turn.contextCommand){finish('summary command');commandTurns.set(chatId,turn.id);done();
        void (async()=>{try{const text=await compactForTurn(turn,false);store.update<Turn>('turn',turn.id,{status:'completed',text,error:null});}catch(error){const status=store.get<Turn>('turn',turn.id).status;store.update<Turn>('turn',turn.id,{status:status==='stopping'?'stopped':'interrupted',error:status==='stopping'?null:backend.scrubber.text(String(error))});}finally{if(commandTurns.get(chatId)===turn.id)commandTurns.delete(chatId);emit();wake(chatId);}})();return;
      }
      // Engines shrink their own live sessions (Claude Code / Hermes). Tris summarises only for a session that must start fresh.
      // A message sent into a live, busy session is never a fresh one (its saved position is uncertain while it answers).
      const engine=providerFor(turn.model)==='claude-code'?'claude' as const:'hermes' as const,live=engine==='claude'?!!native.processing(chatId):hermesTurns.has(chatId)||hermesWaiting(chatId)>0,fresh=!live&&!handover(store.all<Turn>('turn'),store.all<ToolCall>('tool'),turn,store.enginePosition(chatId,engine),chat.context,chat.contextInstructions,'',false).sessionId;
      // A fresh session never waits for a summary (batch 5, 7b; 10-13..20: 21 sends waited up to 285 s): one built in
      // the background earlier is applied now, else the message goes at once with recent history and read_chat_history
      // while one builds for next time.
      if(fresh&&!chat.parentChatId){if(await applyReadyDraft(chatId))Object.assign(chat,store.get<Chat>('chat',chatId));else if(shouldAutoCompact(store,turn,fresh))compactInBackground(turn);}

      signal.throwIfAborted();
      preparingStep('Checking attachments');await loadInputCapabilities(turn,signal);
      if(store.get<Turn>('turn',turn.id).status==='stopping'){store.update<Turn>('turn',turn.id,{status:'stopped'});return;}
      preparingStep('Selecting model');const choice=modelChoice(turn);if(turn.routePending&&!(await routeTurn(chat,turn)))return;
      await joinWaiting(turn,choice,signal);
      // The pick may be another engine or model than the one answering: that switch waits for its idle.
      {const reason=switchReason(chat,turn);if(reason){store.update<Turn>('turn',turn.id,{status:'queued',preparation:undefined});hold(chatId,turn,reason);return;}}
      if((turn.models||[turn.model]).some(model=>!checkDispatch(chat,{...turn,model})))return;
      const review=turn.parentTurnId?null:reviewRequest(turn.prompt);
      let expanded=turn.parentTurnId?turn.prompt:await pluginCommand(turn.prompt,store.all<NativePluginInstall>('native-plugin'),path.join(data,'native-plugins'));
      if(review){
        const target=await reviewTarget(p.folder?workingDirectory(p):null,data,review.base,review.repository),brief=await backend.host('review_context',{messages:reviewMessages(store.all<Turn>('turn'),turn),focus:reviewFocus(target,review.focus)},signal);
        turn.review=target;store.update<Turn>('turn',turn.id,{review:target});expanded=brief.context;
      }
      if(expanded!==turn.prompt){turn.commandContext=backend.scrubber.text(expanded);store.update<Turn>('turn',turn.id,{commandContext:turn.commandContext});}
      if(store.get<Turn>('turn',turn.id).status==='stopping'){store.update<Turn>('turn',turn.id,{status:'stopped'});return;}
      if(!turn.parentTurnId&&(turn.review||turn.models&&turn.models.length>1)){
        finish('parallel jobs');commandTurns.set(chatId,turn.id);const jobs=createParallel(store,turn,turn.models||[turn.model]);
        // The main window docks these jobs as side-by-side panes; a pane can still pop out into its own window.
        for(const job of jobs)wake(job.chatId);
        return;
      }
      if(providerFor(turn.model)==='claude-code'){await sendClaude(chat,turn,p,step,signal);return;}
      preparingStep('Checking plugins','Checking plugins: plugin files');await testHang(phase);const plugins=store.all<NativePluginInstall>('native-plugin').filter(row=>row.hermes);
      // Each check runs when its folders or inputs changed, and after every Hermes start (the generation is an input).
      const reviewed=backend.generation+JSON.stringify(plugins.map(row=>[row.id,row.hash,row.directory,row.enabled])),copies=path.join(data,'hermes','profiles',p.profile,'plugins');
      if(!pluginGate.quiet('files',[path.join(data,'native-plugins')],reviewed)){await verifyPlugins(plugins,path.join(data,'native-plugins'));pluginGate.pass('files',reviewed);}
      step('Checking plugins: plugin runtime');const runtime=pluginRuntime();
      // In full when the reviewed runtime or its files changed (about 3 s on his 300 MB); a changed folder gets a listing first.
      if(runtime&&!pluginGate.quiet('runtime',[runtime.directory],backend.generation+runtime.hash)){await checkRuntimeOnChange(runtimeChecked,runtime,()=>backend.host('plugin_runtime_check',{runtime},signal));pluginGate.pass('runtime',backend.generation+runtime.hash);}
      step('Checking plugins: plugin copies');
      if(!pluginGate.quiet('copies:'+p.profile,[copies],reviewed)){await hermesPluginCopies(plugins,path.join(data,'hermes','profiles',p.profile));pluginGate.pass('copies:'+p.profile,reviewed);}
      // A live session already has every message it was sent: the handover starts after the last of them.
      const busy=hermesTurns.has(chatId)||hermesWaiting(chatId)>0,sessionRows=chat.runtimeId?hermesSessionRows.get(chat.runtimeId):undefined;
      const rows=store.all<Turn>('turn').filter(t=>t.chatId===chatId),through=busy&&sessionRows?rows.slice(0,rows.findIndex(t=>t.id===turn.id)).reverse().find(t=>sessionRows.has(t.id))?.id:undefined;
      step('Checking plugins: history');const stored=store.beginEngine(chatId,'hermes'),position=through?{...stored,sessionId:chat.storedId||chat.runtimeId,throughTurnId:through,uncertain:false}:stored;
      const transfer=handover(store.all<Turn>('turn'),store.all<ToolCall>('tool'),turn,position,chat.context,chat.contextInstructions,appChatContext(store,chat)+'\n'+rlmContext(store,chat)+screenContext());
      if(!transfer.sessionId){releaseHermesSession(chat);store.update<Chat>('chat',chatId,{runtimeId:null,storedId:null});chat.runtimeId=null;chat.storedId=null;}
      preparingStep('Opening model session');const sid=await session(chat,turn.model,signal);
      if(store.get<Turn>('turn',turn.id).status==='stopping'){store.update<Turn>('turn',turn.id,{status:'stopped'});return;}
      // While Hermes answers, the session keeps the settings the running reply was sent with (same model: switchReason).
      preparingStep('Configuring model');if(!busy){if(hermesModels.get(sid)!==turn.model){
        const configured:any=await backend.rpc.request('config.set',{profile:p.profile,session_id:sid,key:'model',value:`${wireModel(turn.model)} --provider ${providerFor(turn.model)} --session`},30000,signal);
        if(configured.deferred || configured.confirm_required)throw Error('Model selection is not ready for this turn.');
        hermesModels.set(sid,turn.model);
      }
      await backend.rpc.request('config.set',{profile:p.profile,session_id:sid,key:'reasoning',value:turn.effort||chat.effort},30000,signal);
      const ordered=turn.fallbacks||[],nativeIndex=ordered.findIndex(model=>providerFor(model)==='claude-code');
      // Native Claude requires a new turn; never skip its place in Jev's order.
      const fallbacks=ordered.slice(0,nativeIndex<0?ordered.length:nativeIndex).filter(model=>availableModels().includes(model)&&(chat.pool||[]).includes(model)&&!inputMismatch({...turn,model})).map(model=>({model:wireModel(model),provider:providerFor(model),base_url:apiProviders.urls()[providerFor(model)]||(providerFor(model)==='deepseek'?process.env.TRISMEGISTUS_TEST_PROVIDER_URL||'https://api.deepseek.com/v1':process.env.TRISMEGISTUS_TEST_CODEX_URL||'https://chatgpt.com/backend-api/codex')}));
      await backend.rpc.request('config.set',{profile:p.profile,session_id:sid,key:'fallback_providers',value:fallbacks},30000,signal);}
      const attachmentParts=await attachmentContent(path.join(data,'attachments'),chat.parentChatId||chatId,transfer.attachments);
      preparingStep('Loading project memory');const memory=memoryContext(await memoryCache.get(p.profile,signal));
      if(store.get<Turn>('turn',turn.id).status==='stopping'){store.update<Turn>('turn',turn.id,{status:'stopped'});return;}
      if(!checkDispatch(chat,turn))return;
      store.update<Turn>('turn',turn.id,{status:'running',activity:'Waiting for model'});
      // Resumed sessions keep their cached system prompt; current task guidance
      // also travels in the new message without rewriting earlier context.
      // Fixed text (scratch hint, memory, jobs, goals, rules) goes once per session and again only when it changed (Koan, 2026-10-08).
      const appText=appChatContext(store,chat)+'\n'+rlmContext(store,chat)+screenContext(),fixedText=taskScratchHint+'\n\n'+backend.scrubber.text(memory)+'\n\n'+background.context(chat)+native.context(chat)+parallelContext(store,turn)+goals.context(turn);
      const resend=resendFixed(!transfer.sessionId,busy,hermesFixed.get(sid),fixedText+appText);
      const prompt=resend?fixedText+transfer.prompt:handover(store.all<Turn>('turn'),store.all<ToolCall>('tool'),turn,position,chat.context,chat.contextInstructions,appText,false).prompt;
      // From here the row is Hermes's. Idle: it starts now and its events name it. Busy: Hermes has it, not started.
      finish('sent');if(busy)waitingFor(chatId).add(turn.id);else hermesTurns.set(chatId,turn.id);done();
      let answer:any;
      try{answer=await backend.rpc.request('prompt.submit',{profile:p.profile,session_id:sid,client_id:turn.id,text:attachmentParts.length?[{type:'text',text:prompt},...attachmentParts]:prompt});}
      catch(error){if(!await hermesAccepted(p.profile,sid))throw error;}
      if(!hermesSessionRows.has(sid))hermesSessionRows.set(sid,new Set());hermesSessionRows.get(sid)!.add(turn.id);
      if(resend)hermesFixed.set(sid,fixedText+appText);
      // Hermes's own answer: started now, read by the running reply after its current step (steer), or next in its queue.
      const label=modelLabel(turn.model,claude.models);
      if(answer?.status==='streaming'){hermesSent.get(chatId)?.delete(turn.id);if(!hermesTurns.has(chatId))hermesTurns.set(chatId,turn.id);}
      else if(['steered','redirected','queued'].includes(answer?.status)){
        if(hermesTurns.get(chatId)===turn.id&&!hermesStarted.has(turn.id)){hermesTurns.delete(chatId);waitingFor(chatId).add(turn.id);}
        if(answer.status==='queued')hermesQueued.add(turn.id);
        store.update<Turn>('turn',turn.id,{delivery:'sent',activity:answer.status==='queued'?'Sent, '+label+' answers it next':'Sent, '+label+' reads it after the current step'});
      }
    }catch(e){if(!stuck){const status=store.get<Turn>('turn',turn.id).status;if(hermesTurns.get(chatId)===turn.id)hermesTurns.delete(chatId);hermesSent.get(chatId)?.delete(turn.id);if(providerFor(turn.model)!=='claude-code'&&!hermesTurns.has(chatId)&&!hermesWaiting(chatId)){releaseHermesSession(chat);store.update<Chat>('chat',chatId,{runtimeId:null});}if(status!=='needs-model')store.update<Turn>('turn',turn.id,{status:status==='stopping'?'stopped':'interrupted',error:status==='stopping'?null:phase+': '+backend.scrubber.text(String(e))});}}
    finally{if(!stuck){finish(store.get<Turn>('turn',turn.id).status);done();emit();}}
  })();
  await Promise.race([work,released]);
}
// Opus: the message goes into the chat's live Claude process at once, busy or not (TURN-REVIEW part 1). The reply
// arrives on its own; finishNative records it.
export async function sendClaude(chat:Chat,turn:Turn,project:Project,step:(name:string)=>void,preparation:AbortSignal){
  // Stop or the step limit during preparation also ends Claude's own waits (a settings review, the memory read).
  const controller=new AbortController();claudeControllers.set(turn.id,controller);const link=()=>controller.abort();preparation.addEventListener('abort',link,{once:true});
  const started=Date.now();
  try{
    const turns=store.all<Turn>('turn'),rows=turns.filter(t=>t.chatId===chat.id),before=rows.slice(0,rows.findIndex(t=>t.id===turn.id)).map(t=>t.id);
    // A live process already has every message it was sent: the handover starts after the last of them.
    const stored=store.beginEngine(chat.id,'claude'),position=native.livePosition(chat.id,before)||stored;
    const transfer=handover(turns,store.all<ToolCall>('tool'),turn,position,chat.context,chat.contextInstructions,'',false);
    const options=await prepareClaude(chat,turn,project,controller,transfer,undefined,step);
    step('Opening Claude');
    const busy=native.busyRuntime(chat.id),into={...options,sessionId:busy?.sessionId};
    const picked=busy&&busy.compatible(into)?{session:busy,options:into}:await native.acquire(chat,options,()=>{
      const fresh=handover(store.all<Turn>('turn'),store.all<ToolCall>('tool'),turn,undefined,chat.context,chat.contextInstructions,'',false);
      return {...options,sessionId:undefined,prompt:backend.scrubber.text(parallelContext(store,turn)+(turn.parentTurnId?'Current user message:\n':'')+fresh.prompt)};
    });
    step('Sending');preparation.removeEventListener('abort',link);
    const answer=native.submit(picked);
    store.update<Turn>('turn',turn.id,{status:'running',delivery:'sent',activity:'Sent, '+modelLabel(turn.model,claude.models)+' reads it after the current step'});
    void answer.then(result=>finishNative(chat,turn,result,picked.session.id,started),error=>{const saved=store.get<Turn>('turn',turn.id);store.update<Turn>('turn',turn.id,{status:controller.signal.aborted||saved.status==='stopping'?'stopped':'interrupted',...(controller.signal.aborted||saved.status==='stopping'?{stopReason:saved.stopReason||'unknown'}:{}),error:controller.signal.aborted||saved.status==='stopping'?null:backend.scrubber.text(String(error))});}).finally(()=>cleanupNative(chat,turn));
  }catch(error){cleanupNative(chat,turn);throw error;}
}
export function finishNative(chat:Chat,turn:Turn,result:ClaudeResult,runtimeId:string,started:number){
  // His remove button took the row away before Claude answered.
  if(!store.find<Turn>('turn',turn.id))return;
  const current=store.get<Turn>('turn',turn.id),context=current.usage?.context_used!=null?{context_used:current.usage.context_used,context_max:current.usage.context_max}:{};
  // Claude's result may replace streamed commentary with only its final message.
  const patch:Partial<Turn>=result.answeredIn?{status:result.status,answeredIn:result.answeredIn,delivery:undefined,error:null}:{status:result.status,delivery:undefined,text:typeof result.result?.result==='string'?result.result.result:current.text,usage:{...claudeTurnUsage(result.result),...context},error:result.status==='failed'?(result.result?.errors?.join('\n')||result.result?.result||'Claude could not finish the turn.'):null};
  if(patch.text!==undefined&&patch.text!==current.text)resetJoinedText(store,turn.id);
  // A message from another Claude session that the prompt check refused shows as stopped, not failed (TURN-BUILD decision 2).
  if(current.automatic?.source==='other-session'&&patch.status==='failed')Object.assign(patch,{status:'stopped',error:current.error});
  // Every stopped turn says why; Stop has already written its reason (batch 4, 6a).
  if(patch.status==='stopped'&&!current.stopReason)patch.stopReason='unknown';
  native.finished(runtimeId,turn,result);
  if(!turn.automatic)store.finishEngine(turn.id,'claude',result.sessionId||null,patch);else store.update<Turn>('turn',turn.id,patch);
  if(result.status==='failed')claude.status='Last turn failed';else if(result.status==='completed'){claude.status='Signed in';health.clear('claude-code',['auth','model'],started,turn.model);}
}
export function cleanupNative(chat:Chat,turn:Turn){
  clearHistoryReads(store,turn.id);
  for(const approval of store.all<Approval>('approval'))if(approval.turnId===turn.id&&approval.status==='pending'){requests.get(approval.id)?.respond({choice:'deny'});requests.delete(approval.id);store.update<Approval>('approval',approval.id,{status:'expired'});}
  for(const tool of store.where<ToolCall>('tool','turnId',turn.id))if(tool.status==='running')store.update<ToolCall>('tool',tool.id,{status:'uncertain'});
  coordination.interrupt(turn.id);if(turn.automatic){claudeAutomatic.get(turn.id)?.controller.abort();claudeAutomatic.delete(turn.id);}else claudeControllers.delete(turn.id);
  emit();wake(chat.id);
}
// A turn Claude starts by itself (a job notice, a wake-up, a timer): an automatic row with its own Stop, made at once
// from the context the chat's live process already has (TURN-REVIEW part 1). Claude is waiting, so nothing here waits.
export function automaticClaude(chatId:string,runtimeId:string,last:ClaudeRun|undefined,model:string){
  if(quitting||!last)return undefined;
  let chat:Chat;try{chat=store.get<Chat>('chat',chatId);}catch{return undefined;}
  const origin=last.turnId?store.find<Turn>('turn',last.turnId):undefined,controller=new AbortController(),started=Date.now();
  const turn:Turn={id:randomUUID(),chatId,parentTurnId:origin?.parentTurnId,remote:origin?.remote,routine:origin?.routine,voice:origin?.voice,automatic:{originTurnId:origin?.automatic?.originTurnId||origin?.id||'',taskId:'',runtimeId},prompt:'',text:'',reasoning:'',model:'claude-code:'+model,effort:last.effort,status:'running',usage:null,error:null,created:started};
  store.transaction(()=>{store.put('turn',turn);if(turn.parentTurnId){const parent=store.get<Turn>('turn',turn.parentTurnId);store.update<Turn>('turn',parent.id,{jobs:[...parent.jobs!,turn.id],status:'running'});}});
  if(turn.parentTurnId&&chat.parentChatId&&!commandTurns.has(chat.parentChatId))commandTurns.set(chat.parentChatId,turn.parentTurnId);
  claudeAutomatic.set(turn.id,{chatId,controller});emit();
  const options=bindClaude(chat,turn,projectFor(chat),controller,{...last,prompt:'',attachments:[],projectMemory:undefined,turnId:turn.id});
  return {options,complete:(value:ClaudeResult|Error)=>{if(value instanceof Error)store.update<Turn>('turn',turn.id,{status:controller.signal.aborted?'stopped':'interrupted',error:backend.scrubber.text(value.message)});else finishNative(chat,turn,value,runtimeId,started);cleanupNative(chat,turn);}};
}
// An agent Claude starts with its Agent tool runs in its own pane, never holding the chat.
export async function continueNative(chat:Chat,origin:Turn,task:{id:string;model:string;runtimeId:string;description?:string;agentType?:string},projectSourceGrant?:ProjectSourceGrant){
  if(quitting)throw Error('The app is closing.');
  const model='claude-code:'+task.model;if(providerFor(model)!=='claude-code'||!claude.connected||!claudeExecutable||blockedFor(health.rows(),model))throw Error(unavailableMessage(model));
  const controller=new AbortController(),started=Date.now(),turn:Turn={id:randomUUID(),chatId:chat.id,parentTurnId:origin.parentTurnId,remote:origin.remote,routine:origin.routine,voice:origin.voice,automatic:{originTurnId:origin.id,taskId:task.id,runtimeId:task.runtimeId,kind:'agent' as const,description:task.description,agentType:task.agentType},prompt:'',text:'',reasoning:'',model,status:'running',usage:null,error:null,created:started};
  store.transaction(()=>{store.put('turn',turn);if(turn.parentTurnId){const parent=store.get<Turn>('turn',turn.parentTurnId);store.update<Turn>('turn',parent.id,{jobs:[...parent.jobs!,turn.id],status:'running'});}});
  claudeAutomatic.set(turn.id,{chatId:chat.id,controller});
  if(turn.parentTurnId&&chat.parentChatId&&!commandTurns.has(chat.parentChatId))commandTurns.set(chat.parentChatId,turn.parentTurnId);
  emit();
  const complete=(value:ClaudeResult|Error)=>{if(value instanceof Error)store.update<Turn>('turn',turn.id,{status:controller.signal.aborted?'stopped':'interrupted',error:backend.scrubber.text(value.message)});else finishNative(chat,turn,value,task.runtimeId,started);cleanupNative(chat,turn);};
  try{
    const transfer=handover(store.all<Turn>('turn'),store.all<ToolCall>('tool'),turn,native.position(task.runtimeId),chat.context,chat.contextInstructions,appChatContext(store,chat)+'\n'+rlmContext(store,chat)+screenContext());
    // Worker configuration retains the parent effort. A native agent resolves
    // its own effort; its saved record stays unknown until native reports it.
    const options=await prepareClaude(chat,{...turn,effort:origin.effort},projectFor(chat),controller,transfer,projectSourceGrant);return {options,complete};
  }catch(error){complete(error instanceof Error?error:Error(String(error)));throw error;}
}
export async function coordinateChat(turn:Turn,name:string,args:any,signal:AbortSignal){
 const chat=store.get<Chat>('chat',turn.chatId);
 const approve=(description:string)=>new Promise<boolean>(resolve=>{
  if(signal.aborted){resolve(false);return;}
  const id='chat-access:'+turn.id+':'+randomUUID(),finish=(allowed:boolean)=>{signal.removeEventListener('abort',abort);requests.delete(id);resolve(allowed);};
  const abort=()=>{store.update<Approval>('approval',id,{status:'expired'});finish(false);emit();};
  signal.addEventListener('abort',abort,{once:true});requests.set(id,{respond:(answer:any)=>finish(answer.choice==='once')});
  askApproval({id,chatId:chat.id,turnId:turn.id,method:'approval',params:{description:backend.scrubber.text(description)},status:'pending'});store.update<Turn>('turn',turn.id,{status:'waiting'});emit();
 });
 if(backend.scrubber.text(JSON.stringify(args))!==JSON.stringify(args)||redactPastedKeys(JSON.stringify(args))!==JSON.stringify(args))throw Error('Remove credentials before sharing chat content.');
 return backend.scrubber.value(await chatToolCall(store,turn,name,args,{approve,mode:()=>projectFor(chat).mode,submit:async(id,chatId,text,handoff)=>{await submitTurn({id,chatId,text},{handoff},signal);emit();}},signal));
}
export function requestProjectReview(chat:Chat,turn:Turn,controller:AbortController,review:ProjectTrustReview,description:string,sourceDiscovery=false){return new Promise<boolean>(resolve=>{
    if(controller.signal.aborted){resolve(false);return;}
    const id='claude:'+turn.id+':project-trust:'+randomUUID();
    const finish=(approved:boolean)=>{controller.signal.removeEventListener('abort',abort);requests.delete(id);resolve(approved);};
    const abort=()=>{store.update<Approval>('approval',id,{status:'expired'});finish(false);emit();};
    controller.signal.addEventListener('abort',abort,{once:true});requests.set(id,{respond:(answer:any)=>finish(answer.choice==='once')});
    askApproval({id,chatId:chat.id,turnId:turn.id,method:'project-trust',params:backend.scrubber.value({sourceDiscovery,description:description+'\n'+JSON.stringify({commands:review.commands,settings:review.settings,agents:review.agents,skills:review.skills,warnings:review.warnings,scripts:review.files.map(file=>file.path)},null,2)}),status:'pending'});
    store.update<Turn>('turn',turn.id,{status:'waiting'});emit();
  });}
// The context one message's Claude run needs; the waits (settings review, plugin folders, memory) are here, the
// callbacks are in bindClaude, which a turn Claude starts itself reuses without waiting.
export async function prepareClaude(chat:Chat,turn:Turn,project:Project,controller:AbortController,transfer:ReturnType<typeof handover>,inheritedTrust?:ProjectSourceGrant,step:(name:string)=>void=()=>{}):Promise<ClaudeRun>{
  if(!claudeExecutable)throw Error('Check the Claude Code connection in Settings.');
  let trustedProject=false,projectSettingsHash:string|undefined,projectAgents:Record<string,any>|undefined,projectSourceGrant:ProjectSourceGrant|undefined;
  const exchangeRoot=path.join(data,'claude-exchange');await fs.mkdir(exchangeRoot,{recursive:true});
  step('Checking project settings');
    if(project.folder){
      const review=await projectSettingsReview(workingDirectory(project),inheritedTrust?.skillFolders),saved=trustRecord(review.folder);
      if(saved?.hash&&!review.error){
        trustedProject=inheritedTrust?.sourceHash===review.sourceHash||saved.hash===review.hash&&!review.reviewEveryRun;
        if(!trustedProject){
          if(turn.automatic)throw Error('Project settings changed. Review them in a new message before continuing the native task.');
          trustedProject=await requestProjectReview(chat,turn,controller,review,saved.hash!==review.hash?'Project settings or hook scripts changed.':'Review the project commands and plugins for this run.');
          if(trustedProject){const current=await projectSettingsReview(workingDirectory(project),review.skillFolders);if(current.error||current.sourceHash!==review.sourceHash)throw Error('Project settings changed during review. Send again to review the current settings.');store.put('trust',{id:saved.id,folder:review.folder,hash:review.hash,skillFolders:review.skillFolders});}
        }
      }else if(saved?.hash&&review.error)throw Error(review.error);
      if(trustedProject){const current=await projectSettingsReview(workingDirectory(project),review.skillFolders);if(current.error||current.sourceHash!==review.sourceHash||inheritedTrust&&inheritedTrust.sourceHash!==current.sourceHash)throw Error('Project settings or agent definitions changed. Review them in a new message.');projectSettingsHash=current.sourceHash;projectAgents=current.definitions;projectSourceGrant=inheritedTrust||{sourceHash:current.sourceHash!,skillFolders:current.skillFolders||[]};}
    }
    if(store.get<Turn>('turn',turn.id).status==='stopping')controller.abort();
    emit();
    step('Checking plugin folders');
    const pluginDirectories=await nativePluginDirectories(store.all<NativePluginInstall>('native-plugin'),path.join(data,'native-plugins'));
    step('Loading project memory');
    const snapshot=memoryContext(await memoryCache.get(project.profile,controller.signal));
    step('Reading attachments');
    const base={chrome:screenSettings().screen&&screenSettings().ownChrome,env:claudeScreenEnv(),executable:claudeExecutable,prefixArgs:fixtureClaudeArgs(),python:backend.python,worker:path.join(root,'backend','claude_worker.py'),directory:workingDirectory(project),planDirectory:project.folder?path.join(await fs.realpath(workingDirectory(project)),'.trismegistus','plans',chat.id):undefined,dataRoot:data,exchangeRoot,model:turn.model.slice(12),effort:turn.effort||'high',mode:project.mode,sessionId:transfer.sessionId||undefined,prompt:backend.scrubber.text(parallelContext(store,turn)+(turn.parentTurnId?'Current user message:\n':'')+transfer.prompt),projectMemory:managementText(appChatContext(store,chat)+'\n'+rlmContext(store,chat)+screenContext())+'\n\n'+backend.scrubber.text(snapshot)+'\n\n'+background.context(chat)+native.context(chat)+goals.context(turn),attachments:await attachmentContent(path.join(data,'attachments'),chat.parentChatId||chat.id,transfer.attachments,true),hasFolder:!!project.folder,trustedProject,projectSettingsHash,projectSourceGrant,projectAgents,scrubber:backend.scrubber,pluginDirectories} as ClaudeRun;
    return bindClaude(chat,turn,project,controller,base);
}
export function request(request:any){
  // Completion belongs to its original lease, even after Stop, a new turn or
  // a new model session. Never use the currently active turn as its owner.
  if(request.method==='trismegistus.work'&&request.params.operation==='finish'){
    void (async()=>{
      const action=coordination.completionOwner(request.params.lease,backend.generation,request.params.session_id);
      const chat=store.get<Chat>('chat',action.owner!.chatId);
      await background.finishTool({...chat,runtimeId:action.owner!.sessionId},action.job,action.id,backend.scrubber.value(request.params.result),request.params.uncertain===true,request.params.refused===true);
      return {enabled:true};
    })().then(value=>request.respond(value),error=>request.respond({error:backend.scrubber.text(String(error))}));return true;
  }
  const chat=store.all<Chat>('chat').find(c=>c.runtimeId===request.params.session_id);
  if(!chat)return false;
  // Session replay can include a live request still owned by this handler.
  if(['trismegistus.work','trismegistus.mcp'].includes(request.method)&&mcpToolRequests.get(backend.generation+':'+request.id)?.chatId===chat.id)return true;
  const turnId=hermesTurns.get(chat.id);if(!turnId)return false;
  if(request.method==='trismegistus.work'){
    const turn=store.get<Turn>('turn',turnId);
    if(!['running','waiting'].includes(turn.status)||turn.model.startsWith('claude-code:')){request.respond({error:'This job is no longer accepting tool actions.'});return true;}
    const id=backend.generation+':'+request.id,controller=new AbortController();mcpToolRequests.set(id,{chatId:chat.id,controller});
    void (async()=>{
      if(request.replayed||!store.event('work:'+id,()=>{}))throw Error('This action request was already dispatched. Inspect its outcome.');
      if(request.params.operation==='inspect')return {enabled:true,value:await coordination.inspectAction(turn.id,workingDirectory(projectFor(chat)),backend.scrubber.value(request.params.arguments))};
      if(request.params.operation==='board'){if(!turn.parentTurnId)throw Error('This tool requires an active parallel job.');return {enabled:true,value:await coordination.board(turn.parentTurnId,turn.id,workingDirectory(projectFor(chat)),backend.scrubber.value(request.params.arguments))};}
      if(request.params.operation==='begin'){
        const {name,arguments:args}=request.params;
        if(typeof name!=='string'||!args||typeof args!=='object'||Array.isArray(args))throw Error('Invalid action request.');
        if(name==='computer_use'&&screenSettings().screen)await screenStep(turn,name,args,hermesScreenTarget(args),controller.signal);
        await background.recoverReceipts();
        const lease=await coordination.begin(turn.parentTurnId||turn.id,turn.id,workingDirectory(projectFor(chat)),name,backend.scrubber.value(args),controller.signal,request.params.patch_paths??undefined);
        if(lease)store.update<import('../work-coordination').WorkAction>('work-action',lease,{toolId:typeof request.params.request_id==='string'?turn.id+':'+request.params.request_id:undefined,owner:{generation:backend.generation,sessionId:request.params.session_id,chatId:chat.id,profile:projectFor(chat).profile}});
        return {enabled:true,lease};
      }
      throw Error('Unknown action request.');
    })().then(value=>request.respond(value),error=>request.respond({error:backend.scrubber.text(String(error))})).finally(()=>mcpToolRequests.delete(id));return true;
  }
  if(request.method==='trismegistus.mcp'){
    const id=backend.generation+':'+request.id;
    if(request.replayed||!store.event('mcp:'+id,()=>{})){request.respond({error:'This connection request was already dispatched. Check its outcome before retrying.'});return true;}
    if(store.get<Turn>('turn',turnId).model.startsWith('claude-code:')||!['running','waiting'].includes(store.get<Turn>('turn',turnId).status)){request.respond({error:'This chat is no longer running.'});return true;}
    const controller=new AbortController();mcpToolRequests.set(id,{chatId:chat.id,controller});
    const {operation,connection,tool,arguments:args}=request.params;
    void (async()=>{
      if(operation==='goal')return goals.tool(turnId,backend.scrubber.value(args));
      if(operation==='app')return createApp(chat,backend.scrubber.value(args),turnId);
      if(operation==='app-update')return updateApp(chat,backend.scrubber.value(args),turnId);
      if(operation==='app-list')return listAppTasks(chat);
      if(operation==='chat-coordinate')return coordinateChat(store.get<Turn>('turn',turnId),tool,args,controller.signal);
      if(operation==='chat-history')return backend.scrubber.value(readRuntimeHistory(store,store.get<Turn>('turn',turnId),args));
      if(operation==='background-process')return backgroundProcess(store,chat,args,()=>background.refresh(),id=>handlers.backgroundStop({id}),()=>coordination.denied(turnId,'background_process\n'+JSON.stringify(args)));
      if(operation==='history-query')return queryHistory(store.get<Turn>('turn',turnId),args,controller.signal);
      if(operation==='output'){const value=await saveChatOutput(store,data,store.get<Turn>('turn',turnId),workingDirectory(projectFor(chat)),args,text=>{if(backend.scrubber.text(text)!==text||redactPastedKeys(text)!==text)throw Error('Remove credentials before saving this output.');},controller.signal,backend);emit();return value;}
      if(operation==='image'){if(tool==='generate_image'&&projectFor(chat).mode==='plan')throw Error('Plan mode permits inspection and proposals only.');return imageToolCall(store,backend,store.get<Turn>('turn',turnId),workingDirectory(projectFor(chat)),tool,args,controller.signal,()=>coordination.denied(turnId,tool+'\n'+JSON.stringify(args),undefined,'Image action ended without file changes.'),emit);}
      if(operation==='document'){if(documentMutations.has(tool)&&projectFor(chat).mode==='plan')throw Error('Plan mode permits inspection and proposals only.');return documentToolCall(store,backend,store.get<Turn>('turn',turnId),workingDirectory(projectFor(chat)),tool,args,controller.signal,()=>coordination.denied(turnId,tool+'\n'+JSON.stringify(args),undefined,'Document action refused; no files were changed.'));}
      if(operation==='web')return researchTool(store,backend,store.get<Turn>('turn',turnId),tool,args,controller.signal);
      if(operation==='app-link')return linkCurrentApp(chat,backend.scrubber.value(args));
      if(operation==='app-todo-update')return updateAppTask(chat,backend.scrubber.value(args),turnId);
      if(operation==='app-todo')return addAppTask(chat,backend.scrubber.value(args));
      if(operation==='preview'){if(['publish','delete'].includes(String(args?.action))&&projectFor(chat).mode==='plan')throw Error('Plan mode permits inspection and proposals only.');return previewTool_(chat,store.get<Turn>('turn',turnId),backend.scrubber.value(args),controller.signal);}
      if(operation==='publish'){if(projectFor(chat).mode==='plan')throw Error('Plan mode permits inspection and proposals only.');return args?.client===true?shareWithClient(chat,args?.path,controller.signal):publish(args?.path,controller.signal);}
      if(!['list','tools','call'].includes(operation))throw Error('Unsupported MCP operation.');
      if(operation==='list')return (await mcp.request('list',{},controller.signal)).filter((row:McpConnection)=>row.enabled).map((row:McpConnection)=>({id:row.id,name:row.name,status:row.status}));
      if(typeof connection!=='string'||operation==='call'&&(typeof tool!=='string'||!args||typeof args!=='object'||Array.isArray(args)))throw Error('Invalid MCP tool request.');
      return mcp.request(operation,{id:connection,name:tool,arguments:args},controller.signal);
    })().then(value=>{if(!controller.signal.aborted&&hermesTurns.get(chat.id)===turnId)request.respond({value});},error=>request.respond({error:backend.scrubber.text(String(error))})).finally(()=>mcpToolRequests.delete(id));
    return true;
  }
  if(!['approval','approval.request','clarify','clarify.request'].includes(request.method))return false;
  if(!['running','waiting'].includes(store.get<Turn>('turn',turnId).status)){request.respond(request.method.startsWith('clarify')?{}:{choice:'deny'});return true;}
  // Read this chat's current mode at the final approval boundary, including
  // requests from lower-level file guards. Clarifications still need an answer.
  if(request.method.startsWith('approval')&&projectFor(chat).mode==='bypass'){request.respond({choice:'once'});return true;}
  const id=backend.generation+':'+request.id;
  requests.set(id,request);
  askApproval({id,chatId:chat.id,turnId,method:request.method.split('.')[0],params:backend.scrubber.value(request.params),status:'pending'});
  store.update<Turn>('turn',turnId,{status:'waiting'});emit();return true;
}
