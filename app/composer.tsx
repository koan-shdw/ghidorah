import './attachment-thumbnails.css';
import {linkedClipboardText} from './clipboard-text';
import {ChatFilesButton} from './chat-files-panel';
import {FileMentions} from './file-mentions';
import {DictationControls,DictationProblem,useDictation} from './dictation';
import {DictationWaves} from './dictation-waves';
import type {WaveStyle} from './listening';
import {Menu,SidebarIcon,type MenuItem} from './kit';
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

export function Composer({voice,draft,commands=[],inputRef,disabled,sendError,busy,working,change,submit,stop,plugins,attachments=[],attaching=false,attach,remove,dictationChat,waves='bars',other,left,right,sideChat,addModel}:{
 /** The chat's own controls, placed inside the box (chatDock in chat-chrome.tsx): `left` after the + button, what
  * the next message uses; `right` before the microphone, the chat's state. */left?:React.ReactNode;right?:React.ReactNode;
 /** Rows of the + menu that belong to the chat: start a side chat, add a model. */sideChat?:()=>void;addModel?:()=>void;
 /** While a reply runs and there is something to send: the action Enter does not do, as a button with its key. */other?:{label:string;run:()=>void};voice?:()=>void;dictationChat?:string;waves?:WaveStyle;attaching?:boolean;attachments?:Attachment[];attach:(files:File[])=>void;remove:(id:string)=>void;draft:string;commands?:ChatCommand[];inputRef:React.RefObject<HTMLTextAreaElement|null>;disabled:boolean;sendError?:string|null;busy:boolean;working:boolean;change:(text:string)=>void;submit:()=>void;stop:()=>void;plugins:()=>void}){
 const id=useId(),commandId=id+'-commands',mentionId=id+'-mentions';
 const dictation=useDictation({chatId:dictationChat||'',draft,change,input:inputRef});
 // The waves show while dictation records, in the style chosen in Settings › Voice.
 const listening=!!dictationChat&&dictation.phase==='recording',dictating=!!dictationChat&&dictation.phase!=='idle';
 // While dictating, Enter and the send arrow finish dictation, wait for the last words and send (Koan 2026-11-19).
 // The send runs after the box has the final words, so it uses this render's submit, not the one from the press.
 const latest=useRef({submit,other,sendError,working});latest.current={submit,other,sendError,working};
 const sendDictated=(alternative:boolean)=>()=>{const now=latest.current;if(now.sendError)return;if(alternative&&now.other&&now.working)now.other.run();else now.submit();};
 // With nothing typed while a reply runs the arrow is Stop, except while dictating: there it always sends.
 const stops=working&&!draft&&!attachments.length&&!dictating;
 // The + button (Koan 2026-11-19): what was four icons in the box, plus the chat's Side chat and Add model.
 // A press on + while its menu is open closes it: the menu shuts on the press, so the click must not open it again.
 const [adding,setAdding]=useState<{x:number;y:number}|null>(null),wasAdding=useRef(false);
 const add=(run:()=>void)=>()=>{setAdding(null);run();};
 const addItems:MenuItem[]=[
  {label:'Attach files',icon:'attach',disabled:busy,title:'Images, PDFs or text files. Drop or paste works too',action:add(()=>files.current?.click())},
  {label:'Skills and commands',icon:'slash',key:'/',action:add(()=>{setBrowsing(true);setDismissed(false);inputRef.current?.focus();})},
  ...(sideChat?[{label:'Side chat',icon:'chats',key:'Ctrl+;',action:add(sideChat)} as MenuItem]:[]),
  ...(dictationChat&&voice?[{label:'Voice helper',icon:'voice',action:add(voice)} as MenuItem]:[]),
  ...(addModel?[{label:'Add a model',icon:'models',separator:true,action:add(addModel)} as MenuItem]:[]),
 ];
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
  // Ctrl+Enter does the other thing while a reply runs (Send now, or wait its turn when the chat's switch is on).
  if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();if(!sendError){if(event.ctrlKey&&other&&working)other.run();else submit();}}
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
  <div className={'composer-box'+(listening?' is-dictating waves-'+waves:'')}>
   <textarea ref={inputRef} role="combobox" aria-label="Message" aria-autocomplete="list" aria-expanded={open||mentionIndex!==null} aria-controls={mentionIndex!==null?mentionId:open?commandId:undefined} aria-activedescendant={mentionIndex!==null&&mentionIndex>=0?mentionId+'-'+mentionIndex:open&&selected>=0?commandId+'-'+selected:undefined} aria-multiline="true" placeholder={dictation.placeholder||'Message'} value={draft} disabled={disabled} readOnly={dictation.phase!=='idle'} onFocus={()=>{setFocused(true);if(dictationChat)dictation.focus();}} onSelect={event=>setCaret(event.currentTarget.selectionStart)} onChange={event=>{setDismissed(false);setBrowsing(false);setCaret(event.target.selectionStart);change(event.target.value);}} onPaste={paste} onKeyDown={event=>{if(!dictation.key(event,sendDictated(event.ctrlKey)))keydown(event);}}/>
   {listening&&waves==='line'&&<DictationWaves style="line" level={dictation.level}/>}
   {/* One row inside the box. Left: +, then what the next message uses. Right: the chat's state, the microphone, send.
       While the bars show your voice they take the state's place; it is back when dictation ends. */}
   <div className="composer-toolbar"><div className="composer-tools">
    <button type="button" className="composer-add" aria-label="Add" aria-haspopup="menu" aria-expanded={!!adding} title="Attach files, skills and commands, side chat, voice helper" disabled={disabled} onPointerDown={()=>{wasAdding.current=!!adding;}} onClick={event=>{const box=event.currentTarget.getBoundingClientRect();setAdding(adding||wasAdding.current?null:{x:box.left,y:box.top-6});wasAdding.current=false;}}><SidebarIcon name="plus"/></button>
    {adding&&<Menu x={adding.x} y={adding.y} above label="Add" items={addItems} close={()=>setAdding(null)}/>}
   </div>{left}{listening&&waves==='bars'?<DictationWaves style="bars" level={dictation.level}/>:right}{other&&working&&(!!draft.trim()||attachments.length>0)&&<button type="button" className="send-other" title={other.label+' · Ctrl+Enter'} disabled={disabled||busy||!!sendError} onClick={()=>{if(!dictating||!dictation.finishThen(sendDictated(true)))other.run();}}>{other.label}<kbd aria-hidden="true">Ctrl ↵</kbd></button>}{dictationChat&&<DictationControls dictation={dictation} disabled={disabled||busy}/>}<button type="button" className="send" aria-label={stops?'Stop':working?'Queue message':'Send'} title={stops?'Stop':sendError|| (working?'Queue message · Enter':'Send · Enter')} disabled={disabled||busy||!!sendError&&!stops} onClick={()=>{if(stops)stop();else if(!dictating||!dictation.finishThen(sendDictated(false)))submit();}}><SidebarIcon name={stops?'stop':'send'}/></button></div>
   {dictationChat&&<DictationProblem dictation={dictation}/>}
  </div>
 </div>;
}
