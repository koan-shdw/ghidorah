import React,{useEffect,useState} from 'react';
import type {CheckpointPreview} from './checkpoints';
import {Button,Dialog,Notice} from './kit';

export function CheckpointDialog({chatId,turnId,call,close}:{chatId:string;turnId:string;call:(method:string,args:any)=>Promise<any>;close:()=>void}){
 const [preview,setPreview]=useState<CheckpointPreview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(false),[result,setResult]=useState<any>(null);
 const message=(error:unknown)=>String(error).replace(/^Error invoking remote method 'app': (?:Error: )?/,'');
 async function refresh(){setBusy(true);setPreview(null);setError('');try{setPreview(await call('checkpointPreview',{chatId,turnId}));}catch(error){setError(message(error));}finally{setBusy(false);}}
 useEffect(()=>{void refresh();},[chatId,turnId]);
 const count=preview?.files.filter(f=>f.action==='restore'||f.action==='remove').length||0;
 async function restore(){setBusy(true);setError('');try{setResult(await call('checkpointRestore',{chatId,turnId,revision:preview!.revision,retry}));}catch(error){setError(message(error));}finally{setBusy(false);}}
 return <Dialog title="Restore a checkpoint" id="checkpoint-title" className="checkpoint-dialog" size="lg" busy={busy} closeLabel="Close checkpoint" onClose={close} footer={<><Button variant="outline" disabled={busy} onClick={close}>{result?'Done':'Cancel'}</Button>{!result&&<><Button variant="outline" disabled={busy} onClick={()=>void refresh()}>Refresh preview</Button><Button variant="primary" disabled={busy||!count} onClick={()=>void restore()}>{busy?'Working…':retry?'Restore files and retry':'Restore files'}</Button></>}</>}>
   <p className="kit-dialog-lead">Review file edits from this message onward.</p>
   <p className="hint">Your original conversation is kept. Only verified direct file edits can be restored. Later changes are preserved. Commands, Git operations and external actions remain as they are.</p>
   {error&&<Notice tone="danger" role="alert" className="error">{error}</Notice>}
   {result?<><h3>Restore result</h3>{result.results.map((row:any)=><p key={row.path}><strong>{row.path}</strong> · {row.status==='restored'?'Restored':row.status==='not-restored'?'Kept':'Needs inspection'}<br/><span className="hint">{row.message}</span></p>)}{result.preserved>0&&<p>{result.preserved} changed or unverified {result.preserved===1?'file was':'files were'} preserved.</p>}{result.newChatId&&<p>A new chat is ready with your editable message. Sending is up to you.</p>}</>:
    <>{preview&&<><div className="checkpoint-counts"><span>{count} to restore</span><span>{preview.files.filter(f=>f.action==='preserve').length} preserved</span><span>{preview.files.filter(f=>f.action==='unchanged').length} already match</span></div>
    {!preview.files.length&&<p>No saved direct file edits for this message. Older edits and files changed through commands have no restorable checkpoint.</p>}
    {preview.files.map(file=><details className="checkpoint-file" key={file.path}><summary><strong>{file.path}</strong><span data-action={file.action}>{({restore:'Restore',remove:'Remove',unchanged:'Unchanged',preserve:'Preserve'})[file.action]}</span></summary><p>{file.reason}</p>{(file.beforeText||file.currentText)&&<div className="checkpoint-compare"><section><h4>Current file</h4><pre>{file.currentText||'(No file)'}</pre></section><section><h4>Checkpoint</h4><pre>{file.before===null?'(File did not exist)':file.beforeText||'(Empty file)'}</pre></section></div>}{file.truncated&&<p className="hint">Preview shortened. Restoration uses the full saved file.</p>}</details>)}
    {!!preview.otherActions.length&&<details className="checkpoint-effects"><summary>Other actions stay unchanged · {preview.otherActions.reduce((n,a)=>n+a.count,0)}</summary>{preview.otherActions.map(a=><p key={a.name}>{a.name} <span>×{a.count}</span></p>)}</details>}
    <label className="checkpoint-choice"><input type="checkbox" checked={retry} onChange={e=>setRetry(e.target.checked)}/>Also prepare this message in a new chat</label></>}</>}
 </Dialog>;
}
