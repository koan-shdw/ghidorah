const randomUUID=()=>globalThis.crypto.randomUUID();
import type {Store} from './store';
import type {Chat,Project,Turn,ToolCall} from './types';
import type {Goal} from './goals';

export interface SidebarGroup {id:string;name:string;position:number;collapsed:boolean;}
export interface SidebarPreferences {id:'sidebar';groupBy:'folders'|'date'|'state'|'working-folder'|'none';sort:'updated'|'created'|'name'|'manual';sortVersion?:1;visibility:'active'|'archived'|'all';stateDays:1|3|7|30;}
const defaults:SidebarPreferences={id:'sidebar',groupBy:'folders',sort:'updated',visibility:'active',stateDays:7};
export const pendingTurn=(status:string)=>['queued','dispatching','running','waiting','stopping','needs-model'].includes(status);
export function chatStamp(chat:Chat,turns:Turn[]){const own=turns.filter(t=>t.chatId===chat.id);return own.map(t=>`${t.id}:${t.status}`).join('|');}
export function chatUnread(chat:Chat,turns:Turn[]){return !!chat.unread||chat.readThrough!==undefined&&chat.readThrough!==chatStamp(chat,turns);}
export function chatUpdated(chat:Chat,turns:Turn[]){return Math.max(chat.updated||chat.created||0,...turns.filter(t=>t.chatId===chat.id).map(t=>t.created));}
export function chatState(chat:Chat,turns:Turn[]){const own=turns.filter(t=>t.chatId===chat.id);if(own.some(t=>['waiting','needs-model'].includes(t.status)))return 'Needs input';if(own.some(t=>pendingTurn(t.status)))return 'Working';return ['failed','interrupted','partial'].includes(own.at(-1)?.status||'')?'Needs attention':own.length?'Completed':'New';}
function name(value:unknown){if(typeof value!=='string'||!value.trim()||value.trim().length>100||/[\x00-\x1f]/.test(value))throw Error('Enter a name between 1 and 100 characters.');return value.trim();}
export class Sidebar {
 constructor(private store:Store){}
 groups(){return this.store.all<SidebarGroup>('sidebar-group').sort((a,b)=>a.position-b.position);}
 preferences():SidebarPreferences{return this.store.all<SidebarPreferences>('settings').find(s=>s.id==='sidebar')||defaults;}
 initialize(){
  const preferences=this.preferences();
  if(preferences.sortVersion!==1)this.store.put('settings',{...preferences,sort:preferences.sort==='manual'?'updated':preferences.sort,sortVersion:1});
  this.store.transaction(()=>{const groups=this.groups(),turns=this.store.all<Turn>('turn');let position=0;for(const chat of this.store.all<Chat>('chat')){
   if(chat.parentChatId||chat.created!==undefined)continue;
   const project=this.store.get<Project>('project',chat.projectId);let group=groups.find(g=>g.name===project.group);
   if(project.group&&project.group!=='Ungrouped'&&!group){group=this.store.put('sidebar-group',{id:randomUUID(),name:project.group,position:groups.length,collapsed:false});groups.push(group);}
   this.store.update<Chat>('chat',chat.id,{groupId:group?.id||null,created:turns.find(t=>t.chatId===chat.id)?.created||Date.now(),readThrough:chatStamp(chat,turns),position:position++});
  }});
 }
 root(id:unknown){if(typeof id!=='string')throw Error('Choose a chat.');const chat=this.store.get<Chat>('chat',id);if(chat.parentChatId)throw Error('Manage this job from its parent chat.');return chat;}
 owned(id:string){this.root(id);return this.store.all<Chat>('chat').filter(c=>c.id===id||c.parentChatId===id);}
 settings(patch:any){
  if(!patch||typeof patch!=='object'||Object.keys(patch).some(k=>!['groupBy','sort','visibility','stateDays'].includes(k)))throw Error('Invalid sidebar settings.');
  const next={...this.preferences(),...patch};
  if(!['folders','date','state','working-folder','none'].includes(next.groupBy)||!['updated','created','name','manual'].includes(next.sort)||!['active','archived','all'].includes(next.visibility)||![1,3,7,30].includes(next.stateDays))throw Error('Invalid sidebar settings.');
  return this.store.put('settings',next);
 }
 group(action:string,args:any){
  if(action==='create'){const title=name(args.name);if(this.groups().some(g=>g.name.toLowerCase()===title.toLowerCase()))throw Error('A folder with that name already exists.');return this.store.put('sidebar-group',{id:randomUUID(),name:title,position:this.groups().length,collapsed:false});}
  const group=this.store.get<SidebarGroup>('sidebar-group',args.id);
  if(action==='rename'){const title=name(args.name);if(this.groups().some(g=>g.id!==group.id&&g.name.toLowerCase()===title.toLowerCase()))throw Error('A folder with that name already exists.');return this.store.update<SidebarGroup>('sidebar-group',group.id,{name:title});}
  if(action==='collapse'){if(typeof args.collapsed!=='boolean')throw Error('Invalid folder state.');return this.store.update<SidebarGroup>('sidebar-group',group.id,{collapsed:args.collapsed});}
  if(action==='delete')return this.store.transaction(()=>{for(const chat of this.store.all<Chat>('chat'))if(chat.groupId===group.id)this.store.update<Chat>('chat',chat.id,{groupId:null});this.store.db.prepare("DELETE FROM records WHERE kind='sidebar-group' AND id=?").run(group.id);});
  if(action==='move'){const rows=this.groups(),index=rows.findIndex(g=>g.id===group.id),target=args.beforeId?rows.findIndex(g=>g.id===args.beforeId):rows.length;if(target<0)throw Error('Folder no longer exists.');rows.splice(index,1);rows.splice(target-(index<target?1:0),0,group);return this.store.transaction(()=>rows.forEach((g,i)=>this.store.update<SidebarGroup>('sidebar-group',g.id,{position:i})));}
  throw Error('Unknown folder action.');
 }
 chat(action:string,args:any){
  const chat=this.root(args.chatId);let patch:Partial<Chat>;
  if(action==='rename')patch={title:name(args.name)};
  else if(action==='pin'){if(typeof args.pinned!=='boolean')throw Error('Invalid pin state.');patch={pinned:args.pinned,...(args.pinned?{archived:false}:{})};}
  else if(action==='archive'){if(typeof args.archived!=='boolean')throw Error('Invalid archive state.');patch={archived:args.archived,...(args.archived?{pinned:false}:{})};}
  else if(action==='read'){if(typeof args.unread!=='boolean')throw Error('Invalid read state.');patch={unread:args.unread,readThrough:chatStamp(chat,this.store.all<Turn>('turn'))};}
  else if(action==='move'){if(args.groupId!==null)this.store.get<SidebarGroup>('sidebar-group',args.groupId);patch={groupId:args.groupId,pinned:false};}
  else if(action==='reorder'){
   const rows=this.store.all<Chat>('chat').filter(c=>!c.parentChatId).sort((a,b)=>(a.position||0)-(b.position||0)),index=rows.findIndex(c=>c.id===chat.id),target=args.beforeId?rows.findIndex(c=>c.id===args.beforeId):rows.length;if(target<0)throw Error('Chat no longer exists.');
   rows.splice(index,1);rows.splice(target-(index<target?1:0),0,chat);return this.store.transaction(()=>{rows.forEach((c,i)=>this.store.update<Chat>('chat',c.id,{position:i}));this.settings({sort:'manual'});});
  }else throw Error('Unknown chat action.');
  return this.store.update<Chat>('chat',chat.id,patch);
 }
 fork(chatId:string,{sideChat=false,beforeTurnId}:{sideChat?:boolean;beforeTurnId?:string}={}){
  const source=this.root(chatId);let owned=this.owned(chatId),turns=this.store.all<Turn>('turn').filter(t=>owned.some(c=>c.id===t.chatId));
  if(!sideChat&&turns.some(t=>pendingTurn(t.status)))throw Error('Finish or stop current work before forking.');
  let retry:Turn|undefined;
  if(beforeTurnId!==undefined){
   if(source.sideSourceId)throw Error('Keep this side chat before creating a branch.');
   retry=turns.find(t=>t.id===beforeTurnId&&t.chatId===chatId&&!t.parentTurnId&&!t.automatic&&!t.goal?.automatic&&!t.contextSnapshot);
   if(sideChat||!retry)throw Error('Choose an ordinary message in this chat.');
   const roots=new Set(turns.slice(0,turns.indexOf(retry)).filter(t=>t.chatId===chatId).map(t=>t.id));
   const kept=turns.filter(t=>roots.has(t.id)||!!t.parentTurnId&&roots.has(t.parentTurnId)),keptIds=new Set(kept.map(t=>t.id)),tools=this.store.all<ToolCall>('tool');
   // Branching rewinds the conversation, not the filesystem or outside services.
   // Preserve executed outcomes so a fresh engine cannot mistake them for work still to do.
   const effects=turns.filter(t=>!keptIds.has(t.id)&&tools.some(tool=>tool.turnId===t.id)).map(t=>({...t,chatId,parentTurnId:undefined,jobs:undefined,automatic:undefined,command:undefined,commandContext:undefined,review:undefined,remote:undefined,routine:undefined,voice:undefined,attachments:[],prompt:'Actions already performed in the original chat. Files and external effects have not been reverted. Inspect their current state before repeating or replacing an action.',text:'',reasoning:'',error:null,usage:null,status:'context',contextSnapshot:{turnId:t.id,status:t.status}}));
   turns=[...kept,...effects];owned=owned.filter(c=>c.id===chatId||kept.some(t=>t.chatId===c.id));
  }
  const chatIds=new Map(owned.map(c=>[c.id,randomUUID()]));
  const turnIds=new Map(turns.map(t=>[t.id,randomUUID()])),newId=chatIds.get(chatId)!;
  const forkedTools=this.store.all<ToolCall>('tool').filter(tool=>turnIds.has(tool.turnId)),toolIds=new Map(forkedTools.map(tool=>[tool.id,randomUUID()]));
  const sources=this.store.all<import('./web-research').WebSource>('web-source').filter(row=>row.chatId===source.id&&turnIds.has(row.turnId)),sourceIds=new Map(sources.map(row=>[row.id,randomUUID()]));
  const outputs=this.store.all<import('./chat-files').ChatOutput>('chat-output').filter(row=>row.chatId===source.id&&turnIds.has(row.turnId)),outputIds=new Map(outputs.map(row=>[row.id,randomUUID()]));
  const aliases=(chat:Chat)=>Object.fromEntries([...turnIds,...toolIds,...sourceIds,...outputIds,...Object.entries(chat.historyAliases||{}).flatMap(([old,id])=>{const next=turnIds.get(id)||toolIds.get(id)||sourceIds.get(id)||outputIds.get(id);return next?[[old,next]]:[];})]);
  const compact=(chat:Chat)=>chat.context&&turnIds.has(chat.context.throughTurnId)&&(!retry||this.store.all<Turn>('turn').findIndex(t=>t.id===chat.context!.throughTurnId)<this.store.all<Turn>('turn').findIndex(t=>t.id===retry!.id))?{...chat.context,id:randomUUID(),throughTurnId:turnIds.get(chat.context.throughTurnId)!}:undefined;
  this.store.transaction(()=>{
   const originalProject=this.store.get<Project>('project',source.projectId),project=sideChat?this.store.project(originalProject.folder):originalProject;
   if(sideChat)this.store.update<Project>('project',project.id,{mode:originalProject.mode,worktree:originalProject.worktree});
   for(const chat of owned)this.store.put('chat',{...chat,context:compact(chat),historyAliases:aliases(chat),id:chatIds.get(chat.id)!,...(chat.parentChatId?{parentChatId:newId,groupTurnId:turnIds.get(chat.groupTurnId!)}:{title:sideChat?'Side chat · '+source.title:source.title+' (fork)',sideSourceId:sideChat?source.id:undefined,created:Date.now(),updated:Date.now(),forkedFrom:source.id}),projectId:project.id,runtimeId:null,storedId:null,draft:'',attachments:[],pinned:false,archived:false,unread:false,readThrough:'',selected:sideChat?source.selected:false,selectedModels:sideChat?source.selectedModels:[]});
   for(const turn of turns)this.store.put<Turn>('turn',{...turn,...(sideChat?{contextSnapshot:{turnId:turn.id,status:turn.contextSnapshot?.status||turn.status},status:'context',usage:null}:{}),id:turnIds.get(turn.id)!,chatId:chatIds.get(turn.chatId)!,jobs:turn.jobs?.map(id=>turnIds.get(id)!),parentTurnId:turn.parentTurnId?turnIds.get(turn.parentTurnId):undefined,goal:undefined,automatic:turn.automatic?{...turn.automatic,originTurnId:turnIds.get(turn.automatic.originTurnId)||'',taskId:randomUUID()}:undefined,attachments:turn.attachments?.map(a=>({...a,chatId:newId}))});
   for(const tool of forkedTools)this.store.put('tool',{...tool,id:toolIds.get(tool.id)!,turnId:turnIds.get(tool.turnId)!});
   for(const output of outputs)this.store.put('chat-output',{...output,id:outputIds.get(output.id)!,chatId:newId,turnId:turnIds.get(output.turnId)!});
   for(const page of sources)this.store.put('web-source',{...page,id:sourceIds.get(page.id)!,chatId:newId,turnId:turnIds.get(page.turnId)!});
   if(retry){
    const models=(retry.models||[retry.model]).filter(model=>(source.pool||[source.model]).includes(model));
    this.store.update<Chat>('chat',newId,{branchTurnId:retry.id,title:source.title+' (retry)',sideSourceId:undefined,draft:retry.prompt,draftRevision:randomUUID(),attachments:retry.attachments?.map(a=>({...a,chatId:newId}))||[],selected:models.includes('deepseek-flash'),selectedModels:models,lockedModel:models.includes(source.lockedModel||'')?source.lockedModel:null,effort:retry.effort||source.effort,efforts:{...source.efforts,...retry.efforts,...(retry.effort?{[retry.model]:retry.effort}:{})}});
   }
   const goal=this.store.all<Goal>('goal').find(g=>g.id===source.id);if(goal&&!sideChat)this.store.put('goal',{...goal,id:newId,key:randomUUID(),runId:randomUUID(),status:'paused',tokens:0,usageIncomplete:false,accounted:[],turns:0,cursor:null,summary:'Copied direction. Resume when ready.',evidence:'',created:Date.now(),updated:Date.now()});
   this.chat('read',{chatId:newId,unread:false});
  });return newId;
 }
 delete(chatId:string){
  if(this.store.all<Chat>('chat').some(chat=>chat.sideSourceId===chatId&&!chat.parentChatId))throw Error('Keep or discard this thread’s side chat before deleting the thread.');
  const chats=new Set(this.owned(chatId).map(c=>c.id)),turns=new Set(this.store.all<Turn>('turn').filter(t=>chats.has(t.chatId)).map(t=>t.id));
  if(this.store.all<Turn>('turn').some(t=>turns.has(t.id)&&pendingTurn(t.status)))throw Error('Finish or stop current work before deleting.');
  this.store.transaction(()=>{
   for(const row of this.store.db.prepare('SELECT kind,id,data FROM records').all() as any[]){const value=JSON.parse(row.data);if(chats.has(value.chatId)||turns.has(value.turnId)||turns.has(value.job)||turns.has(value.group)||row.kind==='turn'&&turns.has(row.id)||['chat','goal'].includes(row.kind)&&chats.has(row.id)||row.kind==='goal-report'&&turns.has(row.id))this.store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(row.kind,row.id);}
  });
 }
}
