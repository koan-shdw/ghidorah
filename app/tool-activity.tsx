// The action list under a reply (TRIS-TODO 4.1, Koan's pick A2 on 2026-10-10): like the Claude app, one closed
// line ("Ran 12 actions · 1 failed", or the current action while it works), rows in plain words in one rounded box,
// a row opens to its command and output, a read's lines or an edit's old and new lines. Tris's own internal steps
// are not listed.
import React,{useContext,useState} from 'react';
import {ChatViewContext} from './chat-view';
import type {ToolCall} from './types';
import {toolResultFailed} from './tool-result';
import {Button} from './kit';

const object=(value:any):any=>{try{if(typeof value==='string')return JSON.parse(value);}catch{}return value;};
// Tris checking or describing its own tools: bookkeeping, not work (Koan: "internal steps hidden").
const internal=new Set(['inspect_action','tool_describe','toolsearch','tool_search','connected_tools','goal_status']);
const base=(file:string)=>file.split(/[/\\]/).filter(Boolean).at(-1)||file;
const clip=(text:string,size:number)=>{const one=text.replace(/\s+/g,' ').trim();return one.length>size?one.slice(0,size-1)+'…':one;};
const host=(url:string)=>{try{return new URL(url).host;}catch{return clip(url,50);}};

export function activityInfo(tool:ToolCall){
 const args=object(tool.args)||{},raw=object(tool.result),result=raw?.content?.length===1&&raw.content[0].type==='text'?object(raw.content[0].text):raw;
 const key=(tool.name||'Tool').split('__').at(-1)!.toLowerCase();
 const kind=/^(bash|terminal|exec_command|shell|run_command)$/.test(key)?'command':/^(read|read_file|readfile|read_text_file)$/.test(key)?'read':/^(write|write_file|edit|edit_file|apply_patch|patch|multiedit|multi_edit)$/.test(key)?'edit':/web|browse|fetch/.test(key)?'web':/search|grep|glob/.test(key)?'search':'tool';
 const failed=tool.status==='failed'||tool.status==='error'||toolResultFailed(tool.result);
 const state=['stopped','uncertain'].includes(tool.status)?tool.status:failed?'failed':tool.status;
 const returnedPaths=[...(Array.isArray(result?.files_modified)?result.files_modified:[]),...(Array.isArray(result?.files_created)?result.files_created:[]),...(Array.isArray(result?.files_deleted)?result.files_deleted:[])];
 const paths=returnedPaths.length?returnedPaths:[args.file_path,args.path,args.filename,args.notebook_path];
 const files=['read','edit'].includes(kind)?[...new Set(paths.filter((p):p is string=>typeof p==='string'&&!!p))]:[];
 // Counts come from the returned diff, never from an edit that was merely requested.
 let counts:{added:number;removed:number}|null=null;
 if(kind==='edit'&&state==='completed'&&typeof result?.diff==='string'&&result.diff){
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
 // Plain words: Claude's own command description when there is one; otherwise Tris writes a short phrase.
 const file=files[0]?base(files[0])+(files.length>1?' and '+(files.length-1)+' more':''):'';
 const pattern=String(args.pattern??args.query??args.regex??'');
 const words=typeof args.description==='string'&&args.description.trim()?clip(args.description,90)
  :kind==='command'?(String(args.command??args.cmd??'').trim()?'Run '+clip(String(args.command??args.cmd),70):'Run a command')
  :kind==='read'?'Read '+(file||'a file')
  :kind==='edit'?(/^write/.test(key)?'Write ':'Edit ')+(file||'a file')
  :kind==='search'?(key==='glob'?'Find files '+clip(pattern,50):pattern?'Search for "'+clip(pattern,50)+'"':'Search files')
  :key==='preview_page'?(args.action==='publish'?'Publish the page "'+clip(String(args.title??''),50)+'"':args.action==='delete'?'Delete a page':args.action==='read'?'Read a page':args.action==='list'?'List your pages':'Read the page guide')
  :kind==='web'?(/search/.test(key)?'Search the web for "'+clip(pattern,50)+'"':'Open '+host(String(args.url??'')))
  :clip(key.replace(/_/g,' ').replace(/^\w/,c=>c.toUpperCase())+(detail?' '+detail:''),80);
 return {kind,key,args,result,files,detail,counts,state,words,internal:internal.has(key)};
}

// A result as the text a person reads.
export function resultText(value:any):string{
 if(value==null)return '';
 if(typeof value==='string')return value;
 if(Array.isArray(value.content))return value.content.map((part:any)=>part?.type==='text'?part.text:'').join('\n');
 for(const key of ['output','stdout','content','result','text','error','message'])if(typeof value[key]==='string'&&value[key])return [value[key],key!=='stderr'&&typeof value.stderr==='string'?value.stderr:''].filter(Boolean).join('\n');
 return JSON.stringify(value,null,2);
}
// An edit's old and new lines: from the returned diff, else from what the edit asked for.
export function editLines(args:any,result:any){
 const lines:{sign:'-'|'+'|' ';text:string}[]=[],add=(sign:'-'|'+',text:unknown)=>{if(typeof text==='string')for(const line of text.split(/\r?\n/))lines.push({sign,text:line});};
 const diff=typeof result?.diff==='string'?result.diff:typeof args.patch==='string'?args.patch:typeof args.input==='string'&&/^\*\*\* Begin Patch/m.test(args.input)?args.input:'';
 if(diff){for(const line of diff.split(/\r?\n/))if(!/^(---|\+\+\+|@@|\*\*\*|diff |index )/.test(line)&&/^[-+ ]/.test(line))lines.push({sign:line[0] as '-'|'+'|' ',text:line.slice(1)});}
 else if(Array.isArray(args.edits))for(const edit of args.edits){add('-',edit?.old_string);add('+',edit?.new_string);}
 else if(typeof args.old_string==='string'||typeof args.new_string==='string'){add('-',args.old_string);add('+',args.new_string);}
 else add('+',args.content);
 return lines.length?lines.slice(0,400):null;
}
export function took(tool:ToolCall){
 if(tool.started==null||tool.finished==null)return '';
 const seconds=Math.max(0,(tool.finished-tool.started)/1000);
 return seconds<10?seconds.toFixed(1)+' s':seconds<60?Math.round(seconds)+' s':Math.floor(seconds/60)+' min '+Math.round(seconds%60)+' s';
}
function commandParts(command:string){
 return (command.match(/"[^"]*"|'[^']*'|\S+/g)||[]).map((part,index)=><React.Fragment key={index}>{index>0&&' '}<span className={index===0?'program':/^["']/.test(part)?'string':/^-/.test(part)?'flag':undefined}>{part}</span></React.Fragment>);
}

type Row=ReturnType<typeof activityInfo>&{tool:ToolCall};
function Detail({row,fileLinks}:{row:Row;fileLinks:React.ReactNode}){
 const {tool,kind,state,args,result}=row,output=resultText(result),failed=state==='failed';
 if(kind==='command'||kind==='search'){
  const command=String(args.command??args.cmd??(tool.name+' '+[args.pattern??args.query,args.path].filter(v=>typeof v==='string').join(' ')));
  return <div className="activity-term"><div className="activity-cmd"><span className="activity-ps" aria-hidden="true">$</span>{commandParts(command)}</div>{state==='running'?<span className="activity-spin" role="status" aria-label="Running"/>:output?<pre className={failed?'failed':undefined}>{output}</pre>:<span className="hint">No output</span>}</div>;
 }
 if(kind==='read')return <>{fileLinks}<pre className="activity-code">{output}</pre></>;
 const lines=kind==='edit'?editLines(args,result):null;
 if(lines)return <>{fileLinks}<div className="activity-diff">{lines.map((line,index)=><div key={index} className={line.sign==='-'?'old':line.sign==='+'?'new':undefined}><i aria-hidden="true">{line.sign==='-'?'−':line.sign}</i>{line.text}</div>)}</div>{failed&&<pre className="failed">{output}</pre>}</>;
 return <div className="activity-io">{fileLinks}<span className="hint">{tool.name} · Input</span><pre>{typeof tool.args==='string'?tool.args:JSON.stringify(tool.args,null,2)}</pre>{tool.result!=null&&<><span className="hint">Output</span><pre className={failed?'failed':undefined}>{output}</pre></>}</div>;
}
function ActionRow({row,open:initial,fileLink}:{row:Row;open:boolean;fileLink:(file:string,tool:ToolCall)=>React.ReactNode}){
 const [open,setOpen]=useState(initial),{tool,state,counts,words,files}=row,time=took(tool);
 return <details className="activity" open={open} data-tool-id={tool.id} data-status={state} onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary><span className="activity-words">{words}</span>{counts&&<span className="activity-counts" aria-label={`${counts.added} lines added, ${counts.removed} lines removed`}><span>+{counts.added}</span> <span>−{counts.removed}</span></span>}{state==='running'&&<span className="activity-spin" role="status" aria-label="Running"/>}{state==='uncertain'&&<span className="activity-flag">needs checking</span>}{state==='stopped'&&<span className="activity-flag">stopped</span>}<span className="activity-chevron" aria-hidden="true">›</span>{time&&<span className="activity-time">{time}</span>}</summary>
  {open&&<div className="activity-body"><Detail row={row} fileLinks={files.length?<div className="activity-files">{files.map(file=>fileLink(file,tool))}</div>:null}/></div>}
 </details>;
}

// A page a model published (FEATURE-SPECS 4), like Claude's artifact card: its title, Open in the preview pane as
// the user, Open in browser, Copy link.
// What preview_page returned, as Claude Code records it (content blocks or their text) or as a JSON-RPC answer.
const pageOf=(value:any):any=>{value=object(value);if(value?.jsonrpc&&value.result)value=value.result;if(Array.isArray(value))value={content:value};value=value?.content?.length===1&&value.content[0]?.type==='text'?object(value.content[0].text):value;return typeof value?.link==='string'?value:null;};
function PageCard({tool,page}:{tool:ToolCall;page:{link:string;title:string;version:number}}){
 const [error,setError]=useState(''),[copied,setCopied]=useState(false);
 const open=(browser:boolean)=>void window.desktop.invoke('pageOpen',{turnId:tool.turnId,url:page.link,browser}).catch(e=>setError(String(e).replace(/^Error invoking remote method 'app': (?:Error: )?/,'').replace(/^Error: /,'')));
 return <section className="page-card" aria-label={'Page: '+page.title}>
  <span className="page-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM4 9h16M8 13h5M8 16h8"/></svg></span>
  <span className="page-card-text"><strong>{page.title}</strong><span>Page · version {page.version}</span></span>
  <span className="page-card-actions"><Button variant="primary" onClick={()=>open(false)}>Open</Button><Button variant="outline" onClick={()=>open(true)}>Open in browser</Button><Button variant="outline" onClick={()=>void navigator.clipboard.writeText(page.link).then(()=>setCopied(true),()=>{})}>{copied?'Copied':'Copy link'}</Button></span>
  {error&&<p className="chat-link-error" role="alert">{error}</p>}
 </section>;
}

export function ToolActivity({tools}:{tools:ToolCall[]}){
 const viewMode=useContext(ChatViewContext),[error,setError]=useState(''),[opened,setOpened]=useState({mode:viewMode,open:viewMode==='verbose'});
 const expanded=opened.mode===viewMode?opened.open:viewMode==='verbose';
 const rows=tools.map(tool=>({tool,...activityInfo(tool)})).filter(row=>!row.internal);
 if(!rows.length)return null;
 const failed=rows.filter(row=>row.state==='failed').length,current=rows.findLast(row=>row.state==='running'),count=rows.length+' '+(rows.length===1?'action':'actions');
 async function openFile(event:React.MouseEvent,tool:ToolCall,href:string){event.preventDefault();event.stopPropagation();setError('');try{await window.desktop.invoke('chatLink',{turnId:tool.turnId,href});}catch(e){setError(String(e).replace(/^Error invoking remote method 'app': (?:Error: )?/,'').replace(/^Error: /,''));}}
 const fileLink=(file:string,tool:ToolCall)=><button type="button" className="activity-file" key={file} title={file} aria-label={'Open '+file} onClick={event=>void openFile(event,tool,file)}>{base(file)}</button>;
 return <div className="activity-list"><details className="activity-group" key={viewMode} open={expanded} onToggle={event=>{if(event.target===event.currentTarget)setOpened({mode:viewMode,open:event.currentTarget.open});}} aria-label="Tool activity">
  <summary>{current?<><span className="activity-spin" role="status" aria-label="Working"/><span className="activity-words">{current.words}</span><span className="activity-more">· {count}</span></>:<span className="activity-words">Ran {count}</span>}{failed>0&&<span className="activity-failed">· {failed} failed</span>}<span className="activity-chevron" aria-hidden="true">›</span></summary>
  {expanded&&<div className="activity-group-body">{rows.map(row=><ActionRow key={row.tool.id} row={row} open={viewMode==='verbose'} fileLink={fileLink}/>)}</div>}
 </details>{error&&<p className="chat-link-error" role="alert">{error}</p>}
 {rows.filter(row=>row.key==='preview_page'&&row.args.action==='publish'&&row.state==='completed'&&pageOf(row.tool.result)).map(row=><PageCard key={row.tool.id} tool={row.tool} page={pageOf(row.tool.result)}/>)}</div>;
}
