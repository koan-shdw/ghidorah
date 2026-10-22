import React,{useEffect,useRef,useState} from 'react';
import {mountGraph} from '../hermes/skills/software-development/repo-map/scripts/view.mjs';
import type {SavedApp} from './saved-apps';
import type {RepositoryMap} from './repo-map-service';
import './repo-map-panel.css';

type Call=(method:string,args?:any)=>Promise<any>;
export function RepoMapPanel({app,call}:{app:SavedApp;call:Call}){
 const [chosen,setChosen]=useState(''),[map,setMap]=useState<RepositoryMap|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
 const repositories=app.repositories||[],repository=repositories.includes(chosen)?chosen:repositories[0]||'',host=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  if(!repository){setMap(null);return;}
  let live=true;
  setMap(null);setError('');setBusy(true);
  // Opening reuses the saved map unless the repo has a new commit; the button (revision>0) forces a rebuild.
  call('savedAppMap',{id:app.id,repository,force:revision>0})
   .then(next=>{if(live)setMap(next);})
   .catch(e=>{if(live)setError(String(e).replace(/^Error invoking remote method 'app': (?:Error: )?/,''));})
   .finally(()=>{if(live)setBusy(false);});
  return()=>{live=false;};
 },[app.id,repository,revision]);
 useEffect(()=>{if(host.current&&map)return mountGraph(host.current,map);},[map]);
 return <section className="repo-map-panel" aria-label="Repository map"><header><div><h2>Repository map</h2><p>Explore files, dependencies and source-linked explanations.</p></div>{!!repositories.length&&<><select aria-label="Map repository" value={repository} onChange={e=>setChosen(e.target.value)}>{repositories.map(repo=><option key={repo} value={repo}>{repo.split(/[\\/]/).filter(Boolean).at(-1)||repo}</option>)}</select><button disabled={busy} onClick={()=>setRevision(v=>v+1)}>{busy?'Checking source…':'Refresh map'}</button></>}</header>
 {!repository&&<p>Add a repository folder to map this app.</p>}
 {error&&<p className="error" role="alert">Map refresh failed; any displayed map is an older snapshot. {error}</p>}
 {busy&&!map&&<p role="status">Indexing source files locally…</p>}
 <div ref={host}/>
 {map&&<p className="repo-map-help">Models can read <code>.repo-map/index.txt</code> in this repository, then use the repo-map skill for a fresh, task-focused query. Rebuilt when the repository has a new commit; press the button to rebuild now.</p>}
 </section>;
}
