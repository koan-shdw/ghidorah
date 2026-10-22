import React,{useEffect,useRef,useState} from 'react';
export function InlineContent({turnId,href,title}:{turnId:string;href:string;title:string}){
 const element=useRef<HTMLSpanElement>(null),[ready,setReady]=useState(false),[attempt,setAttempt]=useState(0);
 const [preview,setPreview]=useState<{url:string;href:string;name:string;kind:'image'|'html'}|null>(null),[error,setError]=useState('');
 useEffect(()=>{const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setReady(true);observer.disconnect();}},{rootMargin:'200px'});if(element.current)observer.observe(element.current);return ()=>observer.disconnect();},[]);
 useEffect(()=>{
  if(!ready)return;let current=true,url='';setError('');setPreview(null);
  const release=()=>{if(url)void window.desktop.invoke('chatLink',{turnId,href:url,inline:'close'}).catch(()=>{});};
  void window.desktop.invoke('chatLink',{turnId,href,inline:true}).then(value=>{url=value.url;if(current)setPreview(value);else release();},reason=>{if(current)setError(String(reason).replace(/^.*Error: /,''));});
  return ()=>{current=false;release();};
 },[turnId,href,ready,attempt]);
 const open=(external=false)=>{void window.desktop.invoke('chatLink',{turnId,href:preview?.href||href,external}).then(result=>{if(result?.chatFile)return window.desktop.invoke('chatFiles',{...result.chatFile,action:'preview'});}).catch(reason=>setError(String(reason)));};
 return <span ref={element} className="inline-preview">
  <span className="inline-preview-bar"><strong>{title==='Preview'?preview?.name||'Preview':title}</strong><button type="button" onClick={()=>setAttempt(value=>value+1)}>Reload</button><button type="button" onClick={()=>open()}>Preview in app</button><button type="button" onClick={()=>open(true)}>Open in browser</button></span>
  {error?<span role="alert" className="chat-link-error">{error}</span>:!preview?<span className="hint">Loading preview…</span>:preview.kind==='image'?<button type="button" className="inline-preview-image" aria-label={'Enlarge '+title} onClick={()=>open()}><img src={preview.url} alt={title} onError={()=>setError('Image could not be loaded. Reload or open the file.')}/></button>:<span className="inline-preview-frame"><iframe src={preview.url} title={title==='Preview'?preview.name:title} sandbox="allow-scripts" referrerPolicy="no-referrer"/></span>}
 </span>;
}
