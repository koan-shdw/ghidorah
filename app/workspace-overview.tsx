// The Workspace panel's sections (Koan's pick 2026-11-18: version 3 of the sidebar mockup). The panel is the chat's
// state in one place: Environment, Context, Plan, Changes, Outputs, Agents, Background and Tools. Each section folds
// and shows a count. Files, Changes, Terminal and Preview are rows that open the tool as it was, with a way back
// (workspace-panel.tsx draws that). The agents are the same list the pills read (activeAgents), the context bars and
// account limits are the usage panel's own figures, and the plan's steps are the reply checklist's: nothing here
// keeps a second copy of the chat's state.
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {activeAgents,type ChatActivity} from './activity';
import {agentSteps,approvalWords,elapsed} from './agent-pills';
import {permissionModes} from './chat-chrome';
import type {ChatFile} from './chat-files';
import {ChatFilesDialog,previewable,size as fileSize} from './chat-files-panel';
import {ContextDialog} from './context-dialog';
import type {GitSnapshot} from './git-controls';
import {Icon,Spinner,fileIcon,type IconName} from './kit';
import {modelEfforts,modelLabel,providerFor} from './models';
import type {WorkspaceView} from './pane-layout';
import type {Snapshot} from './types';
import {modelUsage,usageModels,windowLabel} from './usage';
import {Meter,compact,shortReset} from './usage-panel';
// Styles: workspace.css (.ws-*).

type Call=(method:string,args?:any)=>Promise<any>;
const busy=new Set(['queued','running','waiting','stopping']),live=new Set(['running','checking','stopping']);
const planWords:Record<string,string>={pending:'Waiting for review',once:'Approved',deny:'Declined',expired:'Expired'};
// Which sections are folded is remembered on this computer; the panel draws the same without it.
const foldKey='workspace-folds';
function readFolds():string[]{try{const value=JSON.parse(localStorage.getItem(foldKey)||'[]');return Array.isArray(value)?value.filter(item=>typeof item==='string'):[];}catch{return [];}}
const provider=(model:string)=>{try{return providerFor(model);}catch{return '';}};

function Section({id,title,count,end,closed,toggle,children}:{id:string;title:string;count?:React.ReactNode;end?:React.ReactNode;closed:boolean;toggle:(id:string,closed:boolean)=>void;children:React.ReactNode}){
 return <details className="ws-sec" data-section={id} open={!closed} onToggle={event=>{const now=!event.currentTarget.open;if(now!==closed)toggle(id,now);}}>
  <summary><span>{title}</span>{count!==undefined&&count!==''&&count!==0&&<span className="ws-count">{count}</span>}<span className="ws-sec-end">{end}<span className="ws-chev" aria-hidden="true">⌄</span></span></summary>
  {children}
 </details>;
}
function Row({icon,label,value,go,mono,title,open,muted}:{icon?:IconName;label:React.ReactNode;value?:React.ReactNode;go?:()=>void;mono?:boolean;title?:string;open?:string;muted?:boolean}){
 const body=<><span className="ws-icon">{icon&&<Icon name={icon}/>}</span><span className={'ws-label'+(mono?' mono':'')} title={title}>{label}</span>{value!==undefined&&value!==''&&<span className="ws-value">{value}</span>}{go&&<span className="ws-arrow" aria-hidden="true">›</span>}</>;
 return go?<button type="button" className="ws-row" data-open={open} onClick={go}>{body}</button>:<div className={'ws-row'+(muted?' ws-empty':'')}>{body}</div>;
}

export function WorkspaceOverview({state,chatId,root,directory,git,changes,terminals,activity,call,open,openAgent,openSettings,focus}:{state:Snapshot;chatId:string;root:string|null;directory:string;git:GitSnapshot|null;changes:{files:{status:string;path:string}[]}|null;terminals:number;activity:ChatActivity;call:Call;
 /** Opens one of the panel's tools in place of the sections. */open:(view:WorkspaceView)=>void;openAgent?:(id:string)=>void;
 /** Opens Settings › Subscriptions; a chat in its own window has no Settings and leaves it out. */openSettings?:()=>void;
 /** The title bar's Plan or Tasks button: that section is brought into view. */focus?:WorkspaceView}){
 const chat=state.chats.find(row=>row.id===chatId)||state.jobChats?.find(row=>row.id===chatId),project=state.projects.find(row=>row.id===chat?.projectId);
 const turns=useMemo(()=>state.turns.filter(turn=>turn.chatId===chatId),[state.turns,chatId]),working=turns.some(turn=>busy.has(turn.status));
 // The chat's models are the ones in its model row: its pool, or its one model before it has a pool. Context also
 // lists a model that has answered here and has since left the row, while it still reports a window.
 const models=usageModels([],[...new Set([...(chat?.pool||[]),...(chat?.lockedModel?[chat.lockedModel]:chat?.selectedModels?.length?chat.selectedModels:chat?.model?[chat.model]:[])])]);
 const measured=usageModels(turns,models,chat?.summarizationUsage).map(model=>({model,used:modelUsage(turns,model,chat?.summarizationUsage).context})).filter(row=>row.used||models.includes(row.model));
 const agents=chatId?activeAgents(state,chatId):[],ids=agents.map(agent=>agent.id).join(' '),steps=useMemo(()=>agentSteps(agents,state.tools),[state.tools,ids]);
 const finished=activity.agents.filter(turn=>!busy.has(turn.status)).sort((a,b)=>(b.finished||b.created)-(a.finished||a.created));
 // Commands still running in this chat, its side jobs and its agents. An agent's own row is left out: it is the agent.
 const owners=new Set([chatId,...activity.agents.map(turn=>turn.chatId),...[...state.chats,...state.jobChats||[]].filter(row=>row.parentChatId===chatId).map(row=>row.id)]),agentTasks=new Set(activity.agents.map(turn=>turn.chatId+'\n'+turn.automatic?.taskId));
 const commands=(state.background||[]).filter(row=>owners.has(row.chatId)&&live.has(row.status)&&!(row.engine==='claude'&&agentTasks.has(row.chatId+'\n'+row.processId)));
 const [now,setNow]=useState(Date.now()),[closed,setClosed]=useState(readFolds),[files,setFiles]=useState<ChatFile[]>([]),[dialog,setDialog]=useState<string|null>(null),[context,setContext]=useState(false),[error,setError]=useState('');
 // The timer redraws the running times; a row that has just appeared reads the clock itself, never an older tick.
 const body=useRef<HTMLDivElement>(null),moving=agents.length+commands.length>0,clock=Math.max(now,Date.now());
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),moving?5000:30000);return()=>clearInterval(timer);},[moving]);
 // Saved outputs are read when the chat changes and when a reply starts or ends: that is when a new one appears.
 useEffect(()=>{let current=true;if(!chatId){setFiles([]);return;}void call('chatFiles',{chatId}).then(rows=>{if(current)setFiles(rows);}).catch(()=>{});return()=>{current=false;};},[chatId,working]);
 const toggle=(id:string,fold:boolean)=>setClosed(list=>{const next=fold?[...new Set([...list,id])]:list.filter(item=>item!==id);try{localStorage.setItem(foldKey,JSON.stringify(next));}catch{}return next;});
 useEffect(()=>{if(focus!=='plan'&&focus!=='tasks')return;const id=focus==='plan'?'plan':'agents';toggle(id,false);body.current?.querySelector('[data-section="'+id+'"]')?.scrollIntoView({block:'nearest'});},[focus]);
 const run=(method:string,args:any)=>{setError('');void call(method,args).catch(problem=>setError(String(problem).replace(/^Error invoking remote method 'app': (?:Error: )?/,'')));};
 const show=(id:string)=>openAgent?openAgent(id):run('openJob',{id});
 const link=(label:string,action:()=>void,title?:string,target?:string)=><button type="button" className="ws-link" title={title} data-open={target} onClick={event=>{event.preventDefault();event.stopPropagation();action();}}>{label}</button>;
 const section=(id:string,title:string,count:React.ReactNode,content:React.ReactNode,end?:React.ReactNode)=><Section id={id} title={title} count={count} end={end} closed={closed.includes(id)} toggle={toggle}>{content}</Section>;
 const effort=(model:string)=>{const level=chat?.efforts?.[model]||(model==='deepseek-flash'?chat?.effort:'high')||'high';return modelEfforts(model)[level]||(level==='xhigh'?'Extra high':level[0].toUpperCase()+level.slice(1));};
 const folder=root?[root,directory].filter(Boolean).join(root.includes('\\')?'\\':'/'):'',changed=changes?.files||[],remote=state.remote;
 // The limits of the accounts this chat's models run on, as the usage panel shows them.
 const accounts=([['Claude Code',state.claude,'claude-code'],['OpenAI',state.codex,'openai-codex']] as const).filter(([,connection,id])=>connection?.windows?.length&&models.some(model=>provider(model)===id));
 const own=(activity.tasks.find(row=>row.owner===chatId)?.items||[]).filter(item=>item.status!=='cancelled'),done=own.filter(item=>item.status==='completed').length,plan=activity.plans.at(-1);
 const outputs=files.filter(file=>file.kind==='output').sort((a,b)=>b.created-a.created),stoppable=agents.filter(agent=>agent.stopId&&!agent.stopping);
 return <div className="ws-body" ref={body}>
  {section('environment','Environment','',<>
   {folder?<Row icon="folder" label={folder} title={folder} go={()=>open('files')} open="files"/>:<Row icon="folder" label="No working folder" muted/>}
   {git?.branch&&<Row icon="fork" label={git.branch} title={git.branch} value={changed.length?changed.length+' changed':''}/>}
   {project&&<Row icon="shield" label={permissionModes[project.mode]||project.mode}/>}
   {models.map(model=><Row key={model} icon="models" label={modelLabel(model,state.claude?.models)} value={effort(model)}/>)}
   {remote?.enabled&&<Row icon="phone" label="Telegram remote" value={remote.paused?'Paused':remote.status==='running'?'On':remote.status==='starting'?'Starting':remote.status==='failed'?'Failed':'Off'}/>}
  </>)}
  {section('context','Context','',<>
   {measured.map(({model,used})=>{const label=modelLabel(model,state.claude?.models);
    return <div className="ws-meter" key={model}><div><span>{label} {used&&<strong>{used.estimated?'≈ ':''}{Math.round(used.used/used.max*100)}% used</strong>}</span><span className="ws-value">{used?compact(used.used)+' / '+compact(used.max):'Not reported yet'}</span></div>{used&&<Meter label={label+' context used'} used={used.used} max={used.max}/>}</div>;})}
   {!measured.length&&<Row label="Pick a model to see its context." muted/>}
   {accounts.map(([name,connection])=><React.Fragment key={name}><p className="ws-sub">{accounts.length>1?name+' limits':'Account limits'}</p>
    {connection!.windows!.map((window,index)=>{const label=windowLabel(window.label,window.durationSeconds),spent=window.usedPercent;
     return <div className={'ws-meter'+(spent!=null&&spent>=100?' exhausted':spent!=null&&spent>=80?' warning':'')} key={index}><div><span>{label} <strong>{spent==null?'Unavailable':Math.max(0,Math.round(100-spent))+'% left'}</strong></span><span className="ws-value" title={window.resetAt?new Date(window.resetAt).toLocaleString():undefined}>{shortReset(window.resetAt,now)}</span></div>{spent!=null&&<Meter label={name+' '+label+' remaining'} used={spent} remaining/>}</div>;})}</React.Fragment>)}
  </>,<>{chat&&!chat.parentChatId&&!chat.sideSourceId&&link('Manage',()=>setContext(true),'Review and shorten this chat\'s history')}{openSettings&&link('All subscriptions ›',openSettings,'Opens Settings › Subscriptions')}</>)}
  {section('plan','Plan',own.length?done+' of '+own.length:'',<>
   {plan&&<Row icon="plan" label="Plan" value={planWords[plan.approval.status]||plan.approval.status} go={()=>open('plan')} open="plan"/>}
   {own.map((item,index)=><div className={'ws-row'+(item.status==='completed'?' done':'')} key={item.id+':'+index}>{item.status==='completed'?<span className="ws-mark done" aria-label="Done">✓</span>:item.status==='in_progress'?<span className="ws-mark"><Spinner label="In progress"/></span>:<span className="ws-mark todo" aria-label="To do">○</span>}<span className="ws-label" title={item.content}>{item.content}</span></div>)}
   {!plan&&!own.length&&<Row label="No plan yet" muted/>}
  </>,(activity.tasks.length>0||activity.agents.length>0)&&link('Tasks ›',()=>open('tasks'),'Every task list and agent of this chat','tasks'))}
  {section('changes','Changes',changed.length,<>
   {changed.slice(0,8).map(item=><button type="button" className="ws-row" key={item.path} data-open="changes" onClick={()=>open('changes')}><span className="ws-status">{item.status.replace(/ /g,'')}</span><span className="ws-label mono" title={item.path}>{item.path}</span></button>)}
   {changed.length>8&&<Row label={(changed.length-8)+' more'} go={()=>open('changes')} muted/>}
   {!changed.length&&<Row label="No changes" muted/>}
  </>,changed.length>0&&link('Review ›',()=>open('changes'),'Opens Changes','changes'))}
  {section('outputs','Outputs',outputs.length,<>
   {outputs.slice(0,5).map(file=><button type="button" className="ws-row" key={file.id} title={previewable(file)?'Preview in app':'Open in Chat files'} onClick={()=>previewable(file)?run('chatFiles',{chatId,id:file.id,action:'preview'}):setDialog(file.id)}><span className="ws-icon"><Icon name={fileIcon(file.name)}/></span><span className="ws-label">{file.name}</span><span className="ws-value">{fileSize(file.size)}</span>{previewable(file)&&<span className="ws-arrow" aria-hidden="true">›</span>}</button>)}
   {outputs.length>5&&<Row label={(outputs.length-5)+' more'} go={()=>setDialog('')}/>}
   {!outputs.length&&<Row label="No saved outputs" muted/>}
  </>)}
  {section('agents','Agents',agents.length,<>
   {agents.map(agent=>{const approval=agent.approvalId?state.approvals.find(row=>row.id===agent.approvalId):undefined,words=approval?approvalWords(approval):'';
    return <React.Fragment key={agent.id}><div className={'ws-row ws-agent'+(approval?' ask':'')} role="group" aria-label={agent.name}>
     {approval?<span className="ws-mark ask" aria-hidden="true"><i/></span>:<span className="ws-mark"><Spinner label="Working"/></span>}
     <span className="ws-two"><button type="button" className="ws-name" title="Open this agent" onClick={()=>show(agent.id)}>{agent.name}</button><small>{approval?words?'Needs your permission: '+words:'Has a question for you':agent.stopping?'Stopping…':steps[agent.id]||agent.step||'Working'}</small></span>
     <span className="ws-value">{elapsed(agent.since,clock)}</span>
     {agent.stopId&&<button type="button" className="ws-stop" disabled={agent.stopping} aria-label={'Stop '+agent.name} title="Stop this agent" onClick={()=>run('backgroundStop',{id:agent.stopId})}><Icon name="stop"/></button>}
    </div>{approval&&<div className="ws-ask">{words?<><button type="button" onClick={()=>run('approve',{id:approval.id,choice:'once'})}>Allow once</button><button type="button" onClick={()=>run('approve',{id:approval.id,choice:'deny'})}>Deny</button></>:<button type="button" onClick={()=>show(agent.id)}>Open</button>}</div>}</React.Fragment>;})}
   {finished.length>0&&<details className="ws-fold"><summary className="ws-row"><span className="ws-icon"/><span className="ws-label">{finished.length} finished</span><span className="ws-chev" aria-hidden="true">⌄</span></summary>
    {finished.slice(0,5).map(turn=><button type="button" className="ws-row done" key={turn.id} title="Open this agent" onClick={()=>show(turn.id)}><span className={'ws-mark '+(turn.status==='completed'?'done':'failed')} aria-hidden="true">{turn.status==='completed'?'✓':'✕'}</span><span className="ws-label">{turn.automatic?.description||turn.automatic?.agentType||'Agent'}</span><span className="ws-value">{turn.status==='completed'?elapsed(turn.created,turn.finished||turn.created):turn.status}</span></button>)}
    {finished.length>5&&<Row label={(finished.length-5)+' more'} go={()=>open('tasks')} open="tasks"/>}
   </details>}
   {!agents.length&&!finished.length&&<Row label="No agents" muted/>}
  </>,stoppable.length>1&&link('Stop all',()=>{for(const agent of stoppable)run('backgroundStop',{id:agent.stopId});}))}
  {section('background','Background',commands.length,<>
   {commands.map(row=><div className="ws-row" key={row.id}><span className="ws-icon"><Icon name="terminal"/></span><span className="ws-label mono" title={row.command}>{row.command}</span><span className="ws-value">{row.status==='stopping'?'Stopping…':elapsed(row.created,clock)}</span><button type="button" className="ws-stop" disabled={row.status==='stopping'} aria-label={'Stop '+row.command} title="Stop this command" onClick={()=>run('backgroundStop',{id:row.id})}><Icon name="stop"/></button></div>)}
   {!commands.length&&<Row label="Nothing running" muted/>}
  </>)}
  {section('tools','Tools','',<>
   <Row icon="files" label="Files" value={directory} go={()=>open('files')} open="files"/>
   <Row icon="changes" label="Changes" value={changed.length?changed.length+(changed.length===1?' file':' files'):''} go={()=>open('changes')} open="changes"/>
   <Row icon="terminal" label="Terminal" value={terminals?terminals+' open':''} go={()=>open('terminal')} open="terminal"/>
   <Row icon="preview" label="Preview" go={()=>open('preview')} open="preview"/>
  </>)}
  {error&&<p className="error" role="alert">{error}</p>}
  {context&&chat&&<ContextDialog chat={chat} state={state} call={call} close={()=>setContext(false)}/>}
  {dialog!==null&&chatId&&<ChatFilesDialog key={chatId+dialog} chatId={chatId} initialId={dialog||undefined} close={()=>setDialog(null)}/>}
 </div>;
}
