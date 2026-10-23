// projects: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import {hasWork} from './turns';
import {existingAppPath} from '../app-repositories';
import {backend,checkpointChanging,coordination,createAppLocks,creatingProjects,data,emit,folderChanging,folderRecoveryRequired,gitOperation,modeChanges,native,pluginControllers,preparing,refreshAppLights,sideChatOpening,startingAppTasks,store,submittingChats,terminals,voiceWindow,workspaceDrafts,workspaceWindows} from '../main';
import {redactPastedKeys} from '../redaction';
import {AppTodo,SavedApp,appFolderName,appTodo,linkAppChat,saveApp,updateAppTodo} from '../saved-apps';
import type {Chat,Mode,Project,Turn} from '../types';
import {workspacePath} from '../workspace-files';
import {nativeImage} from 'electron';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function projectFor(chat:Chat){return store.get<Project>('project',chat.projectId);}
export function requireStableFolder(){if(gitOperation)throw Error('Wait for the Git operation to finish.');if(checkpointChanging)throw Error('Wait for file restoration to finish.');if(folderRecoveryRequired)throw Error('Restart the backend to restore the working folder configuration.');if(folderChanging)throw Error('Wait for the working folder change to finish.');}
export function requireIdleFolder(){
  if(voiceWindow)throw Error('Close voice before changing the working folder.');
  if(hasWork()||creatingProjects||submittingChats.size||preparing.size||sideChatOpening.size||store.all<Turn>('turn').some(turn=>['queued','dispatching','running','waiting','stopping'].includes(turn.status)))throw Error('Stop active work and wait for queued work before changing the working folder.');
  if(terminals.count)throw Error('Close open terminals before changing the working folder.');
  if(workspaceDrafts.size)throw Error('Save or discard workspace edits before changing the working folder.');
  if(workspaceWindows.size)throw Error('Return workspace windows before changing the working folder.');
}
export function workingDirectory(project:Project){
  if(project.worktree){
    if(!project.folder)throw Error('This worktree has no working folder.');
    const directory=workspacePath(project.folder,path.relative(workspacePath(project.folder),project.worktree));
    if(directory.toLowerCase()!==path.resolve(project.worktree).toLowerCase())throw Error('The worktree location changed. Restore its original folder before using this chat.');
    return directory;
  }
  return project.folder||path.join(data,'hermes','profiles',project.profile,'workspace');
}
// App tools use the desktop's store, just like the form. Existing repositories are registered in place.
export function listAppTasks(chat:Chat){const root=chat.parentChatId||chat.id;return store.all<SavedApp>('saved-app').map(({id,name,stage,current,repositories,chatIds})=>({id,name,stage,current,repositories:repositories||[],linked:chatIds.includes(root),todos:store.all<AppTodo>('app-todo').filter(todo=>todo.appId===id)}));}
export function addAppTask(chat:Chat,args:any){if(projectFor(chat).mode==='plan')throw Error('Plan mode permits inspection and proposals only.');const todo=store.transaction(()=>{const value=appTodo(store,{app:args?.app,title:redactPastedKeys(backend.scrubber.text(String(args?.title||'')))});linkAppChat(store,value!.appId,chat.id,true,'model');return value;});emit();return todo;}
 
export function updateAppTask(chat:Chat,args:any,turnId:string){
 let result;
 try{
  if(projectFor(chat).mode==='plan')throw Error('Plan mode permits inspection and proposals only.');
  if(startingAppTasks.has(args?.id))throw Error('This to-do is starting. Try again in a moment.');
  const input={...args};if(typeof input.title==='string')input.title=redactPastedKeys(backend.scrubber.text(input.title));
  result=store.transaction(()=>updateAppTodo(store,input));
 }catch(error){
  const name=store.get<Turn>('turn',turnId).model.startsWith('claude-code:')?'mcp__ghidorah__update_app_todo':'update_app_todo';
  coordination.denied(turnId,name+'\n'+JSON.stringify(args),undefined,'Task update failed without saved changes.');throw error;
 }
 emit();return result;
}
export function linkCurrentApp(chat:Chat,args:any){const app=linkAppChat(store,args?.app,chat.id,args?.linked,'model');emit();return {id:app.id,app:app.name,linked:app.chatIds.includes(chat.parentChatId||chat.id),userUnlinked:!!app.unlinkedChatIds?.includes(chat.parentChatId||chat.id)};}
export async function appIcon(base:string,iconPath:unknown){
 const file=await existingAppPath(base,iconPath,data),stat=await fs.stat(file);
 if(!stat.isFile()||stat.size>250*1024||! /\.(png|jpe?g|webp)$/i.test(file))throw Error('Use a PNG, JPEG or WebP icon up to 250 KB.');
 const bytes=await fs.readFile(file);if(bytes.length>250*1024||nativeImage.createFromBuffer(bytes).isEmpty())throw Error('Use a valid PNG, JPEG or WebP icon up to 250 KB.');
 return 'data:image/'+(/\.jpe?g$/i.test(file)?'jpeg':path.extname(file).slice(1).toLowerCase())+';base64,'+bytes.toString('base64');
}
export async function updateApp(chat:Chat,args:any,turnId:string){
 let app:SavedApp;
 try{
  const root=chat.parentChatId?store.get<Chat>('chat',chat.parentChatId):chat,project=projectFor(root),mode=project.mode,directory=workingDirectory(project);
  if(mode==='plan')throw Error('Plan mode permits inspection and proposals only.');
  if(!args||typeof args.id!=='string'||!args.id)throw Error('Choose an existing app ID from list_apps.');
  store.get<SavedApp>('saved-app',args.id);
  if(args.name===undefined&&args.icon_path===undefined)throw Error('Provide a name or icon_path.');
  const patch:Partial<SavedApp>={id:args.id};
  if(args.name!==undefined)patch.name=typeof args.name==='string'?redactPastedKeys(backend.scrubber.text(args.name)):args.name;
  if(args.icon_path!==undefined){
   if(!project.folder)throw Error('Choose a working folder in Settings first.');
   patch.icon=await appIcon(await fs.realpath(directory),args.icon_path);
  }
  const current=projectFor(root);
  if(current.mode!==mode||workingDirectory(current)!==directory)throw Error('The permission mode or working folder changed. Review the app request again.');
  app=saveApp(store,patch);
 }catch(error){
  const name=store.get<Turn>('turn',turnId).model.startsWith('claude-code:')?'mcp__ghidorah__update_app':'update_app';
  coordination.denied(turnId,name+'\n'+JSON.stringify(args),undefined,'App update failed without saved changes.');throw error;
 }
 emit();void refreshAppLights();return {id:app.id,app:app.name,icon:app.icon};
}
export async function createApp(chat:Chat,args:any,turnId:string){
  const key=typeof args?.name==='string'?args.name.trim().slice(0,80).toLowerCase():'';
  const root=chat.parentChatId?store.get<Chat>('chat',chat.parentChatId):chat,mode=projectFor(root).mode;
  const previous=createAppLocks.get(key)||Promise.resolve();
  let effectsStarted=false;
  const operation=previous.catch(()=>{}).then(()=>createAppRecord(chat,args,mode,()=>{effectsStarted=true;}));createAppLocks.set(key,operation);
  try{return await operation;}catch(error){
    if(!effectsStarted){
      const name=store.get<Turn>('turn',turnId).model.startsWith('claude-code:')?'mcp__ghidorah__create_app':'create_app';
      coordination.denied(turnId,name+'\n'+JSON.stringify(args),undefined,'App request refused before any files or saved apps changed: '+String(error));
    }
    throw error;
  }finally{if(createAppLocks.get(key)===operation)createAppLocks.delete(key);}
}
export async function createAppRecord(chat:Chat,args:any,expectedMode:Mode,startEffects:()=>void){
  const root=chat.parentChatId?store.get<Chat>('chat',chat.parentChatId):chat,project=projectFor(root);
  if(project.mode!==expectedMode)throw Error('The permission mode changed. Review the app request again.');
  if(project.mode==='plan')throw Error('Plan mode permits inspection and proposals only.');
  const name=typeof args?.name==='string'?args.name.trim().slice(0,80):'';
  if(!name)throw Error('Enter an app name.');
  if(args?.register_only!==undefined&&typeof args.register_only!=='boolean')throw Error('Choose whether to register the app without creating a folder.');
  for(const [key,max] of [['stage',40],['description',2000]] as const)if(args?.[key]!==undefined&&(typeof args[key]!=='string'||args[key].length>max))throw Error('Invalid app '+key+'.');
  const known=store.all<SavedApp>('saved-app').find(app=>app.name.toLowerCase()===name.toLowerCase());
  if(args?.register_only&&args.repositories===undefined&&args.icon_path===undefined){
    startEffects();
    const app=saveApp(store,{id:known?.id,name:known?.name||name,stage:args.stage??known?.stage??'',current:args.description??known?.current??'',chatIds:[...new Set([...(known?.chatIds||[]),root.id])]});
    emit();return {id:app.id,app:app.name,folder:app.repositories?.[0]||null,repositories:app.repositories,createdFolder:false,linkedChat:root.title};
  }
  if(!project.folder)throw Error('Choose a working folder in Settings first.');
  const folderName=appFolderName(name);
  if(!name||!folderName)throw Error('Give the app a name that works as a folder name.');
  const directory=workingDirectory(project),base=await fs.realpath(directory);
  const check=()=>{const current=projectFor(root);if(current.mode!==expectedMode||current.mode==='plan')throw Error('The permission mode changed. Review the app request again.');if(workingDirectory(current)!==directory)throw Error('The working folder changed. Review the app request again.');};
  check();
  const requested=args?.repositories??(known?.repositories?.length?known.repositories:undefined);
  if(requested!==undefined&&(!Array.isArray(requested)||!requested.length||requested.length>30||requested.some(value=>typeof value!=='string'||value.length>500)))throw Error('Choose 1 to 30 existing repository folders.');
  const repositories:string[]=[];
  for(const value of requested||[]){const directory=await existingAppPath(base,value,data);if(!(await fs.stat(directory)).isDirectory())throw Error('An app repository must be a folder.');if(!repositories.includes(directory))repositories.push(directory);}
  let icon=known?.icon||'';
  if(args?.icon_path!==undefined){
    icon=await appIcon(base,args.icon_path);
  }
  let createdFolder=false;
  if(!repositories.length&&!args?.register_only){
    const folder=path.join(base,folderName),existing=await fs.lstat(folder).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(existing&&!existing.isDirectory())throw Error('Something that is not a folder already uses that name in the working folder.');
    check();if(!existing){startEffects();await fs.mkdir(folder);createdFolder=true;}
    repositories.push(workspacePath(base,path.relative(base,folder)));
  }
  check();
  startEffects();
  const app=saveApp(store,{id:known?.id,name:known?.name||name,icon,stage:args?.stage??known?.stage??'Started',current:args?.description??known?.current??'',ideas:known?.ideas||'',planned:known?.planned||'',questions:known?.questions||'',chatIds:[...new Set([...(known?.chatIds||[]),root.id])],repositories:[...new Set([...(known?.repositories||[]),...repositories])]});
  emit();void refreshAppLights();return {id:app.id,app:app.name,folder:repositories[0]||null,repositories:app.repositories,createdFolder,linkedChat:root.title};
}
export async function writePolicy(project?:Project){
  const home=project?path.join(data,'hermes','profiles',project.profile):path.join(data,'hermes'),file=path.join(home,'trismegistus-policy.json'),temporary=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temporary,JSON.stringify({folder:project?.folder?workingDirectory(project):null,profile:project?.profile||'default',mode:project?.mode||'manual',secrets_root:data}));await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}
}
export async function changeProjectMode(projectId:string,requested:Mode,current?:()=>boolean){
  if(!['manual','accept-edits','plan','auto','bypass'].includes(requested))throw Error('Invalid mode');
  const pending=(modeChanges.get(projectId)||Promise.resolve()).catch(()=>{}).then(async()=>{
    const previous=store.get<Project>('project',projectId),chats=store.all<Chat>('chat').filter(chat=>chat.projectId===projectId),mode=current&&!current()?previous.mode:requested;
    if(chats.some(chat=>preparing.has(chat.id))){if(current)await native.setMode(chats.map(chat=>chat.id),previous.mode);throw Error('A message is starting. Try changing the mode again in a moment.');}
    if(previous.mode!==mode)for(const chat of chats)pluginControllers.get(chat.id)?.abort();
    await native.setMode(chats.map(chat=>chat.id),mode,async()=>{try{await writePolicy({...previous,mode});store.update<Project>('project',projectId,{mode});}catch(error){await writePolicy(previous);throw error;}});
  });modeChanges.set(projectId,pending);
  try{await pending;}finally{if(modeChanges.get(projectId)===pending)modeChanges.delete(projectId);emit();}
}