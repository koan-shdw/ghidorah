import React,{useState,useEffect} from 'react';
import type {ApiConnection} from './api-catalog';
import {apiSuppliers,isApiProvider} from './api-catalog';
import {VertexSettings} from './vertex-settings';

export function ApiConnectionSettings({provider,connection,call}:{provider:string;connection?:ApiConnection;call:(method:string,args:any)=>Promise<any>}){
 const [key,setKey]=useState(''),[model,setModel]=useState(''),[busy,setBusy]=useState(false);
 const [region,setRegion]=useState(connection?.region||(provider==='alibaba'?'ap-southeast-1':'global'));
 const [workspaceId,setWorkspaceId]=useState(connection?.workspaceId||'');
 useEffect(()=>{setRegion(connection?.region||(provider==='alibaba'?'ap-southeast-1':'global'));setWorkspaceId(connection?.workspaceId||'');},[provider,connection?.region,connection?.workspaceId]);
 if(!isApiProvider(provider))return null;
 const name=apiSuppliers[provider].name;
 const signIn=provider==='nous'?'nous':provider==='minimax-oauth'?'minimax':'grok',signInName=provider==='nous'?'Nous':provider==='minimax-oauth'?'MiniMax':'Grok';
 async function action(method:string,args:any={}){setBusy(true);try{await call(method,{provider,...args});if(method==='apiSave')setKey('');if(method==='apiModel')setModel('');}catch{}finally{setBusy(false);}}
 return <div className="supplier-settings">
  {provider==='vertex'?<VertexSettings connection={connection} busy={busy} action={action}/>:(provider==='nous'||provider.endsWith('-oauth'))?<>
   <p>{provider==='nous'?'Sign in with Nous Portal. Nous determines your model access and plan limits.':provider==='minimax-oauth'?'Sign in with your MiniMax account. MiniMax determines your model access and plan limits.':'Sign in with your Grok subscription. xAI determines which models your account can access.'}</p>
   {provider==='minimax-oauth'&&<label>Account region<select aria-label="MiniMax account region" disabled={busy||!!connection?.login} value={region} onChange={e=>setRegion(e.target.value)}><option value="global">Global</option><option value="cn">China</option></select></label>}
   <div className="actions"><button className="primary" disabled={busy||!!connection?.login||connection?.status==='Starting sign-in…'} onClick={()=>void action(signIn+'Login',{region})}>{connection?.connected?'Sign in again':'Sign in with '+signInName}</button>{connection?.connected&&<><button disabled={busy||!!connection.login} onClick={()=>void action('apiCheck')}>Check connection</button><button disabled={busy||!!connection.login} onClick={()=>void action('apiDisconnect')}>Disconnect</button></>}</div>
   {connection?.login&&<div className="device-signin"><p>Open the sign-in page and enter this code:</p><code>{connection.login.code}</code><div className="actions"><button onClick={()=>void action(signIn+'Open')}>Open sign-in page ↗</button><button onClick={()=>void action(signIn+'Cancel')}>Cancel sign-in</button></div></div>}
   <p className="hint">Encrypted app-owned sign-in. Setup reads the model list without sending a prompt. Subscription usage windows are unavailable.</p>
  </>:<>
  {provider==='openrouter-api'&&<>
   <p>Sign in through OpenRouter to create a key, or enter an existing API key below.</p>
   <button disabled={busy||!!connection?.login||connection?.status==='Starting sign-in…'} onClick={()=>void action('openrouterLogin')}>Sign in with OpenRouter</button>
   {connection?.login&&<div className="device-signin"><p>Authorize in your browser, then return here.</p><div className="actions"><button onClick={()=>void action('openrouterOpen')}>Open sign-in page ↗</button><button onClick={()=>void action('openrouterCancel')}>Cancel sign-in</button></div></div>}
  </>}
  <p>{provider==='gemini'?'Connect a Google AI Studio API key.':provider==='zai'?'Connect prepaid Z.ai API credit.':'Connect your '+apiSuppliers[provider].account+' key.'} Keep automatic recharge and paid overage off in the supplier’s billing settings.</p>
  {provider==='alibaba'&&<><label>Region<select aria-label="Model Studio region" value={region} disabled={busy} onChange={e=>setRegion(e.target.value)}>{Object.entries({'ap-southeast-1':'Singapore','cn-beijing':'China (Beijing)','us-east-1':'US (Virginia)','cn-hongkong':'China (Hong Kong)','ap-northeast-1':'Japan (Tokyo)','eu-central-1':'Germany (Frankfurt)'}).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><label>Workspace ID<input aria-label="Model Studio workspace ID" value={workspaceId} disabled={busy} onChange={e=>setWorkspaceId(e.target.value)}/></label><p className="hint">Use a pay-as-you-go key from this region. Tokyo and Frankfurt require a workspace ID. Saving region changes requires the key again.</p></>}
  <label>API key<input aria-label={name+' API key'} type="password" autoComplete="off" value={key} onChange={event=>setKey(event.target.value)} placeholder={connection?.connected?'Enter a replacement key':'Paste API key'}/></label>
  <div className="actions"><button className="primary" disabled={busy||!key.trim()} onClick={()=>void action('apiSave',{key,region,workspaceId})}>{busy?'Working…':'Save '+name+' connection'}</button>{connection?.connected&&<><button disabled={busy} onClick={()=>void action('apiCheck')}>Check connection</button><button disabled={busy} onClick={()=>void action('apiDisconnect')}>Disconnect</button></>}<button onClick={()=>void action('apiLink')}>Get API key ↗</button></div>
  <p className="hint">Encrypted in Windows Credential Manager. Setup reads the model list without sending a prompt.</p>
  </>}
  {connection?.connected&&<button disabled={busy} onClick={()=>void action('apiRetry')}>Retry after updating account</button>}
  {connection?.connected&&<><p>{connection.models.length} chat models · {connection.source==='live'?'Supplier model list':connection.source==='cached'?'Saved model list':connection.source==='manual'?'Includes manually added models':'Model list unavailable'}. Add models to a chat from its ＋ button.</p>{connection.checkedAt&&<p className="hint">Checked {new Date(connection.checkedAt).toLocaleString()}</p>}
   <details><summary>Add a model by ID</summary><label>Supplier model ID<input aria-label={name+' model ID'} value={model} onChange={event=>setModel(event.target.value)}/></label><button disabled={busy||!model.trim()} onClick={()=>void action('apiModel',{model})}>Add to available models</button><p className="hint">Use an ID from your supplier’s account. Access is checked on its first reply.</p></details></>}
 </div>;
}
