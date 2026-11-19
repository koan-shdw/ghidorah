// The chat's shared chrome: the title bar's menu and Workspace switch, and the controls that sit inside the message
// box (Koan 2026-11-19, his pick from the mockup). The main chat, side chats, split panes and chat windows all build
// from these, so a change here reaches every chat at once.
import React,{useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Button,ChoiceMenu,Icon,Menu,Popover,StatusDot,type MenuItem} from './kit';
import {ChatFilesDialog} from './chat-files-panel';
import {ExportChatDialog} from './export-dialog';
import {ShortcutDialog,useShortcutKeys} from './shortcut-help';
import {ChatViewTabs} from './chat-view';
import {ContextControls} from './context-dialog';
import {ModelUsageTooltip} from './model-usage-tooltip';
import {UsagePanel} from './usage-panel';
import {contextPercent,contextTooltip} from './usage';
import {modelLabel,modelEfforts} from './models';
import {modelStatus} from './availability';
import {picker} from './pickers';
import {HandoverChip} from './handover-ui';
import {SpeakReplies,SpeakRepliesReader} from './speak-ui';
import type {Chat,Mode,Snapshot,Turn} from './types';

type Call=(method:string,args?:any)=>Promise<any>;
export const permissionModes:Record<Mode,string>={'manual':'Manual','accept-edits':'Accept edits',plan:'Plan',auto:'Auto',bypass:'Bypass permissions'};

/** C1: a caret after the title opens Chat files, Export, Hand off, the artwork command and Keyboard shortcuts. */
export function ChatActions({chatId,shortcuts=false,artwork,handoff}:{chatId?:string;shortcuts?:boolean;artwork?:{label:string;title:string;disabled:boolean;run:()=>void};handoff?:()=>void}){
 const caret=useRef<HTMLButtonElement>(null),[menu,setMenu]=useState<{x:number;y:number}|null>(null),[dialog,setDialog]=useState<'files'|'export'|'shortcuts'|null>(null),[fromMenu,setFromMenu]=useState(false);
 const show=useCallback((which:'files'|'export'|'shortcuts',viaMenu=false)=>{setMenu(null);setFromMenu(viaMenu);setDialog(which);},[]);
 useShortcutKeys(useCallback(()=>show('shortcuts'),[show]),shortcuts);
 const items:MenuItem[]=[
  {label:'Chat files',icon:'files',disabled:!chatId,action:()=>show('files',true)},
  {label:'Export chat',icon:'archive',disabled:!chatId,action:()=>show('export',true)},
  ...(handoff?[{label:'Hand off',icon:'fork',disabled:!chatId,action:()=>{setMenu(null);handoff();}} as MenuItem]:[]),
  ...(artwork?[{label:artwork.label,icon:'art',disabled:artwork.disabled,title:artwork.title,action:()=>{setMenu(null);artwork.run();}} as MenuItem]:[]),
  ...(shortcuts?[{label:'Keyboard shortcuts',icon:'more',key:'F1',action:()=>show('shortcuts',true)} as MenuItem]:[]),
 ];
 const returnFocus=fromMenu?caret.current:undefined,close=()=>setDialog(null);
 return <>
  <Button ref={caret} iconOnly icon="caret" className="chat-menu-trigger" aria-label="Chat menu" title={"Chat files · Export"+(handoff?" · Hand off":"")+" · Keyboard shortcuts"} aria-haspopup="menu" aria-expanded={!!menu} onClick={event=>{const box=event.currentTarget.getBoundingClientRect();setMenu(menu?null:{x:box.left,y:box.bottom+4});}}/>
  {menu&&<Menu x={menu.x} y={menu.y} label="Chat menu" items={items} close={()=>setMenu(null)}/>}
  {dialog==='files'&&chatId&&<ChatFilesDialog chatId={chatId} close={close}/>}
  {dialog==='export'&&chatId&&<ExportChatDialog chatId={chatId} close={close}/>}
  {dialog==='shortcuts'&&<ShortcutDialog returnFocus={returnFocus} close={close}/>}
 </>;
}

/** C2: one switch at the right end of the chat's title bar opens and closes the Workspace panel. Closed, it carries a
 * dot when something inside is new since the panel was last open; `news` says what (workspace-news.ts). */
export function WorkspaceSwitch({open,news='',toggle}:{open:boolean;news?:string;toggle:()=>void}){
 return <span className="workspace-switch">
  <Button iconOnly icon="panelRight" aria-label="Workspace" aria-pressed={open} title={open?'Close the Workspace panel':'Workspace'+(news?' · '+news:'')+' · Ctrl+` opens its terminal'} onClick={toggle}/>
  {!open&&news&&<StatusDot tone="accent" label={'New in Workspace: '+news} className="workspace-news"/>}
 </span>;
}

/** C3: the engine's state as a dot. Words show only while it is not simply connected. */
export function BackendStatus({state,connection}:{state:Snapshot;connection:string}){
 const ready=state.backend==='ready',fine=ready&&connection==='Connected',tone=fine?'ok':ready?'warning':state.backend==='starting'?'muted':'danger';
 return <div className={'backend-status '+(fine?'ready':ready?'':state.backend)} title={fine?'Connected':undefined}><StatusDot tone={tone} label={fine?'Connected':undefined}/>{fine?null:ready?connection:state.backend==='starting'?'Starting…':'Backend stopped'}</div>;
}

/** C11: the context ring shows how full the fullest window is; it opens the usage panel. */
function ContextRing({percent,title,open,controls,toggle}:{percent:number|null;title:string;open:boolean;controls:string;toggle:()=>void}){
 const tone=percent===null?'':percent>=90?'high':percent>=70?'warning':'normal',arc=percent===null?0:Math.min(100,percent)/100*94.2;
 return <button type="button" className="context-ring" data-pressure={tone||undefined} aria-label="Context window and usage" title={title} aria-expanded={open} aria-controls={controls} onClick={toggle}>{percent===null?<Icon name="usage"/>:<><svg className="context-ring-mark" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15"/><circle cx="18" cy="18" r="15" strokeDasharray={arc.toFixed(1)+' 94.2'}/></svg><span>{Math.round(percent)}%</span></>}</button>;
}

export type DockProps={state:Snapshot;chat?:Chat;chatId:string;turns:Turn[];call:Call;usageId:string;details:boolean;setDetails:(open:boolean)=>void;refreshUsage:()=>Promise<void>;openConnections:()=>void;openChatModels:()=>void;
 /** This chat is being written in another view (its own window or a split pane): that view reads its replies aloud. */elsewhere?:boolean};
/** C9 to C12: what the message box carries for its chat. `left` is what the next message uses (the permission mode
 * and who answers), `right` is the chat's state (the context ring and the Options menu), and `under` is what shows
 * below the box only while it applies (the hand-off suggestion, the usage panel). The composer places the first two
 * inside its box. */
export function chatDock(props:DockProps){return {left:<DockSetup {...props}/>,right:<DockStatus {...props}/>,under:<DockUnder {...props}/>};}

/** The permission mode, then Jev and the chat's models as chips. When they do not fit, the models fold into one chip. */
function DockSetup({state,chat,chatId,call,usageId,openConnections,openChatModels}:DockProps){
 const project=state.projects.find(p=>p.id===chat?.projectId),mode=project?.mode||'manual',pool=chat?.pool||[],key=chatId+'|'+pool.join('|');
 const host=useRef<HTMLDivElement>(null),[folded,setFolded]=useState(false),needed=useRef(0),measured=useRef('');
 useLayoutEffect(()=>{
  const element=host.current;if(!element)return;
  // A changed set of models is measured again from its full width.
  if(measured.current!==key){measured.current=key;if(folded){setFolded(false);return;}}
  const check=()=>{
   const parts=[...element.children] as HTMLElement[],gap=parseFloat(getComputedStyle(element).columnGap)||0,room=element.clientWidth;
   const width=parts.reduce((sum,part)=>sum+part.offsetWidth,0)+gap*Math.max(0,parts.length-1);
   if(!folded){if(width>room+1){needed.current=width;setFolded(true);}}else if(room>=needed.current)setFolded(false);
  };
  check();const observer=new ResizeObserver(check);observer.observe(element);return()=>observer.disconnect();
 },[folded,key]);
 return <div className="dock-setup" ref={host}>
  <ChoiceMenu label="Permission mode" value={mode} options={permissionModes} summary={permissionModes[mode].replace(' permissions','')} disabled={!project} onChange={next=>void call('mode',{projectId:project!.id,mode:next})}/>
  <ChatModels usageId={usageId} state={state} chatId={chatId} call={call} connections={openConnections} addModel={openChatModels} folded={folded&&pool.length>0}/>
 </div>;
}

/** C12: Jev, then the chat's models. A chip's name picks it for the next message (Ctrl+click: always use), its level
 * opens the level menu, and its right-click menu has Always use, select duty and Remove. Folded, one chip names who
 * answers next and how many more models there are, and opens them as a menu. */
function ChatModels({usageId,state,chatId,call,connections,addModel,folded}:{usageId:string;state:Snapshot;chatId:string;call:Call;connections:()=>void;addModel:()=>void;folded:boolean}){
 const [menu,setMenu]=useState<{model:string;x:number;y:number}|null>(null),[all,setAll]=useState<{x:number;y:number}|null>(null),[dropping,setDropping]=useState(false),wasAll=useRef(false);
 const chat=state.chats.find(c=>c.id===chatId)||state.jobChats?.find(c=>c.id===chatId),pool=chat?.pool||[],selector=chat?.selector&&pool.includes(chat.selector)?chat.selector:null,engineLabel=picker(state.decisionEngine?.selected||'jev')?.short||'Jev',picks=chat?.selectedModels||(chat?.selected?['deepseek-flash']:[]),owners=new Set(state.chats.filter(c=>c.id===chatId||c.parentChatId===chatId).map(c=>c.id)),chatTurns=state.turns.filter(t=>owners.has(t.chatId));
 const label=(model:string)=>modelLabel(model,state.claude?.models);
 const busyWith=(model:string)=>chatTurns.some(t=>(t.models||[t.model]).includes(model)&&['queued','running','waiting','dispatching','stopping'].includes(t.status));
 useEffect(()=>{if(!menu)return;const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')setMenu(null);};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[menu]);
 useEffect(()=>{if(!folded)setAll(null);},[folded]);
 const pick=(model:string,picked:boolean)=>void call('modelSelection',{chatId,model,selected:!picked}).catch(()=>{});
 const menuItems:MenuItem[]=!menu?[]:!menu.model?[
  ...(selector?[{label:'Hand back to '+engineLabel,icon:'models',action:()=>{setMenu(null);void call('selectorModel',{chatId,model:null}).catch(()=>{});}} as MenuItem]:[]),
  {label:'Decision engine settings',icon:'settings',action:()=>{setMenu(null);connections();}},
 ]:[
  {label:chat?.lockedModel===menu.model?'Stop always using':'Always use',icon:'pin',key:'Ctrl+click',action:()=>{setMenu(null);void call('modelLock',{chatId,model:menu.model}).catch(()=>{});}},
  {label:(selector===menu.model?'Take off select duty':'Put on select duty')+(menu.model.startsWith('claude-code:')&&selector!==menu.model?' · uses Claude limit':''),icon:'models',disabled:selector!==menu.model&&!state.availableModels?.includes(menu.model),title:menu.model.startsWith('claude-code:')?'Each pick uses your Claude limit':undefined,action:()=>{setMenu(null);void call('selectorModel',{chatId,model:selector===menu.model?null:menu.model}).catch(()=>{});}},
  {label:'Remove from chat',icon:'trash',danger:true,separator:true,disabled:busyWith(menu.model),action:()=>{setMenu(null);void call('removeModel',{chatId,model:menu.model}).catch(()=>{});}},
 ];
 if(folded){
  // Who answers next: the first picked model, else the one always used, else the decision engine.
  const lead=picks.find(model=>pool.includes(model))||(chat?.lockedModel&&pool.includes(chat.lockedModel)?chat.lockedModel:''),more=pool.length-(lead?1:0);
  const items:MenuItem[]=[
   ...pool.map(model=>({label:label(model),icon:chat?.lockedModel===model?'pin':'models',checked:picks.includes(model)||chat?.lockedModel===model,disabled:!chat||!state.availableModels?.includes(model)&&!picks.includes(model),title:'Pick for the next message',action:()=>{setAll(null);pick(model,picks.includes(model));}}) as MenuItem),
   {label:'Add or manage models',icon:'plus',separator:true,disabled:!chat,action:()=>{setAll(null);addModel();}},
   {label:'Decision engine settings',icon:'settings',action:()=>{setAll(null);connections();}},
  ];
  return <div className="model-row folded">
   <button type="button" className={'model-pill model-fold'+(lead?' selected':'')+(lead&&chat?.lockedModel===lead?' locked':'')} aria-label="Models in this chat" aria-haspopup="menu" aria-expanded={!!all} title="Who answers the next message · click for this chat's models" onPointerDown={()=>{wasAll.current=!!all;}} onClick={event=>{const box=event.currentTarget.getBoundingClientRect();setAll(all||wasAll.current?null:{x:box.left,y:box.top-6});wasAll.current=false;}}>
    {lead?<><span className={'health-dot '+modelStatus(state,lead).health} aria-hidden="true"/>{chat?.lockedModel===lead&&<Icon name="pin"/>}{label(lead)}</>:engineLabel}{more>0&&<span className="model-more">+{more}</span>}<span aria-hidden="true">⌄</span>
   </button>
   {all&&<Menu x={all.x} y={all.y} above label="Models in this chat" className="model-menu" items={items} close={()=>setAll(null)}/>}
  </div>;
 }
 return <div className={'model-row'+(menu?' menu-open':'')} aria-controls={usageId}><button className={'jev model-pill'+(selector?' on-duty':'')+(dropping?' drop-target':'')} title={selector?label(selector)+' is on select duty for this chat. Right-click to hand back to '+engineLabel+'.':(state.decisionEngine?.status||'Decision engine settings')+'. Drop a model here to put it on select duty.'} onClick={()=>connections()} onDragOver={event=>{if(chat&&event.dataTransfer.types.includes('application/x-trismegistus-model')){event.preventDefault();event.dataTransfer.dropEffect='link';setDropping(true);}}} onDragLeave={()=>setDropping(false)} onDrop={event=>{const model=event.dataTransfer.getData('application/x-trismegistus-model');setDropping(false);if(chat&&model){event.preventDefault();void call('selectorModel',{chatId,model}).catch(()=>{});}}} onContextMenu={event=>{event.preventDefault();if(chat)setMenu({model:'',x:event.clientX,y:event.clientY});}}>{selector?<><Icon name="models"/>{label(selector)}</>:engineLabel}</button>
  <div className="model-pills">{pool.map(model=>{
   const picked=picks.includes(model),running=chatTurns.some(t=>!t.jobs?.length&&t.model===model&&['running','waiting','dispatching','stopping'].includes(t.status));
   const native=state.claude?.models?.find(item=>item.id===model);
   const available=state.availableModels?.includes(model),{status,health}=modelStatus(state,model);
   const efforts=native?Object.fromEntries(native.efforts.map(effort=>[effort,effort==='xhigh'?'Extra high':effort[0].toUpperCase()+effort.slice(1)])):modelEfforts(model);
   const locked=chat?.lockedModel===model;
   return <div key={model} className={'model-pill '+(picked||locked?'selected ':'')+(locked?'locked ':'')+(running?'working':'')} draggable={!!chat} onDragStart={event=>{event.dataTransfer.setData('application/x-trismegistus-model',model);event.dataTransfer.effectAllowed='link';}} onContextMenu={event=>{event.preventDefault();if(chat)setMenu({model,x:event.clientX,y:event.clientY});}}><button aria-pressed={picked||locked} className="model-tab" aria-describedby={usageId+'-model-usage-'+model} disabled={(!available&&!picked&&!locked)||!chat} onClick={event=>void (event.ctrlKey||event.metaKey?call('modelLock',{chatId,model}):call('modelSelection',{chatId,model,selected:!picked})).catch(()=>{})}><span className={'health-dot '+health} aria-hidden="true"/>{locked&&<Icon name="pin"/>}{label(model)} <span>{running?'●':''}</span></button><ModelUsageTooltip id={usageId+'-model-usage-'+model} model={model} state={state} turns={chatTurns} pool={pool} status={status}/><ChoiceMenu label={model==='deepseek-flash'?'Thinking effort':'Thinking effort '+label(model)} value={chat?.efforts?.[model]||(model==='deepseek-flash'?chat?.effort:'high')||'high'} options={efforts} disabled={!chat} onChange={effort=>void call('effort',{chatId,model,effort})}/></div>;
  })}</div>
  {menu&&<Menu x={menu.x} y={Math.max(8,menu.y-(menu.model?150:110))} label={menu.model?label(menu.model)+' actions':engineLabel+' actions'} className="model-menu" items={menuItems} close={()=>setMenu(null)}/>}
 </div>;
}

/** The chat's state at the right of the message box: the context ring, then one Options menu with what is set once. */
function DockStatus({state,chat,chatId,turns,call,usageId,details,setDetails,refreshUsage,openConnections}:DockProps){
 const picks=chat?.lockedModel?[chat.lockedModel]:chat?.selectedModels?.length?chat.selectedModels:chat?.model?[chat.model]:[];
 return <div className="dock-status">
  <ContextRing percent={contextPercent(turns,picks)} title={contextTooltip(turns,picks,state.claude?.models)} open={details} controls={usageId} toggle={()=>{setDetails(!details);if(!details)void refreshUsage().catch(()=>{});}}/>
  <Popover label="Chat options" icon="options" title="Chat options: view, Send now, Wake-ups, RLM, Auto-compact, Speak replies, Connections" end className="chat-options">
   <div className="chat-option chat-option-view"><span>View</span><ChatViewTabs chatId={chatId}/></div>
   <hr/>
   {chat&&<ContextControls chat={chat} turns={turns} call={call} sendNowDefault={state.sendNowDefault}/>}
   <SpeakReplies state={state} call={call}/>
   <hr/>
   <button type="button" className="chat-option connections-link" onClick={()=>{setDetails(false);openConnections();}}><span>Connections</span><Icon name="right"/></button>
  </Popover>
 </div>;
}

/** Under the message box: the reader that speaks finished replies (no look of its own), the hand-off suggestion while
 * it applies, and the usage panel while it is open. */
function DockUnder({state,chat,chatId,turns,call,usageId,details,setDetails,refreshUsage,elsewhere=false}:DockProps){
 return <>
  <SpeakRepliesReader state={state} chatId={chatId} turns={turns} elsewhere={elsewhere}/>
  <div className="dock-under"><HandoverChip state={state} chat={chat} call={call}/></div>
  {details&&<UsagePanel call={call} id={usageId} state={state} chat={chat} turns={turns} models={chat?.pool||[]} refresh={refreshUsage} close={()=>setDetails(false)}/>}
 </>;
}
