// Panes (P1): what the app's regions are called in the layout tree, and how the layout saved before panes (main chat,
// split chat, direction, size) becomes a tree. A pane id says what it holds: chat:<id>, job:<chat id>, workspace.
import {group,split,normalize,isLayoutNode,allPaneIds,removePane,insertAtGroup,findGroupOfPane,type LayoutNode,type DropPosition} from './pane-tree';
import type {ChatLayout} from './chat-layout';

export const chatPane=(chatId:string)=>'chat:'+chatId;
export const jobPane=(chatId:string)=>'job:'+chatId;
export const workspaceViews=['files','changes','terminal','preview','plan','tasks'] as const;
export type WorkspaceView=typeof workspaceViews[number];
export const workspaceTitle=(view:WorkspaceView)=>view[0].toUpperCase()+view.slice(1);
export const WORKSPACE_PANE='workspace';
export function readPaneWorkspace(value:any):{visible:boolean;view:WorkspaceView;owner:string}{
 return {visible:value?.visible===true,view:workspaceViews.includes(value?.view)?value.view:'files',owner:typeof value?.owner==='string'&&value.owner.length<=128?value.owner:''};
}
export function paneKind(id:string):{kind:'chat'|'job'|'agent';id:string}|{kind:'workspace'|'main'}|{kind:'workspaceView';view:WorkspaceView}|null{
 if(id==='main')return {kind:'main'};
 if(id===WORKSPACE_PANE)return {kind:'workspace'};
 if(id.startsWith('workspace:')&&workspaceViews.includes(id.slice(10) as WorkspaceView))return {kind:'workspaceView',view:id.slice(10) as WorkspaceView};
 const match=/^(chat|job|agent):(.+)$/.exec(id);return match?{kind:match[1] as 'chat'|'job'|'agent',id:match[2]}:null;
}

// Reconcile real opened/closed panes without replacing the user's other placements.
export function reconcileTree(tree:LayoutNode,fallback:LayoutNode):LayoutNode{
 const wanted=allPaneIds(fallback),allowed=new Set(wanted);let next:LayoutNode|null=tree;
 for(const id of allPaneIds(tree))if(!allowed.has(id)&&next)next=removePane(next,id);
 if(!next)return fallback;
 for(const id of wanted)if(!allPaneIds(next).includes(id)){
  const anchor:import('./pane-tree').GroupNode|null=findGroupOfPane(next,'main')||findGroupOfPane(next,allPaneIds(next)[0]);
  next=anchor?insertAtGroup(next,anchor.id,id,'right')||next:next;
 }
 return next;
}

export function dropPosition(x:number,y:number,width:number,height:number):DropPosition{
 const horizontal=x/width,vertical=y/height;
 if(horizontal<.25)return 'left';if(horizontal>.75)return 'right';
 if(vertical<.25)return 'top';if(vertical>.75)return 'bottom';return 'center';
}

// Before panes the window held one chat, or two side by side or stacked with the first taking `size` percent.
export function treeFromSaved(saved:ChatLayout):LayoutNode|null{
 if(!saved.chatId)return null;
 const main=group([chatPane(saved.chatId)]);
 if(!saved.splitId||saved.splitId===saved.chatId)return main;
 return split(saved.direction,[main,group([chatPane(saved.splitId)])],[saved.size,100-saved.size]);
}

// A saved tree is taken only when it is a layout tree whose panes all still exist; anything else falls back.
export function readTree(value:unknown,exists:(paneId:string)=>boolean):LayoutNode|null{
 // ponytail: at most 256 nodes and 32 levels; raise these bounds if real layouts need more.
 const pending=[{node:value,depth:0}],seen=new Set<unknown>(),ids=new Set<string>();
 while(pending.length){
  const {node,depth}=pending.pop()!;
  if(!node||typeof node!=='object'||seen.has(node)||seen.size>=256||depth>32)return null;
  seen.add(node);const row=node as Record<string,unknown>;
  if(typeof row.id!=='string'||!row.id||row.id.length>128||ids.has(row.id))return null;
  ids.add(row.id);
  if(row.type==='group'){
   if(row.minimized!==undefined&&typeof row.minimized!=='boolean'||row.tabStrip!==undefined&&row.tabStrip!=='always'&&row.tabStrip!=='never')return null;
   if(!Array.isArray(row.panes)||row.panes.length>256||row.panes.some(pane=>typeof pane!=='string'||pane.length>256))return null;
  }else if(row.type==='split'){
   if(!Array.isArray(row.children)||row.children.length>256||!Array.isArray(row.weights)||!row.weights.every(weight=>typeof weight==='number'&&Number.isFinite(weight)&&weight>0)||!Number.isFinite(row.weights.reduce((sum,weight)=>sum+weight,0)))return null;
   for(const child of row.children)pending.push({node:child,depth:depth+1});
  }else return null;
 }
 if(!isLayoutNode(value))return null;
 const panes=allPaneIds(value);
 if(!panes.length||panes.some(pane=>!paneKind(pane)||!exists(pane))||new Set(panes).size!==panes.length)return null;
 return normalize(value);
}
