import React,{useContext,useState} from 'react';
import {ChatViewContext} from './chat-view';
import type {ToolCall} from './types';
import {toolResultFailed} from './tool-result';

const object=(value:any):any=>{try{if(typeof value==='string')return JSON.parse(value);}catch{}return value;};
const icons={command:'❯',read:'▤',edit:'✎',search:'⌕',web:'◎',tool:'◇'};
export function activityInfo(tool:ToolCall){
 const args=object(tool.args)||{},raw=object(tool.result),result=raw?.content?.length===1&&raw.content[0].type==='text'?object(raw.content[0].text):raw;
 const key=(tool.name||'Tool').split('__').at(-1)!.toLowerCase();
 const kind=/^(bash|terminal|exec_command|shell|run_command)$/.test(key)?'command':/^(read|read_file|readfile|read_text_file)$/.test(key)?'read':/^(write|write_file|edit|edit_file|apply_patch|patch|multiedit|multi_edit)$/.test(key)?'edit':/web|browse|fetch/.test(key)?'web':/search|grep|glob/.test(key)?'search':'tool';
 const failed=tool.status==='failed'||tool.status==='error'||toolResultFailed(tool.result);
 const state=['stopped','uncertain'].includes(tool.status)?tool.status:failed?'failed':tool.status;
 const running=state==='running',finished=state==='completed';
 const webSearch=/search/.test(key);
 const label=({command:running?'Running command':finished?'Ran command':'Command',read:running?'Reading file':finished?'Read file':'File read',edit:running?'Editing file':finished?'Edited file':'File edit',search:running?'Searching files':finished?'Searched files':'File search',web:running?(webSearch?'Searching the web':'Opening web content'):finished?(webSearch?'Searched the web':'Opened web content'):'Web activity',tool:tool.name||'Tool'})[kind];
 const group=({command:running?'Running commands':finished?'Ran commands':'Commands',read:running?'Reading files':finished?'Read files':'File reads',edit:running?'Editing files':finished?'Edited files':'File edits',search:running?'Searching files':finished?'Searched files':'File searches',web:running?(webSearch?'Searching the web':'Opening web content'):finished?(webSearch?'Searched the web':'Opened web content'):'Web activity',tool:running?'Using tools':finished?'Used tools':'Tool calls'})[kind];
 const returnedPaths=[...(Array.isArray(result?.files_modified)?result.files_modified:[]),...(Array.isArray(result?.files_created)?result.files_created:[]),...(Array.isArray(result?.files_deleted)?result.files_deleted:[])];
 const paths=returnedPaths.length?returnedPaths:[args.file_path,args.path,args.filename,args.notebook_path];
 const files=['read','edit'].includes(kind)?[...new Set(paths.filter((p):p is string=>typeof p==='string'&&!!p))]:[];
 // Counts come from the returned diff, never from an edit that was merely requested.
 let counts:{added:number;removed:number}|null=null;
 if(kind==='edit'&&finished&&typeof result?.diff==='string'&&result.diff){
  let old=0,next=0;counts={added:0,removed:0};
  for(const line of result.diff.split(/\r?\n/)){
   const header=line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
   if(header){old=Number(header[1]??1);next=Number(header[2]??1);}
   else if(line.startsWith('+')&&next>0){counts.added++;next--;}
   else if(line.startsWith('-')&&old>0){counts.removed++;old--;}
   else if(line.startsWith(' ')&&old>0&&next>0){old--;next--;}
  }
 }
 const detail=[args.description,args.command,args.query,args.pattern,args.url].find(v=>typeof v==='string')||'';
 const status=({running:'Running',completed:'Finished',failed:'Failed',uncertain:'Needs inspection',stopped:'Stopped'})[state]||state;
 return {kind,label,group,files,detail,counts,state,status,icon:icons[kind]};
}

export function ToolActivity({tools}:{tools:ToolCall[]}){
 const viewMode=useContext(ChatViewContext),[error,setError]=useState(''),[opened,setOpened]=useState({mode:viewMode,open:viewMode==='verbose'});
 const expanded=opened.mode===viewMode?opened.open:viewMode==='verbose';
 if(!tools.length)return null;
 const rows=tools.map(tool=>({tool,...activityInfo(tool)})),kinds=[...new Set(rows.map(row=>row.kind))];
 const summary=kinds.map(kind=>{const same=rows.filter(row=>row.kind===kind);return (same.find(row=>row.state==='running')||same.find(row=>row.state!=='completed')||same[0]).group;}).join(', ');
 const running=rows.filter(row=>row.state==='running').length,issues=rows.filter(row=>['failed','uncertain','stopped'].includes(row.state)).length;
 async function openFile(event:React.MouseEvent,tool:ToolCall,href:string){event.preventDefault();event.stopPropagation();setError('');try{await window.desktop.invoke('chatLink',{turnId:tool.turnId,href});}catch(e){setError(String(e).replace(/^Error invoking remote method 'app': (?:Error: )?/,'').replace(/^Error: /,''));}}
 const fileLink=(file:string,tool:ToolCall)=><button type="button" className="activity-file" key={file} title={file} aria-label={'Open '+file} onClick={event=>void openFile(event,tool,file)}>{file.split(/[/\\]/).at(-1)||file}</button>;
 return <div className="activity-list"><details className="activity-group" key={viewMode} open={expanded} onToggle={event=>{if(event.target===event.currentTarget)setOpened({mode:viewMode,open:event.currentTarget.open});}} aria-label="Tool activity"><summary><span aria-hidden="true" className={running?'activity-icon running':'activity-icon'}>{rows[0].icon}</span><span className="activity-group-label">{summary}</span><span className="activity-group-count">{tools.length} {tools.length===1?'action':'actions'}</span>{running>0&&<span className="activity-group-running">{running} running</span>}{issues>0&&<span className="activity-group-issues">{issues} {issues===1?'issue':'issues'}</span>}</summary>{expanded&&<div className="activity-group-body">{rows.map(({tool,label,files,detail,counts,status,state,icon})=><details className="tool activity" key={tool.id} open={viewMode==='verbose'} data-tool-id={tool.id} data-status={state}><summary><span aria-hidden="true" className={'activity-icon '+state}>{icon}</span><span className="activity-name">{label}</span>{files.length?<span className="activity-detail">{fileLink(files[0],tool)}{files.length>1&&<span> +{files.length-1} files</span>}</span>:<span className="activity-detail" title={detail}>{detail}</span>}{counts&&<span className="activity-counts" aria-label={`${counts.added} lines added, ${counts.removed} lines removed`}><span>+{counts.added}</span> <span>−{counts.removed}</span></span>}<span className="activity-status">{status}</span></summary><div className="activity-body">{files.length>1&&<div className="activity-files">{files.map(file=>fileLink(file,tool))}</div>}<span className="hint">{tool.name} · Input</span><pre>{typeof tool.args==='string'?tool.args:JSON.stringify(tool.args,null,2)}</pre>{tool.result!=null&&<><span className="hint">Output</span><pre>{typeof tool.result==='string'?tool.result:JSON.stringify(tool.result,null,2)}</pre></>}</div></details>)}</div>}</details>{error&&<p className="chat-link-error" role="alert">{error}</p>}</div>;
}
