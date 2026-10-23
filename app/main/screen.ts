// screen: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import {installedChrome,installedProgram,readScreenSettings} from '../browser-tools';
import {claude,cuaEnv,data,emit,handlers,namespace,projectFor,requests,root,screenDriver,screenEnd,screenEsc,screenEscPause,screenShow,screenTurn,store} from '../main';
import {modelLabel} from '../models';
import {ScreenTarget,processName,sameApp,screenActions,screenGuidance,screenInstructions,screenTarget,sendsEscape} from '../screen-control';
import type {Approval,Chat,Project,Turn} from '../types';
import {globalShortcut} from 'electron';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

// Screen control (FEATURE-SPECS 1, was 4e). The two programs ship inside the app (runtime\tools); an older install in
// the data folder still works. agent-browser drives the installed Chrome on a profile kept in this app.
export function screenSettings(){return readScreenSettings(store.all<any>('settings').find(row=>row.id==='browser-tools'));}
export function toolPaths(){const test=namespace.startsWith('Trismegistus/Test/'),bundled=path.join(root,'runtime');return {browser:installedProgram(bundled,'agent-browser')||installedProgram(data,'agent-browser'),computer:(test&&process.env.TRISMEGISTUS_TEST_CUA_DRIVER)||installedProgram(bundled,'cua-driver')||installedProgram(data,'cua-driver')};}
export const browserEnv=(browser:string,chrome:string,profile:string)=>({PATH:path.dirname(browser)+path.delimiter+(process.env.PATH||process.env.Path||''),AGENT_BROWSER_EXECUTABLE_PATH:chrome,AGENT_BROWSER_PROFILE:profile});
export function toolAccess(){
  const {browser,computer}=toolPaths(),on=screenSettings().screen,chrome=installedChrome();
  const active=[...(on&&browser&&chrome?['browser']:[]),...(on&&computer?['computer_use']:[])];
  return {on:active,env:{...(active.includes('browser')?browserEnv(browser!,chrome!,path.join(data,'hermes','browser-profile')):{}),...(active.includes('computer_use')?{HERMES_CUA_DRIVER_CMD:computer!,...cuaEnv}:{})} as Record<string,string>};
}
// Claude models run agent-browser from their terminal, on a Chrome profile of their own.
export function claudeScreenEnv(){const {browser}=toolPaths(),chrome=installedChrome();return screenSettings().screen&&browser&&chrome?browserEnv(browser,chrome,path.join(data,'claude-browser-profile')):undefined;}
export function screenApps():string[]{const apps=store.all<any>('settings').find(row=>row.id==='screen-apps')?.apps;return Array.isArray(apps)?apps.filter((name:unknown):name is string=>typeof name==='string'):[];}
export function screenContext(){return screenSettings().screen&&toolPaths().computer?'\n'+screenGuidance:'';}
export async function screenStep(turn:Turn,tool:string,args:any,target:ScreenTarget,signal:AbortSignal){
  const chat=store.get<Chat>('chat',turn.chatId);
  if(store.get<Project>('project',projectFor(chat).id).mode==='plan'&&screenActions.has(tool==='computer_use'?String(args?.action):tool))throw Error('Plan mode permits looking at the screen only.');
  if(target.kind==='none')return;
  const app=target.kind==='screen'?'Whole screen':target.kind==='named'?target.name:await processName(target.pid);
  if(![...screenApps(),...(store.get<Chat>('chat',chat.id).screenApps||[])].some(name=>sameApp(name,app))){
    const choice=await screenAsk(turn,app,signal);
    if(choice==='deny')throw Error((app==='Whole screen'?'The user did not allow the whole screen':'The user did not allow '+app)+'. Ask them in the chat before trying again.');
    if(choice==='always')store.put('settings',{id:'screen-apps',apps:[...screenApps(),app]});
    else store.update<Chat>('chat',chat.id,{screenApps:[...(store.get<Chat>('chat',chat.id).screenApps||[]),app]});
  }
  screenShow(turn,app);
  if(sendsEscape(tool,args))screenEscPause();
}
export function screenAsk(turn:Turn,app:string,signal:AbortSignal){
  return new Promise<string>(resolve=>{
    const id='screen:'+turn.id+':'+randomUUID(),model=modelLabel(turn.model,claude.models);
    const description=app==='Whole screen'?'Let '+model+' see and control the whole screen?':'Let '+model+' control '+app+'?';
    const finish=(choice:string)=>{signal.removeEventListener('abort',abort);requests.delete(id);resolve(choice);};
    const abort=()=>{if(requests.has(id)){store.update<Approval>('approval',id,{status:'expired'});if(store.get<Turn>('turn',turn.id).status==='waiting')store.update<Turn>('turn',turn.id,{status:'running'});emit();}finish('deny');};
    if(signal.aborted){resolve('deny');return;}
    signal.addEventListener('abort',abort,{once:true});requests.set(id,{respond:(answer:any)=>finish(answer.choice)});
    store.put('approval',{id,chatId:turn.chatId,turnId:turn.id,method:'approval',params:{description,screenApp:app},status:'pending'});
    store.update<Turn>('turn',turn.id,{status:'waiting'});emit();
  });
}
export const screenEscOn=()=>{if(screenTurn&&!screenEsc&&!globalShortcut.isRegistered('Escape'))globalShortcut.register('Escape',()=>void screenStop());};
// The bar and Esc end the moment their turn does (checked on every state change).
export function screenSettle(){if(screenTurn&&!['running','waiting','dispatching','stopping'].includes(store.find<Turn>('turn',screenTurn)?.status||''))screenEnd();}
export async function screenStop(){const id=screenTurn;screenEnd();const t=id?store.find<Turn>('turn',id):null;if(t&&['running','waiting','dispatching'].includes(t.status))await handlers.stop({chatId:t.chatId}).catch(()=>{});}
// Claude models reach the desktop tools as mcp__screen__*, each action checked first.
export function screenServer(turn:Turn){
  if(!screenSettings().screen||!toolPaths().computer)return undefined;
  return {instructions:screenInstructions(!!claudeScreenEnv()),tools:(signal:AbortSignal)=>screenDriver.tools(signal),call:async(name:string,args:any,signal:AbortSignal)=>{await screenStep(turn,name,args,screenTarget(name,args),signal);return screenDriver.call(name,args,signal);}};
}
