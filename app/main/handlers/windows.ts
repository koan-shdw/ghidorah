// windows handlers: moved out of app/main.ts unchanged (SPLIT-PLAN step 7); main.ts spreads them into handlers.
import {chatWindows,requestAppExit,restartBackend,sidebar,win} from '../../main';
import {snapshot} from '../snapshot';
import {openChatWindow,openJob} from '../windows';
import {Menu,shell} from 'electron';

export const windowsHandlers:Record<string,(args:any)=>any>={
  state:()=>snapshot(),
  openChatWindow({chatId}){openChatWindow(chatId);},
  openMainChat({chatId}){sidebar.root(chatId);chatWindows.get(chatId)?.close();win.show();win.focus();win.webContents.send('select-chat',chatId);},
  openJob({id}){openJob(id);},
  async restart(){await restartBackend();},
  async link({kind}){const links:Record<string,string>={keys:'https://platform.deepseek.com/api_keys',billing:'https://platform.deepseek.com/top_up',jev:'https://console.typesafe.ai/keys',fastino:'https://agent.fastino.ai/api-keys',notdiamond:'https://app.notdiamond.ai','claude-install':'https://code.claude.com/docs/en/setup',botfather:'https://t.me/BotFather'};if(!links[kind])throw Error('Unknown link');await shell.openExternal(links[kind]);},
  appMenu(){Menu.buildFromTemplate([{label:'Restart Ghidorah',click:()=>void requestAppExit(true)},{type:'separator'},{label:'Quit Ghidorah',click:()=>void requestAppExit(false)}]).popup({window:win,x:8,y:36});},
  window({action}){if(action==='minimize')win.minimize();if(action==='maximize')win.isMaximized()?win.unmaximize():win.maximize();if(action==='close')win.close();}
};
