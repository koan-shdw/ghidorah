import {ExportChatDialog} from './export-dialog';
import {SavedAppsPanel} from './saved-apps-panel';
import React,{useEffect,useRef,useState} from 'react';
import type {Chat,Snapshot} from './types';
import {chatStamp,chatState,chatUnread,chatUpdated,type SidebarGroup,type SidebarPreferences} from './sidebar';
import {SidebarHoverCard} from './sidebar-overlays';
import {Button,Dialog,Notice,SidebarMenu,SidebarIcon,type MenuItem} from './kit';

type Props={appFilter:string|null;selectApp:(id:string|null,rename?:boolean)=>void;state:Snapshot;selected:string;choose:(id:string)=>void;call:(method:string,args?:any)=>Promise<any>;create:(groupId?:string|null)=>Promise<void>;terminal:(id:string)=>void;split:(id:string)=>void;pane:(id:string)=>void;worktree:()=>void;worktreeKept:(path:string|string[])=>void;settings:(page?:'general'|'plugins'|'skills'|'models')=>void;};
type Menu={kind:'chat'|'group'|'new';id:string;x:number;y:number};
type Edit={kind:'new-group'|'rename-group'|'delete-group'|'rename-chat'|'delete-chat'|'delete-chats';id?:string;ids?:string[];value:string};
type ChatDrop={kind:'pin'|'folder'|'app';id?:string|null;beforeId?:string};
export function SidebarPanel({state,selected,choose,call,create,terminal,split,pane,worktree,worktreeKept,settings,appFilter,selectApp}:Props){
 const [exportChat,setExportChat]=useState<string|null>(null);
 const [search,setSearch]=useState(''),[menu,setMenu]=useState<Menu|null>(null),[edit,setEdit]=useState<Edit|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [collapsed,setCollapsed]=useState(()=>{try{return localStorage.getItem('sidebar-collapsed')==='1';}catch{return false;}});
 const toggleSidebar=()=>setCollapsed(value=>{try{localStorage.setItem('sidebar-collapsed',value?'0':'1');}catch{}return !value;});
 const [preferredWidth,setPreferredWidth]=useState<number|null>(()=>{try{const value=Number(localStorage.getItem('sidebar-width'));return Number.isFinite(value)&&value>=210&&value<=520?value:null;}catch{return null;}});
 const [viewportWidth,setViewportWidth]=useState(window.innerWidth);
 const resizing=useRef<{pointer:number;x:number;width:number;latest:number;previous:number|null}|null>(null);
 const maxWidth=Math.max(210,Math.min(520,viewportWidth-400)),clampWidth=(value:number)=>Math.round(Math.max(210,Math.min(maxWidth,value)));
 const sidebarWidth=clampWidth(preferredWidth??(viewportWidth<=750?215:viewportWidth<=1000?260:294));
 useEffect(()=>{const resize=()=>setViewportWidth(window.innerWidth);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
 function saveWidth(value:number|null){setPreferredWidth(value);try{if(value===null)localStorage.removeItem('sidebar-width');else localStorage.setItem('sidebar-width',String(value));}catch{}}
 function endResize(handle:HTMLElement,cancel=false){const drag=resizing.current;if(!drag)return;resizing.current=null;if(cancel)setPreferredWidth(drag.previous);else saveWidth(drag.latest);if(handle.hasPointerCapture(drag.pointer))handle.releasePointerCapture(drag.pointer);}
 const [picked,setPicked]=useState<string[]>([]),anchor=useRef<string|null>(null),batchLock=useRef(false);
 const [dropTarget,setDropTarget]=useState(''),[dropNotice,setDropNotice]=useState('');
 const dialog=useRef<HTMLFormElement>(null),hoverTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),returnFocus=useRef<HTMLElement|null>(null);
 const [hover,setHover]=useState<{id:string;anchor:DOMRect}|null>(null),[activity,setActivity]=useState(()=>localStorage.getItem('sidebar-activity')==='true');
 function clearHover(){clearTimeout(hoverTimer.current);setHover(null);}
 function showHover(event:React.MouseEvent|React.FocusEvent,id:string){clearTimeout(hoverTimer.current);const anchor=event.currentTarget.getBoundingClientRect();hoverTimer.current=setTimeout(()=>setHover({id,anchor}),350);}
 useEffect(()=>()=>clearTimeout(hoverTimer.current),[]);
 useEffect(()=>{localStorage.setItem('sidebar-activity',String(activity));},[activity]);
 useEffect(()=>{const key=(event:KeyboardEvent)=>{if(!event.defaultPrevented&&!document.querySelector('dialog[open],[role="dialog"]')&&event.ctrlKey&&event.altKey&&event.key.toLowerCase()==='u'){event.preventDefault();clearHover();setActivity(value=>!value);}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
 const groups=state.sidebar?.groups||[],preferences=state.sidebar?.preferences||{id:'sidebar',groupBy:'folders',sort:'updated',visibility:'active',stateDays:7} as SidebarPreferences;
 const turns=state.turns,chat=state.chats.find(c=>c.id===selected),stamp=chat?chatStamp(chat,turns):'';
 async function run(action:()=>Promise<any>){try{setError('');await action();}catch(error){setError(String(error).replace(/^Error invoking remote method 'app': (?:Error: )?/,''));}}
 function closeMenu(){setMenu(null);returnFocus.current?.focus();}
 const change=(action:string,args:any)=>run(async()=>{closeMenu();await call('sidebarChat',{action,...args});});
 const groupChange=(action:string,args:any)=>run(async()=>{closeMenu();await call('sidebarGroup',{action,...args});});
 const prefs=(patch:Partial<SidebarPreferences>)=>run(()=>call('sidebarSettings',patch));
 function openMenu(event:React.MouseEvent,id:string,kind:Menu['kind']){if(batchLock.current)return;if(kind==='chat'&&!picked.includes(id)){setPicked([id]);anchor.current=id;}event.preventDefault();event.stopPropagation();clearHover();returnFocus.current=(event.currentTarget.querySelector('button')||event.currentTarget) as HTMLElement;const box=event.currentTarget.getBoundingClientRect();setMenu({kind,id,x:event.clientX||box.left+18,y:event.clientY||box.top+24});}
 function openEdit(value:Edit){setMenu(null);setError('');setEdit(value);}
 useEffect(()=>{if(edit)dialog.current?.querySelector<HTMLInputElement>('input')?.select();},[edit?.kind,edit?.id]);

 useEffect(()=>{if(!chat)return;const read=()=>{if(document.hasFocus()&&document.visibilityState==='visible')void run(()=>call('sidebarChat',{action:'read',chatId:chat.id,unread:false}));};read();window.addEventListener('focus',read);return()=>window.removeEventListener('focus',read);},[selected,stamp]);
 async function submitEdit(event:React.FormEvent){event.preventDefault();if(!edit)return;setBusy(true);await run(async()=>{
  if(edit.kind==='delete-chats')await batch('delete',{},edit.ids);
  else if(edit.kind==='new-group')await call('sidebarGroup',{action:'create',name:edit.value});
  else if(edit.kind.endsWith('-group'))await call('sidebarGroup',{action:edit.kind==='delete-group'?'delete':'rename',id:edit.id,name:edit.value});
  else{const result=await call('sidebarChat',{action:edit.kind==='delete-chat'?'delete':'rename',chatId:edit.id,name:edit.value});if(result?.worktree)worktreeKept(result.worktree);}
  setEdit(null);returnFocus.current?.focus();
 });setBusy(false);}
 const menuChat=state.chats.find(c=>c.id===menu?.id),menuGroup=groups.find(g=>g.id===menu?.id);
 let rows=state.chats.filter(c=>!c.sideSourceId&&(!appFilter||!!state.savedApps?.find(a=>a.id===appFilter)?.chatIds.includes(c.id))&&!c.parentChatId&&(preferences.visibility==='all'||(preferences.visibility==='archived')===!!c.archived)&&c.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
 rows=rows.sort((a,b)=>preferences.sort==='name'?a.title.localeCompare(b.title):preferences.sort==='manual'?(a.position||0)-(b.position||0):preferences.sort==='created'?(b.created||0)-(a.created||0):chatUpdated(b,turns)-chatUpdated(a,turns));
 if(activity)rows=rows.sort((a,b)=>chatUpdated(b,turns)-chatUpdated(a,turns));
 const pinned=rows.filter(c=>c.pinned&&!c.archived),rest=rows.filter(c=>!pinned.includes(c));
 const sections:{id:string;label:string;rows:Chat[];group?:SidebarGroup}[]=[];
 if(activity){
  const priority=rest.filter(c=>chatUnread(c,turns)||['Working','Needs input','Needs attention'].includes(chatState(c,turns)));
  if(priority.length)sections.push({id:'priority',label:'Priority',rows:priority});
  for(const c of rest.filter(c=>!priority.includes(c))){const updated=chatUpdated(c,turns),today=new Date().setHours(0,0,0,0),yesterday=new Date().setHours(-24,0,0,0);const label=updated>=today?'Today':updated>=yesterday?'Yesterday':'Earlier';let section=sections.find(s=>s.id===label);if(!section){section={id:label,label,rows:[]};sections.push(section);}section.rows.push(c);}
 }else if(preferences.groupBy==='folders'){
  sections.push(...groups.map(g=>({id:g.id,label:g.name,rows:rest.filter(c=>c.groupId===g.id),group:g})));
  sections.push({id:'ungrouped',label:'Ungrouped',rows:rest.filter(c=>!c.groupId||!groups.some(g=>g.id===c.groupId))});
 }else if(preferences.groupBy==='none')sections.push({id:'all',label:'Chats',rows:rest});
 else for(const row of rest){
  const age=(Date.now()-chatUpdated(row,turns))/86400000;
  const label=preferences.groupBy==='date'?(chatUpdated(row,turns)>=new Date().setHours(0,0,0,0)?'Today':chatUpdated(row,turns)>=new Date().setHours(-24,0,0,0)?'Yesterday':age<7?'Previous 7 days':'Older'):preferences.groupBy==='state'?(age>preferences.stateDays?'Older':chatState(row,turns)):(state.projects.find(p=>p.id===row.projectId)?.folder||'No working folder');
  let section=sections.find(s=>s.label===label);if(!section){section={id:label,label,rows:[]};sections.push(section);}section.rows.push(row);
 }
 const visibleIds=[...pinned,...sections.flatMap(section=>section.group?.collapsed&&!search?[]:section.rows)].map(c=>c.id);
 const visibleKey=visibleIds.join('\0');
 useEffect(()=>{setPicked(ids=>{const next=ids.filter(id=>visibleIds.includes(id));return next.length===ids.length?ids:next;});if(anchor.current&&!visibleIds.includes(anchor.current))anchor.current=null;},[visibleKey]);
 function pick(event:{ctrlKey:boolean;metaKey:boolean;shiftKey:boolean},id:string){
  if(batchLock.current)return;clearHover();setDropNotice('');const toggle=event.ctrlKey||event.metaKey;
  if(event.shiftKey){const start=visibleIds.indexOf(anchor.current||selected),end=visibleIds.indexOf(id),range=visibleIds.slice(Math.min(start<0?end:start,end),Math.max(start<0?end:start,end)+1);setPicked(ids=>toggle?[...new Set([...ids,...range])]:range);if(!anchor.current)anchor.current=visibleIds[start]||id;}
  else if(toggle){setPicked(ids=>{const prior=ids.length?ids:visibleIds.includes(selected)?[selected]:[];return prior.includes(id)?prior.filter(value=>value!==id):[...prior,id];});anchor.current=id;}
  else {setPicked([id]);anchor.current=id;choose(id);void change('read',{chatId:id,unread:false});}
 }
 function selectionKeys(event:React.KeyboardEvent){
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('.chat-link');if(!button||batchLock.current)return;
  const id=button.closest<HTMLElement>('[data-chat-id]')!.dataset.chatId!;
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){event.preventDefault();event.stopPropagation();setPicked(visibleIds);anchor.current=id;}
  else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setPicked([]);anchor.current=null;clearHover();}
  else if(event.shiftKey&&['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();event.stopPropagation();const next=visibleIds[Math.max(0,Math.min(visibleIds.length-1,visibleIds.indexOf(id)+(event.key==='ArrowDown'?1:-1)))];pick(event,next);Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-chat-id]')).find(row=>row.dataset.chatId===next)?.querySelector<HTMLButtonElement>('.chat-link')?.focus();}
 }
 async function batch(action:string,args:any={},ids=picked){
  if(batchLock.current)return;batchLock.current=true;setBusy(true);closeMenu();clearHover();
  const failed:string[]=[],messages:string[]=[],kept:string[]=[];
  try{for(const chatId of [...new Set(ids)]){try{const result=action==='link-app'?await call('savedAppLink',{id:args.id,chatId,linked:true}):await call('sidebarChat',{action,...args,chatId});if(result?.worktree)kept.push(result.worktree);}catch(error){failed.push(chatId);messages.push((state.chats.find(c=>c.id===chatId)?.title||'Chat')+': '+String(error).replace(/^Error invoking remote method 'app': (?:Error: )?/,''));}}
   if(kept.length)worktreeKept(kept);setPicked(failed);
   if(failed.length){if(action==='delete')setEdit(value=>value?.kind==='delete-chats'?{...value,ids:failed,value:failed.length+' chats'}:value);throw Error(messages.join('\n'));}
  }finally{batchLock.current=false;setBusy(false);}
 }
 function acceptsChat(event:React.DragEvent){return !batchLock.current&&event.dataTransfer.types.some(type=>type==='application/x-trismegistus-chats'||type==='application/x-trismegistus-chat');}
 function chatDropProps(target:ChatDrop){
  const key=target.kind+':'+(target.id||'')+':'+(target.beforeId||'');
  return {'data-drop-active':dropTarget===key,onDragOver:(event:React.DragEvent)=>{if(!acceptsChat(event))return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';clearHover();setDropTarget(key);},onDragLeave:(event:React.DragEvent)=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setDropTarget(value=>value===key?'':value);},onDrop:(event:React.DragEvent)=>drop(event,target)};
 }
 function drop(event:React.DragEvent,target:ChatDrop){
  if(!acceptsChat(event))return;event.preventDefault();event.stopPropagation();setDropTarget('');setDropNotice('');
  let ids:string[];try{const list=event.dataTransfer.getData('application/x-trismegistus-chats');ids=list?JSON.parse(list):[event.dataTransfer.getData('application/x-trismegistus-chat')];if(!Array.isArray(ids))return;ids=[...new Set(ids.filter(id=>typeof id==='string'&&visibleIds.includes(id)))];}catch{return;}
  const beforeId=ids.includes(target.beforeId||'')?undefined:target.beforeId,app=target.kind==='app'?state.savedApps?.find(app=>app.id===target.id):null;
  if(!ids.length||target.kind==='app'&&!app)return;
  void run(async()=>{
   if(target.kind==='app')await batch('link-app',{id:target.id},ids);
   else {await batch(target.kind==='pin'?'pin':'move',target.kind==='pin'?{pinned:true}:{groupId:target.id||null},ids);if(beforeId&&preferences.sort==='manual')for(const chatId of ids)await call('sidebarChat',{action:'reorder',chatId,beforeId});}
   setDropNotice(ids.length+' chat'+(ids.length===1?'':'s')+(app?' linked to '+app.name:target.kind==='pin'?' pinned':' moved'));
  });
 }
 function chatRow(c:Chat){const last=turns.filter(t=>t.chatId===c.id).at(-1);const unread=chatUnread(c,turns),status=chatState(c,turns);return <div key={c.id} className={'sidebar-chat '+(c.id===selected?'current ':'')+(unread?'unread ':'')+(picked.includes(c.id)?'is-picked':'')} data-chat-id={c.id} onMouseEnter={event=>showHover(event,c.id)} onMouseLeave={clearHover} onFocus={event=>showHover(event,c.id)} onBlur={clearHover} draggable onDragStart={event=>{if(batchLock.current){event.preventDefault();return;}clearHover();closeMenu();setDropNotice('');const ids=picked.includes(c.id)?picked:[c.id];setPicked(ids);event.dataTransfer.setData('application/x-trismegistus-chats',JSON.stringify(visibleIds.filter(id=>ids.includes(id))));event.dataTransfer.setData('application/x-trismegistus-chat',c.id);event.dataTransfer.effectAllowed='move';}} onDragEnd={()=>setDropTarget('')} {...chatDropProps({kind:c.pinned&&!c.archived?'pin':'folder',id:c.groupId||null,beforeId:c.id})} onContextMenu={event=>openMenu(event,c.id,'chat')}>
  <button className={'chat-link '+(c.id===selected?'current':'')} aria-describedby={hover?.id===c.id?'sidebar-chat-tooltip':undefined} aria-current={c.id===selected?'page':undefined} aria-pressed={picked.includes(c.id)} onClick={event=>pick(event,c.id)}><span className={'chat-state '+(status==='Working'?'working':status==='Needs input'?'waiting':'')} title={unread?'Unread · '+status:status} aria-label={unread?'Unread · '+status:status}>{status==='Working'?<span className="kit-spinner" aria-hidden="true"/>:status==='Needs input'?'!':''}</span><span className="sidebar-chat-copy"><span className="sidebar-chat-title">{c.title}</span>{activity&&<span className="sidebar-chat-preview">{last?.text||last?.prompt||chatState(c,turns)}</span>}</span>{c.archived&&<small>Archived</small>}{unread&&<span className="unread-dot" aria-hidden="true"/>}</button><button className="sidebar-more" aria-label={'Actions for '+c.title} onClick={event=>openMenu(event,c.id,'chat')}><SidebarIcon name="more"/></button>
 </div>;}
 const hoverChat=state.chats.find(c=>c.id===hover?.id);
 const menuSelection=menuChat&&picked.includes(menuChat.id)?state.chats.filter(c=>picked.includes(c.id)):[];
 const bulk=menuSelection.length>1;
 const appLinks=(chats:Chat[]):MenuItem=>({label:'Apps',icon:'models',children:(state.savedApps||[]).map(app=>{const linked=chats.every(chat=>app.chatIds.includes(chat.id));return {label:(linked?'Unlink from ':'Link to ')+app.name,icon:'models',checked:linked,action:()=>void run(async()=>{closeMenu();for(const chat of chats)await call('savedAppLink',{id:app.id,chatId:chat.id,linked:!linked});})};})});
 const items:MenuItem[]=menu?.kind==='new'?[
  {label:'New project',icon:'plus',action:()=>{closeMenu();void run(()=>create());}},
  {label:'New chat in a worktree',icon:'fork',action:()=>{closeMenu();worktree();}},
 ]:bulk?[
  ...((state.savedApps||[]).length?[appLinks(menuSelection)]:[]),
  {label:menuSelection.every(c=>c.pinned)?'Unpin':'Pin',icon:'pin',key:'P',action:()=>void run(()=>batch('pin',{pinned:!menuSelection.every(c=>c.pinned)}))},
  {label:'Mark as '+(menuSelection.every(c=>chatUnread(c,turns))?'read':'unread'),icon:'eye',key:'U',action:()=>void run(()=>batch('read',{unread:!menuSelection.every(c=>chatUnread(c,turns))}))},
  {label:'Move to folder',icon:'folder',children:[{label:'Ungrouped',icon:'folder',action:()=>void run(()=>batch('move',{groupId:null}))},...groups.map(g=>({label:g.name,icon:'folder' as const,action:()=>void run(()=>batch('move',{groupId:g.id}))}))]},
  {label:menuSelection.every(c=>c.archived)?'Restore':'Archive',icon:'archive',key:'A',separator:true,action:()=>void run(()=>batch('archive',{archived:!menuSelection.every(c=>c.archived)}))},
  {label:'Delete',icon:'trash',key:'D',danger:true,action:()=>openEdit({kind:'delete-chats',ids:menuSelection.map(c=>c.id),value:menuSelection.length+' chats'})},
  {label:'Clear selection',icon:'check',separator:true,action:()=>{closeMenu();setPicked([]);anchor.current=null;}},
 ]:menuChat?[
  ...((state.savedApps||[]).length?[appLinks([menuChat])]:[]),
  {label:'Rename',icon:'rename',key:'R',action:()=>openEdit({kind:'rename-chat',id:menuChat.id,value:menuChat.title})},
  {label:menuChat.pinned?'Unpin':'Pin',icon:'pin',key:'P',action:()=>void change('pin',{chatId:menuChat.id,pinned:!menuChat.pinned})},
  {label:'Mark as '+(chatUnread(menuChat,turns)?'read':'unread'),icon:'eye',key:'U',action:()=>void change('read',{chatId:menuChat.id,unread:!chatUnread(menuChat,turns)})},
  {label:'Move to folder',icon:'folder',children:[{label:'Ungrouped',icon:'folder',checked:!menuChat.groupId,action:()=>void change('move',{chatId:menuChat.id,groupId:null})},...groups.map(g=>({label:g.name,icon:'folder' as const,checked:menuChat.groupId===g.id,action:()=>void change('move',{chatId:menuChat.id,groupId:g.id})}))]},
  {label:'Export chat…',icon:'files',action:()=>{closeMenu();setExportChat(menuChat.id);}},
  {label:'Fork to new chat',icon:'fork',key:'F',separator:true,action:()=>void run(async()=>{closeMenu();choose(await call('sidebarChat',{action:'fork',chatId:menuChat.id}));})},
  {label:'New chat in a worktree',icon:'fork',action:()=>{closeMenu();worktree();}},
  {label:'Open in',icon:'terminal',separator:true,children:[{label:'Split view',icon:'preview',key:'1',action:()=>{closeMenu();split(menuChat.id);}},{label:'New pane',icon:'preview',key:'5',action:()=>{closeMenu();pane(menuChat.id);}},{label:'New window',icon:'preview',key:'2',action:()=>void run(async()=>{closeMenu();await call('openChatWindow',{chatId:menuChat.id});})},{label:'Open in terminal',icon:'terminal',key:'4',action:()=>{closeMenu();choose(menuChat.id);terminal(menuChat.id);}},{label:'Open in Explorer',icon:'folder',key:'3',action:()=>void run(async()=>{closeMenu();await call('workspaceExplorer');})}]},
  {label:'Move up',icon:'up',action:()=>void change('reorder',{chatId:menuChat.id,beforeId:rows[Math.max(0,rows.findIndex(c=>c.id===menuChat.id)-1)]?.id})},
  {label:'Move down',icon:'down',action:()=>void change('reorder',{chatId:menuChat.id,beforeId:rows[rows.findIndex(c=>c.id===menuChat.id)+2]?.id})},
  {label:menuChat.archived?'Restore':'Archive',icon:'archive',key:'A',separator:true,action:()=>void change('archive',{chatId:menuChat.id,archived:!menuChat.archived})},
  {label:'Delete',icon:'trash',key:'D',danger:true,action:()=>openEdit({kind:'delete-chat',id:menuChat.id,value:menuChat.title})},
 ]:menuGroup?[
  {label:'Rename folder',icon:'rename',key:'R',action:()=>openEdit({kind:'rename-group',id:menuGroup.id,value:menuGroup.name})},
  {label:'Move up',icon:'up',action:()=>void groupChange('move',{id:menuGroup.id,beforeId:groups[Math.max(0,groups.findIndex(g=>g.id===menuGroup.id)-1)]?.id})},
  {label:'Move down',icon:'down',action:()=>void groupChange('move',{id:menuGroup.id,beforeId:groups[groups.findIndex(g=>g.id===menuGroup.id)+2]?.id})},
  {label:'Delete folder',icon:'trash',key:'D',danger:true,separator:true,action:()=>openEdit({kind:'delete-group',id:menuGroup.id,value:menuGroup.name})},
 ]:[];
 return <>{exportChat&&<ExportChatDialog chatId={exportChat} close={()=>setExportChat(null)}/>}<nav className="app-rail" aria-label="App navigation"><button className="sidebar-toggle" title={collapsed?'Show sidebar':'Hide sidebar'} aria-label="Sidebar" aria-expanded={!collapsed} onClick={toggleSidebar}><SidebarIcon name="panel"/></button><button title="Chats" aria-label="Chats" onClick={()=>settings(undefined)}><SidebarIcon name="chats"/></button><hr/>{([['plugins','Plugins','plugins'],['skills','Skills','skills'],['models','Models','models']] as const).map(([id,label,icon])=><button key={id} aria-label={label} title={label} onClick={()=>settings(id)}><SidebarIcon name={icon}/></button>)}<button className="rail-settings" aria-label="Settings" title="Settings" onClick={()=>settings('general')}><SidebarIcon name="settings"/></button></nav><aside className={'sidebar '+(activity?'activity-view':'')} hidden={collapsed} style={{width:sidebarWidth}}>

  <SavedAppsPanel state={state} selected={appFilter} select={selectApp} call={call} chatDropProps={id=>chatDropProps({kind:'app',id})}/>
  <label className="search"><SidebarIcon name="search"/><input aria-label="Search chats" placeholder="Search" value={search} onChange={event=>setSearch(event.target.value)}/></label>
  <div className="sidebar-tools"><button className="nav" onClick={()=>void run(()=>create())} onContextMenu={event=>openMenu(event,'new','new')}><SidebarIcon name="plus"/> <span>New project</span></button><button aria-label="New sidebar folder" title="New folder" onClick={()=>openEdit({kind:'new-group',value:''})}><SidebarIcon name="folder"/></button><button aria-label="Activity view" title="Activity view · Ctrl+Alt+U" aria-pressed={activity} onClick={()=>{clearHover();setActivity(!activity);}}><SidebarIcon name="activity"/></button><details className="sidebar-filter"><summary aria-label="Sidebar filters" title="Filter and sort chats"><SidebarIcon name="filter"/></summary><div>
   <label>Show<select aria-label="Show chats" value={preferences.visibility} onChange={e=>void prefs({visibility:e.target.value as any})}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option></select></label>
   <label>Group by<select aria-label="Group chats by" value={preferences.groupBy} onChange={e=>void prefs({groupBy:e.target.value as any})}><option value="folders">Folders</option><option value="date">Date</option><option value="state">State</option><option value="working-folder">Working folder</option><option value="none">None</option></select></label>
   <label>Sort by<select aria-label="Sort chats by" value={preferences.sort} onChange={e=>void prefs({sort:e.target.value as any})}><option value="updated">Last activity</option><option value="created">Date created</option><option value="name">Name</option><option value="manual">Manual</option></select></label>
   {preferences.groupBy==='state'&&<label>Recent activity<select value={preferences.stateDays} onChange={e=>void prefs({stateDays:Number(e.target.value) as any})}>{[1,3,7,30].map(n=><option key={n} value={n}>{n} {n===1?'day':'days'}</option>)}</select></label>}
  </div></details></div>
  <span className="sidebar-selection-status" role="status" aria-live="polite">{dropNotice||(picked.length?picked.length+' chat'+(picked.length===1?'':'s')+' selected':'')}</span><div className="projects" onScroll={clearHover} onKeyDown={selectionKeys}><section className="sidebar-section sidebar-pinned" aria-label="Pinned chats" {...chatDropProps({kind:'pin'})}><div className="group-label"><SidebarIcon name="pin"/>Pinned</div>{pinned.map(chatRow)}{!pinned.length&&<p className="sidebar-drop-hint">Drop a chat here to pin it</p>}</section>{sections.map(section=><section className="sidebar-section" key={section.id} data-group-id={section.group?.id||''} onDragOver={event=>{if(event.dataTransfer.types.some(t=>t.startsWith('application/x-trismegistus-')))event.preventDefault();}} onDrop={event=>{if((event.target as HTMLElement).closest('.sidebar-chat'))return;const id=event.dataTransfer.getData('application/x-trismegistus-group');if(id&&id!==section.group?.id&&section.group)void groupChange('move',{id,beforeId:section.group.id});else if(!activity&&preferences.groupBy==='folders')drop(event,{kind:'folder',id:section.group?.id||null});}}>
   <div className="sidebar-group-heading" draggable={!!section.group} onDragStart={event=>{if(section.group)event.dataTransfer.setData('application/x-trismegistus-group',section.group.id);}} onContextMenu={event=>{if(section.group)openMenu(event,section.group.id,'group');}}>{section.group?<button className="group-label" aria-expanded={!section.group.collapsed} onClick={()=>void groupChange('collapse',{id:section.group!.id,collapsed:!section.group!.collapsed})}><SidebarIcon name="folder"/><span className="folder-name">{section.label}</span><span className={section.group.collapsed?"folder-chevron":"folder-chevron expanded"}><SidebarIcon name="right"/></span><small>{section.rows.length}</small></button>:<div className="group-label">{section.label}</div>}{section.group&&<><button aria-label={'New chat in '+section.label} onClick={()=>void run(()=>create(section.group!.id))}><SidebarIcon name="plus"/></button><button className="sidebar-more" aria-label={'Actions for folder '+section.label} onClick={event=>openMenu(event,section.group!.id,'group')}><SidebarIcon name="more"/></button></>}</div>
   {(!section.group?.collapsed||!!search)&&section.rows.map(chatRow)}
  </section>)}{!rows.length&&<p className="sidebar-empty">{search?'No matching chats.':preferences.visibility==='archived'?'No archived chats.':'No chats yet.'}</p>}</div>
  {error&&!edit&&<div className="sidebar-error" role="alert">{error}<button aria-label="Dismiss sidebar error" onClick={()=>setError('')}>×</button></div>}
  <button className="settings-link" onClick={()=>settings('general')}><span className="avatar">☿</span><span>Settings</span><SidebarIcon name="settings"/></button>
  {menu&&<SidebarMenu x={menu.x} y={menu.y} label={bulk?'Selected chat actions':menu.kind==='chat'?'Chat actions':'Folder actions'} items={items} close={closeMenu}/>}
  {hover&&hoverChat&&!menu&&!edit&&<SidebarHoverCard title={hoverChat.title} folder={groups.find(g=>g.id===hoverChat.groupId)?.name||'Ungrouped'} status={chatState(hoverChat,turns)} updated={chatUpdated(hoverChat,turns)} anchor={hover.anchor}/>}
  {edit&&<Dialog title={edit.kind==='new-group'?'New folder':edit.kind==='delete-group'?'Delete folder?':edit.kind==='delete-chats'?'Delete selected chats?':edit.kind==='delete-chat'?'Delete chat?':'Rename'} className="sidebar-edit-dialog" size="sm" busy={busy} closeLabel="Close" onClose={()=>setEdit(null)}><form ref={dialog} onSubmit={event=>void submitEdit(event)}>{edit.kind.startsWith('delete')?<><p><strong>{edit.value}</strong></p>{edit.kind==='delete-chats'&&<ul>{edit.ids?.map(id=><li key={id}>{state.chats.find(c=>c.id===id)?.title||id}</li>)}</ul>}<p>{edit.kind==='delete-group'?'Its chats will move to Ungrouped.':'This removes the saved chat and its goal from Ghidorah. Working files and engine-managed history are kept.'}</p></>:<label>Name<input aria-label="Name" maxLength={100} value={edit?.value||''} onChange={event=>setEdit(edit?{...edit,value:event.target.value}:null)}/></label>}{error&&<Notice tone="danger" role="alert" className="error">{error}</Notice>}<div className="actions"><Button variant="outline" disabled={busy} onClick={()=>setEdit(null)}>Cancel</Button><Button variant={edit.kind.startsWith('delete')?'danger':'primary'} disabled={busy||!edit.value.trim()} type="submit">{edit.kind.startsWith('delete')?'Delete':edit.kind==='new-group'?'Create folder':'Save'}</Button></div></form></Dialog>}
  <div className="sidebar-resizer" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" aria-valuemin={210} aria-valuemax={maxWidth} aria-valuenow={sidebarWidth} tabIndex={0} title="Drag to resize · Double-click to reset"
   onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.focus();resizing.current={pointer:event.pointerId,x:event.clientX,width:sidebarWidth,latest:sidebarWidth,previous:preferredWidth};event.currentTarget.setPointerCapture(event.pointerId);}}
   onPointerMove={event=>{const drag=resizing.current;if(!drag||drag.pointer!==event.pointerId)return;drag.latest=clampWidth(drag.width+event.clientX-drag.x);setPreferredWidth(drag.latest);}}
   onPointerUp={event=>endResize(event.currentTarget)} onPointerCancel={event=>endResize(event.currentTarget,true)} onLostPointerCapture={event=>endResize(event.currentTarget,true)} onDoubleClick={()=>saveWidth(null)}
   onKeyDown={event=>{if(event.key==='Escape'){endResize(event.currentTarget,true);return;}const next=event.key==='ArrowLeft'?sidebarWidth-16:event.key==='ArrowRight'?sidebarWidth+16:event.key==='Home'?210:event.key==='End'?maxWidth:null;if(next!==null){event.preventDefault();saveWidth(clampWidth(next));}else if(event.key==='Enter'){event.preventDefault();saveWidth(null);}}}/>
 </aside></>;
}
