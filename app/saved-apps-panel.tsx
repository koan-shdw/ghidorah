import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';

import type {Snapshot} from './types';

import type {SavedApp} from './saved-apps';

import {chatState} from './sidebar';

import {Button,Dialog,Notice,SidebarIcon,SidebarMenu,type MenuItem} from './kit';

const appDragType='application/x-trismegistus-app';

type FolderEdit={action:'create'|'rename'|'remove';id?:string;name:string;appId?:string};



export function SavedAppsPanel({state,selected,select,call,chatDropProps}:{chatDropProps:(id:string)=>React.HTMLAttributes<HTMLDivElement>;state:Snapshot;selected:string|null;select:(id:string|null,rename?:boolean)=>void;call:(method:string,args?:any)=>Promise<any>}){

 const apps=state.savedApps||[],[collapsed,setCollapsed]=useState(()=>localStorage.getItem('saved-apps-collapsed')==='true'),[hover,setHover]=useState<{app:SavedApp;box:DOMRect}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');

 const groups=state.savedAppGroups||[];

 const [menu,setMenu]=useState<{id:string;kind:'app'|'folder'|'section';x:number;y:number}|null>(null),[removing,setRemoving]=useState<string|null>(null);

 const [folderEdit,setFolderEdit]=useState<FolderEdit|null>(null),[dragging,setDragging]=useState(false),[dropTarget,setDropTarget]=useState('');

 const folderDialog=useRef<HTMLFormElement>(null);

 const panel=useRef<HTMLElement>(null),returnFocus=useRef<HTMLElement|null>(null),card=useRef<HTMLDivElement>(null),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);

 async function add(){hide();setBusy(true);setError('');try{const app=await call('savedAppSave',{name:'New app'});setCollapsed(false);select(app.id);}catch(e){setError(String(e));}finally{setBusy(false);}}

 function hide(){clearTimeout(timer.current);setHover(null);}

 function show(app:SavedApp,element:HTMLElement){if(menu||removing||folderEdit||dragging)return;clearTimeout(timer.current);const box=element.getBoundingClientRect();timer.current=setTimeout(()=>setHover({app,box}),300);}

 function restoreFocus(){if(returnFocus.current?.isConnected)returnFocus.current.focus();else panel.current?.querySelector<HTMLButtonElement>('[aria-label="Add saved app"]')?.focus();}

 async function resetIcon(id:string){closeMenu();setBusy(true);setError('');try{await call('savedAppSave',{id,icon:''});}catch(e){setError(String(e).replace(/^Error invoking remote method 'app': (?:Error: )?/,''));}finally{setBusy(false);}}
 function closeMenu(){hide();setMenu(null);restoreFocus();}

 function openMenu(id:string,element:HTMLElement,x?:number,y?:number,kind:'app'|'folder'|'section'='app'){if(busy)return;hide();setError('');returnFocus.current=element;const box=element.getBoundingClientRect();setMenu({id,kind,x:x??box.left,y:y??box.bottom+4});}

 function editFolder(edit:FolderEdit){hide();setMenu(null);setError('');setFolderEdit(edit);}

 function cancelFolder(){if(busy)return;setFolderEdit(null);setError('');restoreFocus();}

 async function folderAction(args:any){if(busy)return false;hide();setMenu(null);setBusy(true);setError('');try{await call('savedAppGroup',args);return true;}catch(e){setError(String(e).replace(/^Error invoking remote method 'app': (?:Error: )?/,''));return false;}finally{setBusy(false);}}

 async function saveFolder(event:React.FormEvent){event.preventDefault();if(folderEdit&&await folderAction(folderEdit)){setFolderEdit(null);setCollapsed(false);requestAnimationFrame(restoreFocus);}}

 async function moveApp(appId:string,groupId:string|null){setDragging(false);setDropTarget('');if(await folderAction({action:'move',appId,groupId}))requestAnimationFrame(restoreFocus);}

 function folderDrop(groupId:string|null):React.HTMLAttributes<HTMLDivElement>{return {

  'data-drop-active':dropTarget===(groupId||'top'),

  onDragOver:event=>{if(!event.dataTransfer.types.includes(appDragType))return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';hide();setMenu(null);setDropTarget(groupId||'top');},

  onDragLeave:event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDropTarget('');},

  onDrop:event=>{if(!event.dataTransfer.types.includes(appDragType))return;event.preventDefault();event.stopPropagation();const id=event.dataTransfer.getData(appDragType);if(apps.some(app=>app.id===id))void moveApp(id,groupId);}

 } as React.HTMLAttributes<HTMLDivElement>;}

 function openPage(id:string,rename=false){hide();setMenu(null);select(id,rename);}

 function cancelRemove(){if(busy)return;setRemoving(null);setError('');restoreFocus();}

 async function remove(){if(!removing||busy)return;setBusy(true);setError('');try{await call('savedAppRemove',{id:removing});if(selected===removing)select(null);setRemoving(null);requestAnimationFrame(restoreFocus);}catch(e){setError(String(e).replace(/^Error invoking remote method 'app': (?:Error: )?/,''));}finally{setBusy(false);}}


 useEffect(()=>{if(menu&&menu.kind!=='section'&&!(menu.kind==='app'?apps:groups).some(row=>row.id===menu.id))closeMenu();if(removing&&!apps.some(app=>app.id===removing))setRemoving(null);},[apps,groups,menu?.id,removing]);

 useEffect(()=>{if(folderEdit)folderDialog.current?.querySelector('input')?.select();},[folderEdit?.action,folderEdit?.id,folderEdit?.appId]);

 useEffect(()=>{localStorage.setItem('saved-apps-collapsed',String(collapsed));},[collapsed]);

 useEffect(()=>()=>clearTimeout(timer.current),[]);

 useLayoutEffect(()=>{if(!hover||!card.current)return;const el=card.current;el.style.left=Math.max(8,Math.min(hover.box.right+10,innerWidth-el.offsetWidth-8))+'px';el.style.top=Math.max(8,Math.min(hover.box.top,innerHeight-el.offsetHeight-8))+'px';},[hover]);

 const linked=hover?state.chats.filter(c=>hover.app.chatIds.includes(c.id)):[],latest=hover?state.turns.filter(t=>hover.app.chatIds.includes(t.chatId)).sort((a,b)=>b.created-a.created)[0]:null;

 const working=linked.filter(c=>chatState(c,state.turns)==='Working').length,waiting=linked.filter(c=>chatState(c,state.turns)==='Needs input').length;

 const menuApp=menu?.kind==='app'?apps.find(app=>app.id===menu.id):undefined,menuGroup=menu?.kind==='folder'?groups.find(group=>group.id===menu.id):undefined,removeApp=apps.find(app=>app.id===removing);

 const items:MenuItem[]=menuApp?[{label:'Open app page',icon:'models',action:()=>openPage(menuApp.id)},{label:'Rename',icon:'rename',key:'R',action:()=>openPage(menuApp.id,true)},...(menuApp.icon?[{label:'Use initials for icon',icon:'models' as const,action:()=>void resetIcon(menuApp.id)}]:[]),{label:'Move to folder',icon:'folder',children:[{label:'No folder · keep at top',icon:'models',checked:!groups.some(group=>group.id===menuApp.groupId),action:()=>void moveApp(menuApp.id,null)},...groups.map(group=>({label:group.name,icon:'folder' as const,checked:menuApp.groupId===group.id,action:()=>void moveApp(menuApp.id,group.id)})),{label:'New folder…',icon:'plus',separator:true,action:()=>editFolder({action:'create',name:'',appId:menuApp.id})}]},{label:'Remove app…',icon:'trash',key:'D',danger:true,separator:true,action:()=>{hide();setMenu(null);setRemoving(menuApp.id);setError('');}}]:menuGroup?[{label:'Rename folder',icon:'rename',action:()=>editFolder({action:'rename',id:menuGroup.id,name:menuGroup.name})},{label:'Remove folder…',icon:'trash',separator:true,action:()=>editFolder({action:'remove',id:menuGroup.id,name:menuGroup.name})}]:menu?.kind==='section'?[{label:'New folder…',icon:'folder',action:()=>editFolder({action:'create',name:''})}]:[];

 const ungrouped=apps.filter(app=>!groups.some(group=>group.id===app.groupId));
 const grid=(entries:SavedApp[])=>entries.length?<div className="saved-app-grid" onScroll={()=>{hide();setMenu(null);}}>{entries.map((app,index)=><div className="saved-app-tile" key={app.id} data-saved-app-id={app.id} {...chatDropProps(app.id)} draggable onDragStart={event=>{hide();setMenu(null);returnFocus.current=event.currentTarget.querySelector<HTMLButtonElement>('.saved-app-select');event.stopPropagation();event.dataTransfer.setData(appDragType,app.id);event.dataTransfer.effectAllowed='move';setDragging(true);}} onDragEnd={()=>{setDragging(false);setDropTarget('');}} onDragOver={event=>{if(event.dataTransfer.types.includes(appDragType))return;hide();setMenu(null);chatDropProps(app.id).onDragOver?.(event);}} style={{'--tile':index} as React.CSSProperties} onContextMenu={event=>{event.preventDefault();event.stopPropagation();openMenu(app.id,event.currentTarget.querySelector<HTMLButtonElement>('.saved-app-select')!,event.clientX||undefined,event.clientY||undefined);}}><button className="saved-app-select" aria-label={'Show chats for '+app.name} aria-pressed={selected===app.id} aria-haspopup="menu" aria-describedby={hover?.app.id===app.id?'saved-app-tooltip':undefined} onMouseEnter={e=>show(app,e.currentTarget)} onMouseLeave={hide} onFocus={e=>show(app,e.currentTarget)} onBlur={hide} onClick={()=>openPage(app.id)} onKeyDown={event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();event.stopPropagation();openMenu(app.id,event.currentTarget);}}}><span className="saved-app-icon">{app.icon?<img alt="" src={app.icon} draggable={false}/>:<span>{app.name.slice(0,2).toUpperCase()}</span>}<i className={state.chats.some(c=>app.chatIds.includes(c.id)&&chatState(c,state.turns)==='Working')?'app-working':''}/></span><span className="app-dots"><span className={'app-light '+(app.light?.state||'unknown')} aria-hidden="true"/>{app.watch?.running?<span className="app-watch-dot checking" role="img" aria-label="Checking for updates" title="Checking for updates"/>:app.watchUnread&&<span className="app-watch-dot" role="img" aria-label="New updates to review" title="New updates to review"/>}</span><span className="saved-app-name">{app.name}</span></button><button className="saved-app-edit" aria-label={'Actions for app '+app.name} aria-haspopup="menu" aria-expanded={menu?.id===app.id} title={'Actions for '+app.name} onMouseEnter={hide} onFocus={hide} onClick={event=>{event.stopPropagation();openMenu(app.id,event.currentTarget);}}><SidebarIcon name="more"/></button></div>)}</div>:null;

 return <section ref={panel} className="saved-apps" aria-label="Saved apps" onContextMenu={event=>{if((event.target as HTMLElement).closest('dialog,.sidebar-menu-frame'))return;event.preventDefault();event.stopPropagation();openMenu('',(event.target as HTMLElement).closest<HTMLElement>('button')||event.currentTarget.querySelector('button')!,event.clientX||undefined,event.clientY||undefined,'section');}} onKeyDown={event=>{if(event.defaultPrevented||(event.target as HTMLElement).closest('dialog,.sidebar-menu-frame'))return;if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();event.stopPropagation();openMenu('',event.target as HTMLElement,undefined,undefined,'section');}}}><header><button aria-expanded={!collapsed} onClick={()=>{hide();setMenu(null);setCollapsed(!collapsed);}}><span className={collapsed?'folder-chevron':'folder-chevron expanded'}><SidebarIcon name="right"/></span>Apps <small>{apps.length}</small></button><div className="saved-app-header-actions"><button aria-label="New app folder" title="New app folder" disabled={busy} onClick={event=>{returnFocus.current=event.currentTarget;editFolder({action:'create',name:''});}}><SidebarIcon name="folder"/></button><button aria-label="Add saved app" title="Add app" disabled={busy} onClick={()=>void add()}><SidebarIcon name="plus"/></button></div></header>

 {!collapsed&&<><div className="saved-app-sections" onScroll={()=>{hide();setMenu(null);}}><div className="saved-app-ungrouped" aria-label="Apps without a folder" {...folderDrop(null)}>{!ungrouped.length&&groups.length>0&&<p className="saved-app-drop-hint">Drop apps here to keep them at the top</p>}{grid(ungrouped)}</div>{groups.map(group=>{const members=apps.filter(app=>app.groupId===group.id);return <div key={group.id} className="saved-app-folder" data-app-folder={group.id} {...folderDrop(group.id)}><div className="saved-app-folder-heading" onContextMenu={event=>{event.preventDefault();event.stopPropagation();openMenu(group.id,event.currentTarget.querySelector('button')!,event.clientX||undefined,event.clientY||undefined,'folder');}}><button className="saved-app-folder-toggle" aria-label={'App folder '+group.name} aria-expanded={!group.collapsed} aria-controls={'app-folder-'+group.id} disabled={busy} onClick={()=>void folderAction({action:'collapse',id:group.id,collapsed:!group.collapsed})} onKeyDown={event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();openMenu(group.id,event.currentTarget,undefined,undefined,'folder');}}}><span className={group.collapsed?'folder-chevron':'folder-chevron expanded'}><SidebarIcon name="right"/></span><SidebarIcon name="folder"/><span>{group.name}</span><small>{members.length}</small></button><button className="saved-app-folder-more" aria-label={'Actions for app folder '+group.name} aria-haspopup="menu" aria-expanded={menu?.kind==='folder'&&menu.id===group.id} onClick={event=>openMenu(group.id,event.currentTarget,undefined,undefined,'folder')}><SidebarIcon name="more"/></button></div><div id={'app-folder-'+group.id} hidden={group.collapsed}>{!group.collapsed&&(members.length?grid(members):<p className="saved-app-empty">Drag apps here or use Move to folder.</p>)}</div></div>;})}</div>{!apps.length&&!groups.length&&<p className="saved-app-empty">Add an app to organise its work.</p>}</>}

 {selected&&<button className="app-filter-clear" onClick={()=>select(null)}>Show all chats</button>}

 {hover&&<div ref={card} role="tooltip" id="saved-app-tooltip" className="sidebar-hover-card saved-app-card"><strong>{hover.app.name}</strong><small>{hover.app.stage||'Stage not set'}{hover.app.summary&&hover.app.summary.revision!==hover.app.summaryRevision?' · Summary out of date':''} · {working?working+' working':waiting?waiting+' waiting for input':linked.length+' linked chats'}{hover.app.light&&' · '+hover.app.light.text}</small>{([['Current work',hover.app.current||hover.app.summary?.items.filter(i=>i.kind==='current').map(i=>i.text).join(' ')||''],['Latest ideas',hover.app.ideas||hover.app.summary?.items.filter(i=>i.kind==='idea').map(i=>i.text).join(' ')||''],['Planned',hover.app.planned||hover.app.summary?.items.filter(i=>i.kind==='planned').map(i=>i.text).join(' ')||'']] as const).map(([label,value])=><section key={label}><h4>{label}</h4><p>{value||'Not recorded yet.'}</p></section>)}{latest&&<section><h4>Latest chat update</h4><p>{(latest.text||latest.prompt).slice(0,280)}</p></section>}</div>}

 {menu&&(menuApp||menuGroup||menu.kind==='section')&&<SidebarMenu key={menu.id} x={menu.x} y={menu.y} label={(menuApp?.name||menuGroup?.name||'Apps')+' actions'} items={items} close={closeMenu}/>}

 {removing&&<Dialog title={'Remove '+(removeApp?.name||'app')+'?'} id="saved-app-remove-title" className="saved-app-remove-dialog" size="sm" closeLabel="Close remove app" onClose={cancelRemove} footer={<><Button variant="outline" data-autofocus disabled={busy} onClick={cancelRemove}>Keep app</Button><Button variant="danger" disabled={busy} onClick={()=>void remove()}>{busy?'Removing…':'Remove app'}</Button></>}><p>This removes the app, its notes and to-dos from the list. Chats and project files are kept.</p>{error&&<Notice tone="danger" role="alert" className="error">{error}</Notice>}</Dialog>}

 {folderEdit&&<Dialog title={folderEdit.action==='remove'?'Remove '+folderEdit.name+'?':folderEdit.action==='rename'?'Rename app folder':'New app folder'} id="saved-app-folder-title" className="saved-app-folder-dialog" size="sm" busy={busy} closeLabel="Close app folder" onClose={cancelFolder}><form ref={folderDialog} onSubmit={saveFolder}>{folderEdit.action==='remove'?<p>Apps in this folder will move to the top. Your apps, chats and files are kept.</p>:<label>Folder name<input autoFocus required maxLength={80} value={folderEdit?.name||''} onChange={event=>setFolderEdit(edit=>edit?{...edit,name:event.target.value}:edit)}/></label>}{error&&<Notice tone="danger" role="alert" className="error">{error}</Notice>}<div className="actions"><Button variant="outline" disabled={busy} onClick={cancelFolder}>Cancel</Button><Button type="submit" variant={folderEdit.action==='remove'?'danger':'primary'} disabled={busy||folderEdit.action!=='remove'&&!folderEdit.name.trim()}>{busy?'Saving…':folderEdit.action==='remove'?'Remove folder':folderEdit.action==='rename'?'Save':'Create folder'}</Button></div></form></Dialog>}

 {error&&!removing&&!folderEdit&&<p role="alert" className="error">{error}</p>}</section>;

}

