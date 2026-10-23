// sharing: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import {contextCompletion,sideModel} from './context';
import {projectFor} from './projects';
import {summaryModel} from '../chat-context';
import {resolveChatLink} from '../chat-links';
import {backend,chatWindows,claude,data,desktopNotices,emit,namespace,ownerKey,quitting,root,shareAlerts,shareQueue,shareStatus,sidebar,store,win,workspaceWindows} from '../main';
import {modelLabel} from '../models';
import {workspaceTitle} from '../pane-layout';
import {assertNoSecrets,pageBundle,publishPage,readPublishing,validatePublishing} from '../publishing';
import {redactPastedKeys} from '../redaction';
import {PreviewPage,ShareNote,ShareProject,ShareSettings,aiAddress,aiSystem,deployedUrl,findWrangler,noteMessages,ownerHash,pageLink,previewGuide,previewIdOf,previewLink,privateId,readyMessage,run as runShare,sections as pageSections,stageSite,writePreview,writeProject} from '../share';
import type {Chat,Turn} from '../types';
import {defaultFolder} from './apps';
import {availableModels} from './models';
import {jevSettings} from './pickers';
import {Notification,shell} from 'electron';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Publishing (4c): settings, and one publish path the preview button and the publish_page tool share.
export function publishing(){return readPublishing(store.all<any>('settings').find(row=>row.id==='publishing'));}
export async function publish(file:string,signal?:AbortSignal,settings=publishing()){
  const link=resolveChatLink(defaultFolder(),String(file||''),[data]);if(link.kind!=='file'||link.directory)throw Error('Choose an HTML file in the working folder.');
  validatePublishing(settings,namespace.startsWith('Trismegistus/Test/'));
  return publishPage({page:path.join(link.root,link.path),settings,clone:path.join(data,'publish',createHash('sha256').update(settings.repository).digest('hex').slice(0,16)),secret:text=>backend.scrubber.text(text)!==text||redactPastedKeys(text)!==text,signal});
}
// Share work with clients (FEATURE-SPECS 3): Tris's own copy of the share site, its setup, sharing a page with the
// client, the notes that come back and the "for your AI" page Koan approves.
export const shareSite=()=>path.join(data,'share-site'),shareTest=()=>namespace.startsWith('Trismegistus/Test/');
export function shareSettings():ShareSettings&{testId?:string}{const row=store.all<any>('settings').find(row=>row.id==='share');return {site:typeof row?.site==='string'?row.site:'',databaseId:typeof row?.databaseId==='string'?row.databaseId:'',ready:row?.ready===true,wrangler:typeof row?.wrangler==='string'?row.wrangler:undefined,checked:row?.checked,testId:row?.testId,ownerKey:typeof row?.ownerKey==='string'?row.ownerKey:undefined,pagesSince:Number(row?.pagesSince)||0};}
// Every deploy restages the Worker from the app (so app updates reach the site) and rewrites each project's settings.
export async function shareDeploy(signal?:AbortSignal,write?:()=>Promise<void>){
  const settings=shareSettings(),wrangler=await findWrangler(shareSite(),settings.wrangler);if(!wrangler||!settings.databaseId)throw Error('Set up Share with clients in Settings first.');
  await stageSite(path.join(root,'share'),shareSite(),settings.databaseId);
  const copied=await previewSync();
  await write?.();
  for(const project of store.all<ShareProject>('share-project'))await writeProject(shareSite(),project);
  await fs.writeFile(path.join(shareSite(),'public','_owner.json'),JSON.stringify({hash:ownerHash(ownerKey())}));
  const url=deployedUrl(await runShare(wrangler,['deploy'],shareSite(),signal),shareTest());
  // The copies have their own folders now.
  for(const row of copied)await pagesApi('/'+row.id,{method:'PUT',body:JSON.stringify({...row,folder:row.id})}).catch(()=>{});
  return url;
}
// "Share this with the client" (3.6): the page and the files it links to go to the project's private folder; the
// link stays the same for every version. The AI page is drafted for Koan and goes live only when he approves it.
export async function shareWithClient(chat:Chat,file:string,signal:AbortSignal){
  const settings=shareSettings();if(!settings.ready||!settings.site)throw Error('Set up Share with clients in Settings first.');
  const link=resolveChatLink(defaultFolder(),String(file||''),[data]);if(link.kind!=='file'||link.directory||!/\.html?$/i.test(link.path))throw Error('Choose an HTML file in the working folder.');
  const page=path.join(link.root,link.path),bundle=await pageBundle(page),name=path.basename(page);
  assertNoSecrets(bundle,text=>backend.scrubber.text(text)!==text||redactPastedKeys(text)!==text);
  const owner=sidebar.root(chat.parentChatId||chat.id),projectId=projectFor(owner).id;
  const shared=await shareQueue(async()=>{
    const existing=store.find<ShareProject>('share-project',projectId);
    const project:ShareProject={...(existing||{id:projectId,shareId:privateId(),aiKey:privateId(),since:0}),chatId:owner.id,title:owner.title,page:name,version:(existing?.version||0)+1,sections:pageSections(bundle.get(name)?.toString('utf8')||''),published:Date.now()} as ShareProject;
    await writeProject(shareSite(),project,bundle);
    store.put('share-project',project);
    try{await shareDeploy(signal);}catch(error){if(existing)store.put('share-project',existing);else store.remove('share-project',projectId);throw error;}
    return project;
  });
  emit();void shareDraft(shared.id);
  const url=pageLink(settings.site,shared);
  for(const end=Date.now()+60000;Date.now()<end;){try{const response=await fetch(url+(shared.password?(url.includes('?')?'&':'?')+'key='+shared.aiKey:''),{signal:AbortSignal.timeout(10000)});await response.body?.cancel();if(response.ok)break;}catch{}signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,2000));}
  return {link:url,version:shared.version,aiPage:shared.ai?'The AI page for version '+shared.ai.version+' stays live; the user reviews the new draft before it changes.':'The user reviews the AI page draft before it goes live.'};
}
export async function shareDraft(id:string){
  const project=store.find<ShareProject>('share-project',id),chat=project&&store.find<Chat>('chat',project.chatId);if(!project||!chat)return;
  const model=summaryModel(true,'',chat.pool||[],availableModels(),jevSettings().summaryModel)||sideModel();
  store.update<ShareProject>('share-project',id,{draft:{text:'',version:project.version,status:'writing'}});emit();
  try{
    if(!model)throw Error('Connect a model to write the draft.');
    const records=store.all<Turn>('turn').filter(turn=>turn.chatId===chat.id&&!turn.automatic&&turn.status==='completed').slice(-14).map(turn=>({you:turn.prompt.slice(0,800),model:(turn.text||'').slice(0,1500)}));
    const answer=await contextCompletion(chat,model,aiSystem,JSON.stringify({project:project.title,page:project.page,version:project.version,previousAiPage:project.ai?.text||null,records}),new AbortController().signal);
    if(store.find<ShareProject>('share-project',id)?.version!==project.version)return;
    store.update<ShareProject>('share-project',id,{draft:{text:answer.text,version:project.version,status:'ready'}});
  }catch(error){if(store.find<ShareProject>('share-project',id)?.version===project.version)store.update<ShareProject>('share-project',id,{draft:{text:'The draft could not be written: '+backend.scrubber.text(error instanceof Error?error.message:String(error)),version:project.version,status:'failed'}});}
  emit();
}
// Clients' notes come back about every minute (3.4); each person's new notes raise one notification.
export async function shareCheck(){
  const settings=shareSettings();if(!settings.ready||!settings.site)return 0;let found=0;
  for(const project of store.all<ShareProject>('share-project')){
    let rows:any;try{const response=await fetch(settings.site+'/api/notes?project='+encodeURIComponent('/'+project.shareId+'/')+'&since='+project.since+(project.password?'&key='+project.aiKey:''),{signal:AbortSignal.timeout(20000)});rows=response.ok?await response.json():null;}catch{rows=null;}
    if(!Array.isArray(rows))continue;
    const fresh:ShareNote[]=rows.filter((row:any)=>typeof row?.id==='string'&&typeof row.text==='string'&&typeof row.name==='string'&&Number.isFinite(row.created)&&!store.find<ShareNote>('share-note',row.id)).map((row:any)=>({id:row.id,shareId:project.shareId,projectId:project.id,page:String(row.page||''),name:row.name.slice(0,60),text:row.text.slice(0,4000),anchor:typeof row.anchor==='string'?row.anchor:null,version:Number.isInteger(row.version)?row.version:null,created:row.created}));
    if(!fresh.length)continue;
    for(const note of fresh)store.put('share-note',note);
    store.update<ShareProject>('share-project',project.id,{since:Math.max(project.since,...fresh.map(note=>note.created))});found+=fresh.length;
    for(const line of noteMessages(project.title,fresh))shareAlert(project,line);
  }
  // Notes on Koan's preview pages: one feed, each page's notes go to the chat that made it.
  try{
    const response=await fetch(settings.site+'/api/notes?pages=1&since='+shareSettings().pagesSince,{headers:{authorization:'Bearer '+ownerKey()},signal:AbortSignal.timeout(20000)}),rows=response.ok?await response.json():null;
    const fresh:ShareNote[]=Array.isArray(rows)?rows.filter((row:any)=>typeof row?.id==='string'&&typeof row.text==='string'&&typeof row.name==='string'&&Number.isFinite(row.created)&&typeof row.page==='string'&&!store.find<ShareNote>('share-note',row.id)).map((row:any)=>{const id=row.page.split('/')[1]||'';return {id:row.id,shareId:id,projectId:'page:'+id,page:row.page,name:row.name.slice(0,60),text:row.text.slice(0,4000),anchor:typeof row.anchor==='string'?row.anchor:null,version:Number.isInteger(row.version)?row.version:null,created:row.created};}):[];
    for(const note of fresh)store.put('share-note',note);
    if(fresh.length)store.put('settings',{...shareSettings(),id:'share',pagesSince:Math.max(shareSettings().pagesSince||0,...fresh.map(note=>note.created))});
    found+=fresh.length;
    for(const id of new Set(fresh.map(note=>note.shareId))){const page=store.find<PreviewPage>('preview-page',id);for(const line of noteMessages(page?.title||'A page',fresh.filter(note=>note.shareId===id)))pageAlert(page,id,line);}
  }catch{/* The site may be away for a moment; the next check picks the notes up. */}
  store.put('settings',{...shareSettings(),id:'share',checked:Date.now()});if(found)emit();return found;
}
export function shareAlert(project:ShareProject,line:string){
  shareAlerts.push(line);shareAlerts.splice(0,shareAlerts.length-20);
  if(quitting||shareTest()||!Notification.isSupported())return;
  const notification=new Notification({title:'Client notes',body:line});desktopNotices.add(notification);
  notification.on('close',()=>desktopNotices.delete(notification));
  notification.on('click',()=>{desktopNotices.delete(notification);const site=shareSettings().site;if(site)void shell.openExternal(pageLink(site,project));const owner=chatWindows.get(project.chatId)||win;owner.show();owner.focus();if(owner===win)win.webContents.send('select-chat',project.chatId);});
  notification.show();
}
export function pageAlert(page:PreviewPage|undefined,id:string,line:string){
  shareAlerts.push(line);shareAlerts.splice(0,shareAlerts.length-20);
  if(quitting||shareTest()||!Notification.isSupported())return;
  const notification=new Notification({title:'Notes on your page',body:line});desktopNotices.add(notification);
  notification.on('close',()=>desktopNotices.delete(notification));
  notification.on('click',()=>{desktopNotices.delete(notification);const site=shareSettings().site;if(page)openPage(page.chatId,previewLink(site,id));else if(site)void withOwner(previewLink(site,id)).then(url=>shell.openExternal(url));});
  notification.show();
}
// What the windows see: never the password hash or the key on its own.
export function shareView(){
  const settings=shareSettings(),notes=store.all<ShareNote>('share-note');
  return {site:settings.site,ready:settings.ready,status:shareStatus,checked:settings.checked,alerts:shareTest()?[...shareAlerts]:[],pages:pagesView(),projects:store.all<ShareProject>('share-project').map(project=>{const {password,aiKey,...rest}=project;return {...rest,password:!!password,link:settings.site?pageLink(settings.site,project):'',aiAddress:settings.site&&project.ai?aiAddress(settings.site,project):'',message:settings.site&&project.ai?readyMessage(settings.site,project):'',notes:notes.filter(note=>note.projectId===project.id).slice(-100)};})};
}
export async function pagesApi(tail:string,init:RequestInit={}){
  const site=shareSettings().site;if(!site)throw Error('Set up Share with clients in Settings first; preview pages live on the same private site.');
  const response=await fetch(site+'/api/pages'+tail,{...init,headers:{authorization:'Bearer '+ownerKey(),'content-type':'application/json'},signal:init.signal||AbortSignal.timeout(20000)});
  const body=await response.json().catch(()=>({}));if(!response.ok)throw Error(body?.error||'The share site answered '+response.status+'.');return body;
}
// Before files change on the site: duplicates made on the web (still showing their source's files) get their own
// folders, and pages deleted on the web lose theirs. Returns the copies, to point them at their folders after deploy.
export async function previewSync(){
  const settings=shareSettings();if(!settings.ready||!settings.site)return [];
  let rows:any[];try{rows=await pagesApi('?all=1');}catch{return [];}
  const valid=(id:unknown)=>typeof id==='string'&&/^[A-Za-z0-9_-]{16,64}$/.test(id),site=shareSite(),copied:any[]=[];
  rows=Array.isArray(rows)?rows.filter(row=>valid(row?.id)&&valid(row?.folder)):[];
  for(const row of rows)if(!row.deleted&&row.folder!==row.id&&await fs.access(path.join(site,'public',row.folder)).then(()=>true,()=>false)){await fs.cp(path.join(site,'public',row.folder),path.join(site,'public',row.id),{recursive:true,force:true});copied.push(row);}
  for(const row of rows)if(row.deleted){
    if(row.folder===row.id&&!rows.some(other=>!other.deleted&&other.folder===row.id&&!copied.includes(other)))await fs.rm(path.join(site,'public',row.id),{recursive:true,force:true});
    if(store.find<PreviewPage>('preview-page',row.id))store.remove('preview-page',row.id);
  }
  return copied.map(({id,title,description,entry,model,chatId,chatTitle,version,files})=>({id,title,description,entry,model,chatId,chatTitle,version,files}));
}
export const pageUrl=(url:unknown)=>{const site=shareSettings().site;return typeof url==='string'&&!!site&&url.startsWith(site+'/')&&!!previewIdOf(site,url);};
// Tris opens Koan's own pages as Koan: a one-time sign-in code in the address (two minutes, once); the site turns it
// into that browser's own session and drops it from the address, so history keeps nothing that opens a page.
export async function withOwner(url:string){
  const site=shareSettings().site;if(!site||!url.startsWith(site+'/')||/[?&]login=/.test(url))return url;
  try{const response=await fetch(site+'/api/login',{method:'POST',headers:{authorization:'Bearer '+ownerKey()},signal:AbortSignal.timeout(15000)}),body=await response.json();if(response.ok&&typeof body?.code==='string')return url+(url.includes('?')?'&':'?')+'login='+body.code;}catch{/* Opened without signing in: the page says it is private. */}
  return url;
}
export function openPage(chatId:string,url:string){
  const popped=workspaceWindows.get('preview'),request={url,chatId,root:'',path:'',directory:false,id:randomUUID()};
  if(popped){if(popped.info.chatId!==chatId)throw Error(workspaceTitle('preview')+' is open for another chat. Return that window before opening this page.');popped.window.show();popped.window.focus();popped.window.webContents.send('open-file',request);return;}
  const owner=chatWindows.get(chatId)||win;owner.show();owner.focus();owner.webContents.send('open-file',request);
}
// A page's Chat button: trismegistus://chat/<id>.
export function openChatLink(link:string){
  const id=/^trismegistus:\/\/chat\/([\w-]{8,80})\/?$/i.exec(link)?.[1];const chat=id&&store.find<Chat>('chat',id);if(!chat)return;
  const target=sidebar.root(chat.id),window=chatWindows.get(target.id)||win;if(!window)return;window.webContents.send('select-chat',target.id);window.show();window.focus();
}
export async function previewPublish(chat:Chat,turn:Turn,input:any,signal:AbortSignal){
  const settings=shareSettings();if(!settings.ready||!settings.site)throw Error('Set up Share with clients in Settings first; preview pages live on the same private site.');
  const link=resolveChatLink(defaultFolder(),String(input?.path||''),[data]);if(link.kind!=='file'||link.directory||!/\.html?$/i.test(link.path))throw Error('Choose an HTML file in the working folder.');
  const title=String(input?.title||'').replace(/\s+/g,' ').trim().slice(0,200);if(!title)throw Error('Give the page a short title.');
  const file=path.join(link.root,link.path),bundle=await pageBundle(file),entry=path.basename(file);
  assertNoSecrets(bundle,text=>backend.scrubber.text(text)!==text||redactPastedKeys(text)!==text);
  const owner=sidebar.root(chat.parentChatId||chat.id);
  // The same file from the same chat, or a page's link, updates that page and keeps its link (like Claude Code).
  let id=input?.link?previewIdOf(settings.site,input.link):null,version=0;
  if(input?.link){
    if(!id)throw Error('That is not a link to one of your pages.');
    const row=(await pagesApi('') as any[]).find(page=>page.id===id);if(!row)throw Error('That page is gone. Publish without a link to make a new one.');version=row.version;
  }else{
    // A page Koan deleted on the web stays deleted: the same file then makes a new, private page.
    const earlier=store.all<PreviewPage>('preview-page').find(page=>page.chatId===owner.id&&page.sourcePath===link.path);
    if(earlier&&(await pagesApi('') as any[]).some(page=>page.id===earlier.id)){id=earlier.id;version=earlier.version;}
  }
  const page:PreviewPage={...store.find<PreviewPage>('preview-page',id||''),id:id||privateId(),chatId:owner.id,sourcePath:link.path,title,description:String(input?.description||'').replace(/\s+/g,' ').trim().slice(0,600),entry,version:version+1,files:bundle.size,published:Date.now(),model:modelLabel(turn.model,claude.models)};
  await shareQueue(async()=>{
    // The page's settings first: the site never serves a page folder it has no settings for as anything else. A site
    // set up before preview pages does not know the owner key yet; one deploy carries it.
    const register=()=>pagesApi('/'+page.id,{method:'PUT',body:JSON.stringify({folder:page.id,title,description:page.description,entry,version:page.version,files:page.files,model:page.model,chatId:owner.id,chatTitle:owner.title}),signal});
    try{await register();}catch(error){if(!/Only the owner/.test(String(error)))throw error;await shareDeploy(signal);await register();}
    await shareDeploy(signal,()=>writePreview(shareSite(),page.id,bundle));
  });
  store.put('preview-page',page);emit();
  const url=previewLink(settings.site,page.id);
  for(const end=Date.now()+60000;Date.now()<end;){try{const response=await fetch(url,{headers:{authorization:'Bearer '+ownerKey()},signal:AbortSignal.timeout(10000)});const text=await response.text();if(response.ok&&text.includes('/v/'))break;}catch{}signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,2000));}
  return {link:url,title,version:page.version,files:[...bundle.keys()].map(name=>name.split(path.sep).join('/')),access:'Private: only the user can open it until they share it from the page.',show:'Ghidorah shows the page under your reply as a card with Open. Put the link in your reply too.'};
}
export async function previewTool_(chat:Chat,turn:Turn,input:any,signal:AbortSignal){
  const action=input?.action,site=shareSettings().site;
  if(action==='guide')return {guide:previewGuide};
  if(action==='publish')return previewPublish(chat,turn,input,signal);
  if(!shareSettings().ready||!site)throw Error('Set up Share with clients in Settings first; preview pages live on the same private site.');
  if(action==='list'){const owner=sidebar.root(chat.parentChatId||chat.id);return (await pagesApi('') as any[]).map(page=>({link:previewLink(site,page.id),title:page.title,description:page.description,updated:new Date(page.updated).toISOString(),version:page.version,access:page.access,pinned:page.pinned,fromThisChat:store.find<PreviewPage>('preview-page',page.id)?.chatId===owner.id}));}
  const id=previewIdOf(site,input?.link);if(!id)throw Error('Give the link of one of your pages.');
  const row=(await pagesApi('?all=1') as any[]).find(page=>page.id===id&&!page.deleted);if(!row)throw Error('That page is gone.');
  if(action==='read'){
    const folder=path.join(shareSite(),'public',row.folder),files:string[]=[];
    const walk=async(dir:string):Promise<void>=>{for(const entry of await fs.readdir(dir,{withFileTypes:true}))if(entry.isDirectory())await walk(path.join(dir,entry.name));else if(entry.name!=='_export.zip')files.push(path.relative(folder,path.join(dir,entry.name)).split(path.sep).join('/'));};
    await walk(folder).catch(()=>{throw Error('This page’s files are not on this computer.');});
    const html=await fs.readFile(path.join(folder,row.entry),'utf8');
    return {link:previewLink(site,id),title:row.title,version:row.version,entry:row.entry,files,html:html.length>300000?html.slice(0,300000)+'\n[cut at 300,000 characters]':html};
  }
  if(action==='delete'){await pagesApi('/'+id,{method:'DELETE',signal});store.remove('preview-page',id);emit();return {deleted:true,link:previewLink(site,id),note:'The link stopped working; its files go at the next publish.'};}
  throw Error('Choose publish, list, read, delete or guide.');
}
export function pagesView(){
  const notes=store.all<ShareNote>('share-note'),site=shareSettings().site;
  return store.all<PreviewPage>('preview-page').map(page=>({id:page.id,chatId:page.chatId,title:page.title,version:page.version,link:site?previewLink(site,page.id):'',notes:notes.filter(note=>note.projectId==='page:'+page.id&&!note.handled).slice(-100)}));
}