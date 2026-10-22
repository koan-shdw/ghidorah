import React,{useEffect,useRef,useState} from 'react';
import type {PreviewState} from './previews';
export const canPreview=(file:string)=>/\.(html?|pdf|svg|png|jpe?g|gif|webp|avif|mp4|webm|ogg|mp3|wav)$/i.test(file);
type Call=(method:string,args?:any)=>Promise<any>;
export function PreviewPanel({chatId,active,call,request}:{chatId:string;active:boolean;call:Call;request:number}){
 const host=useRef<HTMLDivElement>(null),addressFocused=useRef(false),[state,setState]=useState<PreviewState|null>(null),[address,setAddress]=useState(''),[error,setError]=useState(''),[published,setPublished]=useState<{url:string;live:boolean}|null>(null),[publishing,setPublishing]=useState(false);
 // An HTML file previewed from Files can be published (4c); its link shows here once the address answers.
 const page=!state?.savedCopy&&!!state?.url&&!/^https?:/i.test(state.url)&&/\.html?$/i.test(state.url);
 async function publish(){setPublishing(true);setPublished(null);setError('');try{setPublished(await call('publishPreview',{chatId}));}catch(problem){setError(String(problem).replace(/^Error: /,'').replace(/^Error invoking remote method 'app': (?:Error: )?/,''));}finally{setPublishing(false);}}
 async function run(action:()=>Promise<PreviewState>){try{setError('');const result=await action();setState(result);setAddress(result.url);}catch(error){setError(String(error).replace(/^Error: /,'').replace(/^Error invoking remote method 'app': (?:Error: )?/,''));}}
 useEffect(()=>{
  let live=true,busy=false;
  const layout=()=>{const rect=host.current?.getBoundingClientRect(),covered=!!document.querySelector('dialog[open],.modal-backdrop,[role="menu"],[data-pane-dragging]');void call('previewLayout',{chatId,bounds:active&&!covered&&rect?.width&&rect.height?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null}).catch(()=>{});};
  async function refresh(){if(busy||!live||!chatId)return;busy=true;try{const value=await call('previewState',{chatId});if(live){setState(value);if(!addressFocused.current)setAddress(value.url);layout();}}catch{}finally{busy=false;}}
  setState(null);setAddress('');setError('');void refresh();
  const timer=setInterval(()=>void refresh(),500),resize=new ResizeObserver(layout),modals=new MutationObserver(layout);if(host.current)resize.observe(host.current);modals.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open','data-pane-dragging']});window.addEventListener('resize',layout);
  return()=>{live=false;clearInterval(timer);resize.disconnect();modals.disconnect();window.removeEventListener('resize',layout);void call('previewLayout',{chatId,bounds:null}).catch(()=>{});};
 },[chatId,active,request]);
 return <section className={'preview-pane '+(active?'active':'')} aria-label="Preview pane">
  <form className="preview-toolbar" onSubmit={event=>{event.preventDefault();void run(()=>address===state?.url?call('previewAction',{chatId,action:'reload'}):call('previewOpen',{chatId,url:address}));}}>
   <button type="button" aria-label="Back in preview" disabled={!state?.back} onClick={()=>void run(()=>call('previewAction',{chatId,action:'back'}))}>←</button><button type="button" aria-label="Forward in preview" disabled={!state?.forward} onClick={()=>void run(()=>call('previewAction',{chatId,action:'forward'}))}>→</button>
   <button type="button" aria-label={state?.loading?'Stop loading preview':'Reload preview'} disabled={!state?.url} onClick={()=>void run(()=>call('previewAction',{chatId,action:state?.loading?'stop':'reload'}))}>{state?.loading?'×':'↻'}</button>
   <input aria-label="Preview address" placeholder="http://localhost:3000" value={address} onFocus={()=>addressFocused.current=true} onBlur={()=>addressFocused.current=false} onChange={event=>setAddress(event.target.value)}/><button disabled={!chatId||!address.trim()}>Preview in app</button><button type="button" disabled={!chatId||!address.trim()} onClick={()=>void run(async()=>{await call('previewBrowser',{chatId,...(address===state?.url?{}:{url:address})});return call('previewState',{chatId});})}>Open in browser</button>
   {page&&<button type="button" aria-label="Publish page" disabled={publishing} onClick={()=>void publish()}>{publishing?'Publishing…':'Publish'}</button>}
   <button type="button" aria-label="Close preview" disabled={!state?.url} onClick={()=>void run(()=>call('previewAction',{chatId,action:'close'}))}>×</button>
  </form>
  {state?.savedCopy&&<p className="workspace-notice">Saved copy · external resources are not loaded.</p>}
  {(error||state?.error)&&<p className="workspace-notice" role="alert">{error||state?.error}</p>}
  {published&&<p className="workspace-notice" role="status">{published.live?'Published:':'Pushed; the site has not answered yet:'} <a href={published.url} onClick={event=>{event.preventDefault();void run(()=>call('previewOpen',{chatId,url:published.url}));}}>{published.url}</a> <button type="button" onClick={()=>void navigator.clipboard.writeText(published.url)}>Copy link</button></p>}
  {state?.restore&&<p className="workspace-notice">Saved preview <button onClick={()=>void run(()=>call('previewAction',{chatId,action:'reload'}))}>Reopen</button></p>}
  <div className="preview-host" ref={host}>{!state?.url&&<p className="workspace-empty">Open a running development server above, or preview an HTML, PDF, image or video file from Files.</p>}</div>
 </section>;
}
