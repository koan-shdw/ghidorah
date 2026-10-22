import React,{useRef,useState} from 'react';
import {Switch} from './kit';
import type {Snapshot} from './types';
import {parseMcpImport,type McpImportEntry} from './upstream/mcp-import';

type Call=(method:string,args?:any)=>Promise<any>;
export function ImportedServer({entry,call,saved}:{entry:McpImportEntry;call:Call;saved:()=>void}){
 const [name,setName]=useState(entry.name),[json,setJson]=useState(()=>JSON.stringify(entry.config,null,2)),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const lock=useRef(false);
 async function save(){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{let config;try{config=JSON.parse(json);}catch{throw Error('Enter valid JSON for this server.');}if(config.transport){config.type=config.transport;delete config.transport;}await call('mcpAdd',{name,config});setJson('');saved();}catch(error){setError(String(error));}finally{lock.current=false;setBusy(false);}}
 return <section className="mcp-import"><label>Connection name<input aria-label="Imported connection name" value={name} onChange={event=>setName(event.target.value)}/></label><label>Server configuration<textarea aria-label="Imported server configuration" spellCheck={false} value={json} onChange={event=>setJson(event.target.value)}/></label><p className="hint">Review the command, server address and credentials before saving. Saving does not start the server.</p>{error&&<p role="alert">{error}</p>}<button disabled={busy||!name.trim()} onClick={()=>void save()}>{busy?'Saving…':'Save imported server'}</button></section>;
}
export function McpSettings({state,call}:{state:Snapshot;call:Call}){
 const [kind,setKind]=useState('http'),[name,setName]=useState(''),[address,setAddress]=useState(''),[oauth,setOauth]=useState(true),[args,setArgs]=useState('[]'),[values,setValues]=useState('{}'),[paste,setPaste]=useState(''),[imports,setImports]=useState<McpImportEntry[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState<string[]>([]);
 const locks=useRef(new Set<string>());
 async function run(key:string,action:()=>Promise<any>){if(locks.current.has(key))return;locks.current.add(key);setBusy([...locks.current]);setError('');try{await action();}catch(error){setError(String(error).replace(/^Error invoking remote method 'app': (?:Error: )?/,''));}finally{locks.current.delete(key);setBusy([...locks.current]);}}
 function json(text:string,label:string){try{return JSON.parse(text);}catch{throw Error('Enter valid JSON for '+label+'.');}}
 async function add(){
  const config=kind==='http'?{url:address.trim(),...(oauth?{auth:'oauth'}:{}),headers:json(values,'headers')}:{command:address.trim(),args:json(args,'arguments'),env:json(values,'environment values')};
  await call('mcpAdd',{name,config});setName('');setAddress('');setArgs('[]');setValues('{}');
 }
 function preview(){const parsed=parseMcpImport(paste);if(!parsed){setError('Paste an MCP configuration, server URL or supported command.');return;}setImports(parsed);setPaste('');setError('');}
 return <section className="mcp-settings" aria-label="MCP connections"><h3>MCP connections</h3><p>One set of connections for all chats.</p>
  {state.mcpError&&<p className="error" role="alert">{state.mcpError}<button onClick={()=>void run('refresh',()=>call('mcpRefresh'))}>Retry</button></p>}
  {!state.mcp?.length&&<p className="hint">No MCP servers added.</p>}
  {state.mcp?.map(row=><details key={row.id} className="supplier-pill" data-mcp-id={row.id}><summary><strong>{row.name}</strong><span>{row.signingIn?'Waiting for sign-in':row.status}</span><span className="supplier-chevron">⌄</span></summary><div className="supplier-settings"><p className="mcp-address">{row.address}</p><p>{row.transport==='stdio'?'Local command':'Remote server'} · {row.tools} tools</p>
   {row.transport==='stdio'&&<p className="hint">Test runs this command with your Windows account. Only connect servers you trust.</p>}
   <div className="actions"><Switch disabled={busy.includes(row.id)} checked={row.enabled} ariaLabel={row.name+' connection'} label={row.enabled?'On':'Off'} onChange={()=>void run(row.id,()=>call('mcpAction',{id:row.id,action:row.enabled?'off':'on'}))}/>
    {row.auth==='oauth'&&(row.signingIn?<button onClick={()=>void run(row.id+':cancel',()=>call('mcpAction',{id:row.id,action:'cancelLogin'}))}>Cancel sign-in</button>:<button disabled={!row.enabled||busy.includes(row.id)} onClick={()=>void run(row.id,()=>call('mcpLogin',{id:row.id}))}>Sign in</button>)}
    <button disabled={!row.enabled||row.signingIn||busy.includes(row.id)} onClick={()=>void run(row.id,()=>call('mcpAction',{id:row.id,action:'test'}))}>Test connection</button>
    {row.auth==='oauth'&&<button disabled={busy.includes(row.id)&&!row.signingIn} onClick={()=>void run(row.id+':revoke',()=>call('mcpAction',{id:row.id,action:'revoke'}))}>Forget sign-in</button>}
    <button disabled={busy.includes(row.id)&&!row.signingIn} onClick={()=>void run(row.id+':remove',()=>call('mcpAction',{id:row.id,action:'remove'}))}>Remove server</button>
   </div></div></details>)}
  <details className="supplier-pill"><summary><strong>Add MCP server</strong><span className="supplier-chevron">＋</span></summary><div className="supplier-settings">
   <label>Setup<select aria-label="MCP setup" value={kind} onChange={event=>{setKind(event.target.value);setAddress('');setValues('{}');}}><option value="http">Remote server</option><option value="stdio">Local command</option><option value="paste">Paste configuration or command</option></select></label>
   {kind==='paste'?<><label>Configuration or command<textarea aria-label="Paste MCP configuration" value={paste} onChange={event=>setPaste(event.target.value)} spellCheck={false}/></label><button disabled={!paste.trim()} onClick={preview}>Review import</button>{imports.map((entry,index)=><ImportedServer key={entry.name+index} entry={entry} call={call} saved={()=>setImports(previous=>previous.filter(item=>item!==entry))}/>)}</>:<>
    <label>Connection name<input aria-label="MCP connection name" value={name} onChange={event=>setName(event.target.value)} autoComplete="off"/></label>
    <label>{kind==='http'?'Server URL':'Executable'}<input aria-label="MCP server address" value={address} onChange={event=>setAddress(event.target.value)} autoComplete="off" placeholder={kind==='http'?'https://…/mcp':'Full path or command name'}/></label>
    {kind==='http'?<label className="inline-check"><input type="checkbox" checked={oauth} onChange={event=>setOauth(event.target.checked)}/>Sign in with OAuth</label>:<label>Arguments (JSON array)<textarea aria-label="MCP arguments" value={args} onChange={event=>setArgs(event.target.value)} spellCheck={false}/></label>}
    <details><summary>{kind==='http'?'Headers':'Environment values'} (optional)</summary><label>Names and values (JSON object)<textarea aria-label="MCP credential values" value={values} onChange={event=>setValues(event.target.value)} spellCheck={false} autoComplete="off"/></label><p className="hint">Credentials are saved in Windows Credential Manager and supplied only to this server.</p></details>
    <p className="hint">Saving does not start the server. Use {kind==='http'&&oauth?'Sign in':'Test connection'} when ready.</p><button className="primary" disabled={busy.includes('add')||!name.trim()||!address.trim()} onClick={()=>void run('add',add)}>{busy.includes('add')?'Saving…':'Save server'}</button>
   </>}
  </div></details>{error&&<p className="error" role="alert">{error}</p>}
 </section>;
}
