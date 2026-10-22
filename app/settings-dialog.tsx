import React,{useLayoutEffect,useRef,useState} from 'react';
import {SidebarIcon,type IconName} from './kit';

const groups=[
 {label:'Workspace',pages:[['general','General','settings'],['models','Default models','models'],['connections','Connections','fork'],['claude-code','Claude Code','terminal']]},
 {label:'Tools',pages:[['plugins','Plugins','plugins'],['skills','Skills','skills'],['browser','Browser and computer','preview'],['images','Images','files'],['publishing','Publishing','send']]},
 {label:'Automation',pages:[['always-on','Always on','activity'],['remote','Remote','chats'],['routines','Routines','changes'],['voice','Voice','voice']]},
 {label:'Account',pages:[['security','Security','eye']]},
] as const;
export type SettingsPage=typeof groups[number]['pages'][number][0]|'chat-models';

/** One stable frame; only the page body and the navigation can scroll. */
export function SettingsDialog({page,select,close,children,closeLabel='Close settings'}:{closeLabel?:string;page:SettingsPage;select:(page:SettingsPage)=>void;close:()=>void;children:React.ReactNode}){
 const dialog=useRef<HTMLDialogElement>(null),body=useRef<HTMLDivElement>(null);
 const title=groups.flatMap(group=>[...group.pages]).find(row=>row[0]===page)?.[1]||'Chat models';
 // C16: the section list filters as you type; Enter opens the first match.
 const [query,setQuery]=useState(''),term=query.trim().toLowerCase();
 const shown=groups.map(group=>({label:group.label,pages:group.pages.filter(([,label])=>!term||label.toLowerCase().includes(term)||group.label.toLowerCase().includes(term))})).filter(group=>group.pages.length);
 useLayoutEffect(()=>{const element=dialog.current!,previous=document.activeElement as HTMLElement|null;element.showModal();return()=>{element.close();queueMicrotask(()=>{if(previous?.isConnected&&!document.querySelector('dialog[open]'))previous.focus({preventScroll:true});});};},[]);
 useLayoutEffect(()=>{if(body.current)body.current.scrollTop=0;},[page]);
 return <dialog ref={dialog} className={'settings settings-dialog'+(page==='chat-models'?' settings-model-dialog':'')} aria-labelledby="settings-title" onCancel={event=>{
  event.preventDefault();
  const menu=dialog.current?.querySelector<HTMLDetailsElement>('.choice-menu[open]');
  if(menu){menu.open=false;menu.querySelector('summary')?.focus();}else close();
 }} onClick={event=>{if(event.target!==event.currentTarget)return;const box=event.currentTarget.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)close();}}>
  <header className="settings-topbar"><h2 id="settings-title">{page==='chat-models'?'Chat models':'Settings'}</h2><button className="settings-close" aria-label={closeLabel} title={closeLabel+' · Esc'} onClick={close}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></header>
  <div className="settings-layout">
   {page!=='chat-models'&&<nav className="settings-nav" aria-label="Settings sections"><label className="settings-search"><SidebarIcon name="search"/><input type="search" aria-label="Search settings" placeholder="Search settings" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&shown[0]?.pages[0])select(shown[0].pages[0][0]);}}/></label>{shown.map(group=><div className="settings-nav-group" key={group.label}><div className="settings-nav-label">{group.label}</div>{group.pages.map(([id,label,icon])=><button key={id} aria-current={page===id?'page':undefined} onClick={()=>select(id)}><SidebarIcon name={icon as IconName}/><span>{label}</span></button>)}</div>)}{!shown.length&&<p className="settings-search-empty">No section matches.</p>}</nav>}
   <div className="settings-page" data-settings-page={page}>
    {page!=='chat-models'&&<div className="settings-page-heading"><h2>{title}</h2></div>}
    <div ref={body} className="settings-body" tabIndex={0} aria-label={title+' settings'}>{children}</div>
   </div>
  </div>
 </dialog>;
}

export function SettingsCard({title,children,className=''}:{title:string;children:React.ReactNode;className?:string}){
 return <section className={'settings-card '+className}><h3>{title}</h3>{children}</section>;
}
