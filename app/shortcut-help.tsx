import React,{useEffect} from 'react';
import {Dialog} from './kit';

const shortcuts=[
 ['Chat','Enter','Send, or queue a follow-up while work is running'],
 ['Chat','Shift+Enter','Insert a new line'],
 ['Command suggestions','↑ / ↓','Select a command'],
 ['Command suggestions','Enter / Tab','Insert the selected command'],
 ['Sidebar','Ctrl/⌘+click · Shift+click','Toggle chats or select a range'],
 ['Sidebar','Ctrl/⌘+A · Escape','Select visible chats or clear selection while a chat row is focused'],
 ['Sidebar','Shift+↑/↓','Extend the chat selection'],
 ['Sidebar','Ctrl+Alt+U','Toggle activity view'],
 ['Chat','Ctrl+;','Open a side chat with a snapshot of this thread'],
 ['Chat view','Ctrl+O','Cycle Normal, Thinking and Verbose for the focused chat'],
 ['Workspace','Ctrl+`','Open terminal'],
 ['File editor','Ctrl+S / ⌘S','Save the current file'],
 ['Open context menu','R / P / U / F / A / D','Rename, pin, read/unread, fork, archive/restore, delete'],
 ['Open context menu','↑ / ↓ / Home / End','Move between menu items'],
 ['Open context menu','→ / ←','Open or leave a submenu'],
 ['Dialogs and menus','Escape','Close the current dialog or menu'],
 ['Help','Ctrl+/ / F1','Open keyboard shortcuts'],
];

/** F1 and Ctrl+/ open the shortcut list, unless another dialog is open. */
export function useShortcutKeys(open:()=>void,enabled=true){
 useEffect(()=>{if(!enabled)return;const key=(event:KeyboardEvent)=>{if(!event.defaultPrevented&&!event.altKey&&!event.metaKey&&((event.key==='F1'&&!event.ctrlKey)||(event.ctrlKey&&event.code==='Slash'))){if(document.querySelector('dialog[open],[role="dialog"]'))return;event.preventDefault();open();}};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[enabled,open]);
}
/** The shortcut list. */
export function ShortcutDialog({close,returnFocus}:{close:()=>void;returnFocus?:HTMLElement|null}){
 return <Dialog title="Keyboard shortcuts" id="shortcut-help-title" className="shortcut-help" size="lg" closeLabel="Close keyboard shortcuts" returnFocus={returnFocus} onClose={close}>
  <p>Menu letters work while that menu is open. Command suggestions take priority over sending a message.</p>
  <table><thead><tr><th>Where</th><th>Keys</th><th>Action</th></tr></thead><tbody>{shortcuts.map(([where,keys,action])=><tr key={where+keys}><td>{where}</td><td><kbd>{keys}</kbd></td><td>{action}</td></tr>)}</tbody></table>
 </Dialog>;
}
