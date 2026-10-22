import React,{useEffect,useRef,useState} from 'react';

type Entry={name:string;path:string;directory:boolean;link:boolean};
export function FileMentions({id,draft,caret,focused,inputRef,change,onActive}:{id:string;onActive:(selected:number|null)=>void;draft:string;caret:number;focused:boolean;inputRef:React.RefObject<HTMLTextAreaElement|null>;change:(text:string)=>void}){
 const match=/(?:^|\s)@(?:"([^"\n]*)|([^\s@"]*))$/.exec(draft.slice(0,caret));
 const query=match?(match[1]??match[2]).replace(/\\/g,'/'):null;
 const start=match?caret-match[0].length+(match[0].startsWith('@')?0:1):0;
 const directory=query?.includes('/')?query.slice(0,query.lastIndexOf('/')+1):'',filter=query?.slice(directory.length).toLowerCase()||'';
 const [entries,setEntries]=useState<Entry[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(false),[truncated,setTruncated]=useState(false),[index,setIndex]=useState(0),[dismissed,setDismissed]=useState<string|null>(null);
 const list=useRef<HTMLDivElement>(null),open=focused&&query!==null&&dismissed!==draft;
 const options=entries.filter(item=>item.name.toLowerCase().includes(filter)),selected=Math.min(index,options.length-1);
 useEffect(()=>{setIndex(0);},[query]);
 useEffect(()=>{
  if(!open)return;let cancelled=false;setLoading(true);setError('');setEntries([]);
  void window.desktop.invoke('workspaceList',{directory}).then(result=>{if(!cancelled){setEntries(result.entries);setTruncated(result.truncated);}},reason=>{if(!cancelled)setError(reason.message||'Could not list this folder.');}).finally(()=>{if(!cancelled)setLoading(false);});
  return()=>{cancelled=true;};
 },[directory,open]);
 function pick(entry:Entry){
  const path=entry.path.replace(/\\/g,'/');
  const insertion=entry.directory?'@"'+path+'/':'@"'+path+'" ';
  const next=draft.slice(0,start)+insertion+draft.slice(caret),position=start+insertion.length;
  change(next);if(!entry.directory)setDismissed(next);
  requestAnimationFrame(()=>{inputRef.current?.focus();inputRef.current?.setSelectionRange(position,position);inputRef.current?.dispatchEvent(new Event('select',{bubbles:true}));});
 }
 useEffect(()=>{
  const input=inputRef.current;if(!input||!open)return;
  const key=(event:KeyboardEvent)=>{
   if(event.isComposing||event.ctrlKey||event.altKey||event.metaKey||event.shiftKey)return;
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setDismissed(draft);}
   else if(['ArrowUp','ArrowDown','Tab','Enter'].includes(event.key)){
    event.preventDefault();event.stopPropagation();
    if(!options.length||loading)return;
    if(event.key==='Enter'||event.key==='Tab')pick(options[selected]);
    else setIndex((selected+(event.key==='ArrowUp'?-1:1)+options.length)%options.length);
   }
  };
  input.addEventListener('keydown',key,true);return()=>input.removeEventListener('keydown',key,true);
 },[open,draft,caret,options,selected,loading]);
 useEffect(()=>{if(open)list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({block:'nearest'});},[open,selected]);
 useEffect(()=>{onActive(open?selected:null);return()=>onActive(null);},[open,selected,onActive]);
 if(!open)return null;
 return <section className="command-picker" aria-label="Workspace file mentions"><header><strong>Files{directory?' · '+directory:''}</strong><span>↑↓ choose · Tab insert · Esc close</span></header><div ref={list} id={id} role="listbox" aria-label="Workspace files">{options.map((entry,n)=><button type="button" id={id+'-'+n} role="option" aria-selected={n===selected} key={entry.path} tabIndex={-1} onPointerDown={event=>event.preventDefault()} onClick={()=>pick(entry)}><span>{entry.directory?'▸':'·'} {entry.name}{entry.directory?'/':''}</span></button>)}</div>{loading?<p role="status">Loading files…</p>:error?<p role="alert">{error}</p>:!options.length?<p>No matching files.</p>:null}<footer><span>{truncated?'First 1,000 entries shown. ':''}Inserts a path from your working folder.</span></footer></section>;
}
