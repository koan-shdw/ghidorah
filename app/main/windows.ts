// windows: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import {chatActivity} from '../activity';
import {chatFiles,findChatFile} from '../chat-files';
import {SavedChatWindow,SavedJobWindow,SavedWorkspaceWindow,WorkspaceWindow,chatPreviews,chatWindows,claude,closingWindows,data,emit,handlers,hiddenMaximizedChats,jobWindows,previews,quitting,root,sidebar,store,win,workspaceDrafts,workspaceWindows,worktreeChanging} from '../main';
import {modelLabel} from '../models';
import {readTree,workspaceTitle,workspaceViews} from '../pane-layout';
import {removePane} from '../pane-tree';
import {Previews} from '../previews';
import type {Chat,ToolCall,Turn} from '../types';
import {WindowBounds,visibleWindowBounds} from '../window-layout';
import {readWorkspaceFile,workspacePath} from '../workspace-files';
import {defaultFolder} from './apps';
import {openChatLink,withOwner} from './sharing';
import {snapshot,toolsForChats} from './snapshot';
import {BrowserWindow,app,dialog,nativeImage,screen} from 'electron';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

export function chatSnapshot(chatId:string,state:ReturnType<typeof snapshot>=snapshot({tools:false})){
 const chats=sidebar.owned(chatId),owners=new Set(chats.map(c=>c.id)),turns=state.turns.filter(t=>owners.has(t.chatId)),ids=new Set(turns.map(t=>t.id));
 return {...state,savedApps:[],sidebar:undefined,chats,projects:state.projects.filter(p=>chats.some(c=>c.projectId===p.id)),turns,tools:store.whereIn<ToolCall>('tool','turnId',[...ids]),approvals:state.approvals.filter(a=>owners.has(a.chatId)),background:state.background.filter(row=>owners.has(row.chatId)),goals:state.goals.filter(goal=>goal.id===chatId),sideAnswers:state.sideAnswers.filter(row=>owners.has(row.chatId)),workReview:[]};
}
export function workspaceWindowState(entry:WorkspaceWindow,state:ReturnType<typeof snapshot>=snapshot({tools:false})){return {workspaceWindow:entry.info,...(['plan','tasks'].includes(entry.info.view)?{activity:chatActivity({...state,tools:toolsForChats(state,new Set([entry.info.chatId]))},entry.info.chatId)}:{}),defaultFolder:defaultFolder(),title:store.all<Chat>('chat').find(chat=>chat.id===entry.info.chatId)?.title||'Workspace'};}
export function saveWorkspaceWindows(){if(!quitting)store.put('settings',{id:'workspace-windows',windows:[...workspaceWindows.values()].filter(({window})=>!window.isDestroyed()&&!closingWindows.has(window)).map(({info,window})=>({...info,bounds:window.getNormalBounds(),maximized:window.isMaximized()||hiddenMaximizedChats.has(window)}))});}
export function openWorkspaceWindow(args:SavedWorkspaceWindow,hidden=false){
 if(!workspaceViews.includes(args?.view))throw Error('Choose a workspace view.');
 const chat=sidebar.root(args.chatId),existing=workspaceWindows.get(args.view);
 if(existing){if(existing.info.chatId!==chat.id)throw Error(workspaceTitle(args.view)+' is open for another chat. Return that window before opening this chat’s view.');existing.window.show();existing.window.focus();return;}
 if(worktreeChanging)throw Error('Wait for the working folder change to finish.');
 const directory=typeof args.directory==='string'?args.directory:'';if(defaultFolder())workspacePath(defaultFolder(),directory);else if(directory)throw Error('Choose the root working folder first.');
 if(args.view==='files'&&args.file!==undefined)readWorkspaceFile(defaultFolder(),args.file);
 if(args.view==='changes'&&args.diff){if(typeof args.diff.file!=='string'||typeof args.diff.staged!=='boolean')throw Error('Invalid diff selection.');workspacePath(defaultFolder(),path.join(directory,args.diff.file));}
 const rectangle=args.bounds,valid=rectangle&&['x','y','width','height'].every(key=>typeof rectangle[key as keyof WindowBounds]==='number'&&Number.isInteger(rectangle[key as keyof WindowBounds])&&Math.abs(rectangle[key as keyof WindowBounds])<=2147483647)&&rectangle.width>0&&rectangle.height>0;
 const bounds=visibleWindowBounds(rectangle,(valid?screen.getDisplayMatching(rectangle!):screen.getPrimaryDisplay()).workArea);
 const view=new BrowserWindow({...bounds,minWidth:450,minHeight:400,show:false,title:workspaceTitle(args.view)+' · '+chat.title,icon:nativeImage.createFromPath(path.join(app.getAppPath(),'assets/icon.png')),backgroundColor:'#141413',frame:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
 const info:SavedWorkspaceWindow={view:args.view,chatId:chat.id,root:defaultFolder(),directory,...(args.view==='files'&&args.file?{file:args.file}:{}),...(args.view==='changes'&&args.diff?{diff:{file:args.diff.file,staged:args.diff.staged}}:{})};
 const entry={info,window:view,preview:new Previews(view,store,defaultFolder,[data],path.join(root,'runtime/poppler/Library/bin'),data,withOwner,openChatLink)};workspaceWindows.set(info.view,entry);
 view.webContents.setWindowOpenHandler(()=>({action:'deny'}));view.webContents.on('will-navigate',event=>event.preventDefault());
 if(info.view==='preview')(chatPreviews.get(chat.id)||previews).move(chat.id,entry.preview);
 let checking=false,discard=false;const owner=view.webContents.id;
 view.on('close',event=>{if(!quitting&&!discard&&workspaceDrafts.has(owner)){event.preventDefault();if(!checking){checking=true;void dialog.showMessageBox(view,{type:'question',message:'This workspace has unsaved edits.',detail:'Close this window and discard them?',buttons:['Keep editing','Discard and close'],defaultId:0,cancelId:0}).then(result=>{checking=false;if(result.response===1){discard=true;view.close();}});}}if(!event.defaultPrevented){recordClosingWindow(view,saveWorkspaceWindows);if(!quitting&&info.view==='preview')entry.preview.move(chat.id,chatPreviews.get(chat.id)||previews);entry.preview.closeAll();}});
 view.on('closed',()=>{workspaceDrafts.delete(owner);workspaceWindows.delete(info.view);saveWorkspaceWindows();emit();if(!quitting&&info.view==='files'&&info.file&&info.root===defaultFolder()&&store.all<Chat>('chat').some(row=>row.id===info.chatId)){win.webContents.send('open-file',{id:randomUUID(),chatId:info.chatId,root:info.root,path:info.file,directory:false,refresh:true});}if(!quitting)win.show();});
 view.on('move',saveWorkspaceWindows);view.on('resize',saveWorkspaceWindows);view.on('maximize',saveWorkspaceWindows);view.on('unmaximize',saveWorkspaceWindows);
 if(args.maximized){if(hidden){hiddenMaximizedChats.add(view);view.once('show',()=>{hiddenMaximizedChats.delete(view);view.maximize();});}else view.maximize();}
 saveWorkspaceWindows();emit();view.once('ready-to-show',()=>{if(!hidden)view.show();});void view.loadFile(path.join(__dirname,'index.html'),{hash:'workspace='+info.view});
}
export async function workspaceWindowRequest(entry:WorkspaceWindow,method:string,args:any){
 const {info,window,preview}=entry;
 if(method==='state')return workspaceWindowState(entry);
 if(method==='openJob'&&info.view==='tasks'){if(!chatActivity(snapshot(),info.chatId).agents.some(turn=>turn.id===args?.id))throw Error('This agent belongs to another chat.');return openJob(args.id);}
 if(method==='chatFiles'&&['plan','tasks'].includes(info.view)){
  const activity=chatActivity(snapshot(),info.chatId);
  return turnFilesRequest([...activity.plans.map(row=>row.approval.turnId),...activity.agents.map(turn=>turn.id)],args);
 }
 if(['approve','chatLink','toolResult'].includes(method)&&['plan','tasks'].includes(info.view)){
  const activity=chatActivity(snapshot(),info.chatId);
  if(method==='approve'){if(info.view!=='plan'||!activity.plans.some(row=>row.approval.id===args?.id))throw Error('This plan belongs to another chat.');}
  else if(!activity.plans.some(row=>row.approval.turnId===args?.turnId)&&!activity.agents.some(turn=>turn.id===args?.turnId))throw Error('This link belongs to another chat.');
  return handlers[method](args);
 }
 if(method==='window'){if(args?.action==='close')window.close();else if(args?.action==='minimize')window.minimize();else if(args?.action==='maximize')window.isMaximized()?window.unmaximize():window.maximize();return;}
 if(method==='workspaceWindowOpen'){if(!workspaceViews.includes(args?.view))throw Error('Choose a workspace view.');return openWorkspaceWindow({...info,view:args.view});}
 if(method==='workspaceWindowReturn'){window.close();return;}
 if(method==='workspaceList'||method==='workspaceRead'||method==='workspaceSave'||method==='workspaceChanges'){
  if(method==='workspaceSave'&&info.view!=='files')throw Error('Edit files in the Files window.');
  const result=await handlers[method](args||{});
  if(method==='workspaceRead')info.file=args.file;
  if(method==='workspaceList')info.directory=args?.directory||'';
  if(method==='workspaceChanges'&&args?.file)info.diff={file:args.file,staged:args.staged===true};
  saveWorkspaceWindows();return result;
 }
 if(['terminalList','terminalOpen','terminalRead','terminalWrite','terminalResize','terminalClose','workspaceGit','workspaceGitCancel','reviewDraft','publishPreview','previewState','previewOpen','previewAction','previewLayout','previewBrowser'].includes(method)){
  if(args?.chatId!==info.chatId)throw Error('This action belongs to another chat.');
  if(method.startsWith('terminal')&&info.view!=='terminal')throw Error('Use the Terminal window.');
  if(['reviewDraft','workspaceGit','workspaceGitCancel'].includes(method)&&info.view!=='changes')throw Error('Use the Changes window.');
  if(method.startsWith('preview')){
   if(method==='previewBrowser')return handlers.previewBrowser(args);
   if(method==='previewLayout')return info.view==='preview'?preview.layout(info.chatId,args.bounds):undefined;
   const controller=info.view==='preview'?preview:workspaceWindows.get('preview')?.info.chatId===info.chatId?workspaceWindows.get('preview')!.preview:chatPreviews.get(info.chatId)||previews;
   if(method==='previewState')return controller.state(info.chatId);
   if(method==='previewOpen')return controller.open(info.chatId,{url:args.url,file:args.file,chatFileId:args.chatFileId});
   if(!['back','forward','reload','stop','close'].includes(args.action))throw Error('Invalid preview action.');return controller.action(info.chatId,args.action);
  }
  return handlers[method](args);
 }
 throw Error('This action is unavailable in a workspace window.');
}
export function recordClosingWindow(view:BrowserWindow,save:()=>void){if(!quitting){closingWindows.add(view);save();}}
export function saveChatWindows(){
 if(quitting)return;
 store.put('settings',{id:'chat-windows',windows:[...chatWindows].filter(([,view])=>!view.isDestroyed()&&!closingWindows.has(view)).map(([chatId,view])=>({chatId,bounds:view.getNormalBounds(),maximized:view.isMaximized()||hiddenMaximizedChats.has(view)}))});
}
export function removeSavedPane(id:string){const saved=store.all<any>('settings').find(row=>row.id==='pane-layout');if(!saved?.tree)return;const tree=readTree(saved.tree,()=>true);if(tree){const next=removePane(tree,id);if(next)store.put('settings',{...saved,tree:next});}}
export function openChatWindow(chatId:string,saved?:SavedChatWindow,hidden=false){
 const chat=sidebar.root(chatId),existing=chatWindows.get(chatId);if(existing&&!existing.isDestroyed()){existing.show();existing.focus();return;}
 const rectangle=saved?.bounds;
 const valid=rectangle&&['x','y','width','height'].every(key=>typeof rectangle[key as keyof WindowBounds]==='number'&&Number.isInteger(rectangle[key as keyof WindowBounds])&&Math.abs(rectangle[key as keyof WindowBounds])<=2147483647)&&rectangle.width>0&&rectangle.height>0;
 const bounds=visibleWindowBounds(rectangle,(valid?screen.getDisplayMatching(rectangle!):screen.getPrimaryDisplay()).workArea);
 const view=new BrowserWindow({icon:nativeImage.createFromPath(path.join(app.getAppPath(),'assets/icon.png')),...bounds,minWidth:450,minHeight:400,show:false,title:chat.title,backgroundColor:'#141413',frame:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
 chatWindows.set(chatId,view);removeSavedPane('chat:'+chatId);view.webContents.setWindowOpenHandler(()=>({action:'deny'}));view.webContents.on('will-navigate',event=>event.preventDefault());
 previews.close(chatId);chatPreviews.set(chatId,new Previews(view,store,defaultFolder,[data],path.join(root,'runtime/poppler/Library/bin'),data,withOwner,openChatLink));
 const editorOwner=view.webContents.id;let checkingClose=false,discardOnClose=false;
 view.on('close',event=>{if(!quitting&&!discardOnClose&&workspaceDrafts.has(editorOwner)){event.preventDefault();if(!checkingClose){checkingClose=true;void dialog.showMessageBox(view,{type:'question',message:'This file has an unsaved draft.',detail:'Close this window and discard the file draft?',buttons:['Keep editing','Discard and close'],defaultId:0,cancelId:0}).then(result=>{checkingClose=false;if(result.response===1){discardOnClose=true;view.close();}});}}if(!event.defaultPrevented){recordClosingWindow(view,saveChatWindows);chatPreviews.get(chatId)?.closeAll();}});
 view.on('closed',()=>{workspaceDrafts.delete(editorOwner);chatPreviews.delete(chatId);chatWindows.delete(chatId);saveChatWindows();emit();});view.on('move',saveChatWindows);view.on('resize',saveChatWindows);view.on('maximize',saveChatWindows);view.on('unmaximize',saveChatWindows);
 if(saved?.maximized){if(hidden){hiddenMaximizedChats.add(view);view.once('show',()=>{hiddenMaximizedChats.delete(view);view.maximize();});}else view.maximize();}
 saveChatWindows();emit();view.once('ready-to-show',()=>{if(!hidden)view.show();});void view.loadFile(path.join(__dirname,'index.html'),{hash:'chat='+chatId});
}
export function jobSnapshot(chatId:string,state:ReturnType<typeof snapshot>=snapshot({tools:false})){
  const chat=store.get<Chat>('chat',chatId),turns=state.turns.filter(t=>t.chatId===chatId),ids=new Set(turns.map(t=>t.id));
  return {...state,sidebar:undefined,goals:[],background:state.background.filter(row=>row.chatId===chatId),workReview:[],chats:[{...chat,pool:store.get<Chat>('chat',chat.parentChatId!).pool}],projects:state.projects.filter(p=>p.id===chat.projectId),turns:[...turns,store.get<Turn>('turn',chat.groupTurnId!)],tools:store.whereIn<ToolCall>('tool','turnId',[...ids]),approvals:state.approvals.filter(a=>a.chatId===chatId)};
}
export function agentSnapshot(id:string,state:ReturnType<typeof snapshot>=snapshot({tools:false})){
 const turn=store.get<Turn>('turn',id),chat=store.get<Chat>('chat',turn.chatId);if(turn.automatic?.kind!=='agent')throw Error('This is not a native agent.');
 return {...state,savedApps:[],sidebar:undefined,goals:[],jobChats:[],workReview:[],chats:[chat],projects:state.projects.filter(project=>project.id===chat.projectId),turns:[turn],tools:store.where<ToolCall>('tool','turnId',id),approvals:state.approvals.filter(approval=>approval.turnId===id),background:state.background.filter(row=>row.chatId===chat.id&&row.engine==='claude'&&row.processId===turn.automatic!.taskId&&row.generation===turn.automatic!.runtimeId)};
}
export function turnFilesRequest(turnIds:string[],args:any){
 const allowed=new Set(turnIds),rows=chatFiles(store,args?.chatId).filter(row=>row.turnId&&allowed.has(row.turnId));
 if(!args?.action||args.action==='list')return rows.map(({blob,...row})=>row);
 const row=findChatFile(store,args?.chatId,args?.id);if(!rows.some(file=>file.id===row.id))throw Error('This file belongs to another task.');
 return handlers.chatFiles(args);
}
export function agentWindowRequest(id:string,method:string,args:any){
 const state=agentSnapshot(id),view=jobWindows.get('agent:'+id)!;
 if(method==='state')return state;
 if(method==='chatFiles')return turnFilesRequest([id],args);
 if(method==='window'){if(args?.action==='close')view.close();else if(args?.action==='minimize')view.minimize();else if(args?.action==='maximize')view.isMaximized()?view.unmaximize():view.maximize();return;}
 if(['approve','answer'].includes(method)){if(!state.approvals.some(row=>row.id===args?.id))throw Error('This approval belongs to another agent.');}
 else if(['chatLink','toolResult','openParent'].includes(method)){if(args?.turnId!==id)throw Error('This action belongs to another agent.');}
 else if(method==='backgroundStop'){if(!state.background.some(row=>row.id===args?.id))throw Error('This task belongs to another agent.');}
 else throw Error('This action is unavailable in an agent window.');
 return handlers[method](args);
}
export function modelWindowHash(key:string){return key.startsWith('agent:')?'agent='+key.slice(6):'job='+key;}
export function saveJobWindows(){if(!quitting)store.put('settings',{id:'job-windows',windows:[...jobWindows].filter(([,view])=>!view.isDestroyed()&&!closingWindows.has(view)).map(([chatId,view])=>({turnId:chatId.startsWith('agent:')?chatId.slice(6):store.all<Turn>('turn').findLast(turn=>turn.chatId===chatId)?.id,bounds:view.getNormalBounds(),maximized:view.isMaximized()||hiddenMaximizedChats.has(view)}))});}
export function openJob(id:string,saved?:SavedJobWindow,hidden=false){
  const turn=store.get<Turn>('turn',id),chat=store.get<Chat>('chat',turn.chatId);
  const agent=turn.automatic?.kind==='agent',key=agent?'agent:'+turn.id:chat.id;
  if(!agent&&(!turn.parentTurnId||!chat.parentChatId))throw Error('This is not a parallel job.');
  const existing=jobWindows.get(key);if(existing&&!existing.isDestroyed()){existing.show();existing.focus();return;}
  const rectangle=saved?.bounds;
  const valid=rectangle&&['x','y','width','height'].every(key=>typeof rectangle[key as keyof WindowBounds]==='number'&&Number.isInteger(rectangle[key as keyof WindowBounds])&&Math.abs(rectangle[key as keyof WindowBounds])<=2147483647)&&rectangle.width>0&&rectangle.height>0;
  const bounds=visibleWindowBounds(rectangle||{width:540,height:640},(valid?screen.getDisplayMatching(rectangle!):screen.getPrimaryDisplay()).workArea);
  const window=new BrowserWindow({icon:nativeImage.createFromPath(path.join(app.getAppPath(),'assets/icon.png')),...bounds,minWidth:450,minHeight:400,show:false,title:modelLabel(turn.model,claude.models),backgroundColor:'#141413',frame:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
  jobWindows.set(key,window);removeSavedPane(agent?key:'job:'+chat.id);
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
  window.on('close',()=>recordClosingWindow(window,saveJobWindows));
  window.on('closed',()=>{jobWindows.delete(key);saveJobWindows();emit();});
  window.on('move',saveJobWindows);window.on('resize',saveJobWindows);window.on('maximize',saveJobWindows);window.on('unmaximize',saveJobWindows);
  if(saved?.maximized){if(hidden){hiddenMaximizedChats.add(window);window.once('show',()=>{hiddenMaximizedChats.delete(window);window.maximize();});}else window.maximize();}
  saveJobWindows();emit();window.once('ready-to-show',()=>{if(!hidden)window.showInactive();});
  void window.loadFile(path.join(__dirname,'index.html'),{hash:modelWindowHash(key)});
}
