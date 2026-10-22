// Share with another project (4b, SPEC F19). A right-click on a message offers "Share with…". The dialog takes
// the text selected in that message, or an AI summary of it, which Koan edits and approves; it lands in the
// chosen project's memory with its origin. Nothing else from this project moves.
import React,{useEffect,useRef,useState} from 'react';
import type {Snapshot,Turn} from './types';
import {Button,Dialog,Notice,SidebarMenu,SidebarIcon,type MenuItem} from './kit';
import {pendingTurn} from './sidebar';
import {CheckpointDialog} from './checkpoint-dialog';

type Call=(method:string,args?:any)=>Promise<any>;
interface Share {sourceTitle:string;date:string;turn:Turn;text:string;target:string;busy:boolean;error:string}

// Projects are never named: each other project is shown by its chats' titles.
export function otherProjects(state:Snapshot,chatId:string){
 const own=state.chats.find(chat=>chat.id===chatId)?.projectId;
 return (state.shareTargets||[]).filter(row=>row.projectId!==own);
}

export function useShare(state:Snapshot,call:Call,chatId:string){
 const revision=useRef(0);
 useEffect(()=>{revision.current++;setMenu(null);setShare(null);setCheckpoint(null);},[chatId]);
 const close=()=>{revision.current++;setShare(null);};
 const [menu,setMenu]=useState<{x:number;y:number;turn:Turn;selection:string}|null>(null),[share,setShare]=useState<Share|null>(null);
 const [checkpoint,setCheckpoint]=useState<string|null>(null);
 const open=(turn:Turn)=>(event:React.MouseEvent<HTMLElement>)=>{
  const selection=window.getSelection(),inside=!!selection?.anchorNode&&event.currentTarget.contains(selection.anchorNode)&&!!selection.focusNode&&event.currentTarget.contains(selection.focusNode);
  event.preventDefault();setMenu({x:event.clientX,y:event.clientY,turn,selection:inside?selection!.toString().trim():''});
 };
 async function start(turn:Turn,selection:string){
  const target=otherProjects(state,chatId)[0]?.projectId||'',request=++revision.current;
  setShare({turn,sourceTitle:state.chats.find(chat=>chat.id===chatId)?.title||'',date:new Date().toISOString().slice(0,10),text:selection,target,busy:!selection,error:''});
  if(selection)return;
  try{const summary=await call('shareSummary',{chatId,turnId:turn.id});if(request===revision.current)setShare(current=>current&&{...current,text:summary,busy:false});}
  catch(error){if(request===revision.current)setShare(current=>current&&{...current,busy:false,error:String(error).replace(/^Error invoking remote method 'app': (?:Error: )?/,'')});}
 }
 const canBranch=(turn:Turn)=>turn.chatId===chatId&&!turn.parentTurnId&&!turn.automatic&&!turn.goal?.automatic&&!turn.contextSnapshot&&state.chats.some(chat=>chat.id===chatId&&!chat.parentChatId&&!chat.sideSourceId);
 const working=state.turns.some(turn=>(turn.chatId===chatId||state.jobChats?.some(chat=>chat.id===turn.chatId&&chat.parentChatId===chatId))&&pendingTurn(turn.status));
 async function branch(turn:Turn){setMenu(null);try{await call('branchMessage',{chatId,turnId:turn.id});}catch{/* The chat displays the error. */}}
 const actions=(turn:Turn)=>canBranch(turn)?<div className="message-actions"><button disabled={working} title={working?'Finish or stop current work first':'Prepare this message in a new chat. The original stays intact.'} onClick={()=>void branch(turn)}><SidebarIcon name="rename"/>Edit / retry</button><button aria-label="Message actions" onClick={event=>{const box=event.currentTarget.getBoundingClientRect();setMenu({x:box.left,y:box.bottom,turn,selection:''});}}><SidebarIcon name="more"/></button></div>:null;
 const items:MenuItem[]=menu?[...(canBranch(menu.turn)&&!working?[{label:'Edit or retry in a new chat',icon:'rename' as const,key:'E',action:()=>void branch(menu.turn)},{label:'Restore checkpoint…',icon:'fork' as const,action:()=>{setCheckpoint(menu.turn.id);setMenu(null);}}]:[]),{label:'Share with…',icon:'fork',key:'S',action:()=>{const {turn,selection}=menu;setMenu(null);void start(turn,selection);}}]:[];
 const element=<>{menu&&<SidebarMenu x={menu.x} y={menu.y} label="Message actions" items={items} close={()=>setMenu(null)}/>}{checkpoint&&<CheckpointDialog chatId={chatId} turnId={checkpoint} call={call} close={()=>setCheckpoint(null)}/>}
  {share&&<ShareDialog share={share} projects={otherProjects(state,chatId)} change={patch=>setShare({...share,...patch})} close={close} send={async()=>{const request=++revision.current;setShare({...share,busy:true,error:''});try{await call('shareToProject',{chatId,turnId:share.turn.id,projectId:share.target,text:share.text,sourceTitle:share.sourceTitle,date:share.date});if(request===revision.current)setShare(null);}catch(error){if(request===revision.current)setShare({...share,busy:false,error:String(error).replace(/^Error invoking remote method 'app': (?:Error: )?/,'')});}}}/>}</>;
 return {open,element,actions};
}

function ShareDialog({share,projects,change,close,send}:{share:Share;projects:{projectId:string;title:string}[];change:(patch:Partial<Share>)=>void;close:()=>void;send:()=>void}){
 return <Dialog title="Share with another project" id="share-title" className="share-dialog" busy={share.busy} closeLabel="Close share" onClose={close}><form onSubmit={event=>{event.preventDefault();send();}}>
  {projects.length?<label>Project<select aria-label="Share with project" value={share.target} onChange={event=>change({target:event.target.value})}>{projects.map(row=><option key={row.projectId} value={row.projectId}>{row.title}</option>)}</select></label>:<p>No other project yet.</p>}
  <p className="hint">From “{share.sourceTitle}” in another project, {share.date}.</p>
  <label>Shared text<textarea aria-label="Shared text" rows={6} maxLength={1500} value={share.text} disabled={share.busy} placeholder={share.busy?'Summarizing…':''} onChange={event=>change({text:event.target.value})}/></label>
  <p className="hint">Saved in that project's memory with where it came from. Nothing else from this chat moves.</p>
  {share.error&&<Notice tone="danger" role="alert" className="error">{share.error}</Notice>}
  <div className="actions"><Button variant="outline" disabled={share.busy} onClick={close}>Cancel</Button><Button type="submit" variant="primary" disabled={share.busy||!share.text.trim()||!share.target}>Share</Button></div>
 </form></Dialog>;
}
