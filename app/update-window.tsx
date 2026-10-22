// The window named "update" (BACKLOG 1 October): what's new with its history and app updates; the new-model check
// and the Hermes release notice join it. It opens by itself once per new version and reopens from Settings.
// What's new is Video Dancer's news card (his pick U1, 2026-10-22): the new version's lines, then "earlier" and every
// version before it in one scroll. UpdateChip is Video Dancer's header chip, at the right end of the title bar.
import React from 'react';
import type {Snapshot} from './types';
import {ChoiceMenu,Dialog,Icon,Notice} from './kit';
import {modelLabel} from './models';

type Call=(method:string,args?:any)=>Promise<any>;

function NewsRows({notes}:{notes:string[]}){return <div className="update-rows">{notes.map(note=><div key={note}><span className="update-gem" aria-hidden="true">◆</span><span>{note}</span></div>)}</div>;}

export function UpdateChip({state,call}:{state:Snapshot;call:Call}){
 const u=state.updates,version=u?.available?.version;
 if(u?.downloaded)return <button className="update-chip ready" title={`Ghidorah ${version} is downloaded. Click: your chats are copied, it installs and reopens. If you quit instead, it installs then.`} onClick={()=>void call('updateRestart')}><Icon name="restart"/>restart to update ({version})</button>;
 if(u?.downloading)return <span className="update-chip" role="status" title={`Downloading Ghidorah ${version}`}><Icon name="restart"/>updating {u.percent??0}%</span>;
 if(u?.failed)return <button className="update-chip failed" title={u.failed+' Click to try again.'} onClick={()=>void call('updateCheck')}>update failed ✕</button>;
 return null;
}

export function UpdateWindow({state,call,close}:{state:Snapshot;call:Call;close:()=>void}){
 const u=state.updates,[error,setError]=React.useState('');
 if(!u)return null;
 const run=(method:string,args?:any)=>{setError('');void call(method,args).catch(problem=>setError(String(problem).replace(/^Error invoking remote method 'app': (?:Error: )?/,'')));};
 const [newest,...earlier]=u.history;
 return <Dialog title="update" id="update-title" className="update-window" closeLabel="Close update" onClose={close}>
  {error&&<Notice tone="danger" role="alert" className="error">{error}</Notice>}
  {u.rolledBack&&<Notice tone="warning" role="status">{u.rolledBack} didn't open, so {u.current} came back by itself. Your chats were copied before the install.</Notice>}
  <section aria-label="What's new" className="update-news">
   {newest?<><h3>new in {newest.version}</h3>
    <div className="update-news-scroll">
     <NewsRows notes={newest.notes}/>
     {earlier.length>0&&<div className="update-earlier"><span>earlier</span><i/></div>}
     {earlier.map(entry=><div key={entry.version} className="update-release"><div className="update-version">v{entry.version}</div><NewsRows notes={entry.notes}/></div>)}
    </div>
    <p className="update-news-foot">{u.available?'':"you're on the newest version · "}scroll for the whole story · this shows once per update</p></>:<p className="hint">No release notes yet.</p>}
  </section>
  <section aria-label="App updates"><h3>App updates</h3>
   <div className="connection-field"><span>Updates</span><ChoiceMenu label="App updates" value={u.mode} options={{manual:'Manual',automatic:'Automatic'}} onChange={mode=>run('updateSettings',{mode})}/></div>
   <p role="status">{u.status}</p>
   <p className="hint">Your chats are copied before every install.</p>
   {u.available?.notes&&!u.downloaded&&<pre className="update-notes">{u.available.notes}</pre>}
   <div className="actions"><button disabled={u.checking||u.downloading||u.downloaded} onClick={()=>run('updateCheck')}>Check now</button>{u.available&&!u.downloaded&&!u.downloading&&<button onClick={()=>run('updateDownload')}>Download update</button>}{u.downloaded&&<button className="primary" onClick={()=>run('updateRestart')}>Restart to update</button>}</div>
  </section>
  <section aria-label="New models"><h3>New models</h3>
   <div className="connection-field"><span>Check</span><ChoiceMenu label="New-model check" value={u.discovery.mode} options={{manual:'Manual',session:'Once per session'}} onChange={mode=>run('discoverySettings',{mode})}/></div>
   <div className="connection-field"><span>Checked by</span><ChoiceMenu label="New-model check AI" value={u.discovery.model||''} options={Object.fromEntries([['','Choose a model'],...(state.availableModels||[]).filter(model=>!model.startsWith('claude-code:')).map(model=>[model,modelLabel(model)])])} onChange={model=>run('discoverySettings',{model})}/></div>
   <p role="status">{u.discovery.status}</p>
   <div className="actions">{u.discovery.running?<button onClick={()=>run('discoveryCancel')}>Cancel</button>:<button disabled={!u.discovery.model} onClick={()=>run('discoveryCheck')}>Check now</button>}</div>
   {u.discovery.result&&<div className="discovery"><p className="hint">AI review of supplier pages. Catalogue absence does not confirm retirement; suggestions do not change tool permissions.</p>
    {(u.discovery.result.unavailable||[]).map(row=><p className="hint" key={row.provider}>{row.provider}: {row.reason} Previous check retained.</p>)}
    {u.discovery.result.added.length===0&&u.discovery.result.removed.length===0&&<p className="hint">No new or missing catalogue entries since the last check.</p>}
    {u.discovery.result.models.map(model=><p key={model.provider+model.id}><strong>{model.id}</strong> · new · {model.description} <small>{model.abilities.join(', ')} · <a href={model.source}>source</a></small></p>)}
    {(u.discovery.result.changes||[]).map(model=><p key={'changed'+model.provider+model.id}><strong>{model.id}</strong> · capability change · {model.description} <small>{model.abilities.join(', ')} · <a href={model.source}>source</a></small></p>)}
    {u.discovery.result.removed.map(model=><p key={'gone'+model.provider+model.id}><strong>{model.id}</strong> · no longer listed</p>)}
    {u.discovery.result.suggestions.length>0&&<><h4>Feature ideas</h4>{u.discovery.result.suggestions.map(item=><p key={item.title}><strong>{item.title}</strong> · {item.status==='planned'?'already planned':'new'} · {item.detail}</p>)}</>}
   </div>}
  </section>
  <section aria-label="Hermes"><h3>Hermes</h3>
   <p>Installed: Hermes {u.hermes.pinned} <small>(fork {u.hermes.fork.slice(0,7)})</small></p>
   <p role="status">{u.hermes.status}</p>
   {u.hermes.releases.map(release=><details key={release.tag} open={release.state==='new'}><summary>{release.name} · {release.state==='roll-in'?'to roll in':release.state==='skipped'?'skipped':'new'}</summary>
    {release.impact&&<><h4>What changes</h4><ul>{release.impact.facts.map(fact=><li key={fact}>{fact}</li>)}</ul><h4>Recommendation</h4><p>{release.impact.recommendation}</p></>}
    <pre className="update-notes">{release.notes}</pre>
    {release.state==='new'&&<div className="actions"><button className="primary" onClick={()=>run('hermesRelease',{tag:release.tag,state:'roll-in'})}>Roll in</button><button onClick={()=>run('hermesRelease',{tag:release.tag,state:'skipped'})}>Skip</button></div>}
   </details>)}
   <div className="actions"><button onClick={()=>run('hermesCheck')}>Check now</button></div>
  </section>
 </Dialog>;
}
