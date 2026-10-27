import React,{useRef,useState} from 'react';
import {Switch,Tabs} from './kit';
import type {Snapshot} from './types';
import {parseMcpImport,type McpImportEntry} from './upstream/mcp-import';
import {mcpCatalog} from './mcp-catalog';

type Call=(method:string,args?:any)=>Promise<any>;
type Offer={key:string;name:string;about:string;url:string;type?:'http'|'sse';headers:string[];prefix?:string;hint?:string;oauth:boolean};
const catalogOffers:Offer[]=mcpCatalog.map(entry=>({key:entry.url,name:entry.name,about:entry.about,url:entry.url,headers:entry.token?[entry.token.header]:[],prefix:entry.token?.prefix,hint:entry.token?.hint,oauth:!entry.token}));
// One Discover row: OAuth servers save and open sign-in at once; token servers ask for the token first.
function OfferRow({offer,added,run,busy,call}:{offer:Offer;added:boolean;run:(key:string,action:()=>Promise<any>)=>Promise<void>;busy:boolean;call:Call}){
 const [values,setValues]=useState<Record<string,string>>({}),[open,setOpen]=useState(false),asks=offer.headers.length>0;
 async function add(){
  const headers=Object.fromEntries(offer.headers.map(name=>[name,(offer.prefix||'')+(values[name]||'').trim()]));
  const id=await call('mcpAdd',{name:offer.name,config:{url:offer.url,...(offer.type==='sse'?{type:'sse'}:{}),...(asks?{headers}:{auth:'oauth'})}});
  setOpen(false);setValues({});if(!asks&&offer.oauth&&typeof id==='string')await call('mcpLogin',{id});
 }
 return <li className="mcp-offer" data-offer={offer.key}><div><strong>{offer.name}</strong><p className="hint">{offer.about||offer.url}</p></div>
  {added?<span>Added</span>:asks&&!open?<button disabled={busy} onClick={()=>setOpen(true)}>Add</button>:!asks?<button disabled={busy} onClick={()=>void run('offer:'+offer.key,add)}>{offer.oauth?'Add and sign in':'Add'}</button>:null}
  {asks&&open&&!added&&<div className="mcp-offer-token">{offer.headers.map(name=><label key={name}>{offer.hint||name}<input type="password" aria-label={offer.name+' '+name} value={values[name]||''} onChange={event=>setValues(previous=>({...previous,[name]:event.target.value}))} autoComplete="off"/></label>)}
   <p className="hint">Saved in Windows Credential Manager and sent only to this server.</p><div className="actions"><button className="primary" disabled={busy||offer.headers.some(name=>!(values[name]||'').trim())} onClick={()=>void run('offer:'+offer.key,add)}>Save</button><button onClick={()=>setOpen(false)}>Cancel</button></div></div>}
 </li>;
}
// Google admits no app-registered sign-in, so Workspace runs locally (taylorwilsdon/google_workspace_mcp, pinned)
// with Ghidorah's own Desktop OAuth client (Google Cloud project ghidorah-512910), built in from google-client.json
// (kept out of git: GitHub push protection refuses OAuth secrets). ponytail: the app is in Google's testing mode until verified, so only its listed test
// users can sign in and grants expire after 7 days; publish it (Branding page, then verification) for everyone.
const googleArgs=['workspace-mcp==2.2.1','--single-user','--tools','gmail','drive','calendar','docs','sheets','slides'];
const googleClient=JSON.parse(process.env.GOOGLE_CLIENT||'null') as {id:string;secret:string}|null;
function GoogleWorkspace({state,call,run,busy}:{state:Snapshot;call:Call;run:(key:string,action:()=>Promise<any>)=>Promise<void>;busy:boolean}){
 const added=!!state.mcp?.some(row=>row.transport==='stdio'&&row.address==='uvx'&&row.name==='Google Workspace');
 const add=()=>call('mcpAdd',{name:'Google Workspace',config:{command:'uvx',args:googleArgs,env:{GOOGLE_OAUTH_CLIENT_ID:googleClient!.id,GOOGLE_OAUTH_CLIENT_SECRET:googleClient!.secret}}});
 return <li className="mcp-offer" data-offer="google-workspace"><div><strong>Google Workspace</strong><p className="hint">Gmail, Drive, Calendar, Docs, Sheets and Slides for every model. Runs on this PC; needs uv. Google sign-in opens the first time a chat uses it.</p></div>
  {added?<span>Added</span>:<button disabled={busy||!googleClient} title={googleClient?undefined:'This build has no Google sign-in app'} onClick={()=>void run('offer:google',add)}>Add</button>}
 </li>;
}
function Discover({state,call,run,busy}:{state:Snapshot;call:Call;run:(key:string,action:()=>Promise<any>)=>Promise<void>;busy:string[]}){
 const [query,setQuery]=useState(''),[found,setFound]=useState<Offer[]|null>(null);
 const added=(url:string)=>!!state.mcp?.some(row=>row.address===url.split('?')[0]),term=query.trim().toLowerCase();
 const shown=catalogOffers.filter(offer=>!term||(offer.name+' '+offer.about).toLowerCase().includes(term));
 async function search(){const rows=await call('mcpRegistry',{search:query});setFound((rows as any[]).map(row=>({key:row.id,name:row.name,about:row.id+(row.about?' · '+row.about:''),url:row.url,type:row.type,headers:row.headers,oauth:!row.headers.length})));}
 const row=(offer:Offer)=><OfferRow key={offer.key} offer={offer} added={added(offer.url)} busy={busy.includes('offer:'+offer.key)} run={run} call={call}/>;
 return <div className="mcp-discover">
  <label>Search<input aria-label="Search connectors" value={query} onChange={event=>{setQuery(event.target.value);setFound(null);}} onKeyDown={event=>{if(event.key==='Enter'&&query.trim())void run('registry',search);}} placeholder="Notion, Stripe, Webflow…" autoComplete="off"/></label>
  <ul className="mcp-offers">{(!term||'google workspace gmail drive calendar docs sheets slides'.includes(term))&&<GoogleWorkspace state={state} call={call} run={run} busy={busy.includes('offer:google')}/>}{shown.map(row)}</ul>
  {!shown.length&&<p className="hint">Not in the list.</p>}
  <div className="actions"><button disabled={!query.trim()||busy.includes('registry')} onClick={()=>void run('registry',search)}>{busy.includes('registry')?'Searching…':'Search the MCP Registry'}</button></div>
  {found&&(found.length?<><p className="hint">From the public MCP Registry. Anyone can list a server there: add only ones from developers you trust.</p><ul className="mcp-offers">{found.map(row)}</ul></>:<p className="hint">No remote servers found for “{query}”.</p>)}
  <p className="hint">Not here, like Shopify, Xero or Figma? Claude chats can use your claude.ai connectors: Settings, Connections, Anthropic. Any other server: Yours, Add MCP server.</p>
 </div>;
}
export function ImportedServer({entry,call,saved}:{entry:McpImportEntry;call:Call;saved:()=>void}){
 const [name,setName]=useState(entry.name),[json,setJson]=useState(()=>JSON.stringify(entry.config,null,2)),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const lock=useRef(false);
 async function save(){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{let config;try{config=JSON.parse(json);}catch{throw Error('Enter valid JSON for this server.');}if(config.transport){config.type=config.transport;delete config.transport;}await call('mcpAdd',{name,config});setJson('');saved();}catch(error){setError(String(error));}finally{lock.current=false;setBusy(false);}}
 return <section className="mcp-import"><label>Connection name<input aria-label="Imported connection name" value={name} onChange={event=>setName(event.target.value)}/></label><label>Server configuration<textarea aria-label="Imported server configuration" spellCheck={false} value={json} onChange={event=>setJson(event.target.value)}/></label><p className="hint">Review the command, server address and credentials before saving. Saving does not start the server.</p>{error&&<p role="alert">{error}</p>}<button disabled={busy||!name.trim()} onClick={()=>void save()}>{busy?'Saving…':'Save imported server'}</button></section>;
}
export function McpSettings({state,call}:{state:Snapshot;call:Call}){
 const [kind,setKind]=useState('http'),[name,setName]=useState(''),[address,setAddress]=useState(''),[oauth,setOauth]=useState(true),[args,setArgs]=useState('[]'),[values,setValues]=useState('{}'),[paste,setPaste]=useState(''),[imports,setImports]=useState<McpImportEntry[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState<string[]>([]),[tab,setTab]=useState<'yours'|'discover'>('yours');
 const locks=useRef(new Set<string>());
 async function run(key:string,action:()=>Promise<any>){if(locks.current.has(key))return;locks.current.add(key);setBusy([...locks.current]);setError('');try{await action();}catch(error){setError(String(error).replace(/^Error invoking remote method 'app': (?:Error: )?/,''));}finally{locks.current.delete(key);setBusy([...locks.current]);}}
 function json(text:string,label:string){try{return JSON.parse(text);}catch{throw Error('Enter valid JSON for '+label+'.');}}
 async function add(){
  const config=kind==='http'?{url:address.trim(),...(oauth?{auth:'oauth'}:{}),headers:json(values,'headers')}:{command:address.trim(),args:json(args,'arguments'),env:json(values,'environment values')};
  await call('mcpAdd',{name,config});setName('');setAddress('');setArgs('[]');setValues('{}');
 }
 function preview(){const parsed=parseMcpImport(paste);if(!parsed){setError('Paste an MCP configuration, server URL or supported command.');return;}setImports(parsed);setPaste('');setError('');}
 return <section className="mcp-settings" aria-label="MCP connections"><h3>MCP connections</h3><p>One set of connections for all chats.</p>
  <Tabs label="MCP connections view" items={[{id:'yours',label:'Yours'},{id:'discover',label:'Discover'}]} value={tab} onChange={setTab}/>
  {tab==='discover'?<Discover state={state} call={call} run={run} busy={busy}/>:<>
  {state.mcpError&&<p className="error" role="alert">{state.mcpError}<button onClick={()=>void run('refresh',()=>call('mcpRefresh'))}>Retry</button></p>}
  {!state.mcp?.length&&<p className="hint">No MCP servers added. Find one in Discover.</p>}
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
  </div></details></>}{error&&<p className="error" role="alert">{error}</p>}
 </section>;
}
