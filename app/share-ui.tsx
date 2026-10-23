// Share work with clients on screen (FEATURE-SPECS 3): the setup (Settings and the setup wizard, in Koan's words),
// the shared projects, the card in a shared project's chat and the review of the "for your AI" page.
import React,{useState} from 'react';
import type {Snapshot,ShareProjectView} from './types';
import {SettingsCard} from './settings-dialog';
import {Button,Dialog} from './kit';

type Call=(method:string,args?:any)=>Promise<any>;
const copy=(text:string)=>void navigator.clipboard.writeText(text).catch(()=>{});
const fresh=(project:ShareProjectView)=>project.notes.filter(note=>!note.handled);
const names=(project:ShareProjectView)=>[...new Set(fresh(project).map(note=>note.name))].join(', ');
const draftWaiting=(project:ShareProjectView)=>project.draft?.status==='ready'&&(project.ai?.version||0)<project.draft.version;

export function ShareSetup({state,call}:{state:Snapshot;call:Call}){
 const share=state.share,[busy,setBusy]=useState(false);
 const working=busy||/…$/.test(share?.status||'');
 return <SettingsCard title="Share work with clients">
  <p>In the future you can publish work in progress and send it to people for notes. Let’s set up your Cloudflare for free and make a private link where people can see a project and leave notes; their notes come back to Ghidorah.</p>
  <p className="hint">Ghidorah uses Cloudflare’s own tool (wrangler) with your Cloudflare sign-in in the browser; no key is stored. The site holds only what you share, never project code.</p>
  <div className="connection-field"><span>Status</span><span className="settings-status" role="status">{share?.status||(share?.ready?'Ready':'Not set up')}</span></div>
  {share?.ready&&<div className="connection-field"><span>Site</span><span className="share-address">{share.site}</span></div>}
  <div className="actions"><button className={share?.ready?undefined:'primary'} disabled={working} onClick={()=>{setBusy(true);void call('shareSetup').catch(()=>{}).finally(()=>setBusy(false));}}>{share?.ready?'Set up again':'Set it up'}</button></div>
 </SettingsCard>;
}

export function ShareSettings({state,call}:{state:Snapshot;call:Call}){
 const projects=state.share?.projects||[],[review,setReview]=useState<string|null>(null);
 return <>
  <ShareSetup state={state} call={call}/>
  {state.share?.ready&&<SettingsCard title="Shared projects">
   {!projects.length&&<p className="hint">Nothing shared yet. Ask a model in any chat to share a page with the client.</p>}
   {projects.map(project=><ShareRow key={project.id} project={project} call={call} review={()=>setReview(project.id)}/>)}
   <div className="actions"><button onClick={()=>void call('shareCheck').catch(()=>{})}>Check for notes now</button></div>
  </SettingsCard>}
  {review&&<AiPageDialog project={projects.find(project=>project.id===review)!} call={call} close={()=>setReview(null)}/>}
 </>;
}

function ShareRow({project,call,review}:{project:ShareProjectView;call:Call;review:()=>void}){
 const [password,setPassword]=useState('');
 return <section className="share-project" aria-label={'Shared project '+project.title}>
  <div className="share-head"><strong>{project.title}</strong><span className="hint">Version {project.version} · {project.page}</span></div>
  <div className="share-line"><span className="share-address">{project.link}</span><button onClick={()=>copy(project.link)}>Copy link</button><button onClick={()=>void call('shareOpen',{id:project.id}).catch(()=>{})}>Open</button></div>
  <div className="share-line"><span>AI page: {project.ai?'version '+project.ai.version+' is live':'not live yet'}{project.draft?.status==='writing'?' · writing a draft…':draftWaiting(project)?' · a draft for version '+project.draft!.version+' waits for you':project.draft?.status==='failed'?' · the draft failed':''}</span>
   {(draftWaiting(project)||project.ai)&&<button onClick={review}>{draftWaiting(project)?'Review':'Edit'}</button>}{project.draft?.status==='failed'&&<button onClick={()=>void call('shareRedraft',{id:project.id}).catch(()=>{})}>Try again</button>}</div>
  {project.ai&&<div className="share-line"><span className="share-address">{project.aiAddress}</span><button onClick={()=>copy(project.message)}>Copy message for the client</button></div>}
  <div className="share-line"><span>Password: {project.password?'on':'off'}</span><input type="password" aria-label={'New password for '+project.title} placeholder={project.password?'Change password':'Set a password'} value={password} onChange={event=>setPassword(event.target.value)}/>
   <button disabled={password.length<4} onClick={()=>void call('sharePassword',{id:project.id,password}).then(()=>setPassword('')).catch(()=>{})}>Save password</button>{project.password&&<button onClick={()=>void call('sharePassword',{id:project.id,password:null}).catch(()=>{})}>Remove password</button>}</div>
  <div className="share-line"><span>Notes: {project.notes.length} · {fresh(project).length} new</span>{fresh(project).length>0&&<button onClick={()=>void call('shareNotesSend',{id:project.id}).catch(()=>{})}>Send new notes to the model</button>}</div>
 </section>;
}

// Koan approves every version of the AI page before it goes live (3.7, his answer 2026-10-10).
export function AiPageDialog({project,call,close}:{project:ShareProjectView;call:Call;close:()=>void}){
 const [text,setText]=useState(draftWaiting(project)?project.draft!.text:project.ai?.text||project.draft?.text||''),[busy,setBusy]=useState(false),[done,setDone]=useState<{address:string;message:string}|null>(null);
 const approve=()=>{setBusy(true);void call('shareAiApprove',{id:project.id,text}).then(setDone).catch(()=>{}).finally(()=>setBusy(false));};
 return <Dialog className="share-dialog" label={'AI page for '+project.title} title={'AI page for '+project.title+' · version '+(draftWaiting(project)?project.draft!.version:project.version)} closeLabel="Close AI page" busy={busy} onClose={close}
  footer={done?<><Button variant="primary" onClick={()=>copy(done.message)}>Copy message</Button><Button variant="outline" onClick={close}>Close</Button></>
   :<><Button variant="primary" disabled={busy||!text.trim()} onClick={approve}>{busy?'Publishing…':'Approve and publish'}</Button><Button variant="outline" onClick={close}>Cancel</Button></>}>
  <p className="hint">The client’s AI reads this to help them give notes. Edit it, then approve. Ghidorah adds how to write notes and the page’s sections below it. Nothing else from the chat goes on it.</p>
  {done?<><p>Live at <span className="share-address">{done.address}</span></p><p className="hint">A message for the client:</p><p className="share-address">{done.message}</p></>
  :<textarea aria-label="AI page text" value={text} onChange={event=>setText(event.target.value)} rows={16}/>}
 </Dialog>;
}

// In the shared project's chat, just above the message box: a new version shared, an AI page draft to review, notes.
export function ShareCard({state,call,chatId}:{state:Snapshot;call:Call;chatId:string}){
 const [review,setReview]=useState<string|null>(null);
 const projects=(state.share?.projects||[]).filter(project=>project.chatId===chatId&&(project.seenVersion!==project.version||draftWaiting(project)||fresh(project).length>0));
 if(!projects.length&&!review)return null;
 const reviewing=(state.share?.projects||[]).find(project=>project.id===review);
 return <>{projects.map(project=><section className="share-card" aria-label={'Shared with the client: '+project.title} key={project.id}>
  <header><span>Shared with the client · version {project.version}</span><Button iconOnly icon="close" className="side-close" aria-label="Dismiss" title="Dismiss" onClick={()=>void call('shareDismiss',{id:project.id}).catch(()=>{})}/></header>
  <div className="share-line"><span className="share-address">{project.link}</span><button onClick={()=>copy(project.link)}>Copy link</button><button onClick={()=>void call('shareOpen',{id:project.id}).catch(()=>{})}>Open</button></div>
  {project.draft?.status==='writing'&&<p className="hint">Writing the AI page draft…</p>}
  {draftWaiting(project)&&<div className="share-line"><span>The AI page for version {project.draft!.version} is ready for you.</span><button className="primary" onClick={()=>setReview(project.id)}>Review</button></div>}
  {project.ai&&!draftWaiting(project)&&<div className="share-line"><span className="share-address">{project.message}</span><button onClick={()=>copy(project.message)}>Copy message</button></div>}
  {fresh(project).length>0&&<div className="share-line"><span>{fresh(project).length} new note{fresh(project).length===1?'':'s'} from {names(project)}</span><button className="primary" onClick={()=>void call('shareNotesSend',{id:project.id}).catch(()=>{})}>Send to the model</button></div>}
 </section>)}
 {reviewing&&<AiPageDialog project={reviewing} call={call} close={()=>setReview(null)}/>}</>;
}
