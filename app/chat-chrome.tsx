// The chat's shared chrome: the title bar's actions, and the controls and model row under the message box. The main
// chat, side chats, split panes and chat windows all build from these, so a change here reaches every chat at once.
import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Button,ChoiceMenu,Icon,Menu,StatusDot,type IconName,type MenuItem} from './kit';
import {ChatFilesDialog} from './chat-files-panel';
import {ExportChatDialog} from './export-dialog';
import {ShortcutDialog,useShortcutKeys} from './shortcut-help';
import {ChatViewSelect} from './chat-view';
import {ContextControls} from './context-dialog';
import {ModelUsageTooltip} from './model-usage-tooltip';
import {UsagePanel} from './usage-panel';
import {contextPercent,contextTooltip} from './usage';
import {modelLabel,modelEfforts} from './models';
import {modelStatus} from './availability';
import {picker} from './pickers';
import type {Chat,Mode,Snapshot,Turn} from './types';

type Call=(method:string,args?:any)=>Promise<any>;
export const permissionModes:Record<Mode,string>={'manual':'Manual','accept-edits':'Accept edits',plan:'Plan',auto:'Auto',bypass:'Bypass permissions'};
export type PanelView='preview'|'files'|'changes'|'terminal'|'plan'|'tasks';
const panels:[PanelView,IconName,string][]=[['preview','preview','Preview'],['files','files','Files'],['changes','changes','Changes'],['terminal','terminal','Terminal · Ctrl+`'],['plan','plan','Plan'],['tasks','tasks','Tasks']];

/** C1 C2: a caret after the title opens Chat files, Export and Keyboard shortcuts; the panels are one icon group. */
export function ChatActions({chatId,open,shortcuts=false,artwork}:{chatId?:string;open:(view:PanelView)=>void;shortcuts?:boolean;artwork?:{label:string;title:string;disabled:boolean;run:()=>void}}){
 const caret=useRef<HTMLButtonElement>(null),[menu,setMenu]=useState<{x:number;y:number}|null>(null),[dialog,setDialog]=useState<'files'|'export'|'shortcuts'|null>(null),[fromMenu,setFromMenu]=useState(false);
 const show=useCallback((which:'files'|'export'|'shortcuts',viaMenu=false)=>{setMenu(null);setFromMenu(viaMenu);setDialog(which);},[]);
 useShortcutKeys(useCallback(()=>show('shortcuts'),[show]),shortcuts);
 const items:MenuItem[]=[
  {label:'Chat files',icon:'files',disabled:!chatId,action:()=>show('files',true)},
  {label:'Export chat',icon:'archive',disabled:!chatId,action:()=>show('export',true)},
  ...(shortcuts?[{label:'Keyboard shortcuts',icon:'more',key:'F1',action:()=>show('shortcuts',true)} as MenuItem]:[]),
 ];
 const returnFocus=fromMenu?caret.current:undefined,close=()=>setDialog(null);
 return <>
  <Button ref={caret} iconOnly icon="caret" className="chat-menu-trigger" aria-label="Chat menu" title="Chat files · Export · Keyboard shortcuts" aria-haspopup="menu" aria-expanded={!!menu} onClick={event=>{const box=event.currentTarget.getBoundingClientRect();setMenu(menu?null:{x:box.left,y:box.bottom+4});}}/>
  <div className="workspace-actions panel-group" role="group" aria-label="Panels">
   {panels.map(([view,icon,title])=><Button key={view} iconOnly icon={icon} aria-label={'Open '+view} title={title} onClick={()=>open(view)}/>)}
   {artwork&&<Button iconOnly icon="art" aria-label={artwork.label} title={artwork.title} disabled={artwork.disabled} onClick={artwork.run}/>}
  </div>
  {menu&&<Menu x={menu.x} y={menu.y} label="Chat menu" items={items} close={()=>setMenu(null)}/>}
  {dialog==='files'&&chatId&&<ChatFilesDialog chatId={chatId} close={close}/>}
  {dialog==='export'&&chatId&&<ExportChatDialog chatId={chatId} close={close}/>}
  {dialog==='shortcuts'&&<ShortcutDialog returnFocus={returnFocus} close={close}/>}
 </>;
}

/** C3: the engine's state as a dot and a quiet word. */
export function BackendStatus({state,connection}:{state:Snapshot;connection:string}){
 const ready=state.backend==='ready',tone=ready&&connection==='Connected'?'ok':ready?'warning':state.backend==='starting'?'muted':'danger';
 return <div className={'backend-status '+(connection==='Connected'?'ready':ready?'':state.backend)}><StatusDot tone={tone}/>{ready?connection:state.backend==='starting'?'Starting…':'Backend stopped'}</div>;
}

/** C11: the context ring shows how full the fullest window is; it opens the usage panel. */
function ContextRing({percent,title,open,controls,toggle}:{percent:number|null;title:string;open:boolean;controls:string;toggle:()=>void}){
 const tone=percent===null?'':percent>=90?'high':percent>=70?'warning':'normal',arc=percent===null?0:Math.min(100,percent)/100*94.2;
 return <button className="context-ring" data-pressure={tone||undefined} aria-label="Context window and usage" title={title} aria-expanded={open} aria-controls={controls} onClick={toggle}>{percent===null?<Icon name="usage"/>:<><svg className="context-ring-mark" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15"/><circle cx="18" cy="18" r="15" strokeDasharray={arc.toFixed(1)+' 94.2'}/></svg><span>{Math.round(percent)}%</span></>}</button>;
}

/** C9 to C12: under the message box, one compact line of controls and one line of model pills; every chat uses it. */
export function ChatDock({state,chat,chatId,turns,call,usageId,details,setDetails,refreshUsage,openConnections,openChatModels,openSideChat}:{state:Snapshot;chat?:Chat;chatId:string;turns:Turn[];call:Call;usageId:string;details:boolean;setDetails:(open:boolean)=>void;refreshUsage:()=>Promise<void>;openConnections:()=>void;openChatModels:()=>void;openSideChat:()=>void}){
 const project=state.projects.find(p=>p.id===chat?.projectId),picks=chat?.lockedModel?[chat.lockedModel]:chat?.selectedModels?.length?chat.selectedModels:chat?.model?[chat.model]:[];
 return <>
  <div className="composer-controls">
   <ChoiceMenu label="Permission mode" value={project?.mode||'manual'} options={permissionModes} disabled={!project} onChange={mode=>void call('mode',{projectId:project!.id,mode})}/>
   <ChatViewSelect chatId={chatId}/>
   <Button className="side-chat-button" disabled={!chat||!!chat.sideSourceId} title="Side chat · Ctrl+;" aria-label="Open side chat" onClick={openSideChat}>Side chat</Button>
   {chat&&<ContextControls chat={chat} turns={turns} call={call}/>}
   <Button className="connections-link" onClick={()=>{setDetails(false);openConnections();}}>Connections</Button>
   <ContextRing percent={contextPercent(turns,picks)} title={contextTooltip(turns,picks,state.claude?.models)} open={details} controls={usageId} toggle={()=>{setDetails(!details);if(!details)void refreshUsage().catch(()=>{});}}/>
  </div>
  <ChatModelRow usageId={usageId} state={state} chatId={chatId} call={call} details={details} setDetails={setDetails} connections={openConnections} addModel={openChatModels}/>
  {details&&<UsagePanel call={call} id={usageId} state={state} chat={chat} turns={turns} models={chat?.pool||[]} refresh={refreshUsage} close={()=>setDetails(false)}/>}
 </>;
}

/** C12: Jev, then the chat's models on one line that scrolls, then Add model and details; × shows on hover. */
export function ChatModelRow({usageId,state,chatId,call,details,setDetails,connections,addModel}:{usageId:string;state:Snapshot;chatId:string;call:Call;details:boolean;setDetails:(value:boolean)=>void;connections:()=>void;addModel:()=>void}){
 const [menu,setMenu]=useState<{model:string;x:number;y:number}|null>(null),[dropping,setDropping]=useState(false);
 const chat=state.chats.find(c=>c.id===chatId),pool=chat?.pool||[],selector=chat?.selector&&pool.includes(chat.selector)?chat.selector:null,engineLabel=picker(state.decisionEngine?.selected||'jev')?.short||'Jev',picks=chat?.selectedModels||(chat?.selected?['deepseek-flash']:[]),owners=new Set(state.chats.filter(c=>c.id===chatId||c.parentChatId===chatId).map(c=>c.id)),chatTurns=state.turns.filter(t=>owners.has(t.chatId));
 const busyWith=(model:string)=>chatTurns.some(t=>(t.models||[t.model]).includes(model)&&['queued','running','waiting','dispatching','stopping'].includes(t.status));
 useEffect(()=>{if(!menu)return;const key=(e:KeyboardEvent)=>{if(e.key==='Escape')setMenu(null);};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[menu]);
 const menuItems:MenuItem[]=!menu?[]:!menu.model?[
  ...(selector?[{label:'Hand back to '+engineLabel,icon:'models',action:()=>{setMenu(null);void call('selectorModel',{chatId,model:null}).catch(()=>{});}} as MenuItem]:[]),
  {label:'Decision engine settings',icon:'settings',action:()=>{setMenu(null);connections();}},
 ]:[
  {label:chat?.lockedModel===menu.model?'Stop always using':'Always use',icon:'pin',key:'Ctrl+click',action:()=>{setMenu(null);void call('modelLock',{chatId,model:menu.model}).catch(()=>{});}},
  {label:(selector===menu.model?'Take off select duty':'Put on select duty')+(menu.model.startsWith('claude-code:')&&selector!==menu.model?' · uses Claude limit':''),icon:'models',disabled:selector!==menu.model&&!state.availableModels?.includes(menu.model),title:menu.model.startsWith('claude-code:')?'Each pick uses your Claude 5-hour limit':undefined,action:()=>{setMenu(null);void call('selectorModel',{chatId,model:selector===menu.model?null:menu.model}).catch(()=>{});}},
  {label:'Remove from chat',icon:'trash',danger:true,separator:true,disabled:busyWith(menu.model),action:()=>{setMenu(null);void call('removeModel',{chatId,model:menu.model}).catch(()=>{});}},
 ];
 return <div className={'model-row'+(menu?' menu-open':'')} aria-controls={usageId} onClick={event=>{if(event.target===event.currentTarget)setDetails(!details);}}><button className={'jev model-pill'+(selector?' on-duty':'')+(dropping?' drop-target':'')} title={selector?modelLabel(selector,state.claude?.models)+' is on select duty for this chat. Right-click to hand back to '+engineLabel+'.':(state.decisionEngine?.status||'Decision engine settings')+'. Drop a model here to put it on select duty.'} onClick={()=>connections()} onDragOver={event=>{if(chat&&event.dataTransfer.types.includes('application/x-trismegistus-model')){event.preventDefault();event.dataTransfer.dropEffect='link';setDropping(true);}}} onDragLeave={()=>setDropping(false)} onDrop={event=>{const model=event.dataTransfer.getData('application/x-trismegistus-model');setDropping(false);if(chat&&model){event.preventDefault();void call('selectorModel',{chatId,model}).catch(()=>{});}}} onContextMenu={event=>{event.preventDefault();if(chat)setMenu({model:'',x:event.clientX,y:event.clientY});}}>{selector?<><Icon name="models"/>{modelLabel(selector,state.claude?.models)}</>:engineLabel}</button>
  <div className="model-pills">{pool.map(model=>{
   const picked=picks.includes(model),running=chatTurns.some(t=>!t.jobs?.length&&t.model===model&&['running','waiting','dispatching','stopping'].includes(t.status));
   const native=state.claude?.models?.find(item=>item.id===model);
   const available=state.availableModels?.includes(model),{status,health}=modelStatus(state,model);
   const efforts=native?Object.fromEntries(native.efforts.map(effort=>[effort,effort==='xhigh'?'Extra high':effort[0].toUpperCase()+effort.slice(1)])):modelEfforts(model);
   const locked=chat?.lockedModel===model;
   return <div key={model} className={'model-pill '+(picked||locked?'selected ':'')+(locked?'locked ':'')+(running?'working':'')} draggable={!!chat} onDragStart={event=>{event.dataTransfer.setData('application/x-trismegistus-model',model);event.dataTransfer.effectAllowed='link';}} onContextMenu={event=>{event.preventDefault();if(chat)setMenu({model,x:event.clientX,y:event.clientY});}}><button aria-pressed={picked||locked} className="model-tab" aria-describedby={usageId+'-model-usage-'+model} disabled={(!available&&!picked&&!locked)||!chat} onClick={event=>void (event.ctrlKey||event.metaKey?call('modelLock',{chatId,model}):call('modelSelection',{chatId,model,selected:!picked})).catch(()=>{})}><span className={'health-dot '+health} aria-hidden="true"/>{locked&&<Icon name="pin"/>}{modelLabel(model,state.claude?.models)} <span>{running?'●':''}</span></button><ModelUsageTooltip id={usageId+'-model-usage-'+model} model={model} state={state} turns={chatTurns} pool={pool} status={status}/><ChoiceMenu label={model==='deepseek-flash'?'Thinking effort':'Thinking effort '+modelLabel(model,state.claude?.models)} value={chat?.efforts?.[model]||(model==='deepseek-flash'?chat?.effort:'high')||'high'} options={efforts} disabled={!chat} onChange={effort=>void call('effort',{chatId,model,effort})}/><button className="model-remove" aria-label={'Remove '+modelLabel(model,state.claude?.models)+' from chat'} disabled={!chat||busyWith(model)} title="Remove from chat" onClick={()=>void call('removeModel',{chatId,model}).catch(()=>{})}>×</button></div>;
  })}</div>
  {menu&&<Menu x={menu.x} y={Math.max(8,menu.y-(menu.model?150:110))} label={menu.model?modelLabel(menu.model,state.claude?.models)+' actions':engineLabel+' actions'} className="model-menu" items={menuItems} close={()=>setMenu(null)}/>}
  <button className="model-add" aria-label="Add model" title="Add model" disabled={!chat} onClick={()=>{setDetails(false);addModel();}}><Icon name="plus"/><span>Add model</span></button><button className="model-disclosure" aria-label="Model details" aria-controls={usageId} aria-expanded={details} onClick={()=>setDetails(!details)}><Icon name={details?'down':'up'}/></button></div>;
}
