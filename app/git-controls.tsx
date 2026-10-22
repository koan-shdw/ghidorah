import React,{useState} from 'react';
export interface GitSnapshot {repository:string;directory:string;revision:string;branch:string;head:string;upstream?:string;branches:string[];files:{path:string;status:string}[];remotes:{name:string;urls:string[]}[];}
export function GitControls({state,busy,disabled,onAction,onCancel}:{state:GitSnapshot|null;busy:boolean;disabled:boolean;onAction:(action:string,args?:any)=>Promise<any>;onCancel:()=>void}){
 const [form,setForm]=useState(''),[message,setMessage]=useState(''),[branch,setBranch]=useState(''),[remote,setRemote]=useState(''),[target,setTarget]=useState('');
 if(!state)return null;
 const staged=state.files.filter(file=>![' ','?','!'].includes(file.status[0])),chosen=state.remotes.find(row=>row.name===(remote||state.remotes[0]?.name));
 async function submit(action:string,args:any={}){const result=await onAction(action,args);if(result){setForm('');if(action==='commit')setMessage('');}}
 return <section className="git-controls" aria-label="Repository actions">
  <div className="git-heading"><span title={state.repository}>{state.repository.split(/[\\/]/).at(-1)}</span><span className="git-branch">{state.branch}</span>{busy&&<button onClick={onCancel}>Stop Git</button>}</div>
  <div className="git-buttons">{['Commit','Branch','Push'].map(label=><button key={label} disabled={disabled||busy||label==='Push'&&!state.remotes.length} aria-expanded={form===label} onClick={()=>setForm(form===label?'':label)}>{label}{label==='Commit'&&staged.length?' · '+staged.length:''}</button>)}</div>
  {form==='Commit'&&<form onSubmit={event=>{event.preventDefault();void submit('commit',{message});}}>
   <label>Commit message<textarea aria-label="Commit message" value={message} maxLength={4000} placeholder="Describe this change" onChange={event=>setMessage(event.target.value)}/></label>
   <details open><summary>{staged.length} staged {staged.length===1?'file':'files'} in this repository</summary><ul>{staged.map(file=><li key={file.path}>{file.path}</li>)}</ul>{!staged.length&&<p>Stage the files you want to include.</p>}</details>
   <button className="primary" disabled={busy||disabled||!staged.length||!message.trim()}>Commit staged</button>
  </form>}
  {form==='Branch'&&<div className="git-branch-form"><form onSubmit={event=>{event.preventDefault();void submit('branch',{branch});}}><label>New branch<input aria-label="New branch name" value={branch} maxLength={200} onChange={event=>setBranch(event.target.value)} placeholder="feature/my-change"/></label><button disabled={busy||disabled||!branch.trim()}>Create branch</button></form>{state.branches.some(name=>name!==state.branch)&&<form onSubmit={event=>{event.preventDefault();void submit('switch',{branch:target});}}><label>Existing branch<select aria-label="Existing branch" value={target} onChange={event=>setTarget(event.target.value)}><option value="">Choose a branch</option>{state.branches.filter(name=>name!==state.branch).map(name=><option key={name}>{name}</option>)}</select></label><button disabled={busy||disabled||!target}>Switch branch</button></form>}</div>}
  {form==='Push'&&<form onSubmit={event=>{event.preventDefault();void submit('push',{remote:chosen?.name});}}><label>Remote<select aria-label="Push remote" value={chosen?.name||''} onChange={event=>setRemote(event.target.value)}>{state.remotes.map(row=><option key={row.name}>{row.name}</option>)}</select></label><p className="git-destination"><strong>{state.branch}</strong><span>→ {chosen?.urls.join(', ')}</span></p><p>Push this branch’s committed changes.</p><button className="primary" disabled={busy||disabled||!chosen||chosen.urls.length!==1||state.branch==='(detached)'||state.head==='(initial)'}>Push branch</button></form>}
  {form&&<p className="git-hint">Git uses your configured identity, credentials, hooks and filters. Unsaved editor drafts are excluded.</p>}
 </section>;
}
