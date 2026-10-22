// A worktree per chat (R2): choose the repository for a new chat's worktree; after a worktree chat is deleted, keep
// or remove its folder.
import React,{useState} from 'react';
import {Button,Dialog,Notice} from './kit';

type Call=(method:string,args?:any)=>Promise<any>;
type Mode=null|{kind:'choose';sources:{path:string;label:string}[]}|{kind:'remove';path:string;remaining:string[]};
export function useWorktree(call:Call,choose:(id:string)=>void){
 const [mode,setMode]=useState<Mode>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const message=(failure:unknown)=>String(failure).replace(/^Error: /,'').replace(/^Error invoking remote method 'app': (?:Error: )?/,'');
 const next=()=>setMode(current=>current?.kind==='remove'&&current.remaining.length?{kind:'remove',path:current.remaining[0],remaining:current.remaining.slice(1)}:null);
 async function act(work:()=>Promise<unknown>){setBusy(true);setError('');try{await work();next();}catch(failure){setError(message(failure));}finally{setBusy(false);}}
 async function start(){setError('');try{setMode({kind:'choose',sources:await call('worktreeSources')});}catch(failure){setError(message(failure));setMode({kind:'choose',sources:[]});}}
 const element=mode&&<Dialog title={mode.kind==='remove'?'Worktree folder kept':'New chat in a worktree'} label={mode.kind==='remove'?'Worktree folder':'New chat in a worktree'} className="worktree-dialog" size="sm" busy={busy} closeLabel="Close worktree" onClose={()=>setMode(null)}>
  {mode.kind==='choose'&&<>
   {mode.sources.length?<><p>The chat works in its own checkout on a new branch, kept inside the working folder.</p><div className="actions">{mode.sources.map(source=><button key={source.path} disabled={busy} onClick={()=>void act(async()=>choose(await call('worktreeChat',{repository:source.path})))}>{source.label}</button>)}</div></>
   :<p>The working folder and the saved apps' linked folders hold no Git repository.</p>}
   <div className="actions"><Button variant="outline" disabled={busy} onClick={()=>setMode(null)}>Cancel</Button></div></>}
  {mode.kind==='remove'&&<><p>The deleted chat's worktree is still at <code>{mode.path}</code>.</p>
   <div className="actions"><Button variant="outline" disabled={busy} onClick={next}>Keep it</Button><Button variant="danger" disabled={busy} onClick={()=>void act(()=>call('worktreeRemove',{path:mode.path}))}>Remove it</Button></div></>}
  {error&&<Notice tone="danger" role="alert" className="error">{error}</Notice>}
 </Dialog>;
 return {element,start,kept:(paths:string|string[])=>{const all=Array.isArray(paths)?paths:[paths];setError('');setMode({kind:'remove',path:all[0],remaining:all.slice(1)});}};
}
