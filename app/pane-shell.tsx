import React,{createContext,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {allPaneIds,group,split,movePane,setSplitWeights,growShares,type LayoutNode,type SplitNode,type DropPosition} from './pane-tree';
import {dropPosition} from './pane-layout';
import {PaneTabs,PaneFocus} from './pane-controls';
import './pane-shell.css';

export const PaneTargets=createContext<ReadonlyMap<string,HTMLDivElement>>(new Map());

export function windowTree(splitId:string,direction:'row'|'column',size:number,jobs:string[],views:string[]=[],extraChats:string[]=[],agents:string[]=[]):LayoutNode{
 const main=group(['main'],{id:'main-group'});
 // Keep this parent even with one pane: replacing it during close detaches a
 // focused composer between focus and input, which can submit its older draft.
 const chats=split(direction,[main,...(splitId?[group(['chat:'+splitId],{id:'split-group'})]:[]),...extraChats.map(id=>group(['chat:'+id],{id:'chat-extra-'+id}))],extraChats.length?undefined:splitId?[size,100-size]:[1],'chat-split');
 const dock=split('row',[...jobs.map(id=>group(['job:'+id],{id:'job-group-'+id})),...agents.map(id=>group(['agent:'+id],{id:'agent-group-'+id}))],undefined,'job-dock');
 return split('row',[split('row',[chats,...(jobs.length||agents.length?[dock]:[])],undefined,'chat-region'),group(['workspace'],{id:'workspace-group'}),...views.map(view=>group(['workspace:'+view],{id:'workspace-'+view+'-group'}))],undefined,'window-layout');
}

type ChatSplit={size:number;direction:'row'|'column';setSize:(value:number)=>void};
function ChatDivider({control}:{control:ChatSplit}){
 const change=(size:number)=>control.setSize(Math.max(25,Math.min(75,size)));
 function resize(event:React.PointerEvent){
  event.preventDefault();const handle=event.currentTarget,box=handle.parentElement!.getBoundingClientRect();handle.setPointerCapture(event.pointerId);
  const move=(e:Event)=>{const pointer=e as PointerEvent;change(100*(control.direction==='row'?(pointer.clientX-box.left)/box.width:(pointer.clientY-box.top)/box.height));};
  const end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);};
  handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
 }
 return <div className="chat-split-divider" role="separator" aria-label="Resize split chats" aria-orientation={control.direction==='row'?'vertical':'horizontal'} aria-valuenow={control.size} aria-valuemin={25} aria-valuemax={75} tabIndex={0} onPointerDown={resize} onKeyDown={event=>{if(['ArrowLeft','ArrowUp','ArrowRight','ArrowDown'].includes(event.key)){event.preventDefault();change(control.size+(['ArrowLeft','ArrowUp'].includes(event.key)?-5:5));}}}/>;
}

// Portals keep editors, microphone sessions and terminals mounted when their layout parents change.
export function PaneShell({layout,panes,chatSplit,change,title=id=>id,arranged=false,popOut,hidden=[]}:{layout:LayoutNode;panes:Record<string,React.ReactNode>;chatSplit:ChatSplit;change?:(tree:LayoutNode)=>void;title?:(id:string)=>string;arranged?:boolean;popOut?:(id:string)=>void;hidden?:string[]}){
 const hosts=useRef(new Map<string,HTMLDivElement>()),targets=useRef(new Map<string,HTMLDivElement>());
 const dragging=useRef(''),dragRoot=useRef<HTMLElement|null>(null),[drop,setDrop]=useState<{group:string;position:DropPosition}|null>(null);
 for(const id of Object.keys(panes))if(!hosts.current.has(id)){const host=document.createElement('div');host.className='pane-content';host.dataset.pane=id;hosts.current.set(id,host);}
 useLayoutEffect(()=>{
  function place(node:LayoutNode){if(node.type==='split'){node.children.forEach(place);return;}const target=targets.current.get(node.id);if(!target)return;const active=hidden.includes(node.active)?node.panes.find(id=>!hidden.includes(id)):node.active;for(const id of node.panes){const host=hosts.current.get(id);if(host){if(host.parentElement!==target)target.append(host);host.hidden=id!==active;}}}
  place(layout);for(const [id,host] of hosts.current)if(!(id in panes)){host.remove();hosts.current.delete(id);}
 });
 function drag(event:React.DragEvent,id:string){dragging.current=id;dragRoot.current=event.currentTarget.closest('.pane-shell');dragRoot.current?.setAttribute('data-pane-dragging','true');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-trismegistus-pane',id);}
 function target(event:{currentTarget:EventTarget|null;clientX:number;clientY:number},nodeId:string){if(!change||!dragging.current)return null;const box=(event.currentTarget as HTMLElement).getBoundingClientRect();return {group:nodeId,position:dropPosition(event.clientX-box.left,event.clientY-box.top,box.width,box.height)};}
 function finish(){dragging.current='';dragRoot.current?.removeAttribute('data-pane-dragging');dragRoot.current=null;setDrop(null);}
 function groupTarget(element:HTMLDivElement|null,id:string){
  if(!element)return;
  // Portal events follow React ancestry; drops must follow the actual DOM pane.
  element.ondragover=event=>{const at=target(event,id);if(at){event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';setDrop(at);}};
  element.ondrop=event=>{const at=target(event,id);if(at){event.preventDefault();const next=movePane(layout,dragging.current,{groupId:at.group,pos:at.position});if(next)change?.(next);}finish();};
  element.ondragend=finish;
 }
 function divider(node:SplitNode,index:number,previousIndex:number){
  const total=node.weights[previousIndex]+node.weights[index],value=100*node.weights[previousIndex]/total;
  const resize=(amount:number)=>{const weights=[...node.weights],fraction=Math.max(.1,Math.min(.9,amount/100));weights[previousIndex]=fraction*total;weights[index]=(1-fraction)*total;change?.(setSplitWeights(layout,node.id,weights));};
  return <div className="chat-split-divider" role="separator" aria-label={'Resize panes '+index} aria-orientation={node.orientation==='row'?'vertical':'horizontal'} aria-valuenow={Math.round(value)} aria-valuemin={10} aria-valuemax={90} tabIndex={0} onKeyDown={event=>{if(['ArrowLeft','ArrowUp','ArrowRight','ArrowDown'].includes(event.key)){event.preventDefault();resize(value+(['ArrowLeft','ArrowUp'].includes(event.key)?-5:5));}}} onPointerDown={event=>{
   event.preventDefault();const handle=event.currentTarget,previous=handle.previousElementSibling!,next=handle.nextElementSibling!,a=previous.getBoundingClientRect(),b=next.getBoundingClientRect(),horizontal=node.orientation==='row';handle.setPointerCapture(event.pointerId);
   const move=(raw:Event)=>{const e=raw as PointerEvent;resize(100*(horizontal?(e.clientX-a.left)/(b.right-a.left):(e.clientY-a.top)/(b.bottom-a.top)));};
   const end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);};handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
  }}/>;
 }
 function render(node:LayoutNode,style?:React.CSSProperties):React.ReactNode{
  if(node.type==='group'){
   const visible=node.panes.filter(id=>!hidden.includes(id)),active=visible.includes(node.active)?node.active:visible[0];
   return <div key={node.id} className={'pane-group '+(!arranged&&node.id==='workspace-group'?'workspace-group':'')+(arranged?' arranged':'')} data-group={node.id} data-drop={drop?.group===node.id?drop.position:undefined} style={{...style,...(!visible.length?{display:'none'}:{})}} ref={element=>groupTarget(element,node.id)}>
   {change&&visible.length>0&&allPaneIds(layout).filter(id=>!hidden.includes(id)).length>1&&<PaneTabs node={{...node,panes:visible,active}} tree={layout} title={title} change={change} drag={drag} popOut={popOut} hidden={hidden}/>}
   <div className="pane-slot" ref={element=>{if(element)targets.current.set(node.id,element);else targets.current.delete(node.id);}}/>
  </div>;}
  const chats=!arranged&&node.id==='chat-split'&&node.children.length>1,dock=!arranged&&node.id==='job-dock',shell=!arranged&&node.id==='window-layout',region=!arranged&&node.id==='chat-region';
  const className='pane-split '+(chats?'chat-panes split-'+node.orientation:dock?'job-dock':region?'chat-panes':'');
  const visible=(item:LayoutNode):boolean=>item.type==='group'?item.panes.some(id=>!hidden.includes(id)):item.children.some(visible);
  const shares=growShares(node.weights,node.children.map((child,index)=>visible(child)&&!(shell&&index===1)&&!(region&&child.id==='job-dock')));
  return <div key={node.id} className={className} data-split={node.id} data-direction={node.orientation} aria-label={dock?'Models working at once':undefined} role={dock?'region':undefined} style={{...style,flexDirection:node.orientation,...(!visible(node)?{display:'none'}:{}),...(dock?{'--dock-panes':node.children.length} as React.CSSProperties:{})}}>{node.children.map((child,index)=>{if(!visible(child))return null;const previous=node.children.slice(0,index).findLastIndex(visible);return <React.Fragment key={child.id}>{previous>=0&&(chats?<ChatDivider control={chatSplit}/>:arranged?divider(node,index,previous):null)}{render(child,shell&&index===1?undefined:region&&child.id==='job-dock'?undefined:{flex:shares[index]+' 1 0px'})}</React.Fragment>;})}</div>;
 }
 return <PaneTargets.Provider value={hosts.current}><PaneFocus>{render(layout)}{Object.entries(panes).map(([id,content])=>createPortal(content,hosts.current.get(id)!,id))}</PaneFocus></PaneTargets.Provider>;
}
