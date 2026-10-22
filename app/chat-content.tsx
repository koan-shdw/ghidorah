import {ChatFilesDialog} from './chat-files-panel';
import {ToolActivity} from './tool-activity';
export {ToolActivity} from './tool-activity';
import {linkIconUrl} from './link-icons';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Marked,type RendererObject} from 'marked';
import DOMPurify from 'dompurify';
import {createPortal} from 'react-dom';
import {InlineContent} from './inline-content';
import {previewDirective,previewImages} from './message-previews';
import type {ToolCall,Turn} from './types';
import {Dialog,Notice} from './kit';

export type SavedMessage={title:string;turn:Turn;tools:ToolCall[]};
export function SavedMessageDialog({record,close}:{record:SavedMessage;close:()=>void}){
 return <Dialog title={record.title} label="Saved source message" className="checkpoint-dialog" size="lg" closeLabel="Close saved source" onClose={close}><p className="kit-dialog-lead">Saved history · {record.turn.model}</p><p className="hint">This record was retained when the chat was branched. Its actions have not been replayed.</p><div className="user-message"><Markdown message text={record.turn.prompt} turnId={record.turn.id}/></div><ToolActivity tools={record.tools}/><Markdown text={record.turn.text} turnId={record.turn.id}/>{record.turn.error&&<Notice tone="danger" className="error">{record.turn.error}</Notice>}</Dialog>;
}

const escape=(text:string)=>text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const links:RendererObject={link({href,title,tokens}){return `<a href="#" data-chat-href="${escape(href)}"${title?` title="${escape(title)}"`:''}>${this.parser.parseInline(tokens)}</a>`;}};
const parser=new Marked({gfm:true,renderer:{...links,...previewImages}},previewDirective);
const messageParser=new Marked({gfm:true,breaks:true,renderer:{...links,...previewImages,html({text}){return escape(text);}}});
const globe='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#98a6b3"><circle cx="8" cy="8" r="6.5"/><ellipse cx="8" cy="8" rx="3" ry="6.5"/><path d="M1.5 8h13M3 4.5h10M3 11.5h10"/></svg>');
export function Markdown({text,turnId,message=false}:{text:string;turnId:string;message?:boolean}){
  const [error,setError]=useState(''),[file,setFile]=useState<{chatId:string;id:string}|null>(null),[saved,setSaved]=useState<SavedMessage|null>(null);
  const content=useRef<HTMLDivElement>(null);
  const [previews,setPreviews]=useState<HTMLElement[]>([]);
  const html=useMemo(()=>{
    const fragment=DOMPurify.sanitize((message?messageParser:parser).parse(text,{async:false}) as string,{RETURN_DOM_FRAGMENT:true,
      ALLOWED_TAGS:['p','br','hr','h1','h2','h3','h4','h5','h6','strong','em','del','blockquote','ul','ol','li','a','pre','code','table','thead','tbody','tr','th','td','input','details','summary','span'],
      ALLOWED_ATTR:['href','data-chat-href','data-preview-href','data-preview-title','title','class','start','align','type','checked','disabled'],ALLOW_DATA_ATTR:false,ADD_URI_SAFE_ATTR:['data-chat-href','data-preview-href']});
    for(const input of fragment.querySelectorAll('input')){if(input.type!=='checkbox')input.remove();else{input.disabled=true;input.setAttribute('aria-label',input.checked?'Completed task':'Incomplete task');}}
    for(const anchor of fragment.querySelectorAll('a')){
      const href=anchor.dataset.chatHref||anchor.getAttribute('href')||'';
      anchor.setAttribute('title',href);anchor.setAttribute('rel','noreferrer');
      if(linkIconUrl(href)){
        const icon=document.createElement('img');icon.src=globe;icon.alt='';icon.setAttribute('aria-hidden','true');icon.className='link-site-icon';icon.dataset.siteHref=href;anchor.prepend(icon);
      }
    }
    for(const pre of fragment.querySelectorAll('pre')){
      const code=pre.querySelector('code');if(!code)continue;
      const bar=document.createElement('div');bar.className='code-toolbar';const language=document.createElement('span');language.textContent=code.className.replace(/^language-/, '')||'Code';bar.append(language);
      const copy=document.createElement('button');copy.type='button';copy.textContent='Copy';copy.setAttribute('aria-label','Copy code');copy.dataset.copyCode='true';bar.append(copy);pre.prepend(bar);
    }
    const wrapper=document.createElement('div');wrapper.append(fragment);return {__html:wrapper.innerHTML};
  },[text,message]);
  useEffect(()=>{setPreviews([...content.current?.querySelectorAll<HTMLElement>('[data-preview-href]')||[]]);},[html]);
  useEffect(()=>{
    let current=true;
    const observer=new IntersectionObserver(entries=>{for(const entry of entries){if(!entry.isIntersecting)continue;const image=entry.target as HTMLImageElement;observer.unobserve(image);
      void window.desktop.invoke('chatLink',{turnId,href:image.dataset.siteHref,icon:true}).then(value=>{if(current&&value?.icon)image.src=value.icon;},()=>{});
    }},{rootMargin:'100px'});
    for(const image of content.current?.querySelectorAll<HTMLImageElement>('.link-site-icon')||[])observer.observe(image);
    return ()=>{current=false;observer.disconnect();};
  },[html,turnId]);
  async function click(event:React.MouseEvent<HTMLDivElement>){
    const target=(event.target as Element).closest('a,button[data-copy-code]');if(!target)return;event.preventDefault();setError('');
    try{
      if(target instanceof HTMLButtonElement){await navigator.clipboard.writeText(target.closest('pre')?.querySelector('code')?.textContent||'');target.textContent='Copied';return;}
      const href=(target as HTMLElement).dataset.chatHref||target.getAttribute('href');if(!href)throw Error('This link cannot be opened.');
      const result=await window.desktop.invoke('chatLink',{turnId,href});if(result?.chatFile)setFile(result.chatFile);if(result?.savedMessage)setSaved(result.savedMessage);
    }catch(error){setError(String(error).replace(/^Error: /,'').replace(/^Error invoking remote method 'app': (?:Error: )?/,''));}
  }
  return <>{saved&&<SavedMessageDialog record={saved} close={()=>setSaved(null)}/>} {file&&<ChatFilesDialog chatId={file.chatId} initialId={file.id} close={()=>setFile(null)}/>}<div ref={content} className={'markdown'+(message?' user-markdown':'')} onErrorCapture={event=>{const image=event.target;if(image instanceof HTMLImageElement&&image.classList.contains('link-site-icon')&&image.src!==globe)image.src=globe;}} onClick={event=>void click(event)} onAuxClick={event=>{if((event.target as Element).closest('a'))event.preventDefault();}} dangerouslySetInnerHTML={html}/>{previews.map((node,index)=>createPortal(<InlineContent turnId={turnId} href={node.dataset.previewHref!} title={node.dataset.previewTitle||'Preview'}/>,node,String(index)))}{error&&<p className="chat-link-error" role="alert">{error}</p>}</>;
}
