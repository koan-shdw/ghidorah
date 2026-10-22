import React,{useEffect,useState} from 'react';
import {Switch} from './kit';
import type {PluginChange} from './plugin-changes';
import type {NativePlugin,NativePluginInstall} from './native-plugins';
import {ImportedServer} from './mcp-settings';
import type {McpImportEntry} from './upstream/mcp-import';
import {skillPicks,pickInstalled,type SkillPick} from './skill-picks';

type Call=(method:string,args?:any)=>Promise<any>;
function setupValues(item:NativePlugin,drafts:Record<string,any>){
 const result:Record<string,unknown>={};
 for(const field of item.setup?.fields||[]){
  if(!Object.hasOwn(drafts,field.key))continue;
  const value=drafts[field.key];if(field.type==='secret'&&value==='')continue;
  if(value===null){result[field.key]=null;continue;}
  if(field.type==='json'){try{result[field.key]=JSON.parse(value);}catch{throw Error('Enter valid JSON for '+field.label+'.');}}
  else if(field.type==='number'){if(value==='')result[field.key]=null;else if(Number.isFinite(Number(value)))result[field.key]=Number(value);else throw Error('Enter a number for '+field.label+'.');}
  else result[field.key]=value;
 }
 return result;
}
function SetupFields({item,drafts,setDrafts}:{item:NativePlugin|NativePluginInstall;drafts:Record<string,any>;setDrafts:(value:Record<string,any>)=>void}){
 const configuration='configuration' in item?item.configuration:undefined;
 if(!item.setup?.fields.length)return null;
 return <fieldset className="plugin-fields"><legend>Plugin settings · GPT and DeepSeek</legend>{item.setup.fields.map(field=>{
  const saved=configuration?.values[field.key]??field.default;
  const value=Object.hasOwn(drafts,field.key)?drafts[field.key]:field.type==='secret'?'':field.type==='json'?JSON.stringify(saved??{},null,2):saved??'';
  const change=(value:unknown)=>setDrafts({...drafts,[field.key]:value});
  const choices=field.schema.choices||field.schema.enum||[];
  return <label key={field.key}>{field.label}{field.required?' *':''}
   {field.type==='boolean'?<input type="checkbox" aria-label={field.label} checked={!!value} onChange={event=>change(event.target.checked)}/>:field.type==='enum'?<select aria-label={field.label} value={value??''} onChange={event=>change(event.target.value)}><option value="">Choose…</option>{choices.map((choice:any)=><option key={String(choice)} value={String(choice)}>{String(choice)}</option>)}</select>:field.type==='json'?<textarea aria-label={field.label} value={value??''} onChange={event=>change(event.target.value)}/>:<input type={field.type==='secret'?'password':field.type==='number'?'number':'text'} aria-label={field.label} autoComplete="off" step="any" value={value??''} placeholder={configuration?.filled.includes(field.key)?'Saved · leave blank to keep':''} onChange={event=>change(event.target.value)}/>}
   {field.description&&<small>{field.description}</small>}{configuration?.filled.includes(field.key)&&field.type==='secret'&&<button type="button" onClick={()=>change(null)}>Clear {field.label}</button>}
  </label>;
 })}</fieldset>;
}
function ConfigurationForm({item,save,busy}:{item:NativePluginInstall;save:(values:Record<string,unknown>)=>Promise<void>;busy:boolean}){
 const [drafts,setDrafts]=useState<Record<string,any>>({}),[error,setError]=useState('');
 if(!item.setup?.fields.length)return null;
 return <form onSubmit={event=>{event.preventDefault();setError('');void (async()=>{try{await save(setupValues(item,drafts));setDrafts({});}catch(error){setError(String(error));}})();}}><SetupFields item={item} drafts={drafts} setDrafts={setDrafts}/><button disabled={busy} type="submit">Save plugin settings</button>{error&&<p role="alert">{error}</p>}</form>;
}
function ConversionDetails({item}:{item:NativePlugin}){
 const conversion=item.conversion;if(!conversion)return null;
 return <div className="conversion-details" aria-label="Conversion details">
  <p><strong>{conversion.kind==='skill'?'Shared skill':'Converted for GPT and DeepSeek'}</strong></p>
  {conversion.skills.length>0&&<p>Skills: {conversion.skills.map(row=>row.name).join(', ')}</p>}
  {conversion.commands.length>0&&<p>Commands: {conversion.commands.map(row=><code key={row.name}>/{item.name}:{row.name} </code>)}</p>}
  {conversion.servers.length>0&&<p>MCP servers ready for connection review: {conversion.servers.map(row=>row.name).join(', ')}.</p>}
  {conversion.unsupported.length>0&&<details open><summary>Not converted for GPT/DeepSeek</summary><ul>{conversion.unsupported.map((row,index)=><li key={index}>{row}</li>)}</ul></details>}
 </div>;
}
function SkillsHub({call,review,busy,open=false}:{call:Call;review:(value:any)=>void;busy:boolean;open?:boolean}){
 const [query,setQuery]=useState(''),[result,setResult]=useState<any>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
 async function search(page=1){setLoading(true);setError('');try{setResult(await call('skillsBrowse',{query,page}));}catch(error){setError(String(error));}finally{setLoading(false);}}
 async function inspect(identifier:string){setLoading(true);setError('');try{review(await call('skillReview',{identifier}));}catch(error){setError(String(error));}finally{setLoading(false);}}
 return <details className="supplier-pill" open={open||undefined}><summary><strong>Skills Hub</strong><span>Browse and review</span></summary><div className="supplier-settings">
  <form onSubmit={event=>{event.preventDefault();void search();}}><label>Find a skill<input aria-label="Skills Hub search" maxLength={120} value={query} onChange={event=>setQuery(event.target.value)} placeholder="Name or task"/></label><button disabled={busy||loading} type="submit">Search skills</button></form>
  {result&&<div className="hub-results">{!result.items.length&&<p>No skills found.</p>}{result.items.map((item:any)=><div className="hub-skill" key={item.identifier}><strong>{item.name}</strong><p>{item.description}</p><small>{item.identifier}<br/>{item.source} · {item.trust}</small><button disabled={busy||loading} aria-label={'Review skill '+item.name} onClick={()=>void inspect(item.identifier)}>Review skill</button></div>)}<div className="actions"><button disabled={loading||result.page===1} onClick={()=>void search(result.page-1)}>Previous</button><small>Page {result.page}</small><button disabled={loading||!result.more} onClick={()=>void search(result.page+1)}>Next</button></div></div>}
  {loading&&<p role="status">{result?'Loading skill…':'Loading Skills Hub…'}</p>}{error&&<p role="alert" className="error">{error}</p>}
 </div></details>;
}
const initials=(name:string)=>name.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0,2).map(part=>part[0].toUpperCase()).join('')||'?';
function SkillIcon({name,icon}:{name:string;icon?:string}){return <span className="skill-icon" aria-hidden="true">{icon?<img src={icon} alt=""/>:initials(name)}</span>;}
// Skills page: installed packages and Koan's picks as icons; selecting one opens its details under the grid.
function SkillShelf({installed,call,busy,run,load,review}:{installed:NativePluginInstall[];call:Call;busy:boolean;run:(action:()=>Promise<any>)=>Promise<void>;load:()=>Promise<void>;review:(value:any)=>void}){
 const [open,setOpen]=useState<string|null>(null);
 const toggle=(key:string)=>setOpen(open===key?null:key);
 const source=(item:NativePluginInstall)=>item.repository&&!item.repository.startsWith('installed:')?item.repository:null;
 const iconFor=(item:NativePluginInstall)=>skillPicks.find(pick=>pickInstalled(pick,[item]))?.icon;
 const item=installed.find(row=>open==='installed:'+row.id),pick=skillPicks.find(row=>open==='pick:'+row.name),pickHave=pick&&pickInstalled(pick,installed);
 const github=(repository:string)=>void call('openRepository',{repository}).catch(()=>{});
 const install=(row:SkillPick)=>{const target=row.install!;void run(async()=>review(target.kind==='repository'?await call('pluginRepositoryReview',{repository:target.repository,commit:''}):await call('skillReview',{identifier:target.identifier})));};
 return <section className="skill-shelf" aria-label="Skill shelf">
  <h4>Installed</h4>
  {installed.length?<div className="skill-grid">{installed.map(row=><button key={row.id} className={'skill-tile'+(open==='installed:'+row.id?' open':'')+(row.enabled?'':' off')} aria-expanded={open==='installed:'+row.id} onClick={()=>toggle('installed:'+row.id)}><SkillIcon name={row.name} icon={iconFor(row)}/><span className="skill-name">{row.name}</span><small>{row.enabled?'On':'Off'}</small></button>)}</div>:<p className="pool-empty">Nothing installed yet. Pick one below.</p>}
  {item&&<div className="skill-detail" role="region" aria-label={item.name+' details'}>
   <header><SkillIcon name={item.name} icon={iconFor(item)}/><div><strong>{item.name}</strong><small>{item.version?item.version+' · ':''}{item.hermes?(item.native?'GPT · DeepSeek · Claude':'GPT · DeepSeek'):'Claude'}</small></div></header>
   <p>{item.description}</p>
   <dl>{source(item)&&<><dt>Repository</dt><dd>{source(item)}</dd></>}{item.commit&&<><dt>Commit</dt><dd><code>{item.commit.slice(0,12)}</code></dd></>}<dt>Content</dt><dd><code>{item.hash.slice(0,12)}</code></dd></dl>
   <ConversionDetails item={item}/>
   <div className="actions">{source(item)&&<button onClick={()=>github(source(item)!)}>Open on GitHub</button>}<Switch disabled={busy} checked={item.enabled} ariaLabel={'Enable '+item.name} label={item.enabled?'Turn off':'Turn on'} onChange={()=>void run(async()=>{await call('nativePluginToggle',{id:item.id,enabled:!item.enabled});await load();})}/><button className="danger" disabled={busy||item.enabled} title={item.enabled?'Turn it off first':undefined} onClick={()=>void run(async()=>{await call('nativePluginRemove',{id:item.id});setOpen(null);await load();})}>Remove</button></div>
  </div>}
  <h4>Our picks</h4>
  <div className="skill-grid">{skillPicks.map(row=>{const have=pickInstalled(row,installed);return <button key={row.name} className={'skill-tile'+(open==='pick:'+row.name?' open':'')} aria-expanded={open==='pick:'+row.name} onClick={()=>toggle('pick:'+row.name)}><SkillIcon name={row.name} icon={row.icon}/><span className="skill-name">{row.name}</span><small>{have?'Installed':row.rank}</small></button>;})}</div>
  {pick&&<div className="skill-detail" role="region" aria-label={pick.name+' details'}>
   <header><SkillIcon name={pick.name} icon={pick.icon}/><div><strong>{pick.name}</strong><small>{pick.rank} · {pick.repo}{pick.path?'/'+pick.path:''}</small></div></header>
   <p>{pick.blurb}</p>{pick.note&&<p className="hint">{pick.note}</p>}
   <div className="actions"><button onClick={()=>github(pick.repo+(pick.path?'/'+pick.path:''))}>Open on GitHub</button>{pick.install&&(pickHave?<span className="skill-installed">Installed · {pickHave.enabled?'On':'Off'}</span>:<button className="primary" disabled={busy} onClick={()=>install(pick)}>Review and install</button>)}</div>
  </div>}
 </section>;
}
export function PluginsSettings({call,skills=false,changes=[]}:{call:Call;skills?:boolean;changes?:PluginChange[]}){
 const [catalog,setCatalog]=useState<any[]>([]),[installed,setInstalled]=useState<NativePluginInstall[]>([]),[review,setReview]=useState<(NativePlugin&{token:string})|null>(null),[checking,setBusy]=useState(false),[error,setError]=useState('');
 const busy=checking||changes.some(row=>row.status==='queued'||row.status==='applying');
 const finished=changes.filter(row=>['completed','failed','cancelled'].includes(row.status)).map(row=>row.id+row.status).join('|');
 useEffect(()=>{if(finished)void load().catch(error=>setError(String(error)));},[finished]);
 const [repository,setRepository]=useState('DietrichGebert/ponytail'),[commit,setCommit]=useState(''),[server,setServer]=useState<McpImportEntry|null>(null),[notice,setNotice]=useState('');
 const [drafts,setDrafts]=useState<Record<string,any>>({}),[installing,setInstalling]=useState(false);useEffect(()=>setDrafts({}),[review?.token]);
 useEffect(()=>{if(review)document.querySelector('[aria-label="Plugin review"]')?.scrollIntoView({block:'nearest'});},[review?.token]);
 async function load(){const result=await call('nativePlugins');setCatalog(result.catalog);setInstalled(result.installed);}
 async function run(action:()=>Promise<any>){setBusy(true);setError('');try{await action();}catch(error){setError(String(error));}finally{setBusy(false);}}
 useEffect(()=>{void run(load);},[]);
 return <section aria-label={skills?"Skills":"Plugins"} className="plugins-settings"><h3>{skills?"Skills":"Plugins"}</h3><p>Plugins apply across chats. Each version stays fixed until you review a change.</p>
  <div className="plugin-feedback">{changes.map(row=><div key={row.id} role={row.status==='failed'?'alert':'status'} className={row.status==='failed'?'error':'settings-card'}><strong>{row.name} · {row.status==='queued'?'Queued':row.status==='applying'?'Applying':row.status==='completed'?'Done':row.status==='cancelled'?'Cancelled':'Failed'}</strong><p>{row.message}</p>{row.cancellable&&<button onClick={()=>void call('pluginSetupCancel',{id:row.id}).catch(error=>setError(String(error)))}>Cancel {row.action.toLowerCase()}</button>}</div>)}{error&&<p className="error" role="alert">{error}</p>}{checking&&!changes.some(row=>row.status==='queued'||row.status==='applying')&&<p role="status">Checking plugin…</p>}</div>
  {skills&&<SkillShelf installed={installed} call={call} busy={busy} run={run} load={load} review={setReview}/>}
  {!skills&&installed.map(item=><details className="supplier-pill" key={item.id}><summary><strong>{item.name}</strong><span>{item.version?item.version+' · ':''}{item.hermes?(item.native?'GPT · DeepSeek · Claude':'GPT · DeepSeek'):'Claude'}</span><span>{item.enabled?'On':'Off'}</span></summary><div className="supplier-settings">
   <p>{item.description}</p><small>Content {item.hash.slice(0,12)}{item.commit?' · Source commit '+item.commit:''}</small><ConversionDetails item={item}/>
   <Switch disabled={busy} checked={item.enabled} ariaLabel={'Enable '+item.name} label={item.enabled?'Turn off':'Turn on'} onChange={()=>void run(async()=>{await call('nativePluginToggle',{id:item.id,enabled:!item.enabled});await load();})}/>
   <ConfigurationForm item={item} busy={busy} save={async values=>{setBusy(true);try{await call('pluginConfigure',{id:item.id,values});await load();}finally{setBusy(false);}}}/>
   {!!item.runtime?.packages.length&&<details><summary>Installed Python packages</summary>{item.runtime.packages.map(row=><p key={row.name}>{row.name} {row.version}</p>)}</details>}
   {item.conversion?.servers.map((entry,index)=><button key={index} disabled={busy||!item.enabled} onClick={()=>void run(async()=>{setNotice('');setServer(await call('pluginServerReview',{id:item.id,index}));})}>Review server {entry.name}</button>)}
  </div></details>)}
  {server&&<section aria-label="Plugin server import"><h3>Plugin server</h3><ImportedServer key={JSON.stringify(server)} entry={server} call={call} saved={()=>{setServer(null);setNotice('Server saved. Test or sign in from Connections. Servers remain separate connections when a plugin is turned off.');}}/><button onClick={()=>setServer(null)}>Cancel server import</button></section>}{notice&&<p role="status">{notice}</p>}
  <h3>Add plugin</h3><details className="supplier-pill" open={!review}><summary><strong>GitHub repository</strong><span>Hermes or Claude plugins</span></summary><div className="supplier-settings"><label>Repository<input aria-label="Plugin repository" value={repository} onChange={event=>setRepository(event.target.value)} placeholder="owner/repository"/></label><label>Commit <small>Optional · leave blank to review the current version</small><input aria-label="Plugin commit" value={commit} onChange={event=>setCommit(event.target.value)} placeholder="40-character commit"/></label><button disabled={busy||!repository.trim()} onClick={()=>void run(async()=>setReview(await call('pluginRepositoryReview',{repository:repository.trim(),commit:commit.trim()})))}>Review repository</button></div></details>
  {review&&<div className="approval" role="region" aria-label="Plugin review"><p role="status">{changes.find(row=>row.name===review.name&&['queued','applying'].includes(row.status))?.message||'Reviewed · Ready to install'}</p><strong>{review.name}{review.version?' · '+review.version:''}</strong><p>{review.description}</p><p>{[review.skills&&'Skills',review.commands&&'Commands',review.agents&&'Agents',review.hooks&&'Hooks'].filter(Boolean).join(' · ')}</p>
   {review.commit&&<p>{review.repository?.startsWith('installed:')?'Source commit reported by Claude Code':review.repository?'Git commit · '+review.repository:'Source commit reported by Claude Code'}<br/><code>{review.commit}</code></p>}<p>Content SHA256<br/><code>{review.hash}</code></p><ConversionDetails item={review}/>
   {review.hermes&&<><p>Available for GPT and DeepSeek{review.native?', and native Claude':''}.</p><p>Static scan: {review.hermes.scan.verdict}. This scan cannot guarantee what the code will do.</p>{review.hermes.scan.findings.length>0&&<details><summary>{review.hermes.scan.findings.length} scan findings</summary>{review.hermes.scan.findings.map((finding,index)=><p key={index}>{finding.file||finding.path} · {finding.message||finding.description||finding.pattern_id}</p>)}</details>}{review.hermes.prerequisites.length>0&&<div role="alert"><strong>Prerequisites need review</strong>{review.hermes.prerequisites.map(item=><p key={item}>{item}</p>)}</div>}</>}
   {!!review.setup?.python.length&&<p>Python dependencies: {review.setup.python.join(', ')}. Setup may run package build code. Packages are saved in a separate app folder.</p>}
   {!!review.setup?.plugins.length&&<p>Requires enabled plugins: {review.setup.plugins.map(row=>row.id+(row.version_range?' '+row.version_range:'')).join(', ')}.</p>}
   <SetupFields item={review} drafts={drafts} setDrafts={setDrafts}/>
  {review.mcp&&<p>{review.conversion?"After import, review each server in this plugin's settings.":'Add this plugin’s MCP servers separately in Connections.'} Saving a connection does not start it.</p>}<p>This code can use all your keys.</p><p>Applies to every chat on its next {review.hermes?'turn':'Claude turn'}. Updates require another review.</p>{error&&<p className="error" role="alert">{error}</p>}<button className="primary" disabled={busy||!!review.hermes&&(review.hermes.prerequisites.length>0||review.hermes.scan.verdict==='dangerous')} onClick={()=>void run(async()=>{setInstalling(true);try{await call('nativePluginInstall',{token:review.token,values:setupValues(review,drafts)});setReview(null);await load();document.querySelector('.plugin-feedback')?.scrollIntoView({block:'nearest'});}finally{setInstalling(false);}})}>{installing?(changes.some(row=>row.name===review.name&&row.status==='queued')?'Queued':'Installing…'):review.setup?.python.length?'Install dependencies and enable':'Import and enable'}</button><button disabled={busy} onClick={()=>setReview(null)}>Cancel</button>
  </div>}
  <SkillsHub open={skills} call={call} review={setReview} busy={busy}/>
  <details className="supplier-pill"><summary><strong>Installed in Claude Code</strong><span>Import or convert</span></summary><div className="supplier-settings">{!catalog.length?<p>No user plugins found.</p>:catalog.map(item=><div className="folder-setting" key={item.id}><span>{item.name} <small>{item.version}</small></span><button disabled={busy} onClick={()=>void run(async()=>setReview(await call('nativePluginReview',{id:item.id})))}>Review {item.name}</button><button disabled={busy} onClick={()=>void run(async()=>setReview(await call('pluginConversionReview',{id:item.id})))}>Convert {item.name}</button></div>)}</div></details>
 </section>;
}
