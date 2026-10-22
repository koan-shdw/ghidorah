import React,{useEffect,useRef,useState} from 'react';
import {Button,Dialog} from './kit';
import {allPaneIds,findGroupOfPane,movePane,setActivePane,type LayoutNode,type GroupNode,type DropPosition} from './pane-tree';

export function PaneTabs({node,tree,title,change,drag,popOut,hidden=[]}:{node:GroupNode;tree:LayoutNode;title:(id:string)=>string;change:(tree:LayoutNode)=>void;drag:(event:React.DragEvent,id:string)=>void;popOut?:(id:string)=>void;hidden?:string[]}){
 const [open,setOpen]=useState(false),[target,setTarget]=useState(''),[position,setPosition]=useState<DropPosition>('right');
 const id=node.active,others=allPaneIds(tree).filter(pane=>pane!==id&&!hidden.includes(pane));
 useEffect(()=>{if(open)setTarget(others[0]||'');},[open]);
 function move(){const group=findGroupOfPane(tree,target);if(!group)return;const next=movePane(tree,id,{groupId:group.id,pos:position});if(next)change(next);setOpen(false);}
 return <><div className="pane-tabs" draggable onDragStart={event=>{if(event.target===event.currentTarget)drag(event,id);}} role={node.panes.length>1?'tablist':undefined} aria-label={node.panes.length>1?'Pane tabs':undefined}>
  {node.panes.map(pane=><button key={pane} className="pane-handle" draggable onDragStart={event=>drag(event,pane)} role={node.panes.length>1?'tab':undefined} aria-selected={node.panes.length>1?pane===id:undefined} tabIndex={pane===id?0:-1} aria-label={node.panes.length>1?title(pane):'Move '+title(pane)} title={'Drag '+title(pane)+' to a split or tab'} onClick={()=>{if(node.panes.length>1)change(setActivePane(tree,node.id,pane));}} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const index=node.panes.indexOf(pane),next=node.panes[event.key==='Home'?0:event.key==='End'?node.panes.length-1:(index+(event.key==='ArrowLeft'?-1:1)+node.panes.length)%node.panes.length];change(setActivePane(tree,node.id,next));(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('.pane-handle')[node.panes.indexOf(next)])?.focus();}}}>⋮⋮{node.panes.length>1&&<span>{title(pane)}</span>}</button>)}
  <button aria-label={'Arrange '+title(id)} title="Arrange pane with the keyboard" disabled={!others.length} onClick={()=>setOpen(true)}>▦</button>
  {popOut&&id!=='workspace'&&!id.startsWith('workspace:')&&<button aria-label={'Pop out pane: '+title(id)} onClick={()=>popOut(id)}>↗</button>}
 </div>{open&&<Dialog label="Arrange pane" className="pane-arrangement" size="sm" closeLabel="Close arrange pane" onClose={()=>setOpen(false)} footer={<><Button variant="outline" onClick={()=>setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!others.includes(target)} onClick={move}>Move pane</Button></>}><h3>{title(id)}</h3><label>Move beside<select aria-label="Target pane" value={target} onChange={event=>setTarget(event.target.value)}>{others.map(pane=><option key={pane} value={pane}>{title(pane)}</option>)}</select></label><label>Position<select aria-label="Pane position" value={position} onChange={event=>setPosition(event.target.value as DropPosition)}>{Object.entries({left:'Left',right:'Right',top:'Above',bottom:'Below',center:'As a tab'}).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></Dialog>}</>;
}

// Capture immediately before React removes old layout parents, then restore only
// a surviving control. Reparenting must not drop typing between focus and input.
export class PaneFocus extends React.Component<{children:React.ReactNode}> {
 private root=React.createRef<HTMLDivElement>();
 getSnapshotBeforeUpdate(){const active=document.activeElement;return active instanceof HTMLElement&&this.root.current?.contains(active)?active:null;}
 componentDidUpdate(_props:unknown,_state:unknown,active:HTMLElement|null){if(active?.isConnected&&document.activeElement!==active)active.focus({preventScroll:true});}
 render(){return <div ref={this.root} className="pane-shell">{this.props.children}</div>;}
}

