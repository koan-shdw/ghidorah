import type {ChatActivity} from './activity';
import React,{useEffect,useState} from 'react';
import {WorkspacePanel} from './workspace-panel';
import {workspaceTitle,type WorkspaceView} from './pane-layout';
import type {FileRequest} from './chat-links';

type State={activity?:ChatActivity;defaultFolder:string|null;title:string;workspaceWindow:{view:WorkspaceView;chatId:string;directory:string;file?:string;diff?:{file:string;staged:boolean}}};
export function WorkspaceWindow(){
 const [state,setState]=useState<State|null>(null),[error,setError]=useState(''),[request,setRequest]=useState<FileRequest|null>(null);
 const call=async(method:string,args?:any)=>window.desktop.invoke(method,args);
 useEffect(()=>{void call('state').then(setState).catch(error=>setError(String(error)));return window.desktop.subscribe(next=>setState(next as unknown as State));},[]);
 useEffect(()=>window.desktop.onOpenFile(setRequest),[]);
 useEffect(()=>{document.documentElement.dataset.theme=localStorage.getItem('theme')||'dark';},[]);
 if(!state)return <p role="status">{error||'Opening workspace…'}</p>;
 const info=state.workspaceWindow;
 function action(name:string){void call('window',{action:name}).catch(error=>setError(String(error)));}
 return <div className="workspace-window"><header className="titlebar"><span>{workspaceTitle(info.view)} · {state.title}</span><div className="window-actions"><button onClick={()=>void call('workspaceWindowReturn').catch(error=>setError(String(error)))}>Return to main window</button><button aria-label="Minimize" onClick={()=>action('minimize')}>—</button><button aria-label="Maximize" onClick={()=>action('maximize')}>□</button><button aria-label="Close window" onClick={()=>action('close')}>×</button></div></header>
  {error&&<p role="alert" className="error">{error}</p>}
  <WorkspacePanel activity={state.activity} only={info.view} initial={info} chatId={info.chatId} root={state.defaultFolder} view={info.view} setView={view=>{if(view!==info.view)void call('workspaceWindowOpen',{view}).catch(error=>setError(String(error)));}} visible onHide={()=>action('close')} call={call} terminalRequest={0} theme={localStorage.getItem('theme')||'dark'} fileRequest={request}/>
 </div>;
}
