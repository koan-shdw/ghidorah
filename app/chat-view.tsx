import React,{createContext,useSyncExternalStore} from 'react';

export type ChatViewMode='normal'|'thinking'|'verbose';
const modes:ChatViewMode[]=['normal','thinking','verbose'];
export const ChatViewContext=createContext<ChatViewMode>('normal');
function current(chatId:string):ChatViewMode{const value=localStorage.getItem('chat-view:'+chatId);return modes.includes(value as ChatViewMode)?value as ChatViewMode:'normal';}
function subscribe(change:()=>void){window.addEventListener('storage',change);window.addEventListener('chat-view-change',change);return()=>{window.removeEventListener('storage',change);window.removeEventListener('chat-view-change',change);};}
export function setChatView(chatId:string,mode:ChatViewMode){if(!chatId||!modes.includes(mode))return;localStorage.setItem('chat-view:'+chatId,mode);window.dispatchEvent(new Event('chat-view-change'));}
export function cycleChatView(chatId:string){setChatView(chatId,modes[(modes.indexOf(current(chatId))+1)%modes.length]);}
export function useChatView(chatId:string){return useSyncExternalStore(subscribe,()=>current(chatId));}
export function ChatViewSelect({chatId}:{chatId:string}){
 const mode=useChatView(chatId);
 return <label className="chat-view-control"><span>View</span><select aria-label="Chat view" title="Chat view · Ctrl+O" value={mode} disabled={!chatId} onChange={event=>setChatView(chatId,event.target.value as ChatViewMode)}><option value="normal">Normal</option><option value="thinking">Thinking</option><option value="verbose">Verbose</option></select></label>;
}
