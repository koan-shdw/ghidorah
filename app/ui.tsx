// Tokens and themes load before every other stylesheet; every style in the app is written in their terms.
import './tokens.css';
import './themes.css';
import './kit.css';
import {isJoinedTurn,replyParts} from './turn-joins';
import appIcon from '../assets/icon.png';
import {applyTurnStream} from './turn-stream';
import {TurnStatus,turnModelLabel} from './turn-status';
import {ContextControls} from './context-dialog';
import {backendSendError} from './backend-state';
import {WakeWindow} from './wake-window';
import {VoiceWindow} from './voice-window';
import {chatActivity} from './activity';
import {readTree,reconcileTree,paneKind,readPaneWorkspace,workspaceTitle} from './pane-layout';
import {allPaneIds,findGroupOfPane,setActivePane,insertAtGroup,type LayoutNode} from './pane-tree';
import {WorkspaceWindow} from './workspace-window';
import {PaneShell,windowTree} from './pane-shell';
import {readChatLayout} from './chat-layout';
import {ChoiceMenu} from './kit';
import {SettingsDialog,SettingsCard} from './settings-dialog';
import {useShare} from './share-dialog';
import {useWorktree} from './worktree-dialog';
import {UpdateWindow,UpdateChip} from './update-window';
import {DecisionSettings} from './picker-settings';
import {isPicker,picker} from './pickers';
import {AlwaysOnSettings,RemoteSettings,RoutinesSettings,VoiceSettings,ClaudeCodeSettings,ClaudeSignIn,SecuritySettings,SupplierDot,PublishingSettings,BrowserSettings} from './settings-pages';
import {ChatViewContext,ChatViewSelect,cycleChatView,setChatView,useChatView} from './chat-view';
import {ChatActions,ChatDock,BackendStatus,permissionModes} from './chat-chrome';
import {ModelUsageTooltip} from './model-usage-tooltip';
import {SidebarIcon} from './kit';
import {AppOverview} from './app-overview';
import {latestChat} from './sidebar';
import {apiSuppliers} from './api-catalog';
import {ApiConnectionSettings} from './api-settings';
import {ImageSettings} from './image-settings';
import React,{useContext,useEffect,useId,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Markdown,ToolActivity,SavedMessageDialog,type SavedMessage} from './chat-content';
import {ChatFilesButton} from './chat-files-panel';
import './chat-files.css';
import {useFollowOutput} from './follow-output';
import {Wizard} from './wizard';
import {VendorIcon} from './vendor-icons';
import type {FileRequest} from './chat-links';
import type {Snapshot,Turn,Mode,Chat} from './types';
import {modelLabel,modelEfforts} from './models';
import {modelStatus} from './availability';
// Main-process errors arrive wrapped by Electron; show the app's own message.
const errorText=(error:unknown)=>String(error).replace(/^Error: /,'').replace(/^Error invoking remote method 'app': (?:Error: )?/,'');
import {UsagePanel} from './usage-panel';
import {contextTooltip} from './usage';
import {ModelPool} from './model-pool';
import {McpSettings} from './mcp-settings';
import {PluginsSettings} from './plugins-settings';
import {Composer,AttachmentImage} from './composer';
import {transcribeForChat} from './dictation';
import {GoalPanel} from './goal-panel';
import {SidebarPanel} from './sidebar-panel';
import {WorkspacePanel,type WorkspaceView} from './workspace-panel';
import {WelcomeArt,artFontNames,defaultArtFont} from './welcome-art';
// Chromium's own zoom steps. Every window applies the saved size and font when it opens and when another window changes them.
const textSizes=[0.8,0.9,1,1.1,1.25,1.5,1.75,2];
const savedTextSize=()=>{const value=Number(localStorage.getItem('text-size'));return textSizes.includes(value)?value:1;};
// Settings, Appearance, Font: the main fonts, listed when Windows has them; Helvetica first (Koan 2026-10-16). Code stays Consolas.
const uiFonts=['Helvetica','Helvetica Neue','Helvetica Now Text','Helvetica Now Display','Arial','Segoe UI','Neue Haas Grotesk Text Pro','Univers','Futura','Avenir','Avenir Next','Gill Sans','Inter','Roboto','SF Pro Text','IBM Plex Sans','Open Sans','Calibri','Aptos','Verdana','Georgia','Times New Roman'];
const savedFont=()=>{const value=localStorage.getItem('ui-font');return value&&uiFonts.includes(value)?value:'Helvetica';};
// While Windows's list loads only the current font shows; if it cannot be read, every main font shows.
const fontChoices=(installed:string[]|undefined,current:string)=>{if(!installed)return [current];const have=new Set(installed.map(name=>name.toLowerCase()));return installed.length?uiFonts.filter(font=>have.has(font.toLowerCase())||font===current):uiFonts;};
const appearance=()=>{window.desktop.textSize(savedTextSize());document.documentElement.style.setProperty('--ui-font',JSON.stringify(savedFont()));};
import './ui.css';
import './chat-content.css';
import './sidebar.css';
import './settings-dialog.css';
import {Question} from './question';
import './question.css';
const api=window.desktop;
const modes=permissionModes;
const empty:Snapshot={projects:[],chats:[],turns:[],tools:[],approvals:[],connected:false,backend:'starting',providerStatus:'Not connected'};
function QuestionReview({state,item,call}:{state:Snapshot;item:any;call:(method:string,args:any)=>Promise<any>}){
 const text=JSON.stringify(item.params),actions=(state.workReview||[]).filter(action=>text.includes(action.id));
 return actions.length?<WorkReview state={{...state,workReview:actions}} call={call} heading="Review action"/>:null;
}
const activeStates=new Set(['queued','dispatching','running','waiting','stopping','needs-model']);
const statusText=(status:string)=>({queued:'Queued',dispatching:'Starting',running:'Working',waiting:'Waiting for approval',stopping:'Stopping…',completed:'Completed','needs-model':'Choose a model',partial:'Partly completed',failed:'Failed',interrupted:'Interrupted',stopped:'Stopped'}[status]||status);
function WorkReview({state,call,heading='Work review'}:{state:Snapshot;call:(method:string,args?:any)=>Promise<any>;heading?:string}){
 const [notes,setNotes]=useState<Record<string,string>>({}),[dismissed,setDismissed]=useState(''),[busy,setBusy]=useState(''),[error,setError]=useState('');
 const reviewKey=(state.workReview||[]).map(row=>row.id).sort().join('|');
 if(!state.workReview?.length||dismissed===reviewKey)return null;
 return <details className="work-review"><summary>{heading} · {state.workReview.length} uncertain {state.workReview.length===1?'action':'actions'}<button type="button" className="work-review-close" aria-label="Close work review" title="Close work review" onClick={event=>{event.preventDefault();event.stopPropagation();setDismissed(reviewKey);}}>×</button></summary><p>Check the affected file or service and record what happened. Recording the outcome releases the hold. Then answer the question or send a message to continue.</p>{error&&<p className="error" role="alert">{error}</p>}{state.workReview.map(action=>{
  const turn=state.turns.find(t=>t.id===action.job),chat=state.chats.find(c=>c.id===turn?.chatId)||state.chats.find(c=>state.turns.find(t=>t.id===turn?.parentTurnId)?.chatId===c.id);
  return <details className="tool" key={action.id} open={heading==='Review action'||undefined}><summary>{action.name} · {chat?.title||'Saved work'}</summary><pre>{JSON.stringify(action.args,null,2)}</pre><pre>{typeof action.result==='string'?action.result:JSON.stringify(action.result,null,2)}</pre><label>Checked outcome<textarea aria-label={'Checked outcome for '+action.id} value={notes[action.id]||''} onChange={event=>setNotes({...notes,[action.id]:event.target.value})}/></label><button type="button" disabled={!!busy||(notes[action.id]||'').trim().length<5} onClick={()=>{setBusy(action.id);setError('');void call('inspectWork',{id:action.id,note:notes[action.id]}).catch(error=>setError(errorText(error))).finally(()=>setBusy(''));}}>{busy===action.id?'Recording…':'Record checked outcome'}</button></details>;
 })}</details>;
}
function BackgroundProcesses({state,turnId,call}:{state:Snapshot;turnId:string;call:(method:string,args?:any)=>Promise<any>}){
 const viewMode=useContext(ChatViewContext),rows=(state.background||[]).filter(row=>row.turnId===turnId);
 return <>{rows.map(row=><details className="background-process" key={row.id+viewMode} open={viewMode==='verbose'} data-process-id={row.id} data-status={row.status}>
  <summary><span className={'dot '+(row.status==='running'?'running':row.status==='lost'?'uncertain':'completed')}/><span>{row.command}</span><strong>{({checking:'Checking',running:'Running',stopping:'Stopping…',exited:'Exited',stopped:'Stopped',lost:'Needs inspection'})[row.status]}{row.exitCode!==undefined?' · '+row.exitCode:''}</strong></summary>
  {row.output&&<pre>{row.output}</pre>}{row.error&&<p className="hint">{row.error}</p>}
  {['running','checking','stopping'].includes(row.status)&&<div><button disabled={row.status==='stopping'} aria-label={'Stop process '+row.processId} onClick={()=>void call('backgroundStop',{id:row.id}).catch(()=>{})}>Stop process</button>{row.engine!=='claude'&&<button onClick={()=>void call('backgroundRefresh').catch(()=>{})}>Refresh status</button>}</div>}
 </details>)}</>;
}
function JoinedMessage({state,turn,call}:{state:Snapshot;turn:Turn;call:(method:string,args?:any)=>Promise<any>}){
 const share=useShare(state,call,turn.chatId);
 return <>{share.element}<div className="user-message" data-turn-id={turn.id} tabIndex={-1} onContextMenu={event=>{event.stopPropagation();share.open(turn)(event);}}>
  <HandoffOrigin turn={turn}/><Markdown message text={turn.prompt} turnId={turn.id}/>
  {!!turn.attachments?.length&&<div className="attachments sent-attachments">{turn.attachments.map(item=>item.kind==='image'?<AttachmentImage key={item.id} item={item} chatId={turn.chatId}/>:<ChatFilesButton className="attachment" key={item.id} chatId={turn.chatId} id={'upload:'+item.id}>{item.name}</ChatFilesButton>)}</div>}
  {share.actions(turn)}
 </div></>;
}
function Response({state,t,call,pool,addModel}:{state:Snapshot;t:Turn;call:(method:string,args?:any)=>Promise<any>;pool:string[];addModel?:()=>void}){
 const viewMode=useContext(ChatViewContext);
 return <>
  {t.automatic?.kind==='agent'&&<button className="agent-open" onClick={()=>void call('openJob',{id:t.id})}>Open agent</button>}
  <div className="model-label" title={t.automatic?.resolvedModel}>{turnModelLabel(t,model=>modelLabel(model,state.claude?.models))}{t.automatic?.kind==='agent'&&t.effort&&<span title="Reported thinking effort">{t.effort}</span>}<TurnStatus turn={t} tools={state.tools} approvals={state.approvals}/></div>
  {t.reasoning&&<details className="thinking" key={viewMode} open={viewMode!=='normal'}><summary>Thinking</summary><Markdown text={t.reasoning} turnId={t.id}/></details>}
  {replyParts(t,state.tools,state.turns).map(part=><React.Fragment key={part.message?.id||'tail'}><ToolActivity tools={part.tools}/>{part.text&&<Markdown text={part.text} turnId={t.id}/>}
   {part.message&&<JoinedMessage state={state} turn={part.message} call={call}/>}
  </React.Fragment>)}
  <BackgroundProcesses state={state} turnId={t.id} call={call}/>
  {state.approvals.filter(a=>a.turnId===t.id&&a.status==='pending').map(a=>a.method.startsWith('clarify')?<Question key={a.id} item={a} call={call} review={<QuestionReview state={state} item={a} call={call}/>}/>:<div className="approval" key={a.id} role="alert"><strong>{a.method==='project-trust'?'Project settings review':a.params.plan?'Review plan':a.params.screenApp?'Screen control':'Permission requested'}</strong><p>{state.chats.find(c=>c.id===t.chatId)?.title} · {modelLabel(t.model,state.claude?.models)}</p>{a.params.directory&&<p>{a.params.directory}</p>}{a.params.plan?<Markdown text={a.params.plan} turnId={t.id}/>:<pre>{a.params.description||a.params.command||JSON.stringify(a.params,null,2)}</pre>}{a.waiting?<p>{a.waiting}</p>:<div>{a.params.screenApp?<><button className="primary" onClick={()=>void call('approve',{id:a.id,choice:'once'})}>Allow for this chat</button><button onClick={()=>void call('approve',{id:a.id,choice:'always'})}>Always</button><button onClick={()=>void call('approve',{id:a.id,choice:'deny'})}>No</button></>:<><button className="primary" onClick={()=>void call('approve',{id:a.id,choice:'once'})}>{a.method==='project-trust'?'Trust and continue':a.params.plan?'Approve plan':'Allow once'}</button><button onClick={()=>void call('approve',{id:a.id,choice:'deny'})}>{a.method==='project-trust'?(a.params.sourceDiscovery?'Skip this operation':'Continue without project settings'):a.params.plan?'Keep planning':'Deny'}</button></>}</div>}</div>)}
  {t.routeNotice&&<div className="hint">{t.routeNotice}</div>}{t.error&&<div className="turn-error">{t.error}</div>}
  {t.status==='needs-model'&&<div className="model-prompt" aria-label="Choose a replacement model">{(t.models||[t.model]).map(replace=><label key={replace}>Replace {modelLabel(replace,state.claude?.models)}<select aria-label={'Replace '+modelLabel(replace,state.claude?.models)} value="" onChange={event=>{if(event.target.value)void call('chooseTurnModel',{id:t.id,replace,model:event.target.value});}}><option value="">Choose a model…</option>{pool.filter(model=>state.availableModels?.includes(model)&&!(t.models||[]).some(item=>item!==replace&&item===model)).map(model=><option key={model} value={model}>{modelLabel(model,state.claude?.models)}</option>)}</select></label>)}{addModel&&<button onClick={addModel}>Add model</button>}<button onClick={()=>void call('chooseTurnModel',{id:t.id,model:null})}>Skip message</button></div>}
  {['running','dispatching'].includes(t.status)&&!t.text&&<div className="working-mark" aria-label="Working">✳</div>}
 </>;
}
function TurnResponse({state,t,call,pool,chatId,addModel}:{state:Snapshot;t:Turn;call:(method:string,args?:any)=>Promise<any>;pool:string[];chatId:string;addModel?:()=>void}){
 return t.jobs?.length?<section className="parallel-results" aria-label="Parallel results"><header><strong>{new Set(t.jobs.map(id=>state.turns.find(job=>job.id===id)?.chatId)).size} models · {statusText(t.status)}</strong>{activeStates.has(t.status)&&<button onClick={()=>void call('stop',{chatId,turnId:t.id})}>Stop group</button>}</header>{t.routeNotice&&<p className="hint">{t.routeNotice}</p>}{t.jobs.map(id=>{const job=state.turns.find(job=>job.id===id);return job?<section key={id} className="parallel-result" data-job-id={id} data-status={job.status}><div className="job-actions"><button onClick={()=>void call('openJob',{id})}>Open {modelLabel(job.model,state.claude?.models)} ↗</button>{activeStates.has(job.status)&&<button onClick={()=>void call('stop',{chatId:job.chatId})}>Stop job</button>}</div>{job.automatic?<div className="hint">{job.automatic.kind==='agent'?'Agent · '+job.automatic.description:'Background update'}</div>:job.prompt!==t.prompt&&<div className="user-message"><Markdown message text={job.prompt} turnId={job.id}/></div>}<Response state={state} t={job} call={call} pool={pool} addModel={addModel}/></section>:null;})}</section>:<Response state={state} t={t} call={call} pool={pool} addModel={addModel}/>;
}
function useMessageReference(chatId:string,turns:Turn[],scroller:React.RefObject<HTMLDivElement|null>,moved:()=>void){
 const [reference,setReference]=useState<{chatId:string;turnId:string}|null>(null);
 useEffect(()=>api.onSelectChat((id,turnId)=>{if(turnId)setReference({chatId:id,turnId});}),[]);
 useEffect(()=>{if(!reference||reference.chatId!==chatId)return;const frame=requestAnimationFrame(()=>{const message=scroller.current?.querySelector<HTMLElement>('[data-turn-id="'+reference.turnId+'"]');if(message){message.scrollIntoView({block:'start'});moved();message.focus({preventScroll:true});setReference(null);}});return()=>cancelAnimationFrame(frame);},[chatId,turns,reference]);
}
function HandoffOrigin({turn}:{turn:Turn}){
 const [error,setError]=useState(''),[saved,setSaved]=useState<SavedMessage|null>(null);
 async function open(){setError('');try{const result=await api.invoke('chatLink',{turnId:turn.id,href:'tris-chat:'+turn.handoff!.sourceChatId+'#'+turn.handoff!.sourceTurnId});if(result?.savedMessage)setSaved(result.savedMessage);}catch(e){setError(String(e).replace(/^Error invoking remote method 'app': (?:Error: )?/,''));}}
 return turn.handoff?<>{saved&&<SavedMessageDialog record={saved} close={()=>setSaved(null)}/>}<div className="handoff-origin"><button onClick={()=>void open()}>From {turn.handoff.title}</button>{error&&<span role="alert">{error}</span>}</div></>:null;
}
function CorrectionOption({show,disabled,send}:{show:boolean;disabled:boolean;send:()=>void}){return show?<div className="correction-option"><span>Enter queues your message. Current work keeps running.</span><button disabled={disabled} onClick={send}>Stop and send</button></div>:null;}
function SideChatNotice({chat,call}:{chat?:Chat;call:(method:string,args?:any)=>Promise<any>}){
 if(chat?.branchTurnId)return <div className="branch-notice"><SidebarIcon name="fork"/><span><strong>New branch</strong> · Original chat preserved. Files and external actions keep their current state. Review the message and model before sending; tools can run again.</span></div>;
 if(!chat?.sideSourceId)return null;
 return <div className="side-chat-notice"><span>Side chat · thread snapshot from opening. Replies stay here.</span><button onClick={()=>void call('sideChatKeep',{chatId:chat.id}).catch(()=>{})}>Keep as chat</button><button onClick={()=>void call('sideChatDiscard',{chatId:chat.id}).catch(()=>{})}>Discard side chat</button><small>Stop active work and close its terminals before discarding.</small></div>;
}
function AgentPane({id,close}:{id:string;close?:()=>void}){
 const [state,setState]=useState(empty),[error,setError]=useState(''),key='agent:'+id,view=useChatView(key),scroll=useRef<HTMLDivElement>(null);
 const follow=useFollowOutput(scroll,[state.turns,state.tools,state.approvals]);
 useEffect(()=>{void api.invoke('state').then(setState);return api.subscribe(setState,updates=>setState(state=>applyTurnStream(state,updates)));},[]);
 const turn=state.turns.find(turn=>turn.id===id),task=state.background?.find(row=>row.engine==='claude'&&row.chatId===turn?.chatId&&row.processId===turn?.automatic?.taskId&&row.generation===turn?.automatic?.runtimeId);
 async function call(method:string,args?:any){try{setError('');if(method==='openJob')return;return await api.invoke(method,args);}catch(error){setError(errorText(error));throw error;}}
 return <ChatViewContext.Provider value={view}><section className={'agent-pane '+(!close?'agent-window':'')} aria-label={'Agent: '+(turn?.automatic?.description||'Agent')} onKeyDownCapture={event=>{if(event.ctrlKey&&!event.altKey&&!event.metaKey&&event.code==='KeyO'){event.preventDefault();cycleChatView(key);}}}>
  <header className="job-titlebar"><strong>{turn?.automatic?.description||'Agent'}</strong><span>{turn?statusText(turn.status):'Loading'}</span>{!close&&<button aria-label="Minimize agent window" onClick={()=>void call('window',{action:'minimize'})}>−</button>}<button aria-label={close?'Close agent pane':'Close agent window'} onClick={()=>close?close():void call('window',{action:'close'})}>×</button></header>
  <div className="job-parent"><button onClick={()=>void call('openParent',{turnId:id})}>Open parent chat</button><ChatViewSelect chatId={key}/>{task&&['running','checking','stopping'].includes(task.status)&&<button disabled={task.status==='stopping'} onClick={()=>void call('backgroundStop',{id:task.id}).catch(()=>{})}>Stop agent</button>}</div>
  {error&&<p role="alert" className="error">{error}</p>}<div className="transcript" ref={scroll} onScroll={follow.onScroll}><div className="messages">{turn&&<Response state={{...state,background:[]}} t={turn} call={call} pool={[]}/>}</div></div>
 </section></ChatViewContext.Provider>;
}
function chatEngineError(state:Snapshot,chat?:Chat){return backendSendError(state.backend,[...(chat?.lockedModel?[chat.lockedModel]:[]),...(chat?.selectedModels||(chat?.selected?['deepseek-flash']:[]))]);}
function BackendNotice({state,call}:{state:Snapshot;call:(method:string,args?:any)=>Promise<any>}){
 const [retrying,setRetrying]=useState(false);
 if(state.backend==='ready')return null;
 const starting=retrying||state.backend==='starting';
 return <div className="backend-notice" role="status"><span>{starting?'Starting chat engine… You can keep writing.':'Chat engine offline. Your draft is saved.'}</span>{!starting&&<button onClick={()=>{setRetrying(true);void call('restart').catch(()=>{}).finally(()=>setRetrying(false));}}>Restore connection</button>}</div>;
}
function SideJob({chatId,ordinary=false,embedded}:{chatId:string;ordinary?:boolean;embedded?:{close:()=>void;select:()=>void;workspace:(view:WorkspaceView)=>void;plugins:()=>void;sideChat:()=>void}}){
 const usageId=useId(),viewMode=useChatView(chatId);
 const [details,setDetails]=useState(false),[modelsOpen,setModelsOpen]=useState(false);

 const [state,setState]=useState(empty),[draft,setDraft]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),composer=useRef<HTMLTextAreaElement>(null),draftEdits=useRef(0),[attaching,setAttaching]=useState(false),loaded=useRef(false),scroll=useRef<HTMLDivElement>(null);
 const [workspace,setWorkspace]=useState(false),[workspaceView,setWorkspaceView]=useState<WorkspaceView>('files'),[terminalRequest,setTerminalRequest]=useState(0),[fileRequest,setFileRequest]=useState<FileRequest|null>(null);
 const chat=state.chats.find(c=>c.id===chatId)||state.jobChats?.find(c=>c.id===chatId),turns=state.turns.filter(t=>t.chatId===chatId),current=turns.at(-1),parent=state.turns.find(t=>t.id===chat?.groupTurnId),working=ordinary?turns.some(t=>activeStates.has(t.status)):current&&activeStates.has(current.status),groupActive=parent&&activeStates.has(parent.status);
 useEffect(()=>{if(chat?.draftRevision){draftEdits.current++;setDraft(chat.draft);}},[chat?.draftRevision]);
 async function call(method:string,args?:any){if(embedded&&method==='openMainChat'){embedded.select();return;}try{setError('');return await api.invoke(method,args);}catch(error){setError(String(error).replace(/^Error invoking remote method 'app': (?:Error: )?/,''));throw error;}}
 useEffect(()=>{const receive=(next:Snapshot)=>{const owner=next.chats.find(c=>c.id===chatId)||next.jobChats?.find(c=>c.id===chatId);if(owner&&!loaded.current){loaded.current=true;setDraft(owner.draft);}setState(next);};api.invoke('state').then(receive);return api.subscribe(receive,updates=>setState(state=>applyTurnStream(state,updates)));},[chatId]);
 const follow=useFollowOutput(scroll,[state.turns,state.tools,state.approvals]);
 useMessageReference(chatId,turns,scroll,follow.onScroll);
 useEffect(()=>{document.documentElement.dataset.theme=localStorage.getItem('theme')||'dark';},[]);
 useEffect(()=>ordinary&&!embedded?api.onOpenFile(request=>{setFileRequest(request);setWorkspaceView('files');setWorkspace(true);}):undefined,[ordinary]);
 async function openSideChat(){if(embedded){embedded.sideChat();return;}try{await call('sideChatOpen',{chatId});}catch{}}
 async function openWorkspace(view:WorkspaceView){if(embedded){embedded.workspace(view);return;}setWorkspaceView(view);setWorkspace(true);if(view==='terminal'&&state.defaultFolder){try{const rows=await call('terminalList',{chatId});if(!rows.length)await call('terminalOpen',{chatId});setTerminalRequest(value=>value+1);}catch{}}}
 useEffect(()=>{if(embedded)return;const key=(event:KeyboardEvent)=>{if(!event.defaultPrevented&&!document.querySelector('dialog[open]')&&event.ctrlKey&&!event.altKey&&!event.metaKey&&(event.code==='KeyO'||ordinary&&['Backquote','Semicolon'].includes(event.code))){event.preventDefault();if(event.code==='KeyO')cycleChatView(chatId);else if(event.code==='Semicolon')void openSideChat();else void openWorkspace('terminal');}};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[ordinary,state.defaultFolder]);
 const sending=useRef(false);
 async function correct(queue=true){if(sending.current||(!draft.trim()&&!(ordinary&&chat?.attachments?.length))||busy)return;const edits=draftEdits.current;sending.current=true;setBusy(true);try{await call(ordinary?(working&&!queue?'correctGroup':'submit'):'correctJob',{id:crypto.randomUUID(),chatId,text:draft,queue});if(edits===draftEdits.current)setDraft('');}catch{}finally{sending.current=false;setBusy(false);}}
 async function attach(files:File[]){
  if(busy||!chat)return;setBusy(true);setAttaching(true);
  try{for(const file of files){if(file.size>25*1024*1024)throw Error('Choose files up to 25 MB.');await call('attachmentAdd',{chatId,name:file.name,bytes:new Uint8Array(await file.arrayBuffer())});}}catch(error){setError(errorText(error));}finally{setBusy(false);setAttaching(false);}
 }
 const share=useShare(state,call,chatId);
 return <ChatViewContext.Provider value={viewMode}>{share.element}<div data-view-mode={viewMode} className={ordinary?"chat-window-shell":"job-window-shell"}><main className="side-job" onDragOver={event=>{if(ordinary&&event.dataTransfer.types.includes('Files'))event.preventDefault();}} onDrop={event=>{if(ordinary&&event.dataTransfer.files.length){event.preventDefault();void attach(Array.from(event.dataTransfer.files));}}}><header className="job-titlebar"><strong>{ordinary?chat?.title||'Chat':current?modelLabel(current.model,state.claude?.models):'Model job'}</strong><span role="status">{current?statusText(current.status):chat?'Ready':'Loading'}</span>{!embedded&&<button aria-label={ordinary?"Minimize chat window":"Minimize job window"} onClick={()=>void call('window',{action:'minimize'})}>−</button>}<button className={current?.status==='completed'?'job-finished':''} aria-label={embedded?(ordinary?"Close split chat":"Close job pane"):ordinary?"Close chat window":"Close job window"} title="Close this view; work keeps running" onClick={()=>embedded?embedded.close():void call('window',{action:'close'})}>×</button></header>
  <div className="job-parent">{embedded&&!ordinary?<button onClick={()=>{if(current)void call('openJob',{id:current.id}).then(()=>embedded.close()).catch(()=>{});}}>Pop out ↗</button>:<button onClick={()=>void call(ordinary?'openMainChat':'openParent',{chatId})}>↗ {chat?.title||'Main chat'}</button>}{!ordinary&&<ChatViewSelect chatId={chatId}/>}{!ordinary&&working&&<button onClick={()=>void call('stop',{chatId})}>Stop job</button>}</div>
  {ordinary&&<SideChatNotice chat={chat} call={call}/>}
  {ordinary&&<GoalPanel chatId={chatId} goal={state.goals?.find(goal=>goal.id===chatId)} busy={!!working} call={call}/>}
  {ordinary&&<div className="chat-window-actions"><ChatActions chatId={chatId} shortcuts={!embedded} open={view=>void openWorkspace(view)}/></div>}
  <div className="transcript" ref={scroll} onScroll={follow.onScroll}><div className="messages">{turns.filter(t=>!isJoinedTurn(t,turns)).map(t=><article className="turn" key={t.id} data-turn-id={t.id} tabIndex={-1} data-status={t.status} onContextMenu={share.open(t)}>{t.automatic?<div className="hint">{t.automatic?.kind==='agent'?'Agent · '+t.automatic.description:'Background update'}</div>:<div className="user-message"><HandoffOrigin turn={t}/><Markdown message text={t.prompt} turnId={t.id}/>{t.attachments?.length?<div className="attachments sent-attachments">{t.attachments.map(item=>item.kind==='image'?<AttachmentImage key={item.id} item={item} chatId={t.chatId}/>:<ChatFilesButton className="attachment" key={item.id} chatId={t.chatId} id={"upload:"+item.id}>{item.name}</ChatFilesButton>)}</div>:null}{t.status==='queued'&&!t.automatic&&<button className="queued-cancel" aria-label="Cancel queued message" title="Cancel queued message" onClick={()=>void call('cancelQueued',{id:t.id}).catch(()=>{})}>×</button>}</div>}<TurnResponse state={state} t={t} call={call} pool={chat?.pool||[]} chatId={chatId} addModel={ordinary?()=>setModelsOpen(true):undefined}/>{share.actions(t)}</article>)}</div></div>

  {ordinary?<div className="chat-window-composer"><BackendNotice state={state} call={call}/>{error&&<div className="error" role="alert">{error}</div>}<Composer sendError={chatEngineError(state,chat)} voice={()=>void call('voiceOpen',{chatId})} dictationOwner={chatId} dictate={(bytes,mime,signal)=>transcribeForChat(call,chatId,bytes,mime,signal)} inputRef={composer} draft={draft} commands={state.commands} disabled={!chat||!!chat.archived} busy={busy} working={!!working} change={text=>{draftEdits.current++;setDraft(text);void call('draft',{chatId,text});}} submit={()=>void correct()} stop={()=>void call('stop',{chatId})} plugins={()=>embedded?embedded.plugins():void call('openMainChat',{chatId})} attachments={chat?.attachments} attaching={attaching} attach={files=>void attach(files)} remove={id=>void call('attachmentRemove',{chatId,id})}/><CorrectionOption show={!!working&&(!!draft.trim()||!!chat?.attachments?.length)} disabled={busy||!!chatEngineError(state,chat)} send={()=>void correct(false)}/><div className="side-model-controls"><ChatDock state={state} chat={chat} chatId={chatId} turns={state.turns.filter(t=>t.chatId===chatId||state.chats.find(c=>c.id===t.chatId)?.parentChatId===chatId)} call={call} usageId={usageId} details={details} setDetails={setDetails} refreshUsage={async()=>{await call('refreshUsage');}} openConnections={()=>void call('openConnections')} openChatModels={()=>setModelsOpen(true)} openSideChat={()=>void openSideChat()}/>{modelsOpen&&<SettingsDialog page="chat-models" select={()=>{}} closeLabel="Close chat models" close={()=>setModelsOpen(false)}><ModelPool state={state} chatId={chatId} call={call} connections={()=>{setModelsOpen(false);void call('openConnections');}}/>{error&&<p className="error">{error}</p>}</SettingsDialog>}</div></div>:<div className="job-correction">{error&&<div className="error" role="alert">{error}</div>}<textarea disabled={!chat} aria-label={ordinary?"Message":"Job correction"} placeholder={ordinary?"Message…":"Correction for this model…"} onKeyDown={event=>{if(ordinary&&!event.nativeEvent.isComposing&&event.key==='Enter'&&!event.shiftKey){event.preventDefault();void correct();}}} value={draft} onChange={event=>{draftEdits.current++;setDraft(event.target.value);void call('draft',{chatId,text:event.target.value});}}/><div><span>{ordinary?'Send continues this chat. Closing the window keeps work running.':groupActive?'Corrections stop this run and start a new one with its saved context.':'This group has finished. Continue in the main chat.'}</span><button disabled={(ordinary?!!chat?.archived:!groupActive)||busy||!draft.trim()} onClick={()=>void correct(ordinary)}>{ordinary?working?'Queue message':'Send':working?'Stop and send correction':'Send correction'}</button></div></div>}
 </main>{ordinary&&!embedded&&<WorkspacePanel activity={chatActivity(state,chatId)} fileRequest={fileRequest} theme={localStorage.getItem('theme')||'dark'} chatId={chatId} root={state.defaultFolder||null} visible={workspace} view={workspaceView} setView={setWorkspaceView} onHide={()=>setWorkspace(false)} call={(method,args)=>api.invoke(method,args)} terminalRequest={terminalRequest}/>}</div></ChatViewContext.Provider>;
}
function ProjectSettings({call,chatId}:{call:(method:string,args?:any)=>Promise<any>;chatId:string}){
  const [review,setReview]=useState<any>(null);
  async function inspect(){try{setReview(await call('projectTrustReview',{chatId}));}catch{}}
  async function save(enabled:boolean){try{await call('projectTrust',{hash:review.hash,enabled,chatId});await inspect();}catch{}}
  return <section className="settings-card"><h3>Project settings</h3><p>Claude project settings stay off until you review their hook commands and access settings.</p><button onClick={()=>void inspect()}>Review project settings</button>{review&&<div className="trust-review"><p><code>{review.folder}</code></p><p>{review.trusted?'Trusted':'Project settings are off'}{review.reviewEveryRun?' · Hook commands need review for each run.':''}</p>{review.error?<p className="error">{review.error}</p>:<><pre>{JSON.stringify({commands:review.commands,settings:review.settings,agents:review.agents,skills:review.skills,warnings:review.warnings,scripts:review.files.map((file:any)=>file.path)},null,2)}</pre><p>Hooks can run commands with your account’s access.</p><button className="primary" onClick={()=>void save(!review.trusted)}>{review.trusted?'Turn project settings off':'Trust these project settings'}</button></>}</div>}</section>;
}
// In the setup wizard the picker and MCP parts are hidden; `only` shows one supplier's row (the Jev step).
function Connections({state,call,open,setup,only}:{state:Snapshot;call:(method:string,args?:any)=>Promise<any>;open?:string;setup?:boolean;only?:string}){
  const [supplier,setSupplier]=useState(''),[key,setKey]=useState(''),[busy,setBusy]=useState(false);
  const codexBusy=!!state.codex?.login||['Starting sign-in…','Signing out…'].includes(state.codex?.status||'');
  const [jevKey,setJevKey]=useState(''),[summaryModel,setSummaryModel]=useState(state.jev?.summaryModel||'deepseek-flash'),[confidence,setConfidence]=useState(state.jev?.confidence??0.7),[timeoutMs,setTimeoutMs]=useState(state.jev?.timeoutMs??500);
  const [shown,setShown]=useState<string[]>(only?[only]:setup?['deepseek','openai']:['deepseek','openai','anthropic','typesafe']);
  const panels=useRef<Record<string,HTMLDetailsElement|null>>({});
  async function save(){setBusy(true);try{await call('saveKey',{key});setKey('');}catch{/* The calling view shows the error. */}finally{setBusy(false);}}
  function choose(value:string){setSupplier(value);if(!shown.includes(value))setShown([...shown,value]);requestAnimationFrame(()=>{const panel=panels.current[value];if(panel){panel.open=true;panel.querySelector('summary')?.focus();}});}
  // Security's Replace key opens that supplier's row here.
  useEffect(()=>{if((only||open)&&!isPicker(only||open))choose((only||open)!);},[open,only]);
  return <section className="connections"><h3>{only==='typesafe'?'Jev':setup?'Connections':'Suppliers'}</h3>
    {!only&&<div className="connection-field"><span>Supplier</span><ChoiceMenu label="Connection supplier" value={supplier} options={{"":"Choose a supplier…",deepseek:"DeepSeek",openai:"OpenAI",anthropic:"Anthropic",typesafe:"TypeSafe · Jev",...Object.fromEntries(Object.entries(apiSuppliers).map(([id,info])=>[id,info.name]))}} onChange={choose}/></div>}
    {shown.includes('deepseek')&&<details className="supplier-pill" ref={element=>{panels.current.deepseek=element;}} open={!state.connected&&!state.codex?.connected&&!state.claude?.connected&&!state.apiProviders?.some(row=>row.connected)&&supplier!=='openai'}><summary><SupplierDot connected={state.connected} status={state.providerStatus}/><VendorIcon id="deepseek"/><strong>DeepSeek</strong><span>{state.connected?state.providerStatus:'Not connected'}</span><span className="supplier-chevron">⌄</span></summary><div className="supplier-settings">
      <p>Connect an account with prepaid API credit. Turn off automatic recharge and paid overage in your provider’s billing settings.</p>
      <label>API key<input aria-label="DeepSeek API key" type="password" autoComplete="off" value={key} onChange={event=>setKey(event.target.value)} placeholder={state.connected?'Enter a replacement key':'Paste your DeepSeek API key'}/></label>
      <div className="actions"><button className="primary" disabled={!key.trim()||busy} onClick={()=>void save()}>{busy?'Connecting…':'Save connection'}</button>{state.connected&&<button onClick={()=>void call('checkAccount')}>Check connection</button>}<button onClick={()=>void call('link',{kind:'keys'})}>Get API key ↗</button><button onClick={()=>void call('link',{kind:'billing'})}>Billing settings ↗</button></div>
      <p className="hint">Saved in Windows Credential Manager. Setup makes a free account check.</p>{state.connected&&<><p>Model: DeepSeek · Credit remaining: {state.balance||'unavailable'}</p></>}
    </div></details>}
    {shown.includes('openai')&&<details className="supplier-pill" ref={element=>{panels.current.openai=element;}}><summary><SupplierDot connected={state.codex?.connected} status={state.codex?.status}/><VendorIcon id="openai"/><strong>OpenAI</strong><span>{state.codex?.status||'Not connected'}</span><span className="supplier-chevron">⌄</span></summary><div className="supplier-settings">
      <p>Use your ChatGPT subscription. Keep paid extra usage turned off in your account’s billing settings.</p>
      <div className="actions"><button className="primary" disabled={codexBusy} onClick={()=>void call('codexLogin')}>{state.codex?.connected?'Switch account':'Sign in with ChatGPT'}</button>{state.codex?.connected&&<><button disabled={codexBusy} onClick={()=>void call('codexCheck')}>Check connection</button><button disabled={codexBusy} onClick={()=>void call('codexDisconnect')}>Sign out</button></>}</div>
      {state.codex?.login&&<div className="device-signin"><p>Open the sign-in page and enter this code:</p><code>{state.codex.login.code}</code><div className="actions"><button className="primary" onClick={()=>void call('codexOpen')}>Open sign-in page ↗</button><button onClick={()=>void call('codexCancel')}>Cancel sign-in</button></div><p className="hint">If OpenAI asks you to enable device-code sign-in, enable it in ChatGPT Security Settings, then cancel here and start sign-in again.</p></div>}
      {state.codex?.connected&&<><p>{state.codex.plan?state.codex.plan+' plan':'ChatGPT subscription'} · Usage windows {state.codex.windows?.length?'':'unavailable'}</p>{state.codex.windows?.map(window=><p key={window.label}>{window.label}: {window.usedPercent==null?'unavailable':window.usedPercent+'% used'}{window.resetAt?' · Resets '+new Date(window.resetAt).toLocaleString():''}</p>)}
</>}
      <p className="hint">Sign-in is saved encrypted in this app. Sign out removes it from Tris and keeps your chats. To switch accounts, choose the other account on the sign-in page; use a private browser window if it keeps choosing the previous account.</p>
    </div></details>}
    {shown.includes('anthropic')&&<details className="supplier-pill" ref={element=>{panels.current.anthropic=element;}}><summary><SupplierDot connected={state.claude?.connected} status={state.claude?.status}/><VendorIcon id="anthropic"/><strong>Anthropic</strong><span>{state.claude?.status||'Not checked'}</span><span className="supplier-chevron">⌄</span></summary><div className="supplier-settings"><p>Uses your installed Claude Code and its subscription sign-in.</p><div className="actions"><ClaudeSignIn state={state} call={call}/><button onClick={()=>void call('claudeCheck')}>Check Claude Code usage</button></div><p>Account usage is available from the context indicator.</p></div></details>}
    {shown.includes('typesafe')&&<details className="supplier-pill" ref={element=>{panels.current.typesafe=element;}}><summary><SupplierDot connected={state.jev?.connected} status={state.jev?.status}/><VendorIcon id="typesafe"/><strong>TypeSafe · Jev</strong><span>{state.jev?.status||'Not connected'}</span><span className="supplier-chevron">⌄</span></summary><div className="supplier-settings">
      <p>Jev chooses the answering model. Your summary model prepares a short description of the task; Jev receives that summary, model choices and account availability.</p>
      <label>API key<input aria-label="Jev API key" type="password" autoComplete="off" value={jevKey} onChange={event=>setJevKey(event.target.value)}/></label>
      <div className="connection-field"><span>Summary model</span><ChoiceMenu label="Routing summary model" value={summaryModel} options={Object.fromEntries((state.availableModels||[]).map(model=>[model,modelLabel(model,state.claude?.models)]))} onChange={setSummaryModel}/></div>
      <label>Ask below confidence<input aria-label="Jev confidence threshold" type="number" min="0" max="1" step="0.05" value={confidence} onChange={event=>setConfidence(Number(event.target.value))}/></label>
      <label>Decision timeout (ms)<input aria-label="Jev timeout" type="number" min="100" max="10000" step="100" value={timeoutMs} onChange={event=>setTimeoutMs(Number(event.target.value))}/></label>
      <div className="actions"><button className="primary" disabled={(!jevKey.trim()&&!state.jev?.connected)||busy} onClick={()=>{setBusy(true);void call('jevSave',{key:jevKey,summaryModel,confidence,timeoutMs}).then(()=>setJevKey('')).catch(()=>{}).finally(()=>setBusy(false));}}>{state.jev?.connected?'Save Jev settings':'Save Jev connection'}</button>{state.jev?.connected&&<><button onClick={()=>void call('jevCheck')}>Check Jev connection</button><button onClick={()=>void call('jevRetry')}>Try Jev on next message</button><button onClick={()=>void call('jevDisconnect')}>Disconnect Jev</button></>}<button onClick={()=>void call('link',{kind:'jev'})}>Get Jev key ↗</button></div>
      <p className="hint">Saved in Windows Credential Manager. Connecting only lists available models. Summaries and routing use your account allowances when you send a message. Turn off automatic recharge and paid overage at the provider. The 500 ms starting timeout and confidence setting need calibration with your account.</p>
    </div></details>}
    {Object.entries(apiSuppliers).filter(([id])=>shown.includes(id)||!only&&state.apiProviders?.some(row=>row.provider===id&&row.connected)).map(([id,info])=><details className="supplier-pill" key={id} ref={element=>{panels.current[id]=element;}}><summary><SupplierDot connected={state.apiProviders?.find(row=>row.provider===id)?.connected} status={state.apiProviders?.find(row=>row.provider===id)?.status}/><VendorIcon id={id}/><strong>{info.name}</strong><span>{state.apiProviders?.find(row=>row.provider===id)?.status||'Not connected'}</span><span className="supplier-chevron">⌄</span></summary><ApiConnectionSettings provider={id} connection={state.apiProviders?.find(row=>row.provider===id)} call={call}/></details>)}
    {!setup&&<><DecisionSettings state={state} call={call} open={isPicker(open)?open:undefined}/><McpSettings state={state} call={call}/></>}
  </section>;
}
function App(){
  const usageId=useId(),[layoutReady,setLayoutReady]=useState(false),[customLayout,setCustomLayout]=useState<LayoutNode|null>(null);
  const workspaceComment=useRef({dirty:false,owner:''});
  const [agents,setAgents]=useState<string[]>([]);
  const [extraChats,setExtraChats]=useState<string[]>([]),[splitId,setSplitId]=useState(''),[splitDirection,setSplitDirection]=useState<'row'|'column'>('row'),[splitSize,setSplitSize]=useState(50),[focusedChat,setFocusedChat]=useState(''),[workspaceOwner,setWorkspaceOwner]=useState('');
  const [fileRequest,setFileRequest]=useState<FileRequest|null>(null),[detachedViews,setDetachedViews]=useState<WorkspaceView[]>([]);
  useEffect(()=>api.onOpenFile(request=>{if(workspaceComment.current.dirty&&request.chatId!==workspaceComment.current.owner){setError('Save or cancel the line comment before switching chats.');return;}setFileRequest(request);setWorkspaceOwner(request.chatId||'');setWorkspaceView('files');setWorkspace(true);setSettings(false);}),[]);
  const [workspace,setWorkspace]=useState(false),[workspaceView,setWorkspaceView]=useState<WorkspaceView>('files'),[terminalRequest,setTerminalRequest]=useState(0);
  const [appId,setAppId]=useState<string|null>(null),[appPage,setAppPage]=useState(false),[appRename,setAppRename]=useState(0),[appOpened,setAppOpened]=useState(0);
  const [state,setState]=useState(empty),[chatId,setChat]=useState(''),[draft,setDraft]=useState(''),[settings,setSettings]=useState<false|'general'|'models'|'chat-models'|'connections'|'plugins'|'skills'|'always-on'|'claude-code'|'security'|'publishing'|'browser'|'remote'|'routines'|'voice'|'images'>(false),[openSupplier,setOpenSupplier]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[details,setDetails]=useState(false);
  const editorRevision=useRef(0),selectionRequest=useRef(0),selectChat=useRef<(id:string)=>void>(()=>{}),[selecting,setSelecting]=useState(false);
  const viewMode=useChatView(chatId);
  const [artFont,setArtFont]=useState(()=>{const saved=localStorage.getItem('welcome-font');return saved&&artFontNames.includes(saved)?saved:defaultArtFont;});
  const [attaching,setAttaching]=useState(false);
  const [theme,setTheme]=useState(localStorage.getItem('theme')||'dark'),[textSize,setTextSize]=useState(savedTextSize),[font,setFont]=useState(savedFont),[installedFonts,setInstalledFonts]=useState<string[]>();
  const scroller=useRef<HTMLDivElement>(null),composer=useRef<HTMLTextAreaElement>(null);
  const offeredSetup=useRef(false),[modelsPending,setModelsPending]=useState(false);
  const popped=!!state.chatWindows?.includes(chatId),inSplit=splitId===chatId||extraChats.includes(chatId),otherEditor=popped||inSplit;
  const chat=state.chats.find(c=>c.id===chatId),project=state.projects.find(p=>p.id===chat?.projectId);
  useEffect(()=>{if(chat?.draftRevision){editorRevision.current++;setDraft(chat.draft);}},[chat?.draftRevision]);
  const picks=chat?.selectedModels||(chat?.selected?['deepseek-flash']:[]);
  const pool=chat?.pool||['deepseek-flash'];
  const connected=state.connected||Boolean(state.codex?.connected)||Boolean(state.claude?.connected)||Boolean(state.apiProviders?.some(row=>row.connected));
  const connectionStatus=state.availableModels?.length?'Connected':connected?'Check connections':'Not connected';
  const needsModel=connected&&!(state.decisionEngine?.connected??state.jev?.connected)&&!picks.length&&!state.turns.some(t=>t.status==='completed'&&!t.command)&&!state.commands?.some(command=>command.kind==='Plugin command'&&command.name===draft.trimStart().split(/\s/,1)[0]);
  const turns=state.turns.filter(t=>t.chatId===chatId);
  const chatTurns=state.turns.filter(t=>t.chatId===chatId||turns.some(parent=>parent.jobs?.includes(t.id)));
  const working=turns.some(t=>['running','waiting','dispatching','stopping'].includes(t.status));
  async function call(method:string,args?:any){if(method==='openJob'&&state.turns.some(turn=>turn.id===args?.id&&turn.automatic?.kind==='agent')&&!state.agentWindows?.includes(args.id)){openAgent(args.id);return;}if(method==='openJob'&&args?.id&&!state.turns.some(turn=>turn.id===args.id&&turn.automatic?.kind==='agent')&&!state.jobWindows?.includes(state.turns.find(turn=>turn.id===args.id)?.chatId||'')){dockJob(args.id);return;}try{setError('');return await api.invoke(method,args);}catch(e){setError(errorText(e));throw e;}}
  async function openWorkspace(view:WorkspaceView,owner=chatId){if(workspaceComment.current.dirty&&owner!==workspaceComment.current.owner){setError('Save or cancel the line comment before switching chats.');return;}if(state.workspaceWindows?.includes(view)){await call('workspaceWindowOpen',{view,chatId:owner});return;}setWorkspaceOwner(owner);setWorkspaceView(view);setWorkspace(true);revealPane(detachedViews.includes(view)?'workspace:'+view:'workspace');if(view==='terminal'&&owner&&state.defaultFolder){try{const rows=await call('terminalList',{chatId:owner});if(!rows.length)await call('terminalOpen',{chatId:owner});setTerminalRequest(value=>value+1);}catch{}}}
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(!event.defaultPrevented&&!document.querySelector('dialog[open]')&&event.ctrlKey&&!event.altKey&&!event.metaKey&&['Backquote','KeyO','Semicolon'].includes(event.code)&&!settings){event.preventDefault();if(event.code==='KeyO')cycleChatView(focusedChat||chatId);else if(event.code==='Semicolon')void openSideChat(focusedChat||chatId);else void openWorkspace('terminal',focusedChat||chatId);}};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[chatId,focusedChat,state.defaultFolder,settings]);
  async function refreshUsage(){await Promise.allSettled([...(state.apiProviders||[]).filter(row=>row.connected).map(row=>call('apiCheck',{provider:row.provider})),...(state.connected?[call('checkAccount')]:[]),...(state.codex?.connected?[call('codexCheck')]:[]),...(state.claude?.connected?[call('claudeCheck')]:[])]);}
  useEffect(()=>{let initial=true;const receive=(next:Snapshot)=>{if(initial){initial=false;const saved=readChatLayout(next.chatLayout?JSON.stringify(next.chatLayout):localStorage.getItem('chat-layout')||JSON.stringify({direction:localStorage.getItem('split-direction')}));setChat(saved.chatId);setSplitId(saved.splitId);setSplitDirection(saved.direction);setSplitSize(saved.size);setDraft(next.chats.find(c=>c.id===saved.chatId)?.draft||'');const restored=readTree(next.paneLayout,id=>{const pane=paneKind(id);return pane?.kind==='main'||pane?.kind==='workspace'||pane?.kind==='workspaceView'||pane?.kind==='chat'&&next.chats.some(c=>c.id===pane.id)&&!next.chatWindows?.includes(pane.id)||pane?.kind==='job'&&!!next.jobChats?.some(c=>c.id===pane.id)&&!next.jobWindows?.includes(pane.id)||pane?.kind==='agent'&&next.turns.some(turn=>turn.id===pane.id&&turn.automatic?.kind==='agent')&&!next.agentWindows?.includes(pane.id);});setCustomLayout(restored);if(restored){setAgents(allPaneIds(restored).filter(id=>paneKind(id)?.kind==='agent').map(id=>id.slice(6)));setExtraChats(allPaneIds(restored).flatMap(id=>{const pane=paneKind(id);return pane?.kind==='chat'&&pane.id!==saved.splitId?[pane.id]:[];}));setDetachedViews(allPaneIds(restored).flatMap(id=>{const pane=paneKind(id);return pane?.kind==='workspaceView'?[pane.view]:[];}));setDocked(allPaneIds(restored).filter(id=>paneKind(id)?.kind==='job').map(id=>id.slice(4)));const workspace=readPaneWorkspace(next.paneWorkspace);setWorkspace(workspace.visible);setWorkspaceView(workspace.view);setWorkspaceOwner(next.chats.some(chat=>chat.id===workspace.owner)?workspace.owner:saved.chatId);}}setState(next);setLayoutReady(true);};api.invoke('state').then(receive);return api.subscribe(receive,updates=>setState(state=>applyTurnStream(state,updates)));},[]);
  useEffect(()=>{if(layoutReady)void api.invoke('chatLayout',{chatId,splitId,direction:splitDirection,size:splitSize}).catch(()=>{});},[layoutReady,chatId,splitId,splitDirection,splitSize]);
  useEffect(()=>api.onOpenConnections(()=>setSettings('connections')),[]);
  useEffect(()=>api.onSelectChat(id=>{setSettings(false);selectChat.current(id);}),[]);
  useEffect(()=>{if(state.backend==='ready'&&!offeredSetup.current&&!state.wizard?.pending){offeredSetup.current=true;if(!connected&&!state.wizard?.show)setSettings('connections');}},[state.backend,connected,state.wizard?.show,state.wizard?.pending]);
  useEffect(()=>{
    if(!settings)return;
    const dialog=document.querySelector<HTMLElement>('.settings[role=dialog]');
    const elements=()=>Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select,textarea,summary')||[]).filter(element=>element.getClientRects().length>0);
    elements()[0]?.focus();
    const keydown=(e:KeyboardEvent)=>{if(e.key==='Escape'){setSettings(false);e.preventDefault();}if(e.key==='Tab'){const list=elements(),first=list[0],last=list.at(-1);if(e.shiftKey&&document.activeElement===first){last?.focus();e.preventDefault();}else if(!e.shiftKey&&document.activeElement===last){first?.focus();e.preventDefault();}}};
    document.addEventListener('keydown',keydown);return ()=>{document.removeEventListener('keydown',keydown);composer.current?.focus();};
  },[settings]);
  useEffect(()=>{document.documentElement.dataset.theme=theme;localStorage.setItem('theme',theme);const style=getComputedStyle(document.documentElement);window.desktop.titleBar?.(style.getPropertyValue('--side').trim(),style.getPropertyValue('--text').trim());},[theme]);
  useEffect(()=>{window.desktop.textSize(textSize);localStorage.setItem('text-size',String(textSize));},[textSize]);
  useEffect(()=>{localStorage.setItem('ui-font',font);document.documentElement.style.setProperty('--ui-font',JSON.stringify(font));},[font]);
  useEffect(()=>{if(settings&&!installedFonts)void call('fontFamilies').then(setInstalledFonts).catch(()=>setInstalledFonts([]));},[settings]);
  useEffect(()=>{if(!layoutReady||selecting)return;if(!state.chats.some(c=>c.id===chatId)){editorRevision.current++;const last=state.chats.filter(c=>!c.archived&&!c.sideSourceId).at(-1);setDraft(last?.draft||'');setChat(last?.id||'');}},[state.chats,chatId,layoutReady,selecting]);
  const follow=useFollowOutput(scroller,[state.turns,state.tools,chatId]);
  useMessageReference(chatId,turns,scroller,follow.onScroll);
  async function addProject(groupId?:string|null){const revision=editorRevision.current;setAppPage(false);const id=await call('addProject',{groupId});if(id&&revision===editorRevision.current)selectChat.current(id);}
  useEffect(()=>{if(layoutReady&&!otherEditor){editorRevision.current++;setDraft(state.chats.find(c=>c.id===chatId)?.draft||'');}},[otherEditor,layoutReady]);
  const sending=useRef(false);
  useEffect(()=>{if(modelsPending&&state.availableModels?.length){setModelsPending(false);setError('');void submit();}},[modelsPending,state.availableModels?.length]);
  async function submit(explicit?:boolean,queue=true){if(sending.current||otherEditor||!chat||(!draft.trim()&&!chat.attachments?.length)||busy)return;if(!(state.availableModels||[]).length){if(connected){setModelsPending(true);setError('Models are still loading. Your message sends when they are ready.');}else void call('wizardOpen',{step:'suppliers'});return;}const text=draft,revision=editorRevision.current;sending.current=true;setBusy(true);try{await call(working&&!queue?'correctGroup':'submit',{id:crypto.randomUUID(),chatId,text,...(explicit===undefined?{}:{selected:explicit})});if(revision===editorRevision.current)setDraft('');}catch{}finally{sending.current=false;setBusy(false);}}
  async function attach(files:File[]){
    if(otherEditor)return;if(!chat){setError('Start a chat before attaching files.');return;}if(busy){setError('Wait for the current files to finish preparing.');return;}const owner=chat.id;setBusy(true);setAttaching(true);
    try{for(const file of files){if(file.size>25*1024*1024)throw Error('Choose files up to 25 MB.');await call('attachmentAdd',{chatId:owner,name:file.name,bytes:new Uint8Array(await file.arrayBuffer())});}}catch(error){setError(errorText(error));}finally{setBusy(false);setAttaching(false);}
  }
  function choose(id:string){
    if(workspaceComment.current.dirty&&id!==workspaceComment.current.owner){setError('Save or cancel the line comment before switching chats.');return;}
    const revision=++editorRevision.current,request=++selectionRequest.current;setSelecting(true);
    revealPane('main');setChat(id);setDraft(state.chats.find(c=>c.id===id)?.draft||'');setWorkspaceOwner(id);setAppPage(false);follow.toBottom();
    // Refresh drafts edited in other views, without replacing newer typing or a later selection.
    void api.invoke('state').then(next=>{if(revision!==editorRevision.current)return;setState(next);setDraft(next.chats.find((c:Chat)=>c.id===id)?.draft||'');}).catch(error=>{if(revision===editorRevision.current)setError(errorText(error));}).finally(()=>{if(request===selectionRequest.current)setSelecting(false);});
  }
  selectChat.current=choose;
  async function openSideChat(owner=chatId){if(!owner)return;try{const id=await call('sideChatOpen',{chatId:owner});await openSplit(id);}catch{}}
  async function openSplit(id:string){if(extraChats.includes(id)){revealPane('chat:'+id);return;}if(state.chatWindows?.includes(id)){setError('Return this chat from its window before opening split view.');return;}const next=await api.invoke('state');setState(next);setSettings(false);setAppPage(false);setSplitId(id);}
  async function closeSplit(){const next=await api.invoke('state');setState(next);setSplitId('');}
  useEffect(()=>{localStorage.setItem('split-direction',splitDirection);},[splitDirection]);
  useEffect(()=>{if(layoutReady&&splitId&&(!state.chats.some(c=>c.id===splitId)||state.chatWindows?.includes(splitId)))setSplitId('');},[splitId,state.chats,state.chatWindows,layoutReady]);
  async function openPane(id:string){try{
    const next=await api.invoke('state');if(next.chatWindows?.includes(id))throw Error('Return this chat from its window before opening a pane.');setState(next);setSettings(false);setAppPage(false);
    if(id===splitId||extraChats.includes(id)){revealPane('chat:'+id);return;}
    const anchor=findGroupOfPane(paneLayout,'main');if(!anchor)return;setExtraChats(previous=>[...previous,id]);arrange(insertAtGroup(paneLayout,anchor.id,'chat:'+id,'right')||paneLayout);
  }catch(error){setError(errorText(error));}}
  function openAgent(id:string){if(agents.includes(id)){revealPane('agent:'+id);return;}const anchor=findGroupOfPane(paneLayout,'main');if(anchor){setAgents(previous=>[...previous,id]);arrange(insertAtGroup(paneLayout,anchor.id,'agent:'+id,'right')||paneLayout);}}
  useEffect(()=>{if(layoutReady)setAgents(previous=>{const next=previous.filter(id=>state.turns.some(turn=>turn.id===id)&&!state.agentWindows?.includes(id));return next.length===previous.length?previous:next;});},[layoutReady,state.turns,state.agentWindows]);
  async function closePane(id:string){const next=await api.invoke('state');setState(next);setExtraChats(previous=>previous.filter(item=>item!==id));}
  useEffect(()=>{if(layoutReady)setExtraChats(previous=>{const next=previous.filter(id=>state.chats.some(chat=>chat.id===id)&&!state.chatWindows?.includes(id));return next.length===previous.length?previous:next;});},[layoutReady,state.chats,state.chatWindows]);
  useEffect(()=>{const id=focusedChat||chatId;if(id)void api.invoke('voiceFocus',{chatId:id}).catch(()=>{});},[focusedChat,chatId]);
  useEffect(()=>{if(focusedChat!==chatId&&focusedChat!==splitId&&!extraChats.includes(focusedChat))setFocusedChat(chatId);},[focusedChat,chatId,splitId,extraChats]);
  // Models working at once dock as side-by-side panes in Thinking view; each stays until closed.
  const [docked,setDocked]=useState<string[]>([]),closedJobs=useRef(new Set<string>());
  const latestGroup=[...turns].reverse().find(t=>t.jobs?.length);
  const jobChatsOf=(group:Turn)=>[...new Set(group.jobs!.map(id=>state.turns.find(t=>t.id===id)?.chatId).filter((id):id is string=>!!id))];
  useEffect(()=>{if(!latestGroup||!activeStates.has(latestGroup.status))return;const fresh=jobChatsOf(latestGroup).filter(id=>!closedJobs.current.has(id)&&!docked.includes(id)&&!state.jobWindows?.includes(id));if(!fresh.length)return;for(const id of fresh)setChatView(id,'thinking');setDocked(previous=>[...new Set([...previous,...fresh])]);},[latestGroup?.id,latestGroup?.status,state.turns.length]);
  useEffect(()=>{if(state.jobWindows?.length)setDocked(previous=>previous.filter(id=>!state.jobWindows!.includes(id)));},[state.jobWindows?.join('|')]);
  const dockedHere=docked.filter(id=>(state.jobChats||[]).some(c=>c.id===id&&c.parentChatId===chatId)&&!state.jobWindows?.includes(id));
  function dockJob(turnId:string){const id=state.turns.find(t=>t.id===turnId)?.chatId;if(!id)return;closedJobs.current.delete(id);if(!docked.includes(id)){setChatView(id,'thinking');setDocked(previous=>[...previous,id]);}}
  function undockJob(id:string){closedJobs.current.add(id);setDocked(previous=>previous.filter(item=>item!==id));}
  const defaultTree=windowTree(splitId,splitDirection,splitSize,dockedHere,detachedViews,extraChats,agents),paneLayout=customLayout?reconcileTree(customLayout,defaultTree):defaultTree;
  function arrange(tree:LayoutNode){setCustomLayout(tree);void api.invoke('paneLayout',{tree,workspace:{visible:workspace,view:workspaceView,owner:workspaceOwner||chatId}}).catch(error=>setError(errorText(error)));}
  function revealPane(id:string){if(!customLayout)return;const group=findGroupOfPane(customLayout,id);if(group&&group.active!==id)arrange(setActivePane(customLayout,group.id,id));}
  useEffect(()=>{if(layoutReady&&customLayout&&paneLayout!==customLayout)arrange(paneLayout);},[layoutReady,customLayout,splitId,dockedHere.join('|'),detachedViews.join('|'),extraChats.join('|'),agents.join('|')]);
  useEffect(()=>{if(layoutReady&&customLayout)void api.invoke('paneLayout',{tree:paneLayout,workspace:{visible:workspace,view:workspaceView,owner:workspaceOwner||chatId}}).catch(error=>setError(errorText(error)));},[workspace,workspaceView,workspaceOwner]);
  function paneTitle(id:string){const pane=paneKind(id);return pane?.kind==='main'?'Main chat':pane?.kind==='workspace'?'Workspace':pane?.kind==='workspaceView'?workspaceTitle(pane.view):pane?.kind==='chat'?'Chat · '+(state.chats.find(c=>c.id===pane.id)?.title||'Chat'):pane?.kind==='agent'?'Agent · '+(state.turns.find(turn=>turn.id===pane.id)?.automatic?.description||'Agent'):pane?.kind==='job'?'Model · '+modelLabel(state.turns.filter(t=>t.chatId===pane.id).at(-1)?.model||''):id;}
  async function popPane(id:string){try{const pane=paneKind(id);if(pane?.kind==='main'&&chatId)await call('openChatWindow',{chatId});else if(pane?.kind==='chat')await call('openChatWindow',{chatId:pane.id});else if(pane?.kind==='agent'){await api.invoke('openJob',{id:pane.id});setAgents(previous=>previous.filter(id=>id!==pane.id));}else if(pane?.kind==='job'){const turn=state.turns.filter(t=>t.chatId===pane.id).at(-1);if(turn){await api.invoke('openJob',{id:turn.id});undockJob(pane.id);}}}catch(error){setError(errorText(error));}}
  function detachView(view:WorkspaceView,detached:boolean){
    const next=detached?[...new Set([...detachedViews,view])]:detachedViews.filter(item=>item!==view);setDetachedViews(next);
    if(detached){const other=detachedViews[0],anchor=findGroupOfPane(paneLayout,other?'workspace:'+other:'main');if(anchor)arrange(insertAtGroup(paneLayout,anchor.id,'workspace:'+view,other?'center':'right')||paneLayout);}
    else{setWorkspace(true);setWorkspaceView(view);arrange(reconcileTree(paneLayout,windowTree(splitId,splitDirection,splitSize,dockedHere,next,extraChats,agents)));}
  }
  const share=useShare(state,call,chatId),worktree=useWorktree(call,choose);
  // The Hairline pick, once installed, turns the chat title into a /hairline-create draft.
  const artwork=state.commands?.find(command=>command.name.endsWith(':hairline-create'));
  return <div className="app-frame"><header className="app-titlebar" aria-label="Window title bar"><button className="app-menu-trigger" aria-label="Ghidorah menu" aria-haspopup="menu" title="Ghidorah · Restart or quit" onClick={()=>void call('appMenu')}><img className="app-mark" src={appIcon} alt="" aria-hidden="true" draggable={false}/><strong>Ghidorah</strong>{state.updates?.dev&&<span className="dev-tag">DEV</span>}<span className="app-menu-chevron" aria-hidden="true">⌄</span></button><UpdateChip state={state} call={call}/></header><div className={'shell '+(workspace?'workspace-open':'')}>{state.wizard?.show&&<Wizard state={state} call={call} appError={error} suppliers={<Connections state={state} call={call} setup/>} jev={<Connections state={state} call={call} setup only="typesafe"/>} openSettings={page=>setSettings(page as any)}/>}{share.element}{worktree.element}{state.updates?.show&&<UpdateWindow state={state} call={call} close={()=>void call('updateClose')}/>}
    <SidebarPanel worktree={()=>void worktree.start()} worktreeKept={worktree.kept} appFilter={appId} selectApp={(id,rename)=>{setAppId(id);setAppPage(!!id);setAppRename(value=>rename?value+1:0);setSettings(false);if(id)setAppOpened(value=>value+1);}} glow={appPage&&appId?(chat=>chat&&{chatId:chat.id,key:appOpened})(latestChat(state.savedApps?.find(a=>a.id===appId)?.chatIds||[],state.chats,state.turns)):null} state={state} selected={chatId} choose={choose} call={call} create={addProject} split={openSplit} pane={id=>void openPane(id)} terminal={id=>void openWorkspace('terminal',id)} settings={page=>{setSettings(page||false);if(!page){setAppPage(false);setAppId(null);}}}/>

    <PaneShell layout={paneLayout} change={arrange} arranged={!!customLayout} title={paneTitle} popOut={id=>void popPane(id)} hidden={[...(workspace?[]:['workspace']),...(state.workspaceWindows||[]).map(view=>'workspace:'+view)]} chatSplit={{size:splitSize,direction:splitDirection,setSize:setSplitSize}} panes={{
      main:<ChatViewContext.Provider value={viewMode}><section data-view-mode={viewMode} className="primary-chat-pane" aria-label="Main chat" onFocusCapture={()=>setFocusedChat(chatId)}>
    {appPage&&state.savedApps?.some(a=>a.id===appId)?<AppOverview app={state.savedApps.find(a=>a.id===appId)!} state={state} key={appId} renameRequest={appRename} choose={choose} notice={setError} call={api.invoke}/>:<main onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect=busy?'none':'copy';}}} onDrop={event=>{if(event.dataTransfer.files.length){event.preventDefault();void attach(Array.from(event.dataTransfer.files));}}}>
      <header className="titlebar"><span className="code-icon">⌘</span><span className="chat-title">{chat?.title||'New chat'}</span><ChatActions chatId={chatId||undefined} shortcuts open={view=>void openWorkspace(view)} artwork={artwork&&chat?{label:"Make artwork for this chat's topic",title:'Draw a Hairline figure for “'+chat.title+'”',disabled:otherEditor||!!chat.archived,run:()=>{const text=artwork.name+' '+chat.title+(draft.trim()?'\n\n'+draft:'');editorRevision.current++;setDraft(text);setState(previous=>({...previous,chats:previous.chats.map(c=>c.id===chatId?{...c,draft:text}:c)}));void api.invoke('draft',{chatId,text});composer.current?.focus();}}:undefined}/><BackendStatus state={state} connection={connectionStatus}/></header>
      {chat?.archived&&<div className="workspace-notice">Archived chat <button onClick={()=>void call('sidebarChat',{action:'archive',chatId,archived:false})}>Restore</button></div>}
      <SideChatNotice chat={chat} call={call}/>
      <GoalPanel key={chatId} chatId={chatId} goal={state.goals?.find(goal=>goal.id===chatId)} busy={working} call={call}/>
      <div className="transcript" ref={scroller} onScroll={follow.onScroll}>
        {!turns.length?<div className="empty"><WelcomeArt font={artFont}/>{!project?<button className="primary" onClick={()=>void addProject()}>New project</button>:!connected?<button className="primary" onClick={()=>void call('wizardOpen',{step:'suppliers'})}>Connect a supplier</button>:null}</div>:<div className="messages">{turns.filter(t=>!isJoinedTurn(t,turns)).map(t=><article className="turn" key={t.id} data-turn-id={t.id} tabIndex={-1} data-status={t.status} onContextMenu={share.open(t)}>
          <HandoffOrigin turn={t}/><div className={t.automatic||t.goal?.automatic?"hint":"user-message"}>{t.automatic?(t.automatic.kind==='agent'?'Agent · '+t.automatic.description:t.automatic.source==='self'?'Claude woke itself up':t.automatic.source==='other-session'?'Message from another Claude session':'Background update'):t.goal?.automatic?(t.prompt.startsWith('[Starting')?'Goal started':'Continuing goal'):<Markdown message text={t.prompt} turnId={t.id}/>}{t.attachments?.length?<div className="attachments sent-attachments">{t.attachments.map(item=>item.kind==='image'?<AttachmentImage key={item.id} item={item} chatId={t.chatId}/>:<ChatFilesButton className="attachment" key={item.id} chatId={t.chatId} id={'upload:'+item.id}><span>{item.kind==='pdf'?'PDF':'▤'}</span><span>{item.name}</span>{item.pages&&<small>{item.pages} pages</small>}</ChatFilesButton>)}</div>:null}{t.paused&&t.status==='queued'&&<span className="queued-paused">Paused after restart <button onClick={()=>void call('sendPaused',{id:t.id}).catch(()=>{})}>Send</button></span>}{(t.status==='queued'||t.status==='running'&&t.delivery==='sent')&&!t.parentTurnId&&!t.automatic&&<button className="queued-cancel" aria-label="Cancel queued message" title="Cancel queued message" onClick={()=>void call('cancelQueued',{id:t.id}).catch(()=>{})}>×</button>}</div>
          <TurnResponse state={state} t={t} call={call} pool={pool} chatId={chatId} addModel={()=>setSettings('chat-models')}/>{share.actions(t)}
        </article>)}</div>}
      </div>
      <div className="bottom-area">
        <WorkReview state={state} call={call}/>
        {error&&<div className="error" role="alert">{error}<button aria-label="Dismiss error" onClick={()=>setError('')}>×</button></div>}
        <BackendNotice state={state} call={call}/>
        {chat?.engineNotice&&<div className="backend-notice" role="status"><span>{chat.engineNotice}</span></div>}
        {needsModel&&draft.trim()&&<div className="model-prompt"><span>Choose a model for this message.</span>{state.connected&&<button className="primary" disabled={busy} onClick={()=>void submit(true)}>Send with DeepSeek</button>}</div>}
        {inSplit&&<div className="hint">This chat is open in another pane. <button onClick={()=>void (extraChats.includes(chatId)?closePane(chatId):closeSplit())}>Continue here</button></div>}
        {popped&&<div className="hint">This chat is open in another window. <button onClick={()=>void call('openMainChat',{chatId})}>Continue here</button></div>}
        <Composer sendError={chatEngineError(state,chat)} voice={()=>void call('voiceOpen',{chatId})} dictationOwner={otherEditor?'':chatId||''} dictate={(bytes,mime,signal)=>transcribeForChat(call,chatId!,bytes,mime,signal)} attaching={attaching} attachments={chat?.attachments} attach={files=>void attach(files)} remove={id=>void call('attachmentRemove',{chatId,id})} key={chatId} inputRef={composer} draft={draft} commands={state.commands} disabled={!layoutReady||!chat||otherEditor} busy={busy} working={working} change={text=>{editorRevision.current++;setDraft(text);setState(previous=>({...previous,chats:previous.chats.map(c=>c.id===chatId?{...c,draft:text}:c)}));if(chatId)void api.invoke('draft',{chatId,text});}} submit={()=>void submit()} stop={()=>void call('stop',{chatId})} plugins={()=>setSettings('plugins')}/>
        <CorrectionOption show={!otherEditor&&working&&(!!draft.trim()||!!chat?.attachments?.length)} disabled={busy||!!chatEngineError(state,chat)} send={()=>void submit(undefined,false)}/>
        <ChatDock state={state} chat={chat} chatId={chatId} turns={chatTurns} call={call} usageId={usageId} details={details} setDetails={setDetails} refreshUsage={refreshUsage} openConnections={()=>setSettings('connections')} openChatModels={()=>setSettings('chat-models')} openSideChat={()=>void openSideChat()}/>
      </div>
    </main>}
    </section></ChatViewContext.Provider>,
      ...(splitId?{['chat:'+splitId]:<section className="secondary-chat-pane" aria-label="Split chat" onFocusCapture={()=>setFocusedChat(splitId)}><div className="split-controls">{!customLayout&&<><button aria-label="Split chats side by side" aria-pressed={splitDirection==='row'} onClick={()=>setSplitDirection('row')}>Side by side</button><button aria-label="Stack split chats" aria-pressed={splitDirection==='column'} onClick={()=>setSplitDirection('column')}>Stacked</button></>}<button aria-label="Pop out split chat" onClick={()=>void call('openChatWindow',{chatId:splitId}).then(()=>setSplitId(''))}>New window</button></div><SideJob key={splitId} chatId={splitId} ordinary embedded={{close:()=>void closeSplit(),select:()=>{const id=splitId;setSplitId('');choose(id);},workspace:view=>void openWorkspace(view,splitId),plugins:()=>setSettings('plugins'),sideChat:()=>void openSideChat(splitId)}}/></section>}:{}),
      ...Object.fromEntries(extraChats.map(id=>['chat:'+id,<section className="secondary-chat-pane" aria-label={'Chat pane: '+(state.chats.find(chat=>chat.id===id)?.title||'Chat')} onFocusCapture={()=>setFocusedChat(id)}><SideJob key={id} chatId={id} ordinary embedded={{close:()=>void closePane(id),select:()=>{void closePane(id).then(()=>choose(id));},workspace:view=>void openWorkspace(view,id),plugins:()=>setSettings('plugins'),sideChat:()=>void openSideChat(id)}}/></section>])),
      ...Object.fromEntries(dockedHere.map(id=>['job:'+id,<div className="job-dock-pane" key={id}><SideJob chatId={id} embedded={{close:()=>undockJob(id),select:()=>{},workspace:view=>void openWorkspace(view),plugins:()=>setSettings('plugins'),sideChat:()=>{}}}/></div>])),
      ...Object.fromEntries(agents.map(id=>['agent:'+id,<AgentPane key={id} id={id} close={()=>setAgents(previous=>previous.filter(item=>item!==id))}/>])),
      ...Object.fromEntries(detachedViews.map(view=>['workspace:'+view,null])),
      workspace:<WorkspacePanel onCommentDirty={dirty=>{workspaceComment.current={dirty,owner:workspaceOwner||chatId};}} openAgent={id=>void call('openJob',{id})} activity={chatActivity(state,workspaceOwner||chatId)} popped={state.workspaceWindows||[]} detached={detachedViews} detach={detachView} fileRequest={fileRequest} theme={theme} chatId={workspaceOwner||chatId} root={state.defaultFolder||null} visible={workspace} view={workspaceView} setView={setWorkspaceView} onHide={()=>setWorkspace(false)} call={(method,args)=>api.invoke(method,args)} terminalRequest={terminalRequest}/>,
    }}/>

    {settings&&<SettingsDialog page={settings} select={setSettings} close={()=>setSettings(false)}>{(settings==='models'||settings==='chat-models')?<ModelPool defaults={settings==='models'} state={state} chatId={chatId} call={call} connections={()=>setSettings('connections')}/>:settings==='connections'?<Connections state={state} call={call} open={openSupplier}/>:settings==='security'?<SecuritySettings state={state} call={call} openSupplier={id=>{if(id==='anthropic'){setSettings('claude-code');return;}setOpenSupplier(id);setSettings('connections');}}/>:settings==='always-on'?<AlwaysOnSettings state={state} call={call}/>:settings==='remote'?<RemoteSettings state={state} call={call}/>:settings==='routines'?<RoutinesSettings state={state} call={call}/>:settings==='images'?<ImageSettings call={call} connections={()=>setSettings('connections')}/>:settings==='voice'?<VoiceSettings state={state} call={call}/>:settings==='publishing'?<PublishingSettings state={state} call={call}/>:settings==='browser'?<BrowserSettings state={state} call={call}/>:settings==='claude-code'?<ClaudeCodeSettings state={state} call={call}/>:(settings==='plugins'||settings==='skills')?<PluginsSettings key={settings} changes={state.pluginChanges} call={(method,args)=>api.invoke(method,args)} skills={settings==='skills'}/>:<div className="general-settings"><SettingsCard title="Root working folder"><p>All chats work here. Models create files and subfolders when the task needs them.</p><div className="folder-setting"><span>{state.defaultFolder||'No folder selected'}</span><div className="actions"><button onClick={()=>void call('workingFolder',{})}>Choose folder</button>{state.defaultFolder&&<button onClick={()=>void call('workingFolder',{clear:true})}>Clear</button>}</div></div></SettingsCard><SettingsCard title="New chats"><label>Default permission mode<select aria-label="Default permission mode" value={state.defaultMode||'manual'} onChange={event=>void call('defaultPermissionMode',{mode:event.target.value}).catch(()=>{})}>{Object.entries(modes).map(([mode,label])=><option key={mode} value={mode}>{label}</option>)}</select></label><p>Applied to new chats. Each chat keeps its own permission mode.</p></SettingsCard><SettingsCard title="Appearance"><div className="settings-form-grid"><label>Theme<select aria-label="Theme" value={theme} onChange={e=>setTheme(e.target.value)}><option value="dark">Dark</option><option value="light">Light</option><option value="black">Black</option><option value="contrast">High contrast</option><option value="paper">Warm paper</option></select></label><label>Text size<select aria-label="Text size" value={textSize} onChange={e=>setTextSize(Number(e.target.value))}>{textSizes.map(size=><option key={size} value={size}>{Math.round(size*100)}%</option>)}</select></label><label>Font<select aria-label="Font" value={font} onChange={e=>setFont(e.target.value)}>{fontChoices(installedFonts,font).map(name=><option key={name} value={name} style={{fontFamily:JSON.stringify(name)}}>{name}</option>)}</select></label><label>Opening artwork font<select aria-label="Opening artwork font" value={artFont} onChange={event=>{setArtFont(event.target.value);localStorage.setItem('welcome-font',event.target.value);}}>{artFontNames.map(font=><option key={font}>{font}</option>)}</select></label></div></SettingsCard><ProjectSettings key={chatId} chatId={chatId} call={call}/><SettingsCard title="Setup and updates"><div className="settings-action-row"><span>Setup</span><button onClick={()=>{setSettings(false);void call('wizardOpen').catch(()=>{});}}>Open setup</button></div><div className="settings-action-row"><span>Updates</span><button onClick={()=>{setSettings(false);void call('updateOpen');}}>Open update</button></div></SettingsCard></div>}{error&&<p className="error" role="alert">{error}</p>}</SettingsDialog>}
  </div></div>;
}
const sideChat=new URLSearchParams(location.hash.slice(1)).get('job');
const chatWindow=new URLSearchParams(location.hash.slice(1)).get('chat');
const agentWindow=new URLSearchParams(location.hash.slice(1)).get('agent');
const workspaceWindow=new URLSearchParams(location.hash.slice(1)).get('workspace');
appearance();
window.addEventListener('storage',event=>{if(event.key==='text-size'||event.key==='ui-font')appearance();});
createRoot(document.getElementById('root')!).render(location.hash==='#wake'?<WakeWindow/>:location.hash==='#voice'?<VoiceWindow/>:agentWindow?<AgentPane id={agentWindow}/>:workspaceWindow?<WorkspaceWindow/>:sideChat?<SideJob chatId={sideChat}/>:chatWindow?<SideJob chatId={chatWindow} ordinary/>:<App/>);
