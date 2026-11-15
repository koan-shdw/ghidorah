// The window named "update": after an update it says which version is installed and what is new, with one Close. It
// opens by itself once per new version and reopens from Settings › Updates (What's new). Everything that asks for a
// choice lives in Settings › Updates: app updates, the new-model check and the Hermes releases (2026-11-16).
// What's new is Video Dancer's news card (his pick U1, 2026-10-22): the new version's lines, then "earlier" and every
// version before it in one scroll. UpdateChip is Video Dancer's header chip, at the right end of the title bar.
import React from 'react';
import type {Snapshot} from './types';
import {Button,ChoiceMenu,Dialog,Icon,Notice} from './kit';
import {modelLabel} from './models';
import {SettingsCard} from './settings-dialog';

type Call=(method:string,args?:any)=>Promise<any>;
type Release=NonNullable<Snapshot['updates']>['hermes']['releases'][number];

function NewsRows({notes}:{notes:string[]}){return <div className="update-rows">{notes.map(note=><div key={note}><span className="update-gem" aria-hidden="true">◆</span><span>{note}</span></div>)}</div>;}

/** True while a Hermes release waits for Roll in or Skip: the dot on Settings and on Settings › Updates. */
export function hermesWaiting(state:Snapshot){return !!state.updates?.hermes.releases.some(release=>release.state==='new');}
export const hermesWaitingNote='A new Hermes release is waiting in Settings › Updates.';

export function UpdateChip({state,call}:{state:Snapshot;call:Call}){
 const u=state.updates,version=u?.available?.version;
 if(u?.downloaded)return <button className="update-chip ready" title={`Ghidorah ${version} is downloaded. Click: your chats are copied, it installs and reopens. If you quit instead, it installs then.`} onClick={()=>void call('updateRestart')}><Icon name="restart"/>restart to update ({version})</button>;
 if(u?.downloading)return <span className="update-chip" role="status" title={`Downloading Ghidorah ${version}`}><Icon name="restart"/>updating {u.percent??0}%</span>;
 if(u?.failed)return <button className="update-chip failed" title={u.failed+' Click to try again.'} onClick={()=>void call('updateCheck')}>update failed ✕</button>;
 return null;
}

export function UpdateWindow({state,close}:{state:Snapshot;close:()=>void}){
 const u=state.updates;
 if(!u)return null;
 const [newest,...earlier]=u.history;
 return <Dialog title={`Ghidorah ${u.current} is installed`} id="update-title" className="update-window" closeLabel="Close update" onClose={close} footer={<Button variant="primary" data-autofocus onClick={close}>Close</Button>}>
  {u.rolledBack&&<Notice tone="warning" role="status">{u.rolledBack} didn't open, so {u.current} came back by itself. Your chats were copied before the install.</Notice>}
  <section aria-label="What's new" className="update-news">
   {newest?<><h3>new in {newest.version}</h3>
    <div className="update-news-scroll">
     <NewsRows notes={newest.notes}/>
     {earlier.length>0&&<div className="update-earlier"><span>earlier</span><i/></div>}
     {earlier.map(entry=><div key={entry.version} className="update-release"><div className="update-version">v{entry.version}</div><NewsRows notes={entry.notes}/></div>)}
    </div>
    <p className="update-news-foot">scroll for the whole story · this shows once per update</p></>:<p className="hint">No release notes yet.</p>}
  </section>
 </Dialog>;
}

const stateWords={new:'new','roll-in':'to roll in',skipped:'skipped'} as const;
const releaseVersion=(release:Release)=>release.name.match(/v\d[\w.-]*$/)?.[0]||release.tag;

/** Hermes releases: every new one shows with Roll in and Skip; the rest fold into one line until it is opened. */
function HermesReleases({releases,run}:{releases:Release[];run:(method:string,args?:any)=>void}){
 const [notes,setNotes]=React.useState<string|null>(null),[all,setAll]=React.useState(false);
 const waiting=releases.filter(release=>release.state==='new'),first=waiting.length?waiting:releases.slice(0,1);
 const shown=all?releases:first,folded=releases.filter(release=>!shown.includes(release));
 const counts=(['roll-in','skipped','new'] as const).map(kind=>[kind,folded.filter(release=>release.state===kind).length] as const).filter(([,count])=>count);
 const fold=folded.length?(counts.length===1?`${folded.length} more ${stateWords[counts[0][0]]}`:`${folded.length} more · ${counts.map(([kind,count])=>count+' '+stateWords[kind]).join(', ')}`)+(folded.length>1?` · ${releaseVersion(folded[folded.length-1])} to ${releaseVersion(folded[0])}`:` · ${releaseVersion(folded[0])}`):'';
 return <div className="hermes-releases">
  {shown.map(release=><div key={release.tag} className="hermes-release">
   <div className="hermes-release-row"><strong>{release.name}</strong><span className={'hermes-tag'+(release.state==='new'?' new':'')}>{stateWords[release.state]}</span>
    <span className="hermes-release-actions">{release.state==='new'&&<><button className="primary" onClick={()=>run('hermesRelease',{tag:release.tag,state:'roll-in'})}>Roll in</button><button onClick={()=>run('hermesRelease',{tag:release.tag,state:'skipped'})}>Skip</button></>}<button aria-expanded={notes===release.tag} aria-label={'Notes for '+release.name} onClick={()=>setNotes(notes===release.tag?null:release.tag)}>Notes</button></span></div>
   {notes===release.tag&&<div className="hermes-release-notes">
    {release.impact&&<><h4>What changes</h4><ul>{release.impact.facts.map(fact=><li key={fact}>{fact}</li>)}</ul><h4>Recommendation</h4><p>{release.impact.recommendation}</p></>}
    <pre className="update-notes">{release.notes}</pre>
   </div>}
  </div>)}
  {(folded.length>0||all)&&<button className="link-button hermes-fold" aria-expanded={all} onClick={()=>setAll(!all)}>{all?'Show fewer':fold}</button>}
 </div>;
}

/** The short word on the version row; the full sentence shows under it when it says more. */
function appStatus(u:NonNullable<Snapshot['updates']>){
 if(u.downloaded)return `${u.available?.version||'Update'} downloaded`;
 if(u.downloading)return `Downloading ${u.percent??0}%`;
 if(u.checking)return 'Checking';
 if(u.available)return `${u.available.version} available`;
 if(u.failed)return 'Check failed';
 return u.status==='Up to date.'?'Up to date':'Not checked yet';
}

/** Settings › Updates: Ghidorah's own updates, the Hermes releases and the new-model check. */
export function UpdatesSettings({state,call,whatsNew}:{state:Snapshot;call:Call;whatsNew:()=>void}){
 const u=state.updates,[error,setError]=React.useState('');
 if(!u)return <p className="hint">Updates are not ready yet.</p>;
 const run=(method:string,args?:any)=>{setError('');void call(method,args).catch(problem=>setError(String(problem).replace(/^Error invoking remote method 'app': (?:Error: )?/,'')));};
 return <div className="updates-settings">
  {error&&<Notice tone="danger" role="alert" className="error">{error}</Notice>}
  <SettingsCard title="Ghidorah">
   <div className="connection-field"><span>Updates</span><ChoiceMenu label="App updates" value={u.mode} options={{manual:'Manual',automatic:'Automatic'}} onChange={mode=>run('updateSettings',{mode})}/></div>
   <div className="connection-field"><span>Version {u.current}</span><span className="settings-status">{appStatus(u)}</span></div>
   {u.status&&u.status!=='Up to date.'&&<p role="status">{u.status}</p>}
   <p className="hint">Your chats are copied before every install.</p>
   {u.available?.notes&&!u.downloaded&&<pre className="update-notes">{u.available.notes}</pre>}
   <div className="actions"><button disabled={u.checking||u.downloading||u.downloaded} onClick={()=>run('updateCheck')}>Check now</button>{u.available&&!u.downloaded&&!u.downloading&&<button onClick={()=>run('updateDownload')}>Download update</button>}{u.downloaded&&<button className="primary" onClick={()=>run('updateRestart')}>Restart to update</button>}<button onClick={whatsNew}>What's new</button></div>
  </SettingsCard>
  <SettingsCard title="Hermes">
   <div className="connection-field"><span>Installed</span><span className="settings-status" title={'fork '+u.hermes.fork.slice(0,7)}>Hermes {u.hermes.pinned}</span></div>
   {u.hermes.status&&<p role="status">{u.hermes.status}</p>}
   {u.hermes.releases.length>0&&<HermesReleases releases={u.hermes.releases} run={run}/>}
   <div className="actions"><button onClick={()=>run('hermesCheck')}>Check now</button></div>
  </SettingsCard>
  <SettingsCard title="New models">
   <div className="connection-field"><span>Check</span><ChoiceMenu label="New-model check" value={u.discovery.mode} options={{manual:'Manual',session:'Once per session'}} onChange={mode=>run('discoverySettings',{mode})}/></div>
   <div className="connection-field"><span>Checked by</span><ChoiceMenu label="New-model check AI" value={u.discovery.model||''} options={Object.fromEntries([['','Choose a model'],...(state.availableModels||[]).filter(model=>!model.startsWith('claude-code:')).map(model=>[model,modelLabel(model)])])} onChange={model=>run('discoverySettings',{model})}/></div>
   {u.discovery.status&&<p role="status">{u.discovery.status}</p>}
   <div className="actions">{u.discovery.running?<button onClick={()=>run('discoveryCancel')}>Cancel</button>:<button disabled={!u.discovery.model} onClick={()=>run('discoveryCheck')}>Check now</button>}</div>
   {u.discovery.result&&<div className="discovery"><p className="hint">AI review of supplier pages. Catalogue absence does not confirm retirement; suggestions do not change tool permissions.</p>
    {(u.discovery.result.unavailable||[]).map(row=><p className="hint" key={row.provider}>{row.provider}: {row.reason} Previous check retained.</p>)}
    {u.discovery.result.added.length===0&&u.discovery.result.removed.length===0&&<p className="hint">No new or missing catalogue entries since the last check.</p>}
    {u.discovery.result.models.map(model=><p key={model.provider+model.id}><strong>{model.id}</strong> · new · {model.description} <small>{model.abilities.join(', ')} · <a href={model.source}>source</a></small></p>)}
    {(u.discovery.result.changes||[]).map(model=><p key={'changed'+model.provider+model.id}><strong>{model.id}</strong> · capability change · {model.description} <small>{model.abilities.join(', ')} · <a href={model.source}>source</a></small></p>)}
    {u.discovery.result.removed.map(model=><p key={'gone'+model.provider+model.id}><strong>{model.id}</strong> · no longer listed</p>)}
    {u.discovery.result.suggestions.length>0&&<><h4>Feature ideas</h4>{u.discovery.result.suggestions.map(item=><p key={item.title}><strong>{item.title}</strong> · {item.status==='planned'?'already planned':'new'} · {item.detail}</p>)}</>}
   </div>}
  </SettingsCard>
 </div>;
}
