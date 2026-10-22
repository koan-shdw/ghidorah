import React,{useEffect,useState} from 'react';
import type {ApiConnection} from './api-catalog';

export function VertexSettings({connection,busy,action}:{connection?:ApiConnection;busy:boolean;action:(method:string,args?:any)=>Promise<void>}){
 const [projectId,setProject]=useState(connection?.projectId||''),[region,setRegion]=useState(connection?.region||'global');
 useEffect(()=>{setProject(connection?.projectId||'');setRegion(connection?.region||'global');},[connection?.projectId,connection?.region]);
 return <>
  <p>Connect Vertex AI using a Google Cloud service-account key or an authorized-user Application Default Credentials (ADC) file. Usage is billed to your Cloud project.</p>
  <label>Google Cloud project ID<input aria-label="Google Cloud project ID" value={projectId} onChange={e=>setProject(e.target.value)}/></label>
  <label>Region<input aria-label="Google Cloud region" value={region} onChange={e=>setRegion(e.target.value)}/></label>
  <div className="actions"><button disabled={busy||!projectId.trim()||!region.trim()} onClick={()=>void action('vertexImport',{projectId:projectId.trim(),region:region.trim()})}>Import credential JSON</button><button disabled={busy||!projectId.trim()||!region.trim()} onClick={()=>void action('vertexImport',{projectId:projectId.trim(),region:region.trim(),adc:true})}>Import saved ADC</button>{connection?.connected&&<><button disabled={busy} onClick={()=>void action('apiCheck')}>Check connection</button><button disabled={busy} onClick={()=>void action('apiDisconnect')}>Disconnect</button></>}</div>
  <p className="hint">Credentials are encrypted in app storage. Setup refreshes credentials and reads the publisher catalog without sending a prompt. Model access is checked on its first reply.</p>
 </>;
}
