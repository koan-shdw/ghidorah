// apps: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import {existingAppPath} from '../app-repositories';
import {AppSummary,appSummarySources,summaryRevision} from '../app-summary';
import {AppIdea,AppWatch,defaultWatch,nextWatchRun,readIdeas,updateModel} from '../app-watch';
import {claudeOneShot} from '../claude';
import {claudeTurnUsage} from '../claude-turn';
import {apiChanging,appLights,appSummaryErrors,appSummaryJobs,appWatchJobs,appWatchSteps,backend,claudeExecutable,data,emit,goals,installing,pluginChanges,pluginsChanging,projectFor,providerUrls,store} from '../main';
import {redactPastedKeys} from '../redaction';
import type {AppTodo,SavedApp} from '../saved-apps';
import type {Chat,Snapshot,Turn} from '../types';
import {fixtureClaudeArgs} from './accounts';
import {availableModels} from './models';
import {jevSettings} from './pickers';
import fs from 'node:fs/promises';
import path from 'node:path';

export function defaultFolder(){return store.all<{id:string,folder:string|null}>('settings').find(s=>s.id==='working-folder')?.folder||null;}
export function defaultModels():string[]{return store.all<{id:string,models:string[]}>('settings').find(s=>s.id==='default-models')?.models||['deepseek-flash'];}
export function favouriteModels():string[]{return store.all<{id:string,models:string[]}>('settings').find(s=>s.id==='favourite-models')?.models||[];}
export function savedAppRows(base:Pick<Snapshot,'chats'|'turns'|'approvals'>=store.snapshot({tools:false})){
 const state={...base,goals:goals?.rows()||[]},summaries=store.all<AppSummary>('app-summary');
 return store.all<SavedApp>('saved-app').map(app=>{const chatIds=app.chatIds.filter(id=>state.chats.some(c=>c.id===id)),value={...app,chatIds,todos:store.all<AppTodo>('app-todo').filter(todo=>todo.appId===app.id).sort((a,b)=>a.created-b.created||a.id.localeCompare(b.id))},revision=summaryRevision(appSummarySources(value,state));const watch={...watchRow(app.id),running:appWatchJobs.has(app.id),step:appWatchSteps.get(app.id)},ideas=store.all<AppIdea>('app-idea').filter(idea=>idea.appId===app.id&&idea.status!=='dismissed').sort((a,b)=>b.found-a.found);return {...value,watch,updates:ideas,watchUnread:ideas.some(idea=>idea.status==='new'&&idea.found>watch.seen),light:appLights.get(app.id),summary:summaries.find(row=>row.id===app.id&&row.sources.every(source=>!source.chatId||chatIds.includes(source.chatId))),summaryRevision:revision,summaryRunning:appSummaryJobs.has(app.id),summaryError:appSummaryErrors.get(app.id)?.revision===revision?appSummaryErrors.get(app.id)?.message:undefined};});
}
export function watchRow(id:string){return store.all<AppWatch>('app-watch').find(row=>row.id===id)||defaultWatch(id);}
export function watchModel(watch:AppWatch){const model=updateModel(watch.model,availableModels(),jevSettings().summaryModel);if(!model)throw Error('Choose an available update model for this app.');return model;}
export function watchProfile(entry:SavedApp){const chats=store.all<Chat>('chat'),owner=chats.find(chat=>entry.chatIds.includes(chat.id))||chats.find(chat=>!chat.parentChatId);if(!owner)throw Error('Create a chat before checking for updates.');return projectFor(owner).profile;}
export function watchApp(entry:SavedApp){const clean=(text:string)=>redactPastedKeys(backend.scrubber.text(text||''));return {name:entry.name,stage:entry.stage,description:clean(entry.current),ideas:clean(entry.ideas),planned:clean(entry.planned)};}
export async function watchHost(stage:string,entry:SavedApp,model:string,context:any,signal?:AbortSignal){
 const request={stage,profile:watchProfile(entry),model,provider_access:backend.providerAccess,provider_urls:providerUrls(),context};
 if(model.startsWith('claude-code:')&&stage!=='gather'){
  signal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(90000)]);
  const prepared=await backend.host('app_watch',{...request,prepare:true},signal),cwd=path.join(data,'app-watch');
  await fs.mkdir(cwd,{recursive:true});
  const answer=await claudeOneShot(claudeExecutable!,model.slice(12),prepared.system,prepared.prompt,cwd,data,signal,60000,fixtureClaudeArgs()?.concat('--fixture-oneshot'));
  return backend.scrubber.value(await backend.host('app_watch',{...request,response:answer.text,usage:answer.usage},signal));
 }
 return backend.scrubber.value(await backend.host('app_watch',request,signal));
}
// App summaries with a Claude model go through the background Claude runner, like the update watcher.
// Routing summaries with a Claude model take the same route, so a subscription Claude can prepare the decision.
export async function routingSummaryHost(request:{model:string}&Record<string,unknown>,signal:AbortSignal){
 if(!request.model.startsWith('claude-code:'))return backend.host('routing_summary',request,signal);
 const prepared=await backend.host('routing_summary',{...request,prepare:true},signal),cwd=path.join(data,'routing-summary');
 await fs.mkdir(cwd,{recursive:true});
 const answer=await claudeOneShot(claudeExecutable!,request.model.slice(12),prepared.system,prepared.prompt,cwd,data,signal,30000,fixtureClaudeArgs()?.concat('--fixture-oneshot'));
 return backend.host('routing_summary',{...request,response:answer.text,usage:{total_tokens:claudeTurnUsage(answer).turn_total}},signal);
}
export async function summaryHost(request:{model:string}&Record<string,unknown>,signal:AbortSignal){
 if(!request.model.startsWith('claude-code:'))return backend.host('app_summary',request,signal);
 const prepared=await backend.host('app_summary',{...request,prepare:true},signal),cwd=path.join(data,'app-summary');
 await fs.mkdir(cwd,{recursive:true});
 const answer=await claudeOneShot(claudeExecutable!,request.model.slice(12),prepared.system,prepared.prompt,cwd,data,signal,120000,fixtureClaudeArgs()?.concat('--fixture-oneshot'));
 return backend.host('app_summary',{...request,response:answer.text,usage:answer.usage},signal);
}
export async function runAppWatch(id:string){
  if(appWatchJobs.has(id))throw Error('This app is already checking for updates.');
  const controller=new AbortController(),started=Date.now(),step=(text:string)=>{appWatchSteps.set(id,text);emit();};appWatchJobs.set(id,controller);step('Planning searches…');
  try{
    if(pluginsChanging||installing||pluginChanges.pending||apiChanging)throw Error('Wait for the current plugin or connection change to finish.');
    const entry=store.get<SavedApp>('saved-app',id),watch=watchRow(id),model=watchModel(watch),existing=store.all<AppIdea>('app-idea').filter(idea=>idea.appId===id);
    // The user's own words are the brief; app notes only help judge relevance.
    const brief=redactPastedKeys(backend.scrubber.text(watch.topics)),app=watchApp(entry);
    const planned=await watchHost('queries',entry,model,{brief,app,sources:watch.sources,today:new Date().toISOString().slice(0,10)},controller.signal);
    const queries=(Array.isArray(planned.queries)?planned.queries:[]).filter((q:unknown)=>typeof q==='string').map((q:string)=>redactPastedKeys(backend.scrubber.text(q)));
    step('Reading sources…');
    // Links already shown to the model are skipped, which also covers feeds without dates.
    const gathered=await watchHost('gather',entry,model,{sources:watch.sources,queries,since:watch.lastRun||started-14*86400000,reported:[...existing.flatMap(idea=>idea.sources.map(source=>source.url)).slice(-500),...watch.read||[]]},controller.signal);
    const items=Array.isArray(gathered.items)?gathered.items:[];
    step('Writing ideas…');
    const reply=items.length?await watchHost('ideas',entry,model,{brief,app,previous:existing.slice(-40).map(idea=>idea.title),items},controller.signal):{ideas:[]};
    controller.signal.throwIfAborted();
    const ideas=readIdeas(reply.ideas,items,existing,id,Date.now());
    store.transaction(()=>{store.get('saved-app',id);for(const idea of ideas)store.put('app-idea',idea);const current=watchRow(id);store.put<AppWatch>('app-watch',{...current,lastRun:started,nextRun:nextWatchRun(current.frequency,Date.now()),error:undefined,read:[...new Set([...current.read||[],...items.map((item:any)=>String(item?.url).slice(0,300))])].slice(-1000),unchecked:(Array.isArray(gathered.unchecked)?gathered.unchecked:[]).map(String).slice(0,60),checked:(Array.isArray(gathered.checked)?gathered.checked:[]).slice(0,40).map((row:any)=>({line:String(row?.line).slice(0,300),feed:String(row?.feed||'').slice(0,120),new:Number(row?.new)||0,...Number.isInteger(row?.captions)?{captions:row.captions}:{}}))});});
    return ideas.length;
  }catch(error){
    const message=controller.signal.aborted?'Update check stopped.':backend.scrubber.text(String(error)).replace(/^Error: /,'').slice(0,300);
    // A failed check retries after six hours instead of every minute.
    if(store.all<SavedApp>('saved-app').some(row=>row.id===id)){const current=watchRow(id);store.put<AppWatch>('app-watch',{...current,error:message,nextRun:current.frequency==='off'?null:Date.now()+6*3600000});}
    throw Error(message,{cause:error});
  }finally{appWatchJobs.delete(id);appWatchSteps.delete(id);emit();}
}
// One linked repository's Git state. Unpushed counts commits on no remote branch, so a repository without a remote counts them all.
export async function repositoryStatus(relative:string){try{
  const directory=await existingAppPath(defaultFolder(),relative,data);
  return {path:relative,...await backend.host('workspace_status',{directory}),checkedAt:Date.now()};
}catch(error){return {path:relative,error:backend.scrubber.text(String(error)).slice(0,350)};}}
// Job chats of each chat's latest parallel group, so the main window can dock their panes.
export function dockableJobChats(turns:Turn[]){const latest=new Map<string,Turn>();for(const t of turns)if(t.jobs?.length)latest.set(t.chatId,t);const jobs=new Set([...latest.values()].flatMap(t=>t.jobs!)),ids=new Set(turns.filter(t=>jobs.has(t.id)).map(t=>t.chatId));return store.all<Chat>('chat').filter(c=>ids.has(c.id)&&c.parentChatId).map(c=>({...c,pool:store.get<Chat>('chat',c.parentChatId!).pool}));}
