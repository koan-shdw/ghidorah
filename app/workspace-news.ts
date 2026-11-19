// What is new in a chat's Workspace panel since it was last open (Koan 2026-11-19): the switch in the chat's title
// bar carries a dot for it. Counted from what the window already holds (finished tool rows and turns), so a closed
// panel still costs nothing: no Git read, no file listing.
import {ownedTurns} from './activity';
import type {Snapshot} from './types';

export interface WorkspaceNews {files:number;outputs:number;agents:number}
const fileWrites=new Set(['write','edit','multiedit','notebookedit','write_file','edit_file','patch','apply_patch']);
const tool=(name:string)=>(name||'').split('__').at(-1)!.toLowerCase();
const args=(value:unknown):any=>{try{return typeof value==='string'?JSON.parse(value):value||{};}catch{return {};}};

/** Files changed, outputs saved and agents finished in this chat after `since`. */
export function workspaceNews(state:Pick<Snapshot,'chats'|'jobChats'|'turns'|'tools'>,chatId:string,since:number):WorkspaceNews{
 const {turns}=ownedTurns(state,chatId),files=new Set<string>();let outputs=0,unnamed=0;
 for(const row of state.tools){
  if(row.status!=='completed'||(row.finished||0)<=since||!turns.has(row.turnId))continue;
  const name=tool(row.name);
  if(name==='save_chat_output')outputs++;
  else if(fileWrites.has(name)){const input=args(row.args),file=input.file_path||input.path||input.notebook_path;if(typeof file==='string'&&file)files.add(file);else unnamed++;}
 }
 const agents=[...turns.values()].filter(turn=>turn.automatic?.kind==='agent'&&!['running','waiting','queued','dispatching','stopping'].includes(turn.status)&&(turn.finished||0)>since).length;
 return {files:files.size+unnamed,outputs,agents};
}
/** "2 files changed · 1 agent finished", or '' when nothing is new. */
export function newsText(news:WorkspaceNews){
 const part=(count:number,one:string,many:string)=>count?count+' '+(count===1?one:many):'';
 return [part(news.files,'file changed','files changed'),part(news.outputs,'output saved','outputs saved'),part(news.agents,'agent finished','agents finished')].filter(Boolean).join(' · ');
}
// When each chat's panel was last open: held here while the window lives and kept in its storage across restarts.
// A chat seen for the first time starts from now, so its history is not news.
const seenAt=new Map<string,number>(),seenKey=(chatId:string)=>'workspace-seen:'+chatId;
export function workspaceSeen(chatId:string,now=Date.now()){
 if(!chatId)return now;
 const held=seenAt.get(chatId);if(held)return held;
 let saved=0;try{saved=Number(localStorage.getItem(seenKey(chatId)))||0;}catch{}
 if(!(saved>0)){saved=now;try{localStorage.setItem(seenKey(chatId),String(now));}catch{}}
 seenAt.set(chatId,saved);return saved;
}
/** The panel is open on this chat now. `keep` also writes it to the window's storage (done as the panel closes). */
export function markWorkspaceSeen(chatId:string,keep=true,now=Date.now()){
 if(!chatId)return;seenAt.set(chatId,now);
 if(keep)try{localStorage.setItem(seenKey(chatId),String(now));}catch{}
}
