// Handover mode in the chat (notes/HANDOVER-MODE-PLAN.md): START HANDOVER on the latest handover reply, Send to new
// chat on the old chat's replies, and the bar both chats show while it runs. Every chat view builds from these.
import React,{useEffect,useState} from 'react';
import {SidebarIcon} from './kit';
import {modelLabel} from './models';
import {unpushed} from './handover';
import type {Chat,Snapshot,Turn} from './types';

type Call=(method:string,args?:any)=>Promise<any>;
type Check={missingPaths:string[];missingNames:string[];namesChecked:boolean;unmarked:string[];unmarkedTotal:number};
const liveOld=(state:Snapshot,chat:Chat)=>chat.handover?.stage==='live'?chat:state.chats.find(c=>c.handover?.stage==='live'&&c.handover.newChatId===chat.id);

function HandoverStart({state,t,chat,call}:{state:Snapshot;t:Turn;chat:Chat;call:Call}){
 const [model,setModel]=useState(t.model),[check,setCheck]=useState<Check|null>(null),[busy,setBusy]=useState(false);
 useEffect(()=>{let current=true;setCheck(null);void window.desktop.invoke('handoverCheck',{chatId:chat.id,turnId:t.id}).then((result:Check)=>{if(current)setCheck(result);}).catch(()=>{});return ()=>{current=false;};},[t.id]);
 const found=check?[...check.missingPaths.map(p=>'File not found: '+p),...check.missingNames.map(n=>'Name not found in the folder: '+n),...check.unmarked.map(c=>'Not marked PROVEN or OPEN: '+c)]:[];
 const run=(method:string,args:any)=>{setBusy(true);void call(method,args).catch(()=>{}).finally(()=>setBusy(false));};
 return <section className="handover-start" aria-label="Start handover">
  <div className="handover-start-row">
   <button className="primary" disabled={busy} onClick={()=>run('handoverStart',{chatId:chat.id,turnId:t.id,model})}>START HANDOVER</button>
   <label>Model <select aria-label="Model for the new chat" value={model} onChange={event=>setModel(event.target.value)}>{(chat.pool||[]).map(id=><option key={id} value={id}>{modelLabel(id,state.claude?.models)}</option>)}</select></label>
   <button disabled={busy} onClick={()=>run('handoverClose',{chatId:chat.id})}>Cancel handoff</button>
  </div>
  <div className="handover-check" role="status">{!check?'Checking the handover…':<>
   <strong>Ghidorah’s check</strong>{found.length?<ul>{found.map(line=><li key={line}>{line}</li>)}</ul>:<span> Every file and name found, every claim marked.</span>}
   {check.unmarkedTotal>check.unmarked.length&&<span> {check.unmarkedTotal-check.unmarked.length} more unmarked.</span>}
   {!check.namesChecked&&<span> Names were not checked: this folder has no Git.</span>}
  </>}</div>
 </section>;
}

/** On a reply: START HANDOVER while a handover is being written; Send to new chat on the old chat's later replies. */
export function HandoverReply({state,t,call}:{state:Snapshot;t:Turn;call:Call}){
 const chat=state.chats.find(c=>c.id===t.chatId),handover=chat?.handover;
 if(!chat||!handover||t.parentTurnId||t.status!=='completed')return null;
 if(handover.stage==='writing')return state.turns.filter(x=>x.chatId===chat.id&&!x.parentTurnId).at(-1)?.id===t.id?<HandoverStart key={t.id} state={state} t={t} chat={chat} call={call}/>:null;
 if(!unpushed(state.turns,chat.id,handover.pushedToNew,t.id).some(x=>x.id===t.id))return null;
 return <div className="handover-actions"><button onClick={()=>void call('handoverPush',{chatId:chat.id,throughTurnId:t.id}).catch(()=>{})}>Send to new chat</button></div>;
}

/** The bar both chats show in handover mode: the new chat's Show old chat, and Close handover on each. */
export function HandoverNotice({state,chat,call,closed}:{state:Snapshot;chat?:Chat;call:Call;closed?:()=>void}){
 const old=chat&&liveOld(state,chat);if(!chat||!old)return null;
 const isOld=old.id===chat.id,other=state.chats.find(c=>c.id===(isOld?old.handover!.newChatId:old.id)),waiting=isOld?0:unpushed(state.turns,chat.id,old.handover!.pushedToOld).length;
 return <div className="handover-notice" role="status"><SidebarIcon name="fork"/>
  <span><strong>Handover mode</strong> · {isOld?<>This chat wrote the handover for “{other?.title||'the new chat'}”. It reads files but does not change them.</>:<>Started from the handover of “{other?.title||'the old chat'}”, open beside you.</>}</span>
  {!isOld&&<button disabled={!waiting} title="Send this chat's new messages to the old chat for its comments" onClick={()=>void call('handoverPush',{chatId:chat.id}).catch(()=>{})}>Show old chat{waiting?' ('+waiting+' new)':''}</button>}
  <button onClick={()=>void call('handoverClose',{chatId:chat.id}).then(()=>closed?.()).catch(()=>{})}>Close handover</button>
 </div>;
}

/** Hand off: the caret menu, the chip and /handoff all send the same command. */
export const startHandoff=(call:Call,chatId:string)=>call('submit',{id:crypto.randomUUID(),chatId,text:'/handoff'});

/** The quiet chip by the context ring, the first time this chat's context was compressed; × hides it for good. */
export function HandoverChip({state,chat,call}:{state:Snapshot;chat?:Chat;call:Call}){
 if(!chat?.compressed||chat.handoverChipHidden||chat.handover||chat.sideSourceId||liveOld(state,chat))return null;
 return <span className="handover-chip"><button title="Write a handover and carry on in a fresh chat" onClick={()=>void startHandoff(call,chat.id).catch(()=>{})}>Context compressed · Hand off?</button><button aria-label="Hide the handoff suggestion" onClick={()=>void call('handoverChipHide',{chatId:chat.id}).catch(()=>{})}>×</button></span>;
}
