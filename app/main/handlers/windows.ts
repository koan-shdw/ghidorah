// windows handlers: moved out of app/main.ts unchanged (SPLIT-PLAN step 7); main.ts spreads them into handlers.
import {chatWindows,checkClaude,checkCodex,requestAppExit,restartBackend,sidebar,win} from '../../main';
import {mainSnapshot,mainWindowState,snapshot} from '../snapshot';
import {openChatWindow,openJob} from '../windows';
import {app,Menu,shell} from 'electron';

export const windowsHandlers:Record<string,(args:any)=>any>={
  // The window asks with {window:true} and gets cut results; a bare request (tests, tools, the workspace window) gets
  // the same shown chats' tools uncut, never every tool row (OUTPUTS 2026-11-09).
  // With rev, the revision of the state it holds, the window gets the changes since then (LAG 2026-11-09).
  state:(args)=>args?.window?mainWindowState(typeof args.chatId==='string'?args.chatId:undefined,typeof args.rev==='number'?args.rev:undefined):mainSnapshot(snapshot({tools:false})),
  openChatWindow({chatId}){openChatWindow(chatId);},
  openMainChat({chatId}){sidebar.root(chatId);chatWindows.get(chatId)?.close();win.show();win.focus();win.webContents.send('select-chat',chatId);},
  openJob({id}){openJob(id);},
  async restart(){await restartBackend();},
  async link({kind}){const links:Record<string,string>={keys:'https://platform.deepseek.com/api_keys',billing:'https://platform.deepseek.com/top_up',jev:'https://console.typesafe.ai/keys',fastino:'https://agent.fastino.ai/api-keys',notdiamond:'https://app.notdiamond.ai','claude-install':'https://code.claude.com/docs/en/setup',botfather:'https://t.me/BotFather','claude-credits':'https://claude.ai/settings/usage','codex-credits':'https://chatgpt.com/codex/settings/usage'};if(!links[kind])throw Error('Unknown link');await shell.openExternal(links[kind]);
    // Back from the supplier's credits page (Koan 2026-11-14): one usage check at once, so a message waiting on the limit goes without the 5-minute wait.
    if(kind==='claude-credits'||kind==='codex-credits')app.once('browser-window-focus',()=>void (kind==='claude-credits'?checkClaude():checkCodex()));},
  appMenu(){Menu.buildFromTemplate([{label:'Restart Ghidorah',click:()=>void requestAppExit(true)},{type:'separator'},{label:'Quit Ghidorah',click:()=>void requestAppExit(false)}]).popup({window:win,x:8,y:36});},
  window({action}){if(action==='minimize')win.minimize();if(action==='maximize')win.isMaximized()?win.unmaximize():win.maximize();if(action==='close')win.close();}
};
