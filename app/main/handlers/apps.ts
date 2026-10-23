// apps handlers: moved out of app/main.ts unchanged (SPLIT-PLAN step 7); main.ts spreads them into handlers.
import {existingAppPath} from '../../app-repositories';
import {AppSummary,SummaryItem,appSummaryError,appSummarySources,applyTodoTitles,summaryBatches,summaryRevision,validateSummary} from '../../app-summary';
import {AppIdea,AppWatch,ideasPrompt,readWatch} from '../../app-watch';
import {apiChanging,apiProviders,appSummaryErrors,appSummaryJobs,appWatchJobs,backend,data,emit,goals,handlers,installing,pluginChanges,pluginsChanging,refreshAppLights,repoMaps,startingAppTasks,store} from '../../main';
import {redactPastedKeys} from '../../redaction';
import {AppTodo,SavedApp,appTodo,changeAppGroup,linkAppChat,removeApp,saveApp} from '../../saved-apps';
import type {Chat} from '../../types';
import {defaultFolder,repositoryStatus,runAppWatch,summaryHost,watchApp,watchHost,watchModel,watchRow} from '../apps';
import {submitTurn} from '../context';
import {providerUrls} from '../dispatch';
import {availableModels} from '../models';
import {projectFor} from '../projects';
import {shell} from 'electron';
import {randomUUID} from 'node:crypto';

export const appsHandlers:Record<string,(args:any)=>any>={
  async savedAppMap({id,repository,force=false}){
    const entry=store.get<SavedApp>('saved-app',id);
    if(typeof repository!=='string'||!entry.repositories?.includes(repository))throw Error('Choose a repository belonging to this app.');
    const directory=await existingAppPath(defaultFolder(),repository,data);
    return repoMaps.refresh(directory,force===true);
  },
  async savedAppSummarize({id,model}){
    if(pluginsChanging||installing||pluginChanges.pending)throw Error('Wait for the queued plugin changes to finish.');
    if(apiChanging)throw Error('Wait for the connection update to finish.');
    const entry=store.get<SavedApp>('saved-app',id),state={...store.snapshot(),goals:goals.rows()};
    if(!availableModels().includes(model))throw Error('Choose an available summary model.');
    const linked=state.chats.filter(chat=>entry.chatIds.includes(chat.id)),todos=store.all<AppTodo>('app-todo').filter(todo=>todo.appId===id);
    if(!linked.length&&!todos.length)throw Error('Add a to-do or link a chat before generating an app summary.');
    const owner=linked[0]||state.chats[0];if(!owner)throw Error('Create a chat before using the summary model.');
    const profile=projectFor(owner).profile;
    const raw=appSummarySources({...entry,todos,chatIds:linked.map(chat=>chat.id)},state),revision=summaryRevision(raw);
    const cached=store.all<AppSummary>('app-summary').find(row=>row.id===id);if(cached?.revision===revision&&cached.model===model)return cached;
    const running=appSummaryJobs.get(id);if(running){if(running.revision===revision&&running.model===model)return running.promise;throw Error('Wait for this app summary or stop it before refreshing.');}
    const controller=new AbortController(),sources=raw.map(source=>({...source,title:redactPastedKeys(backend.scrubber.text(source.title)),text:redactPastedKeys(backend.scrubber.text(source.text))}));
    appSummaryErrors.delete(id);
    const promise=(async()=>{
      let items:SummaryItem[]=[],tokens=0,usageIncomplete=false;const seen:typeof sources=[];
      const pending=todos.filter(todo=>!todo.summary&&todo.title.length>96);
      for(let offset=0;offset<pending.length;offset+=20){
        const batch=pending.slice(offset,offset+20);
        const response=await summaryHost({profile,model,provider_access:backend.providerAccess,provider_urls:providerUrls(),context:{todos:batch.map(todo=>({id:todo.id,notes:redactPastedKeys(backend.scrubber.text(todo.title))}))}},controller.signal);
        controller.signal.throwIfAborted();applyTodoTitles(store,batch,backend.scrubber.value(response.items));emit();
        const count=response.usage?.total_tokens;if(Number.isSafeInteger(count)&&count>=0)tokens+=count;else usageIncomplete=true;
      }
      for(const batch of summaryBatches(sources)){
        controller.signal.throwIfAborted();seen.push(...batch);
        const response=await summaryHost({profile,model,provider_access:backend.providerAccess,
          provider_urls:{deepseek:process.env.TRISMEGISTUS_TEST_PROVIDER_URL||'https://api.deepseek.com/v1','openai-codex':process.env.TRISMEGISTUS_TEST_CODEX_URL||'https://chatgpt.com/backend-api/codex',...apiProviders.urls()},
          context:{previous:items,sources:batch}},controller.signal);
        controller.signal.throwIfAborted();items=validateSummary(backend.scrubber.value(response.items),seen);
        const count=response.usage?.total_tokens;if(Number.isSafeInteger(count)&&count>=0)tokens+=count;else usageIncomplete=true;
      }
      controller.signal.throwIfAborted();store.get('saved-app',id);
      return store.put<AppSummary>('app-summary',{id,revision,model,items,sources:sources.map(({id,chatId,title})=>({id,chatId,title})),generatedAt:Date.now(),tokens,usageIncomplete});
    })().catch(error=>{const message=appSummaryError(backend.scrubber.text(String(error)),controller.signal.aborted);appSummaryErrors.set(id,{revision,message});throw Error(message,{cause:error});}).finally(()=>{appSummaryJobs.delete(id);emit();});
    appSummaryJobs.set(id,{controller,promise,revision,model});emit();return promise;
  },
  savedAppSummaryStop({id}){store.get('saved-app',id);appSummaryJobs.get(id)?.controller.abort();},
  savedAppGroup(args){const result=changeAppGroup(store,args);emit();return result;},
  savedAppSave(args){for(const key of ['name','stage','current','ideas','planned','questions'])if(typeof args?.[key]==='string')args[key]=redactPastedKeys(backend.scrubber.text(args[key]));const result=saveApp(store,args);emit();void refreshAppLights();return result;},
  savedAppLink({id,chatId,linked}){const result=linkAppChat(store,id,chatId,linked);emit();return result;},
  savedAppTodo(args){if(startingAppTasks.has(args?.id))throw Error('This to-do is starting. Try again in a moment.');if(typeof args?.title==='string')args.title=redactPastedKeys(backend.scrubber.text(args.title));const todo=appTodo(store,args);emit();return todo;},
  async savedAppTodoStart({id}){
    if(startingAppTasks.has(id))return startingAppTasks.get(id);
    const job=(async()=>{
      const todo=store.get<AppTodo>('app-todo',id),entry=store.get<SavedApp>('saved-app',todo.appId);
      if(todo.chatId&&store.all<Chat>('chat').some(chat=>chat.id===todo.chatId))return {chatId:todo.chatId};
      if(todo.done)throw Error('Reopen this to-do before starting a chat.');
      const chatId=await handlers.newChat({});
      // Re-read after setup so edits and newly linked chats made while it runs survive.
      const current=store.get<AppTodo>('app-todo',id),latest=store.get<SavedApp>('saved-app',entry.id);
      const prompt='Work on this to-do for '+latest.name+':\n\n'+current.title+(latest.repositories?.length?'\n\nRepository folders: '+latest.repositories.join(', '):'');
      store.transaction(()=>{store.update<Chat>('chat',chatId,{title:current.title.slice(0,80),draft:prompt});store.update<AppTodo>('app-todo',id,{chatId});saveApp(store,{id:entry.id,chatIds:[...latest.chatIds,chatId]});});emit();
      const chat=store.get<Chat>('chat',chatId),models=(chat.pool||[]).filter(model=>availableModels().includes(model));
      if(!models.length)return {chatId,warning:'Choose an available model to start this to-do. Your task is ready in the message box.'};
      try{await submitTurn({id:randomUUID(),chatId,text:prompt,selected:false,models:models.length===1?models:[],goalRun:undefined});return {chatId};}
      catch(error){return {chatId,warning:backend.scrubber.text(String(error))};}
    })().finally(()=>startingAppTasks.delete(id));startingAppTasks.set(id,job);return job;
  },
  savedAppWatchSave(args){const id=args?.id;store.get('saved-app',id);const watch=readWatch(args,watchRow(id),Date.now());store.put<AppWatch>('app-watch',{...watch,sources:redactPastedKeys(backend.scrubber.text(watch.sources)),topics:redactPastedKeys(backend.scrubber.text(watch.topics))});emit();},
  async savedAppWatchSuggest({id}){
    const entry=store.get<SavedApp>('saved-app',id),watch=watchRow(id),todos=store.all<AppTodo>('app-todo').filter(todo=>todo.appId===id&&!todo.done).slice(0,30).map(todo=>redactPastedKeys(backend.scrubber.text(todo.summary||todo.title)).slice(0,300));
    const summary=store.all<AppSummary>('app-summary').find(row=>row.id===id)?.items.filter(item=>item.kind!=='delivery').slice(0,20).map(item=>item.text);
    const reply=await watchHost('profile',entry,watchModel(watch),{brief:watch.topics,app:watchApp(entry),todos,summary,sources:watch.sources});
    // Only sources: the brief stays in the user's own words.
    const sources=(Array.isArray(reply.sources)?reply.sources.join('\n'):typeof reply.sources==='string'?reply.sources:'').trim().slice(0,4000);
    if(!sources)throw Error('The update model did not suggest sources. Try again or choose another model.');
    handlers.savedAppWatchSave({id,sources});
  },
  async savedAppWatchRun({id}){store.get('saved-app',id);return runAppWatch(id);},
  savedAppWatchStop({id}){appWatchJobs.get(id)?.abort();},
  savedAppWatchSeen({id}){store.get('saved-app',id);store.put<AppWatch>('app-watch',{...watchRow(id),seen:Date.now()});emit();},
  savedAppIdea({id,status}){const idea=store.get<AppIdea>('app-idea',id);if(!['new','dismissed'].includes(status))throw Error('Choose whether to keep this idea.');store.update<AppIdea>('app-idea',idea.id,{status});emit();},
  async savedAppIdeaOpen({id,url}){const idea=store.get<AppIdea>('app-idea',id);if(!idea.sources.some(source=>source.url===url))throw Error('Choose a source of this idea.');await shell.openExternal(url);},
  async savedAppIdeasStart({app:appId,ids}){
    const entry=store.get<SavedApp>('saved-app',appId);
    if(!Array.isArray(ids)||!ids.length||ids.length>20)throw Error('Choose up to 20 updates.');
    const ideas=ids.map((id:unknown)=>store.get<AppIdea>('app-idea',String(id)));
    if(ideas.some((idea:AppIdea)=>idea.appId!==appId||idea.status!=='new'))throw Error('These updates changed. Review them again.');
    const chatId=await handlers.newChat({}),latest=store.get<SavedApp>('saved-app',appId),prompt=ideasPrompt(latest,ideas);
    store.transaction(()=>{store.update<Chat>('chat',chatId,{title:(entry.name+' · '+(ideas.length===1?ideas[0].title:ideas.length+' updates')).slice(0,80),draft:prompt});for(const idea of ideas)store.update<AppIdea>('app-idea',idea.id,{status:'started',chatId});saveApp(store,{id:appId,chatIds:[...latest.chatIds,chatId]});});emit();
    const chat=store.get<Chat>('chat',chatId),models=(chat.pool||[]).filter(model=>availableModels().includes(model));
    if(!models.length)return {chatId,warning:'Choose an available model to start this chat. The updates are ready in the message box.'};
    try{await submitTurn({id:randomUUID(),chatId,text:prompt,selected:false,models:models.length===1?models:[],goalRun:undefined});return {chatId};}
    catch(error){return {chatId,warning:backend.scrubber.text(String(error))};}
  },
  async savedAppRepositories({id}){
    const entry=store.get<SavedApp>('saved-app',id);
    return Promise.all((entry.repositories||[]).map(repositoryStatus));
  },
  savedAppRemove({id}){if(store.all<AppTodo>('app-todo').some(todo=>todo.appId===id&&startingAppTasks.has(todo.id)))throw Error('A to-do is starting. Try again in a moment.');appSummaryJobs.get(id)?.controller.abort();store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('app-summary',id);appWatchJobs.get(id)?.abort();removeApp(store,id);emit();}
};
