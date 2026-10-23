// chats handlers: moved out of app/main.ts unchanged (SPLIT-PLAN step 7); main.ts spreads them into handlers.
import {copyArtifact,readArtifactFile} from '../../artifacts';
import {saveAttachment} from '../../attachments';
import type {BackgroundProcess} from '../../background-work';
import {ContextDraft,contextSource,saveContext} from '../../chat-context';
import {captureExport,exportDefaults,exportInfo,writeChatExport} from '../../chat-export';
import {chatFiles,filePreview,findChatFile,readChatFile} from '../../chat-files';
import {resolveChatLink} from '../../chat-links';
import {previewCheckpoint} from '../../checkpoints';
import {newDocumentPath} from '../../documents';
import {linkIcon} from '../../link-icons';
import {backend,background,browserPreviews,chatExports,chatPreviews,chatWindows,claude,claudeAutomatic,commandTurns,contextJobs,coordination,data,documentPreviews,emit,goals,handlers,hermesTurns,inlinePreviews,jevControllers,jobWindows,managingChats,mcpToolRequests,native,pluginControllers,pluginsChanging,preparing,previews,remoteEpoch,requests,sideChatOpening,sidebar,store,terminals,uploading,win,workspaceDrafts,workspaceWindows} from '../../main';
import {modelEfforts,modelLabel} from '../../models';
import {workspaceTitle} from '../../pane-layout';
import {terminalJobStates} from '../../parallel';
import {previewable} from '../../preview-files';
import {questionResult} from '../../questions';
import {redactPastedKeys} from '../../redaction';
import {bindingDigest} from '../../remote-code';
import {SavedApp,saveApp} from '../../saved-apps';
import type {Approval,Chat,SideAnswer,ToolCall,Turn} from '../../types';
import {defaultFolder} from '../apps';
import {configure} from '../backend';
import {generateContext,goalHold,sideFirst,sideRow,submitTurn} from '../context';
import {wake} from '../dispatch';
import {availableModels,recordRoute,unavailableMessage,videoModel} from '../models';
import {changeProjectMode,projectFor,requireStableFolder,workingDirectory} from '../projects';
import {remoteBinding} from '../remote';
import {openPage,pageUrl} from '../sharing';
import {replyRow,stopDeadline} from '../turns';
import {dialog,nativeImage,shell} from 'electron';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const chatsHandlers:Record<string,(args:any)=>any>={
  sidebarSettings(args){const result=sidebar.settings(args);emit();return result;},
  contextSettings({chatId,autoCompact,rlm,wakeUps}){const chat=sidebar.root(chatId);for(const value of [autoCompact,rlm,wakeUps])if(value!==undefined&&typeof value!=='boolean')throw Error('Choose on or off.');store.update<Chat>('chat',chat.id,{...(autoCompact!==undefined?{autoCompact}:{}),...(rlm!==undefined?{rlm}:{}),...(wakeUps!==undefined?{wakeUps}:{})});emit();},
  contextInfo({chatId}){
    const chat=sidebar.root(chatId),job=contextJobs.get(chatId);let source:any;
    try{source=contextSource(store,chatId);}catch(error){return {current:chat.context||null,instructions:chat.contextInstructions||'',reason:(error as Error).message,progress:job?{done:job.done,total:job.total}:null};}
    return {current:chat.context||null,revision:source.revision,throughTurnId:source.throughTurnId,sourceCharacters:source.sourceCharacters,batches:source.batches.length,instructions:source.instructions,goal:source.goal,draft:store.all<ContextDraft>('context-draft').find(d=>d.id===chatId)||null,progress:job?{done:job.done,total:job.total}:null};
  },
  async contextGenerate({chatId,model}){
    requireStableFolder();const chat=sidebar.root(chatId),hold=goalHold(chatId);if(hold)throw Error(hold);
    if(managingChats.has(chatId)||chat.archived||goals.get(chatId)?.status==='active')throw Error('Pause the goal and finish chat changes before compacting.');
    if(!availableModels().includes(model))throw Error('Choose an available model for the summary.');
    return generateContext(chatId,model);
  },
  contextCancel({chatId}){sidebar.root(chatId);contextJobs.get(chatId)?.controller.abort();},
  async contextApply({chatId,revision,summary,instructions}){
    requireStableFolder();sidebar.root(chatId);const hold=goalHold(chatId);if(hold)throw Error(hold);
    if(typeof summary!=='string'||typeof instructions!=='string')throw Error('Enter a summary and standing instructions as text.');
    if(managingChats.has(chatId)||goals.get(chatId)?.status==='active')throw Error('Pause the goal and finish chat changes before compacting.');
    managingChats.add(chatId);try{for(const owner of sidebar.owned(chatId))await native.closeChat(owner.id);return saveContext(store,chatId,revision,redactPastedKeys(backend.scrubber.text(summary)),redactPastedKeys(backend.scrubber.text(instructions)));}finally{managingChats.delete(chatId);emit();}
  },
  async contextReset({chatId}){
    requireStableFolder();sidebar.root(chatId);const hold=goalHold(chatId);if(hold)throw Error(hold);
    if(managingChats.has(chatId)||goals.get(chatId)?.status==='active')throw Error('Pause the goal and finish chat changes before restoring full context.');
    managingChats.add(chatId);try{
      for(const owner of sidebar.owned(chatId))await native.closeChat(owner.id);
      store.transaction(()=>{const chat=store.get<Chat>('chat',chatId);if(chat.context)store.put('context-history',{...chat.context,chatId});store.update<Chat>('chat',chatId,{context:undefined,runtimeId:null,storedId:null});for(const engine of ['claude','hermes'] as const)store.put('engine',{...store.enginePosition(chatId,engine),sessionId:null,uncertain:true});});
    }finally{managingChats.delete(chatId);emit();}
  },
  checkpointPreview({chatId,turnId}){requireStableFolder();const chat=sidebar.root(chatId);return previewCheckpoint(store,chatId,turnId,workingDirectory(projectFor(chat)));},
  async branchMessage({chatId,turnId}){
    const turn=store.get<Turn>('turn',turnId);
    if(turn.chatId!==chatId)throw Error('This message belongs to another chat.');
    const id=await handlers.sidebarChat({action:'fork',chatId,beforeTurnId:turnId});
    for(const entry of store.all<SavedApp>('saved-app'))if(entry.chatIds.includes(chatId))saveApp(store,{id:entry.id,chatIds:[...entry.chatIds,id]});
    emit();win.webContents.send('select-chat',id);
    if(!process.argv.includes('--hidden')){win.show();win.focus();}
    return id;
  },
  sidebarGroup({action,...args}){if(args.name!==undefined)args.name=redactPastedKeys(backend.scrubber.text(args.name));const result=sidebar.group(action,args);emit();return result;},
  async sidebarChat({action,...args}){
    requireStableFolder();
    const chat=sidebar.root(args.chatId);if(args.name!==undefined)args.name=redactPastedKeys(backend.scrubber.text(args.name));
    if(action==='delete'&&store.all<Chat>('chat').some(row=>row.sideSourceId===chat.id&&!row.parentChatId))throw Error('Keep or discard this thread’s side chat before deleting the thread.');
    if(['delete','fork','archive'].includes(action)&&!(action==='archive'&&args.archived===false)){
      if(managingChats.has(chat.id))throw Error('This chat is already changing.');
      const hold=goalHold(chat.id);if(hold)throw Error(hold);
      if(goals.get(chat.id)?.status==='active')throw Error('Pause this chat’s goal first.');
      if(sidebar.owned(chat.id).some(c=>uploading.has(c.id)||terminals.has(c.id)))throw Error('Finish attaching files and close this chat’s terminals first.');
      if(action==='delete'&&workspaceDrafts.has(win.webContents.id))throw Error('Save or discard workspace edits before deleting chats.');
      const workspace=[...workspaceWindows.values()].filter(entry=>entry.info.chatId===chat.id);if(action==='delete'&&workspace.some(entry=>workspaceDrafts.has(entry.window.webContents.id)))throw Error('Save or discard workspace edits before deleting this chat.');
      const editor=chatWindows.get(chat.id);if(action==='delete'&&editor&&workspaceDrafts.has(editor.webContents.id))throw Error('Save or discard the file draft before deleting this chat.');
      managingChats.add(chat.id);
      try{
        if(action==='delete'){
          const owners=sidebar.owned(chat.id);for(const owner of owners){await native.closeChat(owner.id);if(chat.sideSourceId){if(owner.runtimeId){await backend.rpc.request('session.close',{profile:projectFor(owner).profile,session_id:owner.runtimeId});store.update<Chat>('chat',owner.id,{runtimeId:null});}if(owner.storedId){try{await backend.rpc.request('session.delete',{profile:projectFor(owner).profile,session_id:owner.storedId});}catch(error){if((error as any).code!==4007)throw error;}}}previews.close(owner.id,true);browserPreviews.close(owner.id);chatPreviews.get(owner.id)?.close(owner.id,true);for(const [key,view] of jobWindows)if(key===owner.id||key.startsWith('agent:')&&store.all<Turn>('turn').some(turn=>turn.id===key.slice(6)&&turn.chatId===owner.id))if(!view.isDestroyed())view.close();}
          for(const entry of workspace)entry.window.close();
          const popped=chatWindows.get(chat.id);if(popped&&!popped.isDestroyed())popped.close();
          // A worktree chat's folder is kept; the window offers to remove it.
          const worktree=projectFor(chat).worktree;sidebar.delete(chat.id);
          const blobs=new Set(store.all<{blob?:string}>('checkpoint-file').map(row=>row.blob));for(const row of store.all<{id:string}>('checkpoint-blob'))if(!blobs.has(row.id))store.remove('checkpoint-blob',row.id);
          emit();return worktree&&!store.all<Chat>('chat').some(row=>projectFor(row).worktree===worktree)?{worktree}:undefined;
        }
        const result=action==='fork'?sidebar.fork(chat.id,{beforeTurnId:args.beforeTurnId}):sidebar.chat(action,args);emit();return result;
      }finally{managingChats.delete(chat.id);}
    }
    const result=sidebar.chat(action,args);emit();return result;
  },
  goalSet({chatId,objective,tokenBudget=null}){if(managingChats.has(chatId)||sidebar.root(chatId).archived)throw Error('Restore this chat before starting a goal.');if(typeof objective!=='string'||backend.scrubber.text(objective)!==objective||redactPastedKeys(objective)!==objective)throw Error('Enter a goal without credentials.');return goals.set(chatId,objective,tokenBudget);},
  async goalPause({chatId}){goals.pause(chatId);await handlers.stop({chatId,reason:'goal-pause'});emit();},
  goalResume({chatId,tokenBudget=null,objective}){if(managingChats.has(chatId)||sidebar.root(chatId).archived)throw Error('Restore this chat before resuming a goal.');if(objective!==undefined&&(typeof objective!=='string'||backend.scrubber.text(objective)!==objective||redactPastedKeys(objective)!==objective))throw Error('Enter a goal without credentials.');goals.resume(chatId,tokenBudget,objective);emit();},
  goalClear({chatId}){if(goalHold(chatId))throw Error('Wait for current work to finish before clearing the goal.');goals.clear(chatId);},
  async exportChat({chatId,action='preview',options=exportDefaults,requestId}){
    store.get<Chat>('chat',chatId);
    if(action==='cancel'){const job=chatExports.get(requestId);if(job&&job.chatId===chatId)job.controller.abort();return {cancelled:true};}
    const record=captureExport(store,chatId,options,text=>redactPastedKeys(backend.scrubber.text(text)));
    if(action==='preview')return exportInfo(record);
    if(action!=='save'||typeof requestId!=='string'||!/^[a-f0-9-]{36}$/.test(requestId)||chatExports.has(requestId))throw Error('Invalid export request.');
    const controller=new AbortController();chatExports.set(requestId,{chatId,controller});
    try{
      const choice=await dialog.showSaveDialog(chatWindows.get(chatId)||win,{title:'Export chat',defaultPath:record.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'-').slice(0,100)+'.zip',filters:[{name:'Chat archive',extensions:['zip']}]});
      if(choice.canceled||!choice.filePath||controller.signal.aborted)return {cancelled:true};
      return await writeChatExport(backend,record,choice.filePath,controller.signal);
    }finally{chatExports.delete(requestId);}
  },
  async chatFiles({chatId,action='list',id,requestId,member,destination:chosenDestination}){
    if(action==='list')return chatFiles(store,chatId).map(({blob,...row})=>row);
    const row=findChatFile(store,chatId,id);
    if(action==='cancelPreview'){const job=documentPreviews.get(requestId);if(job&&job.chatId===chatId)job.controller.abort();return {cancelled:true};}
    if(action==='thumbnail'){
      const bytes=await readChatFile(data,row),image=nativeImage.createFromBuffer(bytes);
      if(image.isEmpty())throw Error('Image preview unavailable.');
      const {width,height}=image.getSize(),scale=Math.min(1,192/width,144/height);
      return {url:image.resize({width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))}).toDataURL()};
    }
    if(action==='read'){
      if(requestId!==undefined&&(typeof requestId!=='string'||!/^[a-f0-9-]{36}$/.test(requestId)||documentPreviews.has(requestId)))throw Error('Invalid preview request.');
      const controller=new AbortController();if(requestId)documentPreviews.set(requestId,{chatId,controller});
      try{
        const bytes=member!==undefined&&row.artifact?await readArtifactFile(data,row,member):await readChatFile(data,row),preview=filePreview(member||row.name,bytes);controller.signal.throwIfAborted();
        if(/\.(docx|xlsx|pptx)$/i.test(row.name))return await backend.host('document_preview',{file:path.join(data,row.kind==='upload'?'attachments':'outputs',row.blob,'source'),name:row.name,output:row.kind==='output'},controller.signal);
        if(preview.kind==='pdf'){const value=await backend.host('attachment_prepare',{file:path.join(data,row.kind==='upload'?'attachments':'outputs',row.blob,'source'),name:row.name,output:row.kind==='output',strict:true},controller.signal);return {...preview,pages:value.parts.filter((p:any)=>p.type==='image_url').map((p:any)=>p.image_url.url)};}
        return preview;
      }finally{if(requestId)documentPreviews.delete(requestId);}
    }
    if(action==='browser'){await browserPreviews.open(chatId,{chatFileId:row.id});return {opened:true};}
    if(action==='preview'){
      if(!row.artifact&&!previewable(row.name))throw Error('This file has no rendered preview.');const chat=store.get<Chat>('chat',chatId),ownerId=chat.parentChatId||chatId,popped=workspaceWindows.get('preview');if(popped&&popped.info.chatId!==ownerId)throw Error('Preview is open for another chat. Return that window first.');
      const owner=popped?.window||chatWindows.get(ownerId)||win;owner.webContents.send('open-file',{id:randomUUID(),chatId:ownerId,chatFileId:row.id,root:defaultFolder()||'',path:row.name,directory:false});return {opened:true};
    }
    if(action==='editArtifact'){
      requireStableFolder();const root=defaultFolder();if(!root)throw Error('Choose a working folder in Settings.');const destination=await newDocumentPath(root,data,chosenDestination);await readChatFile(data,row);const value=await copyArtifact(data,row,destination,new AbortController().signal),chat=store.get<Chat>('chat',chatId),ownerId=chat.parentChatId||chatId,popped=workspaceWindows.get('files');
      if(popped&&popped.info.chatId!==ownerId)return {...value,opened:false};const owner=popped?.window||chatWindows.get(ownerId)||win;owner.webContents.send('open-file',{id:randomUUID(),chatId:ownerId,root,path:path.relative(root,value.entry),directory:false,refresh:true});return {...value,opened:true};
    }
    if(action!=='download')throw Error('Unknown file action.');
    const choice=await dialog.showSaveDialog(chatWindows.get(chatId)||win,{title:'Save a copy',defaultPath:row.name});if(choice.canceled||!choice.filePath)return {cancelled:true};
    const destination=path.join(await fs.realpath(path.dirname(choice.filePath)),path.basename(choice.filePath)),relative=path.relative(data,destination);if(!relative||!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep))throw Error('Choose a location outside Ghidorah’s private data folder.');
    const bytes=await readChatFile(data,row),temp=destination+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temp,bytes,{flag:'wx'});await fs.rename(temp,destination);}finally{await fs.unlink(temp).catch(()=>{});}return {saved:true};
  },
  // The whole result of one action row; pushed states carry it cut (windowTools).
  toolResult({turnId,id}){const tool=store.get<ToolCall>('tool',id);if(tool.turnId!==turnId)throw Error('This result belongs to another message.');return tool.result;},
  async chatLink({turnId,href,icon=false,inline=false,external=false}){
    const sourceTurn=store.get<Turn>('turn',turnId);
    if(inline==='close'){inlinePreviews.close(sourceTurn.id,href);return;}
    if(inline===true)return inlinePreviews.open(sourceTurn,workingDirectory(projectFor(store.get<Chat>('chat',sourceTurn.chatId))),href);
    if(icon===true)return {icon:await linkIcon(href)};
    if(typeof href==='string'&&/^tris-output:[a-f0-9-]{36}$/.test(href)){const chatId=sourceTurn.chatId,row=findChatFile(store,chatId,'output:'+href.slice(12));if(external===true)return browserPreviews.open(chatId,{chatFileId:row.id});return {chatFile:{chatId,id:row.id}};}
    if(typeof href==='string'&&href.startsWith('tris-chat:')){
      const match=/^tris-chat:([a-f0-9-]{36})(?:#([\w-]{10,80}))?$/.exec(href);if(!match)throw Error('Invalid chat reference.');
      const target=sidebar.root(match[1]);if(target.sideSourceId)throw Error('Keep this side chat before linking it.');let focus=match[2];
      if(focus){focus=target.historyAliases?.[focus]||focus;const message=store.get<Turn>('turn',focus),owner=store.get<Chat>('chat',message.chatId);if((owner.parentChatId||owner.id)!==target.id)throw Error('This message belongs to another chat.');if(message.contextSnapshot)return {savedMessage:backend.scrubber.value({title:target.title,turn:message,tools:store.all<ToolCall>('tool').filter(tool=>tool.turnId===message.id)})};if(message.parentTurnId)focus=message.parentTurnId;}
      const window=chatWindows.get(target.id)||win;window.webContents.send('select-chat',target.id,focus);if(!process.argv.includes('--hidden')){window.show();window.focus();}return;
    }
    const target=resolveChatLink(defaultFolder(),href,[data]);
    if(target.kind==='web'){if(pageUrl(target.url)){const chat=store.get<Chat>('chat',sourceTurn.chatId);openPage(chat.parentChatId||chat.id,target.url);return;}await shell.openExternal(target.url);return;}
    if(external===true){if(target.directory)throw Error('Choose a previewable file.');return browserPreviews.open(sourceTurn.chatId,{file:path.join(target.root,target.path)});}
    const chat=store.get<Chat>('chat',store.get<Turn>('turn',turnId).chatId),chatId=chat.parentChatId||chat.id,view=!target.directory&&previewable(target.path)?'preview':'files',popped=workspaceWindows.get(view);
    if(popped){if(popped.info.chatId!==chatId)throw Error(workspaceTitle(view)+' is open for another chat. Return that window before opening this link.');popped.window.show();popped.window.focus();popped.window.webContents.send('open-file',{...target,chatId,root:defaultFolder(),id:randomUUID()});return;}
    const owner=chatWindows.get(chatId)||win;
    owner.show();owner.focus();owner.webContents.send('open-file',{...target,chatId:chat.parentChatId||chat.id,root:defaultFolder(),id:randomUUID()});
  },
  inspectWork({id,note}){coordination.inspect(id,backend.scrubber.text(note));emit();},
  async backgroundStop({id}){if(store.get<BackgroundProcess>('background',id).engine==='claude')await native.stop(id);else await background.stop(id);},
  async backgroundRefresh(){await background.refresh();},
  answer({id,answers}){
    const a=store.get<Approval>('approval',id);if(a.status!=='pending')throw Error('This question is no longer waiting for an answer.');
    if(!['clarify','clarify.request'].includes(a.method))throw Error('Invalid answer');
    const req=requests.get(id);if(!req)throw Error('Question expired.');
    const result=questionResult(a.params,answers);
    store.update<Approval>('approval',id,{status:'answered'});requests.delete(id);req.respond(result);
    store.update<Turn>('turn',a.turnId,{status:'running'});emit();
  },
  async sideChatOpen({chatId}){
    requireStableFolder();
    const source=sidebar.root(chatId);if(source.sideSourceId)return source.id;
    if(sideChatOpening.has(chatId))return sideChatOpening.get(chatId);
    const existing=store.all<Chat>('chat').find(chat=>chat.sideSourceId===chatId&&!chat.parentChatId);if(existing)return existing.id;
    const id=sidebar.fork(chatId,{sideChat:true}),side=store.get<Chat>('chat',id);
    const opening=configure(projectFor(side)).then(()=>{emit();return id;}).catch(error=>{sidebar.delete(id);store.db.prepare("DELETE FROM records WHERE kind='project' AND id=?").run(side.projectId);throw error;}).finally(()=>sideChatOpening.delete(chatId));sideChatOpening.set(chatId,opening);return opening;
  },
  sideChatKeep({chatId}){if(managingChats.has(chatId))throw Error('This side chat is closing.');const chat=sidebar.root(chatId);if(!chat.sideSourceId)throw Error('This is not a side chat.');store.update<Chat>('chat',chatId,{sideSourceId:undefined});emit();return chatId;},
  async sideChatDiscard({chatId}){
    const chat=sidebar.root(chatId);if(!chat.sideSourceId)throw Error('This is not a side chat.');
    await handlers.sidebarChat({action:'delete',chatId});store.db.prepare("DELETE FROM records WHERE kind='project' AND id=?").run(chat.projectId);
  },
  async newChat(){return handlers.addProject({});},
  draft({chatId,text}){if(typeof text!=='string')throw Error('Invalid draft');store.update<Chat>('chat',chatId,{draft:redactPastedKeys(backend.scrubber.text(text))});},
  selectorModel({chatId,model}){const c=store.get<Chat>('chat',chatId);if(model!==null&&(!(c.pool||[]).includes(model)||!availableModels().includes(model)))throw Error('Add an available model to this chat first.');store.update<Chat>('chat',chatId,{selector:model});emit();},
  modelLock({chatId,model}){const c=store.get<Chat>('chat',chatId);if(model!==null&&!(c.pool||[]).includes(model))throw Error('Add this model to the chat first.');const locked=model===null||c.lockedModel===model?null:model;store.update<Chat>('chat',chatId,{lockedModel:locked});store.put('model-lock',{id:randomUUID(),chatId,model:locked,created:Date.now()});emit();},
  modelSelection({chatId,selected,model='deepseek-flash'}){if(typeof selected!=='boolean')throw Error('Invalid model selection');const c=store.get<Chat>('chat',chatId);if(selected&&!availableModels().includes(model))throw Error(unavailableMessage(model));const picks=c.selectedModels||(c.selected?['deepseek-flash']:[]);const next=selected?[...new Set([...picks,model])]:picks.filter(m=>m!==model);store.transaction(()=>{store.update<Chat>('chat',chatId,{selectedModels:next,selected:next.includes('deepseek-flash')});store.put('model-choice',{id:randomUUID(),chatId,model,selected,created:Date.now()});});emit();},
  mode({projectId,mode}){requireStableFolder();return changeProjectMode(projectId,mode);},
  effort({chatId,effort,model='deepseek-flash'}){const allowed=claude.models?.find(item=>item.id===model)?.efforts||Object.keys(modelEfforts(model));if(!allowed.includes(effort))throw Error('Unsupported effort');const c=store.get<Chat>('chat',chatId);store.update<Chat>('chat',chatId,{...(model==='deepseek-flash'?{effort}:{}),efforts:{...c.efforts,[model]:effort}});emit();},
  group({projectId,name}){const title=String(name).trim(),group=title&&title!=='Ungrouped'?(sidebar.groups().find(g=>g.name===title)||sidebar.group('create',{name:title})):null;for(const chat of store.all<Chat>('chat'))if(chat.projectId===projectId&&!chat.parentChatId)sidebar.chat('move',{chatId:chat.id,groupId:group?.id||null});emit();},
  async attachmentAdd({chatId,name,bytes}){
    if(managingChats.has(chatId)||store.get<Chat>('chat',chatId).archived)throw Error('Restore this chat before attaching files.');if(uploading.has(chatId))throw Error('An attachment is still being prepared.');
    if((store.get<Chat>('chat',chatId).attachments||[]).length>=10)throw Error('Attach up to 10 files per message.');
    uploading.add(chatId);
    try{const item=await saveAttachment(path.join(data,'attachments'),chatId,name,bytes,async file=>{const prepared=await backend.host('attachment_prepare',{file,name});if(prepared.kind==='video'&&!videoModel(store.get<Chat>('chat',chatId)))throw Error('Videos go to Gemini. Connect Gemini in Connections to send this video.');return prepared;},text=>{if(backend.scrubber.text(text)!==text||redactPastedKeys(text)!==text)throw Error('This file contains a credential. Remove it before attaching.');});
      const chat=store.get<Chat>('chat',chatId),gemini=item.kind==='video'?videoModel(chat):null;store.update<Chat>('chat',chatId,{attachments:[...(chat.attachments||[]),item]});if(gemini)handlers.addModel({chatId,model:gemini});emit();return item;
    }finally{uploading.delete(chatId);}
  },
  attachmentRemove({chatId,id}){const chat=store.get<Chat>('chat',chatId);store.update<Chat>('chat',chatId,{attachments:(chat.attachments||[]).filter(a=>a.id!==id)});emit();},
  async submit(args){return await sideFirst(args)??submitTurn(args);},
  // "Tell the main model": his question and the side answer go to the main model as a correction (Stop and send).
  async sideAnswerTell({id,chatId}){
    const row=sideRow(id,chatId);if(row.status!=='done'||row.sent)throw Error('This side answer cannot be sent.');
    const sent=await handlers.correctGroup({id:randomUUID(),chatId,text:row.question+'\n\n(A side answer from '+modelLabel(row.model,claude.models)+', read from the live state while you worked: '+row.text+')'});
    store.update<SideAnswer>('side-answer',id,{sent:'told',closed:true});emit();return sent;
  },
  // "Ask the main model instead": his question is queued for the main model as a normal message.
  async sideAnswerAsk({id,chatId}){
    const row=sideRow(id,chatId);if(row.sent)throw Error('This question was already sent.');
    const sent=await submitTurn({id:randomUUID(),chatId,text:row.question});
    store.update<SideAnswer>('side-answer',id,{sent:'asked',closed:true});emit();return sent;
  },
  sideAnswerClose({id,chatId}){sideRow(id,chatId);store.update<SideAnswer>('side-answer',id,{closed:true});emit();},
  sideAnswerModel({model}){if(typeof model!=='string'||!availableModels().includes(model))throw Error('Choose an available model for side answers.');store.put('settings',{id:'side-answers',model});emit();},
  sendPaused({id}){const turn=store.get<Turn>('turn',id);if(turn.status!=='queued'||!turn.paused)throw Error('This message is not paused.');store.update<Turn>('turn',id,{paused:false});emit();wake(turn.chatId);},
  async cancelQueued({id}){const turn=store.get<Turn>('turn',id);if(turn.automatic)throw Error('This message is already being sent.');
    if(turn.status==='running'&&turn.delivery){if(!await native.withdraw(turn.chatId,id))throw Error('Claude has already started on this message.');}
    else if(turn.status!=='queued'||preparing.get(turn.chatId)?.turnId===id)throw Error('This message is already being sent.');
    store.transaction(()=>{if(turn.parentTurnId){const parent=store.get<Turn>('turn',turn.parentTurnId);store.update<Turn>('turn',parent.id,{jobs:parent.jobs!.filter(job=>job!==id)});}goals.forget(turn);store.put('turn-removed',{id,chatId:turn.chatId,cancelled:true});store.remove('turn',id);});emit();},
  chooseTurnModel({id,model,replace}){
    const turn=store.get<Turn>('turn',id),chat=store.get<Chat>('chat',turn.chatId),owner=chat.parentChatId?store.get<Chat>('chat',chat.parentChatId):chat;
    if(turn.status!=='needs-model'||preparing.get(chat.id)?.turnId===id||pluginsChanging)throw Error('This message is no longer waiting for a model.');
    if(model!==null&&(!availableModels().includes(model)||!(owner.pool||['deepseek-flash']).includes(model)))throw Error('Choose an available model in this chat.');
    const models=turn.models?.length?turn.models:[turn.model];
    if(model!==null&&models.length>1&&(!models.includes(replace)||models.some(item=>item!==replace&&item===model)))throw Error('Choose the selection to replace with a distinct model.');
    const next=models.map(item=>item===(replace||turn.model)?model:item);
    store.transaction(()=>{
      store.update<Turn>('turn',id,model===null?{status:'stopped',error:'Message skipped before dispatch.'}:{model:next[0],models:next.length>1?next:undefined,routePending:false,effort:turn.efforts?.[next[0]]||owner.efforts?.[next[0]]||'high',status:'queued',error:null});
      if(chat.parentChatId&&model!==null)store.update<Chat>('chat',chat.id,{pool:[model],model});
      recordRoute(id,{model,previous:replace||turn.model,reason:model===null?'skipped':'replacement'});
    });
    wake(chat.id);emit();
  },
  async stop({chatId,turnId,reason='user-stop'}){
    if(!['user-stop','superseded-by-message','goal-pause'].includes(reason))throw Error('Invalid stop reason.');
    const owner=store.get<Chat>('chat',chatId);goals.pause(owner.parentChatId||chatId,'Stopped by you');
    if(turnId){const group=store.get<Turn>('turn',turnId);if(group.chatId!==chatId||!group.jobs?.length)throw Error('This group belongs to another chat.');}
    // Stop's target is the reply that is running, never a waiting message: those keep their place and go out after
    // it, as in Claude Code, and each keeps its own remove button (TURN-REVIEW part 5).
    const c=store.get<Chat>('chat',chatId),id=turnId||replyRow(chatId);if(!id){await Promise.all([background.stopChat(c),native.stopChat(chatId)]);return;}
    const turn=store.get<Turn>('turn',id);store.update<Turn>('turn',id,{stopReason:turn.stopReason||reason});
    if(turn.jobs?.length){store.update<Turn>('turn',id,{status:'stopping'});await Promise.all([...new Set(turn.jobs.map(job=>store.get<Turn>('turn',job).chatId))].map(chatId=>handlers.stop({chatId,reason})));emit();return;}
    if(['completed','failed','stopped','interrupted','partial'].includes(turn.status)){emit();return;}
    store.update<Turn>('turn',id,{status:'stopping'});
    if(preparing.get(chatId)?.turnId===id)preparing.get(chatId)!.controller.abort();
    contextJobs.get(chatId)?.controller.abort();
    pluginControllers.get(chatId)?.abort();jevControllers.get(chatId)?.abort();
    for(const pending of mcpToolRequests.values())if(pending.chatId===chatId)pending.controller.abort();
    for(const a of store.all<Approval>('approval'))if(a.turnId===id&&a.status==='pending'){
      if(a.method!=='clarify')coordination.denied(a.turnId,a.params.description,a.params.command);
      requests.get(a.id)?.respond(a.method==='clarify'?{}:{choice:'deny'});requests.delete(a.id);store.update<Approval>('approval',a.id,{status:'expired'});
    }
    // A plugin command or a routing pick ends with its own controller; its process owner stops its jobs itself.
    emit();if(pluginControllers.has(chatId)||jevControllers.has(chatId))return;
    // Claude: interrupt (8 s, then the process closes). Hermes: session.interrupt (20 s, then the session is dropped).
    if(native.replyRow(chatId)===id)await native.interrupt(chatId);
    else if(hermesTurns.get(chatId)===id&&c.runtimeId){const sid=c.runtimeId;setTimeout(()=>stopDeadline(chatId,id,sid),20000).unref();await backend.rpc.request('session.interrupt',{session_id:sid,profile:projectFor(c).profile});}
    await Promise.all([background.stopChat(c,id),native.stopChat(chatId,id)]);
  },
  openParent({chatId,turnId}){const turn=typeof turnId==='string'?store.get<Turn>('turn',turnId):null,chat=store.get<Chat>('chat',turn?.chatId||chatId);if(!chat.parentChatId&&turn?.automatic?.kind!=='agent')throw Error('Not a side job.');const id=chat.parentChatId||chat.id,owner=chatWindows.get(id)||win;owner.show();owner.focus();if(owner===win)win.webContents.send('select-chat',id);},
  async correctGroup({id,chatId,text}){
    if(store.all<Turn>('turn').some(turn=>turn.id===id)||store.all<any>('turn-removed').some(row=>row.id===id))return submitTurn({id,chatId,text});
    if(typeof text==='string'&&/^\/compact(?:\s|$)/i.test(text.trim()))return submitTurn({id,chatId,text});
    const current=replyRow(chatId);if(!current)return submitTurn({id,chatId,text});
    const turn=store.get<Turn>('turn',current),chat=store.get<Chat>('chat',chatId);
    const models=chat.selectedModels?.length?chat.selectedModels:turn.command||turn.routePending?undefined:turn.jobs?[...new Set(turn.jobs.map(id=>store.get<Turn>('turn',id)).filter(job=>!terminalJobStates.has(job.status)).map(job=>job.model))]:[turn.model];
    await submitTurn({id,chatId,text,models});if(replyRow(chatId)===current)await handlers.stop({chatId,reason:'superseded-by-message'});return id;
  },
  async correctJob({id,chatId,text,queue=false}){
    const chat=store.get<Chat>('chat',chatId);
    const removed=store.all<any>('turn-removed').find(row=>row.id===id);if(removed){if(removed.chatId!==chatId)throw Error('Message ID was already used.');return id;}
    if(!chat.parentChatId||!chat.groupTurnId)throw Error('Not a side job.');
    const previous=store.all<Turn>('turn').find(turn=>turn.id===id);if(previous){if(previous.chatId!==chatId||previous.prompt!==text)throw Error('Message ID was already used.');return id;}
    if(commandTurns.get(chat.parentChatId)!==chat.groupTurnId)throw Error('This group has finished. Continue in the main chat.');
    if(typeof text!=='string'||!text.trim()||! /^[\w-]{10,80}$/.test(id)||backend.scrubber.text(text)!==text||redactPastedKeys(text)!==text)throw Error('Enter a correction without credentials.');
    const current=store.all<Turn>('turn').filter(turn=>turn.chatId===chatId).at(-1)!;
    // Every accepted follow-up stays ordered behind the current run.
    store.transaction(()=>{store.accept(id,chatId,text,current.model);store.update<Turn>('turn',id,{parentTurnId:chat.groupTurnId,remote:current.remote,routine:current.routine,voice:current.voice});const parent=store.get<Turn>('turn',chat.groupTurnId!);store.update<Turn>('turn',parent.id,{jobs:[...parent.jobs!,id]});});
    // The accepted correction is durable. Its engine receives it only after the
    // old run has acknowledged Stop and released its process/tool ownership.
    const currentId=replyRow(chatId);
    if(!queue&&currentId){
      // Stop the current run without cancelling the correction just accepted.
      store.update<Turn>('turn',currentId,{status:'stopping',stopReason:'superseded-by-message'});
      if(preparing.get(chatId)?.turnId===currentId)preparing.get(chatId)!.controller.abort();contextJobs.get(chatId)?.controller.abort();jevControllers.get(chatId)?.abort();
      for(const pending of mcpToolRequests.values())if(pending.chatId===chatId)pending.controller.abort();
      for(const a of store.all<Approval>('approval'))if(a.turnId===currentId&&a.status==='pending'){if(a.method!=='clarify')coordination.denied(a.turnId,a.params.description,a.params.command);requests.get(a.id)?.respond(a.method==='clarify'?{}:{choice:'deny'});requests.delete(a.id);store.update<Approval>('approval',a.id,{status:'expired'});}
      if(native.replyRow(chatId)===currentId)await native.interrupt(chatId);else if(hermesTurns.get(chatId)===currentId&&chat.runtimeId)await backend.rpc.request('session.interrupt',{session_id:chat.runtimeId,profile:projectFor(chat).profile});
    }else if(!queue&&current.automatic?.kind==='agent'){for(const item of claudeAutomatic.values())if(item.chatId===chatId)item.controller.abort();await native.stopChat(chatId);}
    wake(chatId);emit();return id;
  },
  async approve({id,choice,expectedRemote}){if(!['once','deny','always'].includes(choice))throw Error('Invalid approval');const a=store.get<Approval>('approval',id);if(choice==='always'&&!a.params?.screenApp)throw Error('Invalid approval');if(a.status!=='pending')return;const req=requests.get(id);if(!req){store.update<Approval>('approval',id,{status:'expired'});emit();throw Error('Approval expired. Send a message to request it again.');}let refusal;try{if(choice!=='deny')await coordination.checkApproval(a.turnId,a.params.description,a.params.command,()=>{store.update<Approval>('approval',id,{waiting:'Allowed. Waiting for a related command to finish first.'});emit();});}catch(error){choice='deny';refusal=error;}const currentApproval=store.get<Approval>('approval',id);if(currentApproval.status!=='pending')return;if(expectedRemote&&(expectedRemote.epoch!==remoteEpoch||expectedRemote.digest!==bindingDigest(remoteBinding(currentApproval))))throw Error('Remote approval changed before dispatch.');store.update<Approval>('approval',id,{status:choice==='deny'?'denied':'approved'});if(choice==='deny')coordination.denied(a.turnId,a.params.description,a.params.command);requests.delete(id);req.respond({choice});store.update<Turn>('turn',a.turnId,{status:'running'});emit();if(refusal)throw refusal;}
};
