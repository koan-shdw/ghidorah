// context: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import {blockedFor} from '../availability';
import {backendSendError} from '../backend-state';
import {ContextDraft,contextSource,contextSystem,resumeDraft,saveContext,summaryModel} from '../chat-context';
import {claudeOneShot} from '../claude';
import {claudeTurnUsage} from '../claude-turn';
import {apiChanging,appSummaryJobs,backend,background,checkpointChanging,claudeExecutable,commandTurns,contextJobs,coordination,data,emit,folderChanging,gitOperation,goals,health,installing,managingChats,modeChanges,native,pluginChanges,pluginControllers,pluginHandlers,pluginOwners,pluginRuntime,pluginWorkerSettings,pluginsChanging,quitting,requests,restartBackend,sidebar,store,submittingChats,uploading} from '../main';
import {NativePluginInstall,hermesPluginCopies,hermesPluginKey,verifyPlugins} from '../native-plugins';
import {PluginProcessOwner,pluginWorker} from '../plugin-commands';
import {handoffCommand,handoverRequest} from '../handover';
import {redactPastedKeys} from '../redaction';
import {queryChatHistory} from '../rlm-history';
import type {Routine} from '../routines';
import {route} from '../routing';
import {preferredSideModel,saysMain,sideQuestion,sideRoute,sideState,sideSystem} from '../side-answers';
import type {Approval,Chat,Project,SideAnswer,ToolCall,Turn} from '../types';
import {fixtureClaudeArgs} from './accounts';
import {providerUrls,wake} from './dispatch';
import {availableModels,connectedModels,recordRoute,unavailableMessage} from './models';
import {chatSelector,classifierActive,decisionEngine,jevSettings} from './pickers';
import {projectFor,requireStableFolder,workingDirectory} from './projects';
import {remoteFallback} from './remote';
import {askApproval} from './snapshot';
import {anyChatBusy,chatBusy,replyRow} from './turns';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function dispatchPluginCommand(chat:Chat,turn:Turn,project:Project){
  const controller=new AbortController();pluginControllers.set(chat.id,controller);
  let owner:PluginProcessOwner|undefined;
  const argumentsText=turn.prompt.trimStart().slice(turn.command!.name.length).trimStart();
  const toolId=turn.id+':plugin-command';let started=false;
  const approve=(description:string,command?:string)=>new Promise<boolean>(resolve=>{
    if(controller.signal.aborted){resolve(false);return;}
    const id='plugin:'+turn.id+':'+randomUUID();
    const finish=(approved:boolean)=>{controller.signal.removeEventListener('abort',abort);requests.delete(id);resolve(approved);};
    const abort=()=>{store.update<Approval>('approval',id,{status:'expired'});finish(false);emit();};
    controller.signal.addEventListener('abort',abort,{once:true});requests.set(id,{respond:(answer:any)=>finish(answer.choice==='once')});
    askApproval({id,chatId:chat.id,turnId:turn.id,method:'approval',params:{description,command},status:'pending'});store.update<Turn>('turn',turn.id,{status:'waiting'});emit();
  });
  const validate=async()=>{
    controller.signal.throwIfAborted();
    const current=store.get<Project>('project',project.id);
    if(!current.folder||workingDirectory(current)!==workingDirectory(project))throw Error('Choose a root working folder in Settings before running plugin commands.');
    if(current.mode==='plan')throw Error('Plan mode does not run plugin command code.');
    const plugin=store.get<NativePluginInstall>('native-plugin',turn.command!.pluginId);
    if(!plugin.enabled||plugin.hash!==turn.command!.hash||hermesPluginKey(plugin)!==turn.command!.pluginKey)throw Error('This command changed. Review the plugin before running it.');
    const plugins=store.all<NativePluginInstall>('native-plugin').filter(row=>row.hermes);
    await verifyPlugins(plugins,path.join(data,'native-plugins'));await hermesPluginCopies(plugins,path.join(data,'hermes','profiles',project.profile));
  };
  try{
    if(store.get<Turn>('turn',turn.id).status==='stopping')controller.abort();
    await validate();
    if(store.get<Project>('project',project.id).mode!=='bypass'&&!await approve('Run '+turn.command!.name+'\n'+turn.prompt+'\nThis command runs reviewed plugin code with your account’s access.'))throw Error('Plugin command was denied.');
    await validate();
    if(!store.event('plugin-command:'+turn.id,()=>{store.update<Turn>('turn',turn.id,{status:'running'});store.put('tool',{id:toolId,turnId:turn.id,name:turn.command!.name,args:{arguments:argumentsText},result:null,status:'running'});} ))throw Error('This command was already dispatched. Check its outcome before retrying.');
    started=true;emit();
    const result=await pluginWorker(backend,{operation:'run',...pluginWorkerSettings(),profile:project.profile,cwd:workingDirectory(project),chat:chat.id,turn:turn.id,command:turn.command!.command,pluginKey:turn.command!.pluginKey,arguments:argumentsText},controller.signal,text=>{if(text){const saved=store.get<Turn>('turn',turn.id);store.update<Turn>('turn',turn.id,{text:saved.text+text});emit();}},async (description,command)=>{
      if(store.get<Project>('project',project.id).mode==='plan')return false;
      return approve(description,command);
    },async request=>{
      if(request.operation==='inspect')return {value:await coordination.inspectAction(turn.id,workingDirectory(project),request.arguments)};
      if(request.operation==='begin')return {lease:await coordination.begin(turn.id,turn.id,workingDirectory(project),request.name,request.arguments,controller.signal)};
      if(request.operation==='finish'){if(!owner)throw Error('The command process owner is unavailable.');await background.finishTool(chat,turn.id,request.lease,request.result,request.uncertain===true,false,owner.id);return {};}
      throw Error('Invalid command action request.');
    },{
      opened:value=>{owner=value;pluginOwners.set(value.id,value);},
      processes:rows=>{if(!owner)throw Error('The command process owner is unavailable.');return background.pluginSnapshot(chat,turn.id,owner.id,rows);},
      closed:async stopped=>{if(owner)try{await background.pluginClosed(owner.id,stopped);}finally{pluginOwners.delete(owner.id);emit();}}
    });
    store.transaction(()=>{const saved=store.get<Turn>('turn',turn.id);store.update<Turn>('turn',turn.id,{text:saved.text+(result?(saved.text?'\n':'')+String(result):saved.text?'':'Command completed.'),status:'completed'});store.update<ToolCall>('tool',toolId,{result,status:'completed'});});
  }catch(error){
    store.update<Turn>('turn',turn.id,{status:controller.signal.aborted?'stopped':'interrupted',error:backend.scrubber.text(String(error))});
    if(started)store.update<ToolCall>('tool',toolId,{status:'uncertain'});
  }finally{coordination.interrupt(turn.id);pluginControllers.delete(chat.id);if(commandTurns.get(chat.id)===turn.id)commandTurns.delete(chat.id);emit();wake(chat.id);}
}
export function pluginChangeWait(){
  if(quitting||!backend||backend.status!=='ready')return 'Waiting for the backend';
  if(backend.loginChild)return 'Waiting for sign-in to finish';
  if(pluginsChanging||installing||apiChanging||folderChanging||checkpointChanging||gitOperation)return 'Waiting for the current app change';
  if(anyChatBusy()||submittingChats.size||contextJobs.size||appSummaryJobs.size||modeChanges.size)return 'Queued — waiting for current work to finish';
  if(pluginOwners.size||background?.rows().some(row=>['running','checking','stopping'].includes(row.status)))return 'Queued — waiting for background work to finish';
  return null;
}
export async function changePlugin(item:NativePluginInstall,runtime?:unknown){
  const previous=store.all<NativePluginInstall>('native-plugin').find(row=>row.id===item.id),hermes=!!(item.hermes||previous?.hermes);
  const next=[...store.all<NativePluginInstall>('native-plugin').filter(row=>row.id!==item.id),item].filter(row=>row.enabled&&row.hermes);
  await backend.host('plugin_dependencies_check',{plugins:next.map(row=>({directory:row.directory,name:row.name,version:row.version,key:hermesPluginKey(row)}))});
  const previousRuntime=pluginRuntime();
  store.transaction(()=>{store.put('native-plugin',item);if(runtime!==undefined)store.put('settings',{id:'plugin-runtime',runtime});else if(!next.some(row=>row.setup?.python.length)&&!(pluginRuntime() as any)?.features?.length)store.put('settings',{id:'plugin-runtime',runtime:null});});
  // A changed system prefix starts a new engine session, retaining the app transcript.
  for(const chat of store.all<Chat>('chat'))for(const engine of hermes?['claude','hermes'] as const:['claude'] as const)store.put('engine',{...store.enginePosition(chat.id,engine),sessionId:null,uncertain:true});
  if(hermes){
    try{await restartBackend(true);}
    catch(error){
      store.put('native-plugin',previous||{...item,enabled:false});
      store.put('settings',{id:'plugin-runtime',runtime:previousRuntime});
      try{await restartBackend(true);}catch{/* Keep the original load error; Restart remains available. */}
      throw error;
    }
  }
  emit();return true;
}
export function goalHold(chatId:string){
  if(pluginChanges.pending||pluginsChanging)return 'Waiting for queued plugin changes.';
  if(gitOperation)return 'Wait for the Git operation to finish.';
  if(contextJobs.has(chatId))return 'Wait for the context summary to finish or stop it.';
  const chat=store.get<Chat>('chat',chatId),ids=[chatId,...store.all<Chat>('chat').filter(row=>row.parentChatId===chatId).map(row=>row.id)];
  if(ids.some(id=>chatBusy(id)||submittingChats.has(id))||modeChanges.has(chat.projectId))return 'Wait for current work to finish.';
  if(store.all<Turn>('turn').some(turn=>ids.includes(turn.chatId)&&['queued','running','waiting','dispatching','stopping'].includes(turn.status)))return 'Wait for queued work to finish.';
  if([...background.rows(),...native.rows()].some(row=>ids.includes(row.chatId)&&['running','checking','stopping'].includes(row.status)))return 'Wait for background work to finish.';
  if(coordination.pending().some(action=>ids.includes(store.get<Turn>('turn',action.job).chatId)))return 'Inspect uncertain actions before continuing the goal.';
  return null;
}
export async function submitTurn({id,chatId,text,selected,models,goalRun}:any,source?:Pick<Turn,'remote'|'routine'|'voice'|'handoff'>,signal?:AbortSignal){
    const checkHandoff=()=>{signal?.throwIfAborted();if(source?.handoff&&!source.handoff.push&&projectFor(store.get<Chat>('chat',source.handoff.sourceChatId)).mode==='plan')throw Error('Plan mode permits inspection and proposals only.');if(source?.handoff&&store.get<Chat>('chat',chatId).archived)throw Error('Restore the destination chat before sending a task.');};
    checkHandoff();
    requireStableFolder();
    if(managingChats.has(chatId)||store.get<Chat>('chat',chatId).archived)throw Error('Restore this chat before sending a message.');
    submittingChats.set(chatId,(submittingChats.get(chatId)||0)+1);
    try{
    if(!source&&uploading.has(chatId))throw Error('Wait for attachments to finish preparing.');
    if(apiChanging)throw Error('Wait for the connection update to finish.');
    if(pluginsChanging)throw Error('Plugins are changing. Send your message when they are ready.');
    if(backend.loginChild)throw Error('Finish or cancel the account sign-in before sending.');
    if(typeof text!=='string'||! /^[\w-]{10,80}$/.test(id))throw Error('Invalid message');
    // /handoff asks this chat for a handover (protocol part 1); its latest finished reply then offers START HANDOVER.
    const handingOff=handoffCommand.test(text.trim());
    if(handingOff){
      const chat=sidebar.root(chatId);if(chat.sideSourceId)throw Error('Keep this side chat before handing off.');
      if(chat.handover?.stage==='live'||store.all<Chat>('chat').some(c=>c.handover?.newChatId===chatId))throw Error('Close handover mode before handing off again.');
      text=handoverRequest(text.trim().slice('/handoff'.length));
    }
    if(backend.scrubber.text(text)!==text || redactPastedKeys(text)!==text)throw Error('This looks like an API key. Save it in Settings.');
    const existing=store.all<Turn>('turn').find(turn=>turn.id===id);if(existing){if(existing.chatId!==chatId||existing.prompt!==text)throw Error('Message ID was already used.');return id;}if(store.all<{id:string;chatId:string}>('turn-removed').some(row=>row.id===id)){if(store.get<{chatId:string}>('turn-removed',id).chatId!==chatId)throw Error('Message ID was already used.');return id;}
    if(!text.trim()&&(source||!store.get<Chat>('chat',chatId).attachments?.length))throw Error('Add a message or attachment.');
    if(/^\/compact(?:\s|$)/i.test(text.trim())){
      const chat=sidebar.root(chatId);if(chat.sideSourceId)throw Error('Keep this side chat before compacting.');
      if(chat.attachments?.length)throw Error('Send or remove attachments before /compact.');
      store.transaction(()=>{store.accept(id,chatId,text,chat.model,source);store.update<Turn>('turn',id,{contextCommand:true});});wake(chatId);emit();return id;
    }
    const handler=pluginHandlers.find(row=>row.name===text.trimStart().split(/\s/,1)[0]);
    if(handler){
      checkHandoff();
      if(!source&&store.get<Chat>('chat',chatId).attachments?.length)throw Error('Plugin commands do not accept attachments. Send them in a model message.');
      const chat=store.get<Chat>('chat',chatId);
      store.transaction(()=>{store.accept(id,chatId,text,'command:'+handler.plugin,source);store.update<Turn>('turn',id,{command:handler});store.update<Chat>('chat',chatId,{selected:chat.selected,selectedModels:chat.selectedModels});});
      wake(chatId);emit();return id;
    }
    const history=store.all<Turn>('turn').filter(t=>t.status==='completed'&&!t.command);
    const previous=history.filter(t=>t.chatId===chatId).at(-1)?.model||null;
    const chat=store.get<Chat>('chat',chatId);
    if(chat.parentChatId)throw Error('Use the side job correction control.');
    if(models!==undefined&&(!Array.isArray(models)||models.some(model=>typeof model!=='string'||!(chat.pool||[]).includes(model))))throw Error('Choose models linked to this chat.');
    // A Ctrl+clicked model answers every message until released; one-off picks add to it.
    const locked=chat.lockedModel&&(chat.pool||[]).includes(chat.lockedModel)?[chat.lockedModel]:[];
    // Remote messages leave pending desktop selections alone. Routines follow
    // the chosen chat's model selection while preserving its unsent draft.
    const picks:string[]=source?.remote?locked:[...new Set([...locked,...(models??(typeof selected==='boolean'?(selected?['deepseek-flash']:[]):chat.selectedModels||(chat.selected?['deepseek-flash']:[])))])];
    const engineError=backendSendError(backend.status,picks);if(engineError)throw Error(engineError);
    if(!availableModels().length){
      const model=picks[0]||(chat.pool||[]).find(model=>blockedFor(health.rows(),model))||connectedModels()[0];
      throw Error(model?unavailableMessage(model):'Connect an available model in Settings to send a message.');
    }
    const accept=(model:string)=>{
      checkHandoff();
      const current=store.get<Chat>('chat',chatId);
      if(goalRun&&(current.draft.trim()||current.attachments?.length||(submittingChats.get(chatId)||0)>1||store.all<Turn>('turn').some(turn=>turn.chatId===chatId&&['queued','running','waiting','dispatching','stopping','needs-model'].includes(turn.status))))throw Error('Your pending message takes priority. Resume the goal after sending it.');
      if(source?.routine){const routine=store.get<Routine>('routine',source.routine.id);if(!routine.enabled||routine.nextFiring!==source.routine.firing)throw Error('Routine changed before dispatch.');}
      const turn=store.accept(id,chatId,text,model,source);goals.attach(turn,goalRun,picks);
      if(handingOff)store.update<Chat>('chat',chatId,{handover:{stage:'writing'}});
      if(goalRun&&['New chat','New project'].includes(current.title))store.update<Chat>('chat',chatId,{title:goals.get(chatId)!.objective.slice(0,55)});
      return turn;
    };
    if(!picks.length&&(classifierActive()||chatSelector(chat))){
      store.transaction(()=>{accept(chat.model);store.update<Turn>('turn',id,{routePending:true,routeBy:chatSelector(chat)||decisionEngine(),requestedModels:picks,models:picks.length>1?picks:undefined});recordRoute(id,{reason:'routing-requested',selected:picks});});wake(chatId);emit();return id;
    }
    const unavailable=picks.find(model=>!availableModels().includes(model));if(unavailable)throw Error(unavailableMessage(unavailable));
    const appPrevious=store.all<{id:string;model?:string}>('settings').find(row=>row.id==='last-model')?.model||history.at(-1)?.model||null;
    const input={selected:picks,eligible:availableModels().filter(model=>(chat.pool||['deepseek-flash']).includes(model)),previous,appPrevious};
    const decision=await route(input).catch(error=>{const model=source&&remoteFallback(source,input);if(!model)throw error;return {model,reason:'remote-fallback',models:undefined};});
    const dispatchError=backendSendError(backend.status,decision.models||[decision.model]);if(dispatchError)throw Error(dispatchError);
    store.transaction(()=>{accept(decision.model);store.update<Turn>('turn',id,{models:decision.models,requestedModels:picks});recordRoute(id,decision);});wake(chatId);emit();return id;
    }finally{const pending=(submittingChats.get(chatId)||1)-1;if(pending)submittingChats.set(chatId,pending);else submittingChats.delete(chatId);goals.schedule();pluginChanges.poke();}
}
export async function contextCompletion(chat:Chat,model:string,system:string,prompt:string,signal:AbortSignal,lookup=false){
 signal=AbortSignal.any([signal,AbortSignal.timeout(lookup?45000:90000)]);
 const answer=model.startsWith('claude-code:')
  ?await claudeOneShot(claudeExecutable!,model.slice(12),system,prompt,await fs.mkdir(path.join(data,'context-summary'),{recursive:true}).then(()=>path.join(data,'context-summary')),data,signal,lookup?45000:90000,fixtureClaudeArgs()?.concat('--fixture-oneshot'))
  :await backend.host('context_summary',{profile:projectFor(chat).profile,model,provider_access:backend.providerAccess,provider_urls:providerUrls(),system,prompt,lookup},signal);
 signal.throwIfAborted();const usage=answer.usage,count=typeof usage?.total_tokens==='number'?usage.total_tokens:claudeTurnUsage({usage}).turn_total;
 return {text:redactPastedKeys(backend.scrubber.text(String(answer.text||''))).trim(),tokens:Number.isSafeInteger(count)&&count>=0?count:null};
}
// Side answers (FEATURE-SPECS 2). The model Koan picked, else the newest fast one he has connected.
export function sideModel():string|null{const ready=availableModels(),saved=store.all<any>('settings').find(row=>row.id==='side-answers')?.model;return ready.includes(saved)?saved:preferredSideModel(ready);}
export const sideRow=(id:unknown,chatId:unknown)=>{const row=typeof id==='string'?store.find<SideAnswer>('side-answer',id):null;if(!row||row.chatId!==chatId)throw Error('This side answer belongs to another chat.');return row;};
// A message from the message box: a side answer takes it (its id is returned) or it goes to the main model (null).
// The running turn is never touched: the side model only reads a copy of the live state.
export async function sideFirst({id,chatId,text,goalRun}:any):Promise<string|null>{
  if(goalRun||typeof text!=='string'||typeof chatId!=='string'||! /^[\w-]{10,80}$/.test(id))return null;
  const chat=store.find<Chat>('chat',chatId);if(!chat||chat.parentChatId||chat.archived)return null;
  if(store.find<SideAnswer>('side-answer',id))return id;
  const running=replyRow(chatId),route=sideRoute(text,{running:!!running,attachments:!!chat.attachments?.length}),model=sideModel();
  // Only "??" for now: any other message reaches the engine at once, as the turn layer delivers it mid-reply.
  if(route!=='side'||!model)return null;
  if(backend.scrubber.text(text)!==text||redactPastedKeys(text)!==text)throw Error('This looks like an API key. Save it in Settings.');
  const roots=store.all<Turn>('turn').filter(t=>t.chatId===chatId&&!t.parentTurnId),turn=running?store.get<Turn>('turn',running):roots.at(-1);
  if(!turn)return null;
  const forced=route==='side',question=forced?sideQuestion(text):text;
  store.put<SideAnswer>('side-answer',{id,chatId,turnId:turn.id,question,model,forced,status:forced?'answering':'sorting',text:'',created:Date.now()});emit();
  try{
    const jobs=(turn.jobs||[]).map(job=>store.find<Turn>('turn',job)).filter((job):job is Turn=>!!job);
    const live=sideState({turn,jobs,tools:store.whereIn<ToolCall>('tool','turnId',[turn.id,...jobs.map(job=>job.id)]),queued:roots.filter(t=>['queued','needs-model'].includes(t.status)),recent:roots.filter(t=>t.status==='completed'&&t.id!==turn.id).slice(-3),now:Date.now()});
    const answer=await contextCompletion(chat,model,sideSystem(forced),JSON.stringify({question,live}),new AbortController().signal,true);
    if(!forced&&saysMain(answer.text)){store.remove('side-answer',id);emit();return null;}
    store.update<SideAnswer>('side-answer',id,{status:'done',text:answer.text,tokens:answer.tokens});
  }catch(error){
    // Unsure goes to the main model; a ?? question shows why it got no answer.
    if(!forced){store.remove('side-answer',id);emit();return null;}
    store.update<SideAnswer>('side-answer',id,{status:'failed',text:'No side answer: '+backend.scrubber.text(error instanceof Error?error.message:String(error))});
  }
  emit();return id;
}
export async function queryHistory(turn:Turn,args:any,signal:AbortSignal){
 const chat=store.get<Chat>('chat',turn.chatId);
 return queryChatHistory(store,turn,args,signal,(system,prompt,signal)=>contextCompletion(chat,turn.model,system,prompt,signal,true)).finally(emit);
}
export async function generateContext(chatId:string,model:string,options:{beforeTurnId?:string;concise?:boolean;origin?:'command'|'automatic'}={},focus=''){
  if(apiChanging)throw Error('Wait for the connection update to finish.');
  if(contextJobs.has(chatId))throw Error('A context summary is already running.');
  const chat=sidebar.root(chatId),source=contextSource(store,chatId,options),controller=new AbortController(),job={controller,done:0,total:source.batches.length};
  // Each summary call has its own time limit (contextCompletion); the whole automatic run gets 5 minutes, not 60 s.
  const signal=options.origin==='automatic'?AbortSignal.any([controller.signal,AbortSignal.timeout(300000)]):controller.signal;
  contextJobs.set(chatId,job);emit();
    // A run saves its progress after each batch; a retry continues from it, and a partial draft is never applied (7a).
    const resume=resumeDraft(store.find<ContextDraft>('context-draft',chatId),source.revision,source.batches.length);
    let summary=resume?.summary??source.previous,tokens:number|null=0;job.done=resume?.start||0;
    try{
      for(const [index,batch] of source.batches.entries()){
        if(index<job.done)continue;
        signal.throwIfAborted();const prompt=JSON.stringify({focus,previousSummary:summary,standingInstructions:source.instructions,goal:source.goal,records:batch});
        const usageId=randomUUID();store.put('context-usage',{id:usageId,chatId,model,tokens:null});
        const answer=await contextCompletion(chat,model,contextSystem,prompt,signal);
        summary=answer.text;if(!summary||summary.length>40000)throw Error('The summary was empty or too large. The current context is kept.');
        store.update<{id:string;tokens:number|null}>('context-usage',usageId,{tokens:answer.tokens});
        tokens=tokens!==null&&answer.tokens!==null?tokens+answer.tokens:null;job.done++;
        if(job.done<source.batches.length)store.put<ContextDraft>('context-draft',{id:chatId,chatId,throughTurnId:source.throughTurnId,revision:source.revision,summary,instructions:source.instructions,sourceCharacters:source.sourceCharacters,model,tokens,created:Date.now(),...options,partial:true,done:job.done});
        emit();
      }
      signal.throwIfAborted();return store.put<ContextDraft>('context-draft',{id:chatId,chatId,throughTurnId:source.throughTurnId,revision:source.revision,summary,instructions:source.instructions,sourceCharacters:source.sourceCharacters,model,tokens,created:Date.now(),...options});
    }finally{contextJobs.delete(chatId);emit();}
}
// A summary that finished in the background is applied when the chat next needs a fresh session (batch 5, 7b).
export async function applyReadyDraft(chatId:string){
 const chat=sidebar.root(chatId),draft=store.find<ContextDraft>('context-draft',chat.id);
 if(!draft||draft.partial||draft.origin!=='automatic'||contextJobs.has(chat.id))return false;
 try{for(const owner of sidebar.owned(chat.id))await native.closeChat(owner.id);saveContext(store,chat.id,draft.revision,draft.summary,draft.instructions);}catch{return false;}
 store.update<Chat>('chat',chat.id,{contextRetryAfter:undefined,compressed:true,contextNotice:'Context compacted. Original messages remain available.'});emit();return true;
}
export function compactInBackground(turn:Turn){
 const chat=sidebar.root(turn.chatId),model=summaryModel(true,turn.model,chat.pool||[],availableModels(),jevSettings().summaryModel);
 if(!model||contextJobs.has(chat.id))return;
 const options={beforeTurnId:turn.id,concise:true,origin:'automatic' as const};
 try{store.update<Chat>('chat',chat.id,{contextAttemptThrough:contextSource(store,chat.id,options).throughTurnId,contextNotice:''});}catch{return;}
 void generateContext(chat.id,model,options).catch(()=>{store.update<Chat>('chat',chat.id,{contextRetryAfter:Date.now()+300000,contextNotice:'The summary of earlier messages did not finish. Recent messages are still sent; it retries later.'});emit();});
}
export async function compactForTurn(turn:Turn,automatic:boolean){
 const chat=sidebar.root(turn.chatId),options={beforeTurnId:turn.id,concise:true,origin:automatic?'automatic' as const:'command' as const};
 const roots=store.all<Turn>('turn').filter(t=>t.chatId===chat.id);
 if(roots.slice(0,roots.findIndex(t=>t.id===turn.id)).filter(t=>!t.automatic&&!t.contextSnapshot&&!t.contextCommand).length<2)return 'No older history needs compaction. The newest exchange is kept in context.';
 const source=contextSource(store,chat.id,options);
 if(!source.sources.length)return 'Older messages are already compacted.';
 // Automatic compaction summarises with a fast model (Jev's summary model, else any Flash/Haiku), so a long chat
 // finishes its shrink; several Opus calls never fit (speed plan, Koan 2026-10-07). /compact keeps the chat's model.
 const model=summaryModel(automatic,turn.model,chat.pool||[],availableModels(),jevSettings().summaryModel);
 if(!model)throw Error('Connect an available model to compact this chat.');
 store.update<Chat>('chat',chat.id,{contextAttemptThrough:source.throughTurnId,contextNotice:''});
 const draft=await generateContext(chat.id,model,options,automatic?'':turn.prompt.replace(/^\/compact\s*/i,''));
 if(store.get<Turn>('turn',turn.id).status==='stopping')throw Error('Compaction stopped. Your previous context is kept.');
 for(const owner of sidebar.owned(chat.id))await native.closeChat(owner.id);
 if(store.get<Turn>('turn',turn.id).status==='stopping')throw Error('Compaction stopped. Your previous context is kept.');
 saveContext(store,chat.id,draft.revision,draft.summary,draft.instructions);
 store.update<Chat>('chat',chat.id,{contextRetryAfter:undefined,compressed:true,contextNotice:'Context compacted. Original messages remain available.'});emit();
 return 'Context compacted. Decisions, unfinished work and source references are saved; the newest exchange and original history are retained.';
}
