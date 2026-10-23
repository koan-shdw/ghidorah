import {GitControls,type GitSnapshot} from './git-controls';
import {ActivityPanel} from './activity-panel';
import type {ChatActivity} from './activity';
import {DiffReview,type ReviewDiff} from './diff-review-panel';
import React,{useContext,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {EditorState,Compartment} from '@codemirror/state';
import {EditorView,lineNumbers,highlightActiveLine,keymap} from '@codemirror/view';
import {defaultKeymap,history,historyKeymap,indentWithTab} from '@codemirror/commands';
import {LanguageDescription} from '@codemirror/language';
import {githubEditorTheme} from './upstream/code-editor-theme';
import {languages} from '@codemirror/language-data';
import {Icon,fileIcon} from './kit';
import type {WorkspaceFile} from './workspace-files';
import type {TerminalInfo} from './terminal';
import type {FileRequest} from './chat-links';
import {PreviewPanel,canPreview} from './preview-panel';
import './workspace.css';
import {createPortal} from 'react-dom';
import {PaneTargets} from './pane-shell';
import {workspaceViews,workspaceTitle,type WorkspaceView} from './pane-layout';
export type {WorkspaceView} from './pane-layout';

type Call=(method:string,args?:any)=>Promise<any>;
type FileDraft=WorkspaceFile & {root:string;draft:string;generation:number};
function TerminalPane({item,active,call}:{item:TerminalInfo;active:boolean;call:Call}){
  const host=useRef<HTMLDivElement>(null),terminal=useRef<Terminal|null>(null),fit=useRef<FitAddon|null>(null);
  const [error,setError]=useState(''),[exit,setExit]=useState<number|null>(null);
  useEffect(()=>{
    const term=new Terminal({fontFamily:'Consolas, monospace',fontSize:12,cursorBlink:true,scrollback:3000,theme:{background:'#141413',foreground:'#e8e6dc'},allowProposedApi:false});
    const addon=new FitAddon();term.loadAddon(addon);term.open(host.current!);terminal.current=term;fit.current=addon;
    let alive=true,pending=false,offset=0;
    const failure=(e:unknown)=>{if(alive)setError(String(e));};
    const input=term.onData(data=>void call('terminalWrite',{chatId:item.chatId,id:item.id,data}).catch(failure));
    const size=term.onResize(({cols,rows})=>void call('terminalResize',{chatId:item.chatId,id:item.id,cols,rows}).catch(failure));
    async function read(){if(pending||!alive)return;pending=true;try{const out=await call('terminalRead',{chatId:item.chatId,id:item.id,after:offset});if(!alive)return;if(out.reset)term.reset();offset=out.offset;if(out.data)term.write(out.data);setExit(out.exit);}catch(e){failure(e);}finally{pending=false;}}
    const timer=setInterval(()=>void read(),120);void read();
    const observer=new ResizeObserver(()=>{if(host.current?.clientWidth&&host.current?.clientHeight)addon.fit();});observer.observe(host.current!);
    return()=>{alive=false;clearInterval(timer);observer.disconnect();input.dispose();size.dispose();term.dispose();terminal.current=null;fit.current=null;};
  },[item.id]);
  useEffect(()=>{if(active){fit.current?.fit();terminal.current?.focus();}},[active]);
  return <section className={'terminal-instance '+(active?'active':'')} aria-label="Interactive terminal"><div className="terminal-host" ref={host}/>{exit!==null&&<p className="workspace-notice">Terminal exited · {exit}</p>}{error&&<p className="error">{error}</p>}</section>;
}
function CodeEditor({file,onChange,onSave,theme,location}:{file:FileDraft;onChange:(text:string)=>void;onSave:()=>void;theme:string;location:FileRequest|null}){
  const host=useRef<HTMLDivElement>(null),editor=useRef<EditorView|null>(null),callbacks=useRef({onChange,onSave});callbacks.current={onChange,onSave};
  useEffect(()=>{
    const language=new Compartment();
    const view=new EditorView({parent:host.current!,state:EditorState.create({doc:file.draft,extensions:[lineNumbers(),history(),highlightActiveLine(),EditorState.lineSeparator.of(file.lineEnding),githubEditorTheme(!['light','paper'].includes(theme)),language.of([]),
      keymap.of([{key:'Mod-s',run:()=>{callbacks.current.onSave();return true;}},...defaultKeymap,...historyKeymap,indentWithTab]),
      EditorView.contentAttributes.of({'aria-label':'File contents','spellcheck':'false'}),EditorView.updateListener.of(update=>{if(update.docChanged)callbacks.current.onChange(update.state.sliceDoc());}),
      EditorView.theme({'&':{height:'100%',fontSize:'12px'},'.cm-scroller':{fontFamily:'Consolas, monospace',overflow:'auto'},'.cm-content':{caretColor:'var(--text)'},'.cm-gutters':{backgroundColor:'var(--surface)',color:'var(--muted)',borderRight:'1px solid var(--line)'},'.cm-activeLine,.cm-activeLineGutter':{backgroundColor:'var(--raised)'},'.cm-selectionBackground':{backgroundColor:'#52708b55 !important'}}),
    ]})});
    editor.current=view;
    let live=true;const description=LanguageDescription.matchFilename(languages,file.name);if(description)void description.load().then(extension=>{if(live)view.dispatch({effects:language.reconfigure(extension)});}).catch(()=>{});
    return()=>{live=false;view.destroy();editor.current=null;};
  },[file.path,file.generation,theme]);
  useEffect(()=>{const view=editor.current;if(!view||!location||location.path!==file.path)return;const line=view.state.doc.line(Math.min(location.line||1,view.state.doc.lines)),anchor=Math.min(line.to,line.from+(location.column||1)-1);view.dispatch({selection:{anchor},effects:EditorView.scrollIntoView(anchor,{y:'center'})});view.focus();},[file.path,file.generation,theme,location?.id]);
  return <div className="code-editor" ref={host}/>;
}
export function WorkspacePanel({chatId,root,view,setView,visible,onHide,call,terminalRequest,theme,fileRequest,detached=[],detach,popped=[],only,initial,activity={plans:[],tasks:[],agents:[]},openAgent,onCommentDirty}:{onCommentDirty?:(dirty:boolean)=>void;openAgent?:(id:string)=>void;activity?:ChatActivity;popped?:WorkspaceView[];only?:WorkspaceView;initial?:{directory:string;file?:string;diff?:{file:string;staged:boolean}};detached?:WorkspaceView[];detach?:(view:WorkspaceView,detached:boolean)=>void;chatId:string;root:string|null;view:WorkspaceView;setView:(view:WorkspaceView)=>void;visible:boolean;onHide:()=>void;call:Call;terminalRequest:number;theme:string;fileRequest:FileRequest|null}){
  const targets=useContext(PaneTargets),home=useRef<HTMLDivElement>(null),hosts=useRef(new Map<WorkspaceView,HTMLDivElement>());
  for(const view of workspaceViews)if(!hosts.current.has(view)){const element=document.createElement('div');element.className='workspace-view-content';hosts.current.set(view,element);}
  const active=(name:WorkspaceView)=>!popped.includes(name)&&(only?name===only:detached.includes(name)||visible&&view===name);
  useLayoutEffect(()=>{for(const name of workspaceViews){const host=hosts.current.get(name)!,target=detached.includes(name)?targets.get('workspace:'+name):home.current;if(target&&host.parentElement!==target)target.append(host);host.hidden=!active(name);}});
  const [previewRequest,setPreviewRequest]=useState(0);
  const [git,setGit]=useState<GitSnapshot|null>(null),[gitBusy,setGitBusy]=useState(false),[gitNotice,setGitNotice]=useState('');
  const gitOwner=useRef<string|null>(null);
  const [location,setLocation]=useState<FileRequest|null>(null);
  const [directory,setDirectory]=useState(initial?.directory||''),[listing,setListing]=useState<any>(null),[file,setFile]=useState<FileDraft|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[terminals,setTerminals]=useState<TerminalInfo[]>([]),[terminalId,setTerminalId]=useState(''),[changes,setChanges]=useState<any>(null),[diff,setDiff]=useState<ReviewDiff|null>(null),[saving,setSaving]=useState(false),[discard,setDiscard]=useState(false),[width,setWidth]=useState(520);
  const [pending,setPending]=useState(0),[commentDirty,setCommentDirty]=useState(false),changed=!!file&&file.draft!==file.text;
  const commentDraft=useRef(false);
  function commentChanged(dirty:boolean){commentDraft.current=dirty;setCommentDirty(dirty);onCommentDirty?.(dirty);}
  function requireSavedComment(){if(commentDraft.current)throw Error('Save or cancel the line comment before changing its diff, folder or chat.');}
  useEffect(()=>{void call('workspaceDraft',{dirty:changed||commentDirty}).catch(()=>{});},[changed,commentDirty]);
  async function pop(name:WorkspaceView){if((name==='files'&&changed)||(name==='changes'&&commentDirty))throw Error('Save or discard these edits before moving to a window.');await call('workspaceWindowOpen',{view:name,chatId,directory,...(file?{file:file.path}:{}),...(diff?{diff:{file:diff.path,staged:diff.staged}}:{})});}
  async function run<T,>(action:()=>Promise<T>):Promise<T|undefined>{setError('');setPending(value=>value+1);try{return await action();}catch(e){setError(String(e).replace(/^(?:Error:\s*)?(?:Error invoking remote method 'app':\s*)?(?:Error:\s*)?/,''));}finally{setPending(value=>value-1);}}
  async function list(folder=directory){if(folder!==directory)requireSavedComment();const result=await call('workspaceList',{directory:folder});if(folder!==directory)requireSavedComment();setListing(result);setDirectory(folder);}
  async function refreshChanges(){requireSavedComment();const result=await call('workspaceChanges',{directory});requireSavedComment();const current=await call('workspaceGit',{chatId,directory,root,action:'inspect'});requireSavedComment();setChanges(result);setGit(current);setDiff(null);}
  async function gitAction(action:string,args:any={}){return run(async()=>{requireSavedComment();if(!git)throw Error('Refresh changes first.');gitOwner.current=chatId;setGitBusy(true);setGitNotice('');try{const result=await call('workspaceGit',{chatId,directory,root,action,revision:git.revision,...args});await refreshChanges();setGitNotice(result.output||'Git action completed.');return result;}catch(error){await refreshChanges().catch(()=>{});throw error;}finally{gitOwner.current=null;setGitBusy(false);}});}
  async function openDiff(file:string,staged:boolean){requireSavedComment();const result=await call('workspaceChanges',{directory,file,staged});requireSavedComment();setDiff(result);}
  async function preview(relative:string){await call('previewOpen',{chatId,file:relative});setPreviewRequest(value=>value+1);setView('preview');}
  async function open(relative:string){if(changed){setError('Save or discard the current draft before opening another file.');return;}const item=await call('workspaceRead',{file:relative});setFile({...item,draft:item.text,generation:(file?.generation||0)+1});setNotice('');setDiscard(false);setView('files');}
  async function save(){if(!file||saving)return;const source=file;setSaving(true);try{const result=await call('workspaceSave',{root:source.root,file:source.path,text:source.draft,revision:source.revision});setFile(current=>current?.path===source.path?{...current,...result,draft:current.draft}:current);setNotice('Saved');setError('');}catch(e){setError(String(e));}finally{setSaving(false);}}
  async function reload(){if(!file)return;const item=await call('workspaceRead',{file:file.path});setFile({...item,draft:item.text,generation:file.generation+1});setDiscard(false);setError('');setNotice('Reloaded from disk');}
  async function newTerminal(){const item=await call('terminalOpen',{chatId});setTerminals(previous=>[...previous,item]);setTerminalId(item.id);setView('terminal');}
  useEffect(()=>{let live=true;if(chatId&&(!only||only==='terminal')&&!popped.includes('terminal'))void run(async()=>{const rows=await call('terminalList',{chatId});if(live){setTerminals(rows);setTerminalId(rows.at(-1)?.id||'');}});return()=>{live=false;};},[chatId,terminalRequest,popped.includes('terminal')]);
  useEffect(()=>{setDirectory(initial?.directory||'');setListing(null);setChanges(null);setGit(null);setGitNotice('');setDiff(null);if(root)void run(async()=>{await list(initial?.directory||'');if(only==='files'&&initial?.file)await open(initial.file);if(only==='changes'&&initial?.diff){await refreshChanges();setDiff(await call('workspaceChanges',{directory:initial.directory,file:initial.diff.file,staged:initial.diff.staged}));}});},[root]);
  useEffect(()=>{if(!commentDraft.current&&active('changes')&&root&&!(only==='changes'&&initial?.diff))void run(refreshChanges);},[active('changes'),directory,root]);
  useEffect(()=>{if(!fileRequest)return;void run(async()=>{
    if(fileRequest.chatFileId){await call('previewOpen',{chatId,chatFileId:fileRequest.chatFileId});setPreviewRequest(value=>value+1);setView('preview');return;}
    // One of Koan's preview pages (FEATURE-SPECS 4), opened as him in the preview pane.
    if(fileRequest.url){await call('previewOpen',{chatId,url:fileRequest.url});setPreviewRequest(value=>value+1);setView('preview');return;}
    if(fileRequest.root!==root)throw Error('The working folder changed. Open the link again.');
    if(fileRequest.directory){await list(fileRequest.path);return;}
    if(!fileRequest.refresh&&canPreview(fileRequest.path)){await preview(fileRequest.path);return;}
    if(!fileRequest.refresh&&file?.path===fileRequest.path&&file.root===root){setLocation(fileRequest);return;}
    if(changed)throw Error('Save or discard the current draft before opening another file.');
    const item=await call('workspaceRead',{file:fileRequest.path});setFile({...item,draft:item.text,generation:(file?.generation||0)+1});setLocation(fileRequest);setNotice('');setDiscard(false);
  });},[fileRequest?.id]);
  // Keep drafts mounted when the panel is hidden or another chat is selected.
  // Main binds saves to the folder where the file was opened.
  function resize(event:React.PointerEvent){const start=event.clientX,initial=width;event.currentTarget.setPointerCapture(event.pointerId);const element=event.currentTarget;const move=(e:Event)=>setWidth(Math.max(320,Math.min(window.innerWidth-350,initial+start-(e as PointerEvent).clientX)));const up=()=>{element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',up);element.removeEventListener('pointercancel',up);};element.addEventListener('pointermove',move);element.addEventListener('pointerup',up);element.addEventListener('pointercancel',up);}
  const contents:Record<WorkspaceView,React.ReactNode>={
    plan:<ActivityPanel view="plan" activity={activity} call={call}/>,
    tasks:<ActivityPanel view="tasks" activity={activity} call={call} openAgent={openAgent}/>,
    files:<><div className="workspace-location"><button aria-label="Parent folder" disabled={!directory} onClick={()=>void run(()=>list(directory.replace(/[\\/][^\\/]+$|^[^\\/]+$/,'')))}>↑</button><span title={directory||root||''}>{directory||'Working folder'}</span><button aria-label="Refresh files" onClick={()=>void run(()=>list())}>↻</button></div>
        <div className="workspace-files">{listing?.entries.map((item:any)=><button key={item.path} title={item.name} onClick={()=>void run(()=>item.directory?list(item.path):canPreview(item.path)&&!(/\.html?$/i.test(item.path))?preview(item.path):open(item.path))}><span className="file-kind" aria-hidden="true"><Icon name={item.link?'popout':fileIcon(item.name,item.directory)}/></span>{item.name}</button>)}{listing?.truncated&&<p>Showing the first 1,000 entries.</p>}</div>
        {file&&<><div className="editor-toolbar"><span title={file.path}>{file.name}{changed?' •':''}</span>{canPreview(file.path)&&<><button disabled={changed} title={changed?'Save the file before previewing it':'Preview saved file'} onClick={()=>void run(()=>preview(file.path))}>Preview in app</button><button disabled={changed} title={changed?'Save the file before previewing it':'Open saved file in browser'} onClick={()=>void run(()=>call('previewBrowser',{chatId,file:file.path}))}>Open in browser</button></>}<button disabled={!changed||saving} onClick={()=>void save()}>Save</button><button disabled={saving} onClick={()=>changed?setDiscard(true):void run(reload)}>{changed?'Discard':'Reload'}</button></div>{discard&&<div className="workspace-confirm">Discard your draft and reload this file?<button onClick={()=>void run(reload)}>Discard draft</button><button onClick={()=>setDiscard(false)}>Keep editing</button></div>}<CodeEditor location={location} theme={theme} file={file} onChange={draft=>setFile(current=>current?{...current,draft}:current)} onSave={()=>void save()}/></>}{notice&&<div className="workspace-notice" role="status">{notice}</div>}</>,
    changes:<><div className="workspace-location"><span>{directory||'Working folder'}</span><button aria-label="Refresh changes" onClick={()=>void run(refreshChanges)}>↻</button></div><GitControls key={JSON.stringify([root,directory,chatId])} state={git} busy={gitBusy} disabled={!chatId||commentDirty} onAction={gitAction} onCancel={()=>void run(()=>call('workspaceGitCancel',{chatId:gitOwner.current||chatId}))}/>{gitNotice&&<p className="git-result" role="status">{gitNotice}</p>}<div className="change-list">{changes?.files.map((item:any)=><div key={item.path}><code>{item.status}</code><button onClick={()=>void run(()=>open([directory,item.path].filter(Boolean).join('/')))}>{item.path}</button>{item.status==='??'?<button onClick={()=>void run(()=>openDiff(item.path,false))}>New file</button>:<>{item.status[1]!==' '&&<button onClick={()=>void run(()=>openDiff(item.path,false))}>Working</button>}{item.status[0]!==' '&&<button onClick={()=>void run(()=>openDiff(item.path,true))}>Staged</button>}</>}{item.status[1]!==' '&&<button disabled={gitBusy||commentDirty||!chatId} aria-label={'Stage '+item.path} onClick={()=>void gitAction('stage',{file:item.path})}>Stage</button>}{item.status[0]!==' '&&item.status!=='??'&&<button disabled={gitBusy||commentDirty||!chatId} aria-label={'Unstage '+item.path} onClick={()=>void gitAction('unstage',{file:item.path})}>Unstage</button>}</div>)}{changes&&!changes.files.length&&<p>No changes.</p>}</div>{diff&&<DiffReview onDirty={commentChanged} key={JSON.stringify([chatId,directory,diff.root,diff.path,diff.staged,diff.revision])} diff={diff} chatId={chatId} directory={directory} call={call}/>}</>,
    terminal:<><div className="terminal-tabs">{terminals.map((item,index)=><div key={item.id} className={item.id===terminalId?'selected':''}><button onClick={()=>setTerminalId(item.id)}>Terminal {index+1}</button><button aria-label={'Close terminal '+(index+1)} title="Close terminal and its processes" onClick={()=>void run(async()=>{await call('terminalClose',{chatId:item.chatId,id:item.id});const rest=terminals.filter(row=>row.id!==item.id);setTerminals(rest);if(terminalId===item.id)setTerminalId(rest.at(-1)?.id||'');})}>×</button></div>)}<button aria-label="New terminal" disabled={!chatId} onClick={()=>void run(newTerminal)}>＋</button></div>{!terminals.length&&<div className="workspace-empty"><p>PowerShell in your working folder.</p><button className="primary" disabled={!chatId} onClick={()=>void run(newTerminal)}>Open terminal</button></div>}<div className="terminal-stack active">{!popped.includes('terminal')&&terminals.map(item=><TerminalPane key={item.id} item={item} active={active('terminal')&&item.id===terminalId} call={call}/>)}</div></>,
    preview:!popped.includes('preview')&&<PreviewPanel chatId={chatId} active={active('preview')} call={call} request={previewRequest}/>,
  };
  return <><aside className={'workspace-panel '+(only?'workspace-window-panel ':'')+(visible?'shown':'hidden')} style={{width}} aria-label="Workspace" aria-hidden={!visible}>
    {!only&&<div className="workspace-resizer" role="separator" aria-label="Resize workspace" aria-orientation="vertical" tabIndex={0} onPointerDown={resize} onKeyDown={event=>{if(event.key==='ArrowLeft')setWidth(Math.min(window.innerWidth-350,width+30));if(event.key==='ArrowRight')setWidth(Math.max(320,width-30));}}/>}
    {!only&&<header className="workspace-title"><strong>Workspace</strong><button aria-label="Hide workspace" onClick={onHide}>×</button></header>}
    {!only&&<nav className="workspace-nav">{workspaceViews.map(name=><button key={name} aria-pressed={view===name} onClick={()=>setView(name)}>{workspaceTitle(name)}</button>)}</nav>}
    {detach&&!detached.includes(view)&&!popped.includes(view)&&<div className="workspace-pane-actions"><button onClick={()=>detach(view,true)}>{'Detach '+workspaceTitle(view)}</button><button disabled={pending>0||saving} onClick={()=>void run(()=>pop(view))}>{'Pop out '+workspaceTitle(view)}</button></div>}
    {!only&&popped.includes(view)&&<div className="workspace-empty"><p>{workspaceTitle(view)} is in its own window.</p><button onClick={()=>void run(()=>call('workspaceWindowOpen',{view,chatId}))}>Show window</button><button onClick={()=>void run(()=>call('workspaceWindowReturn',{view}))}>Return to workspace</button></div>}
    {detached.includes(view)&&!popped.includes(view)&&<div className="workspace-empty"><p>{workspaceTitle(view)} is in its own pane.</p><button onClick={()=>detach?.(view,false)}>Return to workspace</button></div>}
    <div className="workspace-view-home" ref={home}/>
  </aside>{workspaceViews.map(name=>(!only||name===only)&&createPortal(<section className="workspace-view" aria-label={workspaceTitle(name)+' view'}>
    {detached.includes(name)&&<header className="workspace-view-title"><strong>{workspaceTitle(name)}</strong><button disabled={pending>0||saving} aria-label={'Pop out '+workspaceTitle(name)} onClick={()=>void run(()=>pop(name))}>↗</button><button aria-label={'Return '+workspaceTitle(name)+' to workspace'} onClick={()=>detach?.(name,false)}>↙</button></header>}
    {!root&&['files','changes','terminal'].includes(name)?<p className="workspace-notice">Choose the root working folder in Settings to open files and terminals.</p>:contents[name]}
    {error&&<div className="error" role="alert">{error}<button aria-label="Dismiss workspace error" onClick={()=>setError('')}>×</button></div>}
  </section>,hosts.current.get(name)!,name))}</>;

}
