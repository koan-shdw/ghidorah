// The bar at the top of a chat that says what kind of chat it is: a new branch, a side chat, a handover. One bar and
// one look for all three (Koan 2026-11-15).
import React,{useState} from 'react';
import {Button,Dialog,Notice,SidebarIcon} from './kit';
import {sideChatNew} from './side-chat';
import {pendingTurn} from './sidebar';
import {DeleteWork} from './sidebar-panel';
import type {Chat,Snapshot} from './types';

type Call=(method:string,args?:any)=>Promise<any>;
const errorText=(error:unknown)=>String(error).replace(/^Error invoking remote method 'app': (?:Error: )?/,'');

/** The bar: an icon, the kind of chat in bold, one sentence, then its buttons. */
export function ChatNotice({title,children,actions,className,role}:{title:string;children?:React.ReactNode;actions?:React.ReactNode;className?:string;role?:'status'}){
 return <div className={'chat-notice'+(className?' '+className:'')} role={role}><SidebarIcon name="fork"/><span><strong>{title}</strong> · {children}</span>{actions}</div>;
}

/** On a branch: what was kept. On a side chat: Send to main chat, Keep as chat, and Discard, which asks first in the
 * dialog Delete uses in the sidebar, so a side chat is never thrown away without a warning. */
export function SideChatNotice({state,chat,call}:{state:Snapshot;chat?:Chat;call:Call}){
 const [asking,setAsking]=useState(false),[busy,setBusy]=useState(''),[error,setError]=useState('');
 if(chat?.branchTurnId)return <ChatNotice className="branch-notice" title="New branch">Original chat preserved. Files and external actions keep their current state. Review the message and model before sending; tools can run again.</ChatNotice>;
 if(!chat?.sideSourceId)return null;
 const own=state.turns.filter(turn=>turn.chatId===chat.id&&!turn.parentTurnId&&!turn.contextSnapshot),fresh=sideChatNew(state.turns,chat.id).length,pending=own.filter(turn=>pendingTurn(turn.status));
 // A failed command also shows in the window's own error line; the dialog repeats it, as the sidebar's dialog does.
 const run=(method:string,then?:()=>void)=>{setBusy(method);setError('');void call(method,{chatId:chat.id}).then(()=>then?.(),failure=>setError(errorText(failure))).finally(()=>setBusy(''));};
 const sendTitle=fresh?'Puts a short summary of this side chat in the main chat\'s message box, for you to edit and send':'Nothing has finished here yet';
 return <>
  <ChatNotice className="side-chat-notice" title="Side chat" actions={<>
   <button disabled={!fresh||!!busy} title={sendTitle} onClick={()=>run('sideChatSend')}>{busy==='sideChatSend'?'Writing summary…':'Send to main chat'}</button>
   <button disabled={!!busy} onClick={()=>run('sideChatKeep')}>Keep as chat</button>
   <button disabled={!!busy} onClick={()=>{setError('');setAsking(true);}}>Discard side chat</button>
  </>}>Thread snapshot from opening. Replies stay here.</ChatNotice>
  {asking&&<Dialog title="Discard side chat?" busy={!!busy} closeLabel="Close" onClose={()=>setAsking(false)}>
   <p><strong>{chat.title}</strong></p>
   <p>{own.length?'It holds '+own.length+(own.length===1?' message of yours and its reply.':' messages of yours and their replies.'):'Nothing has been asked here yet.'} Discard removes the side chat and everything in it. The main chat and your working files are kept.</p>
   <DeleteWork turns={pending}/>
   {error&&<Notice tone="danger" role="alert" className="error">{error}</Notice>}
   <div className="actions">
    <Button variant="outline" disabled={!!busy} onClick={()=>setAsking(false)}>Cancel</Button>
    <Button variant="outline" disabled={!!busy} onClick={()=>run('sideChatKeep',()=>setAsking(false))}>Keep as chat</Button>
    <Button variant="outline" disabled={!fresh||!!busy} title={sendTitle} onClick={()=>run('sideChatSend',()=>setAsking(false))}>{busy==='sideChatSend'?'Writing summary…':'Send to main chat'}</Button>
    <Button variant="danger" disabled={!!busy} onClick={()=>run('sideChatDiscard')}>{busy==='sideChatDiscard'?'Discarding…':'Discard'}</Button>
   </div>
  </Dialog>}
 </>;
}
