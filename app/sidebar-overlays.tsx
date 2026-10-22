import React,{useLayoutEffect,useRef} from 'react';
import {SidebarIcon} from './kit';

export function SidebarHoverCard({title,folder,status,updated,anchor}:{title:string;folder:string;status:string;updated:number;anchor:DOMRect}){
 const ref=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{const el=ref.current!;el.style.left=Math.max(8,Math.min(anchor.right+6,innerWidth-el.offsetWidth-8))+'px';el.style.top=Math.max(8,Math.min(anchor.top,innerHeight-el.offsetHeight-8))+'px';},[anchor]);
 return <div ref={ref} id="sidebar-chat-tooltip" role="tooltip" className="sidebar-hover-card"><strong>{title}</strong><div><SidebarIcon name="folder"/><span>{folder}</span></div><small>{status}{updated>0&&<> · <time dateTime={new Date(updated).toISOString()}>{new Date(updated).toLocaleDateString()}</time></>}</small></div>;
}
