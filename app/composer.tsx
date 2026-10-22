import './attachment-thumbnails.css';
import {linkedClipboardText} from './clipboard-text';
import {ChatFilesButton} from './chat-files-panel';
import {FileMentions} from './file-mentions';
import {DictationButton} from './dictation';
import {SidebarIcon} from './kit';
import React,{useEffect,useId,useRef,useState} from 'react';
import type {Attachment,ChatCommand} from './types';

export function AttachmentImage({item,chatId=item.chatId,busy=false,remove}:{item:Attachment;chatId?:string;busy?:boolean;remove?:(id:string)=>void}){
 const [url,setUrl]=useState(''),[error,setError]=useState(''),card=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  let current=true;setUrl('');setError('');
  // Read thumbnails only near the viewport, so opening a long chat stays cheap.
  const observer=new IntersectionObserver(entries=>{if(!entries.some(entry=>entry.isIntersecting))return;observer.disconnect();
   void window.desktop.invoke('chatFiles',{chatId,id:'upload:'+item.id,action:'thumbnail'}).then(value=>{if(current)setUrl(value.url);},()=>{if(current)setError('Preview unavailable');});
  },{rootMargin:'200px'});
  if(card.current)observer.observe(card.current);
  return ()=>{current=false;observer.disconnect();};
 },[item.id,chatId]);
 return <div className="attachment-image" title={item.name} ref={card}>
  <ChatFilesButton className="attachment-image-preview" chatId={chatId} id={'upload:'+item.id}>{url?<img src={url} alt={item.name} draggable={false}/>:<span role="status">{error||'Loading image…'}</span>}</ChatFilesButton>
  {remove&&<button type="button" className="attachment-image-remove" aria-label={'Remove '+item.name} disabled={busy} onClick={()=>remove(item.id)}>×</button>}
 </div>;
}

export function Composer({voice,draft,commands=[],inputRef,disabled,sendError,busy,working,change,submit,stop,plugins,attachments=[],attaching=false,attach,remove,dictate,dictationOwner}:{voice?:()=>void;dictationOwner?:string;dictate?:(bytes:Uint8Array,mime:string,signal:AbortSignal)=>Promise<string>;attaching?:boolean;attachments?:Attachment[];attach:(files:File[])=>void;remove:(id:string)=>void;draft:string;commands?:ChatCommand[];inputRef:React.RefObject<HTMLTextAreaElement|null>;disabled:boolean;sendError?:string|null;busy:boolean;working:boolean;change:(text:string)=>void;submit:()=>void;stop:()=>void;plugins:()=>void}){
 const id=useId(),commandId=id+'-commands',mentionId=id+'-mentions';
 const [mentionIndex,setMentionIndex]=useState<number|null>(null);
 const files=useRef<HTMLInputElement>(null);
 const root=useRef<HTMLDivElement>(null),list=useRef<HTMLDivElement>(null);
 const [browsing,setBrowsing]=useState(false),[dismissed,setDismissed]=useState(false),[focused,setFocused]=useState(false),[index,setIndex]=useState(0),[caret,setCaret]=useState(draft.length);
 const prefix=/^\/([^\s]*)$/.exec(draft),query=prefix?.[1].toLowerCase()||'';
 const options=commands.filter(row=>!query||`${row.name} ${row.description}`.toLowerCase().includes(query));
 const open=!disabled&&!dismissed&&(browsing||focused&&!!prefix&&caret===draft.length);
 const selected=Math.min(index,options.length-1);
 useEffect(()=>{setIndex(0);},[query,browsing]);
 useEffect(()=>{if(open)list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({block:'nearest'});},[selected,open]);
 useEffect(()=>{
  const close=(event:PointerEvent)=>{if(root.current&&!root.current.contains(event.target as Node)){setBrowsing(false);setDismissed(true);}};
  document.addEventListener('pointerdown',close);return ()=>document.removeEventListener('pointerdown',close);
 },[]);
 function pick(command:ChatCommand){
  const rest=draft.startsWith('/')?draft.replace(/^\/\S*\s*/, ''):draft;
  const next=command.name+' '+rest;
  change(next);setBrowsing(false);setDismissed(true);
  requestAnimationFrame(()=>{inputRef.current?.focus();inputRef.current?.setSelectionRange(next.length,next.length);});
 }
 function keydown(event:React.KeyboardEvent<HTMLTextAreaElement>){
  if(event.defaultPrevented||event.nativeEvent.isComposing)return;
  if(open){
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setBrowsing(false);setDismissed(true);return;}
   if(options.length&&!event.shiftKey&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();setIndex((selected+(event.key==='ArrowDown'?1:-1)+options.length)%options.length);return;}
   if(options.length&&!event.shiftKey&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&(event.key==='Tab'||event.key==='Enter')){event.preventDefault();pick(options[selected]);return;}
  }
  if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();if(!sendError)submit();}
 }
 function paste(event:React.ClipboardEvent<HTMLTextAreaElement>){
  const items=Array.from(event.clipboardData.files);
  if(items.length){event.preventDefault();attach(items);return;}
  const html=event.clipboardData.getData('text/html');if(!html)return;
  const plain=event.clipboardData.getData('text/plain'),template=document.createElement('template');template.innerHTML=html;
  const text=linkedClipboardText(template.content,plain);if(text===plain)return;
  event.preventDefault();
  // Native insertion keeps the textarea's undo history in Electron.
  if(document.execCommand('insertText',false,text))return;
  const input=event.currentTarget,start=input.selectionStart,end=input.selectionEnd,next=start+text.length;
  change(draft.slice(0,start)+text+draft.slice(end));setCaret(next);
  requestAnimationFrame(()=>input.setSelectionRange(next,next));
 }
 return <div className="composer" ref={root} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget)){setFocused(false);setBrowsing(false);}}}>
  {!disabled&&<FileMentions id={mentionId} draft={draft} caret={caret} focused={focused} inputRef={inputRef} change={change} onActive={setMentionIndex}/>}
  {open&&<section className="command-picker" aria-label="Skills and commands"><header><strong>Skills and commands</strong><span>↑↓ choose · Tab insert · Esc close</span></header>
   <div ref={list} id={commandId} role="listbox" aria-label="Available commands">{options.map((command,n)=><button type="button" id={commandId+'-'+n} role="option" aria-selected={n===selected} key={command.name} tabIndex={-1} onPointerDown={event=>event.preventDefault()} onClick={()=>pick(command)}><span><strong>{command.name}</strong><small>{command.kind}</small></span>{command.description&&<p>{command.description}</p>}</button>)}</div>
   {!options.length&&<p className="command-empty">{commands.length?'No matching commands.':'Add shared skills and commands in Plugins.'}</p>}
   <footer><span>Choose an entry to add it to your message</span><button type="button" onClick={()=>{setBrowsing(false);setDismissed(true);plugins();}}>Manage plugins</button></footer>
  </section>}
  {attaching&&<div className="hint" role="status">Preparing attachments…</div>}
  {attachments.length>0&&<div className="attachments" aria-label="Draft attachments">{attachments.map(item=>item.kind==='image'?<AttachmentImage key={item.id} item={item} busy={busy} remove={remove}/>:<span className="attachment" key={item.id} title={item.name}><span>{item.kind==='pdf'?'PDF':item.kind==='video'?'▶':'▤'}</span><span>{item.name}</span><small>{item.pages?item.pages+' pages':item.size<1024?item.size+' B':Math.ceil(item.size/1024)+' KB'}</small><button aria-label={'Remove '+item.name} disabled={busy} onClick={()=>remove(item.id)}>×</button></span>)}</div>}
  <input ref={files} type="file" multiple hidden disabled={disabled||busy} aria-label="Choose attachments" onChange={event=>{attach(Array.from(event.target.files||[]));event.target.value='';}}/>
  <div className="composer-box">
   <textarea ref={inputRef} role="combobox" aria-label="Message" aria-autocomplete="list" aria-expanded={open||mentionIndex!==null} aria-controls={mentionIndex!==null?mentionId:open?commandId:undefined} aria-activedescendant={mentionIndex!==null&&mentionIndex>=0?mentionId+'-'+mentionIndex:open&&selected>=0?commandId+'-'+selected:undefined} aria-multiline="true" placeholder="Message" value={draft} disabled={disabled} onFocus={()=>setFocused(true)} onSelect={event=>setCaret(event.currentTarget.selectionStart)} onChange={event=>{setDismissed(false);setBrowsing(false);setCaret(event.target.selectionStart);change(event.target.value);}} onPaste={paste} onKeyDown={keydown}/>
   <div className="composer-toolbar"><div className="composer-tools">
    <button type="button" className="attachment-trigger" aria-label="Attach files" title="Attach images, PDFs or text files · drop or paste" disabled={disabled||busy} onClick={()=>files.current?.click()}><SidebarIcon name="attach"/></button>
    {dictate&&<>{voice&&<button type="button" aria-label="Open voice" title="Voice helper" disabled={disabled} onClick={voice}><SidebarIcon name="voice"/></button>}<DictationButton key={dictationOwner} disabled={disabled||busy} dictate={dictate} insert={text=>change(draft.trim()?draft.replace(/\s*$/,' ')+text:text)}/></>}
    <button type="button" className="command-trigger" aria-label="Browse skills and commands" aria-expanded={open} aria-controls={commandId} disabled={disabled} title="Skills and commands" onClick={()=>{const next=!open;setBrowsing(next);setDismissed(!next);inputRef.current?.focus();}}><SidebarIcon name="slash"/></button>
   </div><button type="button" className="send" aria-label={working&&!draft&&!attachments.length?'Stop':working?'Queue message':'Send'} title={working&&!draft&&!attachments.length?'Stop':sendError|| (working?'Queue message · Enter':'Send · Enter')} disabled={disabled||busy||!!sendError&&!(working&&!draft&&!attachments.length)} onClick={()=>working&&!draft&&!attachments.length?stop():submit()}><SidebarIcon name={working&&!draft&&!attachments.length?'stop':'send'}/></button></div>
  </div>
 </div>;
}
