// Native CLI bridge pattern: vi-dancer/src/main/codirBridge.ts.
// Control envelope: anthropics/claude-agent-sdk-python, _internal/query.py.
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import type {Mode} from './types';
import {SecretScrubber} from './redaction';
import {resolveWorkPath} from './work-coordination';
import type {ProjectSourceGrant} from './project-trust';

const execute=promisify(execFile);
const permissionModes={manual:'manual','accept-edits':'acceptEdits',plan:'plan',auto:'auto',bypass:'bypassPermissions'};
const fileEditingTools=new Set(['Write','Edit','MultiEdit','NotebookEdit']);
export function claudeEnvironment(source:NodeJS.ProcessEnv=process.env){
  const env:NodeJS.ProcessEnv={PSExecutionPolicyPreference:'Bypass'};
  for(const name of ['PATH','SystemRoot','SystemDrive','WINDIR','ProgramData','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','TEMP','TMP','ComSpec','PATHEXT','LANG','LC_ALL']){
    const key=Object.keys(source).find(k=>k.toLowerCase()===name.toLowerCase());if(key)env[name]=source[key];
  }
  // Ghidorah projects share one working folder. Native automatic memory is
  // keyed by that folder and would merge them; the app owns project memory.
  return {...env,PYTHONDONTWRITEBYTECODE:'1',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1'};
}
export async function findClaude(){
  const filename=process.platform==='win32'?'claude.exe':'claude';
  const roots=[path.join(process.env.APPDATA||'', 'npm'),...(process.env.PATH||'').split(path.delimiter)];
  const candidates=[path.join(os.homedir(),'.local','bin',filename),...roots.flatMap(dir=>[path.join(dir,'node_modules','@anthropic-ai','claude-code','bin',filename),path.join(dir,filename)])];
  for(const executable of [...new Set(candidates)])try{
    await fs.access(executable);
    const version=(await execute(executable,['--version'],{env:claudeEnvironment(),windowsHide:true,timeout:10000})).stdout.trim();
    if(version.includes('Claude Code'))return {executable,version};
  }catch{}
  return null;
}
export async function claudeAccount(executable:string){
  try{
    const {stdout}=await execute(executable,['auth','status','--json'],{env:claudeEnvironment(),windowsHide:true,timeout:15000});
    const account=JSON.parse(stdout);
    // No token or personal account fields leave this function.
    return {loggedIn:account.loggedIn===true,subscription:account.authMethod==='claude.ai'};
  }catch{return {loggedIn:false,subscription:false};}
}

const protectedNames=['.claude','.codex','mcp-tokens','state-snapshots','auth.json','browser-profile','signal-cli','cmdkey','credread','credentialmanager','credential_manager','find-generic-password','windows_credentials'];
export function protectedClaudeAction(input:unknown,dataRoot:string){
  const text=JSON.stringify(input).toLowerCase().replaceAll('\\\\','/').replaceAll('\\','/');
  return protectedNames.some(name=>text.includes(name))||text.includes(dataRoot.toLowerCase().replaceAll('\\','/'));
}
const pathKey=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
const insidePath=(root:string,file:string)=>{const relative=path.relative(pathKey(root),pathKey(file));return relative!== '..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
export async function claudeDirectory(candidate:unknown,previous:string,dataRoot:string){
  if(typeof candidate!=='string'||!path.isAbsolute(candidate))throw Error('Claude did not report an absolute working directory.');
  const directory=await fs.realpath(candidate),privateRoots=[dataRoot,path.join(os.homedir(),'.claude'),path.join(os.homedir(),'.codex')];
  if(privateRoots.some(root=>insidePath(root,directory)))throw Error('Protected credential directory.');
  if(!protectedClaudeAction({directory},dataRoot))return {directory,worktree:undefined};
  if(!/[\\/]\.claude[\\/]worktrees[\\/]/i.test(directory))throw Error('Protected credential directory.');
  const git=async(cwd:string,args:string[])=>(await execute('git',['-C',cwd,...args],{env:claudeEnvironment(),windowsHide:true,timeout:5000})).stdout.trim();
  const worktree=await fs.realpath(await git(directory,['rev-parse','--show-toplevel']));
  const common=await fs.realpath(await git(directory,['rev-parse','--path-format=absolute','--git-common-dir'])),origin=await fs.realpath(await git(previous,['rev-parse','--path-format=absolute','--git-common-dir']));
  const listed=(await git(previous,['worktree','list','--porcelain','-z'])).split('\0').filter(v=>v.startsWith('worktree ')).map(v=>path.resolve(v.slice(9)));
  if(pathKey(common)!==pathKey(origin)||!listed.some(root=>pathKey(root)===pathKey(worktree))||privateRoots.some(root=>insidePath(root,worktree)||insidePath(root,common))||protectedClaudeAction({directory:path.relative(worktree,directory)},dataRoot))throw Error('This directory is not a verified repository worktree.');
  return {directory,worktree};
}
export async function protectedClaudeTool(input:any,dataRoot:string,directory:string,worktree?:string,toolName=''){
  if(['Read','Write','Edit','MultiEdit','NotebookEdit'].includes(toolName))input=Object.fromEntries(Object.entries(input||{}).filter(([key])=>['file_path','path','notebook_path'].includes(key)));
  const visit=async(value:any,key=''):Promise<any>=>{
    if(typeof value==='string'&&value&&!/[\r\n\0]/.test(value)&&(['file_path','path','notebook_path'].includes(key)||worktree&&path.isAbsolute(value)&&insidePath(worktree,path.resolve(value)))){
      const target=await resolveWorkPath(path.resolve(directory,value));
      if([dataRoot,path.join(os.homedir(),'.claude'),path.join(os.homedir(),'.codex')].some(root=>insidePath(root,target)))return target;
      let tree=worktree;
      if(!tree||!insidePath(tree,target)){
        const candidate=/^(.*[\\/]\.claude[\\/]worktrees[\\/][^\\/]+)(?:[\\/]|$)/i.exec(target)?.[1];
        if(candidate)try{tree=(await claudeDirectory(candidate,directory,dataRoot)).worktree;}catch{return target;}
      }
      return tree&&insidePath(tree,target)?'[verified worktree]/'+path.relative(tree,target):target;
    }
    if(Array.isArray(value))return Promise.all(value.map(v=>visit(v,key)));
    if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.entries(value).map(async([k,v])=>[k,await visit(v,k)])));
    return value;
  };
  return protectedClaudeAction(await visit(input),dataRoot);
}
export function claudeSettings(dataRoot:string,managedTools:string[]=[],planDirectory?:string){
  const directories=['~/.claude/**','~/.codex/**',dataRoot.replaceAll('\\','/')+'/**','**/mcp-tokens/**','**/state-snapshots/**','**/auth.json','**/signal-cli/**'];
  return {...(planDirectory?{plansDirectory:planDirectory}:{}),permissions:{allow:managedTools,deny:[...directories.flatMap(dir=>['Read','Edit','Write'].map(tool=>`${tool}(${dir})`)),...['cmdkey','security find-generic-password','powershell *CredRead*'].map(command=>`Bash(${command}*)`)]}};
}
export async function nativePlanFile(name:string,input:any,planDirectory?:string){
  if(!planDirectory||!['Write','Edit'].includes(name)||typeof input?.file_path!=='string'||!path.isAbsolute(input.file_path)||path.extname(input.file_path).toLowerCase()!=='.md')return false;
  const root=path.resolve(planDirectory),file=path.resolve(input.file_path);
  return pathKey(path.dirname(file))===pathKey(root)&&pathKey(await resolveWorkPath(root))===pathKey(root)&&pathKey(await resolveWorkPath(file))===pathKey(file);
}
export interface ClaudeRun {
  // Settings, Browser and computer: Claude's own Chrome link (claude --chrome) when Claude is chosen (4e).
  chrome?:boolean;
  // Screen control (FEATURE-SPECS 1): agent-browser on PATH and its Chrome settings, for Claude's terminal.
  env?:Record<string,string>;
  executable:string;python:string;worker:string;directory:string;dataRoot:string;exchangeRoot:string;
  prefixArgs?:string[];
  inspectUsage?:boolean;
  inspectMcp?:boolean;
  inspectCapabilities?:boolean;
  pluginDirectories?:string[];
  mcp?:{names:string[];managedTools?:string[];handle:(server:string,message:any,signal:AbortSignal,directory?:string)=>Promise<any>};
  projectMemory?:string;
  planDirectory?:string;
  attachments?:any[];
  work?:{before:(id:string,name:string,args:any,directory?:string,signal?:AbortSignal)=>Promise<void>;after:(id:string,result:any,failed:boolean,refused?:boolean)=>Promise<void>};
  beforePrompt?:(model?:string)=>string|undefined;
  delegation?:(task:{id:string;toolId:string;model:string;runtimeId:string;description:string;agentType:string})=>Promise<{options:ClaudeRun;complete:(result:ClaudeResult|Error)=>void}>;
  trustedProject?:boolean;
  projectSettingsHash?:string;
  projectSourceGrant?:ProjectSourceGrant;
  adoptProjectSources?:(grant:ProjectSourceGrant)=>void;
  projectAgents?:Record<string,any>;
  // The message row this run answers. It is Claude's message ID, so Claude's own events name the row
  // (command_lifecycle, user_message_uuids: TURN-REVIEW part 1).
  turnId?:string;
  // His "Let Claude wake itself up" switch for this chat; off refuses the tools that set wake-ups and timers.
  wakeUps?:()=>boolean;
  model:string;effort:string;mode:Mode;sessionId?:string;prompt:string;hasFolder:boolean;
  signal:AbortSignal;scrubber:SecretScrubber;
  event:(event:any)=>void;
  controls?:(actions:{setMode:(mode:Mode)=>Promise<void>})=>void;
  modeChanged?:(mode:Mode,current:()=>boolean)=>Promise<void>;
  approve:(id:string,name:string,input:any,directory?:string)=>Promise<boolean|{input:any}>;
}
// answeredIn: the row whose reply answered this message, when Claude read it mid-reply.
export interface ClaudeResult {status:'stopped'|'failed'|'completed';sessionId?:string;result:any;models:{id:string;label:string;efforts:string[]}[];answeredIn?:string;}
// What the session tells main about itself: busy and idle, warnings, refused prompts, the process ending.
export interface ClaudeSessionHooks {
  event?:(event:any)=>void;
  // A turn Claude starts by itself (a job notice, a wake-up, a timer). Main makes its automatic row at once from the
  // context it already has for this session; Claude is waiting, so this is synchronous.
  automatic?:(info:{runtimeId:string;model:string})=>{options:ClaudeRun;complete:(result:ClaudeResult|Error)=>void}|undefined;
}
type Scope={id:string;directory:string;worktree?:string;options:ClaudeRun;settled:boolean;cancelled:boolean;error?:Error;result?:any;taskId?:string;agentId?:string;abort:()=>void;stopTimer?:NodeJS.Timeout;stopRequest?:Promise<void>;text:ReturnType<SecretScrubber['stream']>;thinking:ReturnType<SecretScrubber['stream']>;resolve?:(value:ClaudeResult)=>void;reject?:(error:Error)=>void};
// One message Tris sent. Its state is Claude's own command_lifecycle for it.
type Sent={id:string;options:ClaudeRun;state:'sent'|'queued'|'started'|'completed'|'cancelled';turn?:EngineTurn;settled:boolean;resolve:(value:ClaudeResult)=>void;reject:(error:Error)=>void;abort:()=>void};
// One turn Claude actually runs: from a message's start (or init) to its result. owner = the message that started it;
// joined = messages Claude read mid-reply; a turn Claude started itself has no owner and an automatic row instead.
type EngineTurn={id:string;scope:Scope;owner?:string;joined:Set<string>;automatic?:{complete:(result:ClaudeResult|Error)=>void};stopping?:boolean};
type NativeTask={id:string;toolId:string;owner:Scope;status:string;type:string;description:string;background:boolean;execution?:Scope};
const configuration=(o:ClaudeRun)=>JSON.stringify([o.executable,o.python,o.worker,o.prefixArgs,o.directory,o.dataRoot,o.planDirectory,o.effort,o.trustedProject,o.projectSourceGrant?.sourceHash||o.projectSettingsHash,o.pluginDirectories,o.mcp?.names,o.mcp?.managedTools,!!o.work,o.inspectUsage,o.inspectMcp,o.inspectCapabilities,!!o.chrome,o.env||null]);
const finished=(status:string)=>['completed','failed','killed','stopped','lost'].includes(status);
const wakeUpTools=new Set(['ScheduleWakeup','CronCreate']);

// One supervised Claude Code process. Claude is the only judge of busy (TURN-REVIEW part 1): its session state
// events, each message's lifecycle and each turn's result. Tris keeps no guess of its own.
export class ClaudeSession {
  readonly id=randomUUID();
  sessionId?:string;
  private child!:ReturnType<typeof spawn>;
  private lines!:ReturnType<typeof createInterface>;
  private exchange='';
  private ended=false;
  private closing=false;
  private stderr='';
  private controls=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  private requests=new Map<string,{scope?:Scope;controller:AbortController}>();
  private agents=new Map<string,Scope>();
  private sent=new Map<string,Sent>();
  private turn?:EngineTurn;
  // Claude's own report: running or idle (session_state_changed). Undefined until the first one arrives.
  private state?:'running'|'idle';
  private runningSince=0;
  private lastResult=0;
  private lifecycleSeen=false;
  private warned=false;
  private wasBusy=false;
  // A prompt the hook refused before Claude opened its turn; the turn's automatic row shows it.
  private refusal?:{kind:string;reason:string};
  private recheck?:NodeJS.Timeout;
  private idleWaiters:(()=>void)[]=[];
  // Last fixed block this process sent; unchanged blocks are not resent (Koan, 2026-10-08).
  private lastMemory?:string;
  private tools=new Map<string,{owner:Scope;name:string;input:any;directory:string;worktree?:string;permissionMode?:string;modeRevision:number;error?:string;ready?:boolean;finished?:boolean;mcpDispatched?:boolean;check?:AbortController}>();
  private tasks=new Map<string,NativeTask>();
  private models:ClaudeResult['models']=[];
  private model:string;
  private mode:Mode='manual';
  private modeRevision=0;
  private closed!:Promise<void>;
  private constructor(private initial:ClaudeRun,private hooks:ClaudeSessionHooks={}){this.model=initial.model;this.sessionId=initial.sessionId;}
  static async open(options:ClaudeRun,hooks:ClaudeSessionHooks={}){const session=new ClaudeSession(options,hooks);await session.start();return session;}
  get live(){return !this.ended&&!this.closing;}
  get pid(){return this.child?.pid;}
  get permissionMode(){return this.mode;}
  get currentModel(){return this.model;}
  // The row whose reply Claude is writing now: the message that started the open turn, or its automatic row.
  get replyRow(){return this.turn?.scope.options.turnId;}
  // Busy = Claude owes a reply: a turn is open, a message Tris sent is not answered yet, or Claude reports running.
  // A finished turn's result with no idle after it counts as idle 10 s later; silence never does (TURN-REVIEW part 1).
  get busy(){
    if(this.ended)return false;
    if(this.turn)return true;
    if([...this.sent.values()].some(sent=>!sent.settled))return true;
    return this.state==='running'&&!(this.lastResult>=this.runningSince&&Date.now()-this.lastResult>=10000);
  }
  get hasPendingWork(){return this.busy||this.runningTasks.length>0||[...this.agents.values()].some(scope=>!scope.settled);}
  // Names what keeps the session busy, for the hold log.
  get busyReasons(){const out:string[]=[];if(this.turn)out.push('claude-turn='+(this.turn.owner||'automatic'));const waiting=[...this.sent.values()].filter(sent=>!sent.settled&&!sent.turn).length;if(waiting)out.push('claude-waiting='+waiting);if(this.state==='running'&&!this.turn)out.push('claude-running');return out;}
  get runningTasks(){return [...this.tasks.values()].filter(task=>task.background&&!finished(task.status)).map(({id,toolId,status,type,owner})=>({id,toolId,status,type,turnId:owner.options.turnId||owner.id}));}
  compatible(options:ClaudeRun){return this.live&&configuration(this.initial)===configuration(options)&&(!options.sessionId||options.sessionId===this.sessionId);}
  private send(value:any){if(!this.live||!this.child.stdin?.writable||this.child.stdin.writableEnded)throw Error('Claude is no longer running.');this.child.stdin.write(JSON.stringify(value)+'\n');}
  private command(request:any,timeout=15000){return new Promise<any>((resolve,reject)=>{
    const id=randomUUID(),timer=setTimeout(()=>{this.controls.delete(id);reject(Error('Claude did not confirm '+request.subtype+'.'));},timeout);
    this.controls.set(id,{resolve,reject,timer});try{this.send({type:'control_request',request_id:id,request});}catch(error){clearTimeout(timer);this.controls.delete(id);reject(error);}
  });}
  private response(id:string,value:any){if(this.live)this.send({type:'control_response',response:{subtype:'success',request_id:id,response:value}});}
  private async start(){
    const o=this.initial;o.signal.throwIfAborted();
    this.exchange=await fs.mkdtemp(path.join(o.exchangeRoot,'claude-'));
    const settings=path.join(this.exchange,'settings.json'),mcpConfig=path.join(this.exchange,'mcp.json');
    await fs.writeFile(settings,JSON.stringify(claudeSettings(o.dataRoot,o.mcp?.managedTools,o.planDirectory)));
    await fs.writeFile(mcpConfig,JSON.stringify({mcpServers:Object.fromEntries((o.mcp?.names||[]).map(name=>[name,{type:'sdk',name}]))}));
    const args=['-p','--model',o.model,'--effort',o.effort==='none'?'low':o.effort,'--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--replay-user-messages','--permission-prompt-tool','stdio','--permission-mode','manual','--allow-dangerously-skip-permissions','--setting-sources',o.trustedProject&&!o.inspectUsage&&!o.inspectMcp&&!o.inspectCapabilities?'project':'','--settings',settings,'--strict-mcp-config','--mcp-config',mcpConfig,...(o.pluginDirectories||[]).flatMap(dir=>['--plugin-dir',dir]),...(o.inspectUsage||o.inspectMcp||o.inspectCapabilities?['--tools','']:[]),...(o.chrome?['--chrome']:[]),...(o.sessionId?['--resume',o.sessionId]:[])];
    // CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: Claude reports running and idle itself (SDK docs; proven on 2.1.283).
    this.child=spawn(o.python,[o.worker],{env:{...claudeEnvironment(),...o.env,CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS:'1'},windowsHide:true,stdio:'pipe'});
    const stderr=o.scrubber.stream();this.child.stderr!.setEncoding('utf8');this.child.stdout!.setEncoding('utf8');
    this.child.stderr!.on('data',chunk=>{this.stderr=(this.stderr+stderr(chunk)).slice(-4000);});this.child.stdin!.on('error',()=>{});
    this.closed=new Promise<void>(resolve=>{
      this.child.once('error',error=>this.fail(error));
      this.child.once('close',()=>{
        this.ended=true;clearTimeout(this.recheck);const error=Error(this.stderr||'Claude stopped before completing the turn.');
        for(const entry of this.controls.values()){clearTimeout(entry.timer);entry.reject(error);}this.controls.clear();
        for(const entry of this.requests.values())entry.controller.abort();this.requests.clear();
        const turn=this.turn;this.turn=undefined;
        if(turn){clearTimeout(turn.scope.stopTimer);turn.scope.settled=true;turn.automatic?.complete(turn.scope.cancelled?{status:'stopped',sessionId:this.sessionId,result:turn.scope.result,models:this.models}:error);}
        for(const sent of this.sent.values())if(!sent.settled)this.settleSent(sent,sent.state==='cancelled'||sent.turn?.scope.cancelled?{status:'stopped',sessionId:this.sessionId,result:sent.turn?.scope.result,models:this.models}:error);
        for(const scope of this.agents.values())if(!scope.settled)this.settleAgent(scope,scope.cancelled?undefined:error);
        for(const task of this.tasks.values())if(!finished(task.status))task.status='lost';
        this.hooks.event?.({type:'runtime.closed',runtimeId:this.id});this.changed();
        this.lines?.close();resolve();
      });
    });
    this.lines=createInterface({input:this.child.stdout!});this.lines.on('line',line=>{try{this.receive(JSON.parse(line));}catch(error){this.fail(Error('Invalid Claude stream: '+o.scrubber.text(String(error))));}});
    const abort=()=>void this.close();o.signal.addEventListener('abort',abort,{once:true});
    try{
      this.send({executable:o.executable,args:[...(o.prefixArgs||[]),...args],cwd:o.directory});
      // Session definitions carry the app's reviewed grant without changing the
      // user's global Claude trust. Inline MCP connections still use our owner.
      const agents=o.trustedProject?Object.fromEntries(Object.entries(o.projectAgents||{}).map(([name,definition])=>{const {mcpServers,...agent}=definition;return [name,{...agent,...(Array.isArray(mcpServers)?{mcpServers:mcpServers.filter(value=>typeof value==='string'&&o.mcp?.names.includes(value))}:{})}];})):undefined;
      const result=await this.command({subtype:'initialize',...(agents&&Object.keys(agents).length?{agents}:{}),hooks:{UserPromptSubmit:[{matcher:'',hookCallbackIds:['turn-owner']}],SubagentStart:[{matcher:'',hookCallbackIds:['agent-owner']}],PreToolUse:[{matcher:'',hookCallbackIds:['fixed-protection']}],...(o.work?{PostToolUse:[{matcher:'',hookCallbackIds:['fixed-work-finish']}],PostToolUseFailure:[{matcher:'',hookCallbackIds:['fixed-work-finish']}]}:{})}},60000);
      const offered=result.models;
      if(Array.isArray(offered))this.models=offered.filter(item=>typeof item.value==='string'&&/^[a-zA-Z0-9._:-]+$/.test(item.value)).map(item=>({id:'claude-code:'+item.value,label:String(item.displayName||item.value),...(typeof item.description==='string'&&item.description.trim()?{description:item.description.trim().slice(0,300)}:{}),efforts:Array.isArray(item.supportedEffortLevels)?item.supportedEffortLevels.filter((v:unknown)=>typeof v==='string'):['low','medium','high']}));
      this.initialized=result;
    }catch(error){await this.close();throw error;}finally{o.signal.removeEventListener('abort',abort);}
  }
  private initialized:any;
  private fail(error:Error){for(const sent of this.sent.values())if(!sent.settled)this.settleSent(sent,error);void this.close();}
  async setMode(mode:Mode){await this.command({subtype:'set_permission_mode',mode:permissionModes[mode]});this.mode=mode;this.modeRevision++;}
  async stopTask(id:string){const task=this.tasks.get(id);if(!task)throw Error('This native task does not belong to this session.');if(task.execution&&!task.execution.settled)await this.cancelAgent(task.execution);else await this.command({subtype:'stop_task',task_id:id});}
  async close(){
    if(!this.closing){this.closing=true;for(const entry of this.requests.values())entry.controller.abort();this.child?.stdin?.end();}
    await this.closed;
    if(this.exchange){const dir=this.exchange;this.exchange='';if(path.dirname(await fs.realpath(dir))!==await fs.realpath(this.initial.exchangeRoot))throw Error('Unexpected exchange directory.');await fs.rm(dir,{recursive:true,force:true});}
  }
  private createScope(options:ClaudeRun):Scope{
    const scope:Scope={id:randomUUID(),directory:options.directory,options,settled:false,cancelled:false,abort:()=>{},text:options.scrubber.stream(),thinking:options.scrubber.stream()};
    return scope;
  }
  // Busy changed: main hears idle at once (the runner releases a held message on it), and busy for the screen.
  private changed(){
    const busy=this.busy;clearTimeout(this.recheck);
    if(busy&&!this.turn&&this.state==='running'&&this.lastResult>=this.runningSince){this.recheck=setTimeout(()=>this.changed(),Math.max(0,this.lastResult+10000-Date.now())+5);this.recheck.unref?.();}
    if(!busy)for(const resolve of this.idleWaiters.splice(0))resolve();
    if(busy===this.wasBusy)return;this.wasBusy=busy;
    this.hooks.event?.({type:busy?'runtime.busy':'runtime.idle',runtimeId:this.id});
  }
  // Stop: the running reply only (TURN-REVIEW part 5). Messages waiting behind it stay and go out after it, as in
  // Claude Code; the receipt names them. No end within 8 s closes the process.
  async interrupt(){
    const turn=this.turn;if(!turn)return {stillQueued:[] as string[]};
    if(!turn.stopping){
      turn.stopping=true;turn.scope.cancelled=true;
      for(const [id,item] of this.requests)if(item.scope===turn.scope){item.controller.abort();turn.scope.options.event({type:'approval.cancel',id});}
      turn.scope.stopTimer=setTimeout(()=>void this.close(),8000);turn.scope.stopTimer.unref?.();
    }
    const receipt=await this.command({subtype:'interrupt'}).catch(()=>({}));
    return {stillQueued:Array.isArray(receipt?.still_queued)?receipt.still_queued.filter((id:unknown)=>typeof id==='string'):[]};
  }
  // His remove button for a message Claude has not taken yet (cancel_async_message, Claude Code 2.1.283).
  async withdraw(id:string){
    const sent=this.sent.get(id);if(!sent||sent.settled)return true;if(!['sent','queued'].includes(sent.state))return false;
    const answer=await this.command({subtype:'cancel_async_message',message_uuid:id});
    if(answer?.cancelled!==true)return false;
    sent.state='cancelled';this.settleSent(sent,{status:'stopped',sessionId:this.sessionId,result:undefined,models:this.models});this.changed();return true;
  }
  private cancelAgent(scope:Scope){
    if(scope.settled)return Promise.resolve();if(scope.stopRequest)return scope.stopRequest;scope.cancelled=true;
    for(const [id,item] of this.requests)if(item.scope===scope){item.controller.abort();scope.options.event({type:'approval.cancel',id});}
    // An agent's Stop must not interrupt a newer foreground reply.
    scope.stopRequest=this.command({subtype:'stop_task',task_id:scope.agentId}).then(()=>{});
    scope.stopTimer=setTimeout(()=>void this.close(),8000);return scope.stopRequest;
  }
  // Sends his message to Claude at once, busy or not; Claude reads it after its current step (priority next), as when
  // typed in Claude Code. A model change waits for idle: the chat runner holds it until then.
  async submit(options:ClaudeRun):Promise<ClaudeResult>{
    options.signal.throwIfAborted();if(!this.compatible(options))throw Error('The native session configuration changed. Start a fresh session after preserving its running tasks.');
    const id=options.turnId||randomUUID();if(this.sent.has(id))throw Error('This message was already sent to Claude.');
    if(this.initial.projectSourceGrant&&options.projectSourceGrant){options.projectSourceGrant=this.initial.projectSourceGrant;options.adoptProjectSources?.(this.initial.projectSourceGrant);}
    // A turn's idle comes a moment after its result: a model change waits for it, never for a turn still running.
    if(this.model!==options.model&&this.busy&&!this.turn&&!this.sent.size)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,10000);this.idleWaiters.push(()=>{clearTimeout(timer);resolve();});});
    const idle=!this.busy;
    if(this.model!==options.model){if(!idle)throw Error('Claude is still answering; the model changes when it is idle.');await this.command({subtype:'set_model',model:options.model});this.model=options.model;}
    // Native tools can change modes, including during an interrupted turn. While idle, the saved project mode is
    // confirmed before the next message; while busy, mode changes reach the session when he makes them.
    if(idle)await this.setMode(options.mode);
    options.signal.throwIfAborted();const unavailable=options.beforePrompt?.();if(unavailable)throw Error(unavailable);
    options.controls?.({setMode:mode=>this.setMode(mode)});
    if(options.inspectCapabilities)return {status:'completed',sessionId:this.sessionId,result:options.scrubber.value({commands:this.initialized.commands||[],agents:this.initialized.agents||[]}),models:this.models};
    if(options.inspectUsage)return {status:'completed',sessionId:this.sessionId,result:options.scrubber.value(await this.command({subtype:'get_usage'})),models:this.models};
    if(options.inspectMcp){
      const until=Date.now()+30000;let status:any;
      do{status=await this.command({subtype:'mcp_status'});if(!options.mcp?.names.length||status.mcpServers?.length&&!status.mcpServers.some((s:any)=>s.status==='pending'))break;await new Promise(r=>setTimeout(r,250));}while(Date.now()<until);
      return {status:'completed',sessionId:this.sessionId,result:options.scrubber.value(status),models:this.models};
    }
    let resolve!:(value:ClaudeResult)=>void,reject!:(error:Error)=>void;const answer=new Promise<ClaudeResult>((a,b)=>{resolve=a;reject=b;});void answer.catch(()=>{});
    const sent:Sent={id,options:{...options,turnId:id},state:'sent',settled:false,resolve,reject,abort:()=>{}};
    // His Stop on this message: the reply it is in stops; a message Claude has not taken yet is withdrawn.
    sent.abort=()=>{if(sent.settled)return;if(sent.turn&&sent.turn===this.turn)void this.interrupt();else void this.withdraw(id).catch(()=>{});};
    options.signal.addEventListener('abort',sent.abort,{once:true});
    this.sent.set(id,sent);
    try{this.send({type:'user',uuid:id,priority:'next',origin:{kind:'human'},message:{role:'user',content:[{type:'text',text:'[Ghidorah turn '+id+']\n'+options.prompt},...(options.projectMemory&&options.projectMemory!==this.lastMemory?[{type:'text',text:(this.lastMemory=options.projectMemory)}]:[]),...(options.attachments||[])]},session_id:this.sessionId||'',parent_tool_use_id:null});}
    catch(error){this.settleSent(sent,error instanceof Error?error:Error(String(error)));return answer;}
    this.changed();
    // Session-start check: Claude reports a message's state within a second. Without it Tris follows replies only.
    if(!this.lifecycleSeen)setTimeout(()=>{if(!this.lifecycleSeen&&this.live&&!this.warned&&this.sent.has(id)){this.warned=true;this.hooks.event?.({type:'runtime.warning',runtimeId:this.id,message:'Claude Code did not report its message states, so Tris follows its replies only.'});}},3000).unref?.();
    return answer;
  }
  private settleSent(sent:Sent,value:ClaudeResult|Error){
    if(sent.settled)return;sent.settled=true;sent.options.signal.removeEventListener('abort',sent.abort);this.sent.delete(sent.id);
    if(value instanceof Error)sent.reject(value);else sent.resolve(value);
  }
  private settleAgent(scope:Scope,error?:Error){
    error||=scope.error;
    if(scope.settled)return;scope.settled=true;clearTimeout(scope.stopTimer);scope.options.signal.removeEventListener('abort',scope.abort);
    if(error&&!scope.cancelled)scope.reject?.(error);else scope.resolve?.({status:scope.cancelled?'stopped':scope.result?.is_error?'failed':'completed',sessionId:this.sessionId,result:scope.result,models:this.models});
  }
  // A turn opens on the start of one of his messages, or on init for a turn Claude starts itself.
  private open(sent?:Sent){
    let options:ClaudeRun,automatic:EngineTurn['automatic'];
    if(sent)options=sent.options;
    else{
      const made=this.hooks.automatic?.({runtimeId:this.id,model:this.model});
      // Nobody owns it (the chat is gone): its tools are refused and its text goes nowhere.
      options=made?.options||{...this.initial,turnId:undefined,event:()=>{},approve:async()=>false,work:undefined,delegation:undefined,controls:undefined,modeChanged:undefined};
      automatic=made?{complete:made.complete}:undefined;
    }
    const turn:EngineTurn={id:randomUUID(),scope:this.createScope(options),owner:sent?.id,joined:new Set(),automatic};
    if(sent)sent.turn=turn;this.turn=turn;
    options.event({type:'runtime.turn',state:'open',engineTurnId:turn.id,runtimeId:this.id,owner:sent?.id});
    if(!sent&&this.refusal){options.event({type:'runtime.promptRefused',...this.refusal});this.refusal=undefined;}
    this.changed();
  }
  // Claude read this message mid-reply: the running reply answers it (live check 1).
  private join(sent:Sent){
    const turn=this.turn!;sent.turn=turn;if(sent.id!==turn.owner)turn.joined.add(sent.id);
    sent.options.event({type:'runtime.joined',engineTurnId:turn.id,answeredIn:turn.scope.options.turnId});
  }
  private started(sent:Sent){if(sent.turn||sent.settled)return;sent.state='started';if(this.turn)this.join(sent);else this.open(sent);}
  private lifecycle(id:unknown,state:unknown){
    const sent=typeof id==='string'?this.sent.get(id):undefined;if(!sent)return;this.lifecycleSeen=true;
    if(state==='queued'){if(sent.state==='sent'){sent.state='queued';sent.options.event({type:'runtime.delivery',state:'queued'});}}
    else if(state==='started')this.started(sent);
    else if(state==='completed'||state==='cancelled'){
      if(sent.state!=='cancelled')sent.state=state;
      // A message ends with its turn's result. One that never joined a turn (a blocked prompt, a withdrawn one) ends here.
      if(!sent.turn)this.settleSent(sent,{status:state==='cancelled'?'stopped':'completed',sessionId:this.sessionId,result:undefined,models:this.models});
    }
    this.changed();
  }
  private finishTurn(turn:EngineTurn,message:any){
    this.turn=undefined;this.refusal=undefined;this.lastResult=Date.now();clearTimeout(turn.scope.stopTimer);turn.scope.settled=true;
    const scope=turn.scope,o=scope.options,cancelled=scope.cancelled,status:ClaudeResult['status']=cancelled?'stopped':message.is_error?'failed':'completed';
    scope.result=o.scrubber.value(message);
    const result:ClaudeResult={status,sessionId:this.sessionId,result:scope.result,models:this.models};
    o.event({type:'runtime.turn',state:'closed',engineTurnId:turn.id,status,messages:[...(turn.owner?[turn.owner]:[]),...turn.joined]});
    if(turn.owner){const owner=this.sent.get(turn.owner);if(owner)this.settleSent(owner,{...result,status:owner.state==='cancelled'?'stopped':status});}
    else turn.automatic?.complete(result);
    for(const id of turn.joined){const sent=this.sent.get(id);if(sent)this.settleSent(sent,{status:cancelled?'stopped':'completed',sessionId:this.sessionId,result:undefined,models:this.models,answeredIn:o.turnId});}
    // The context reading comes after the result and never holds the chat (it held the next message up to 4 s).
    void this.command({subtype:'get_context_usage'},4000).then(value=>o.event({type:'runtime.context',context:o.scrubber.value(value)}),()=>{});
    this.changed();
  }
  private refuse(scope:Scope|undefined,refusal:{kind:string;reason:string}){if(scope)scope.options.event({type:'runtime.promptRefused',...refusal});else this.refusal=refusal;}
  private owner(request:any){
    const input=request.subtype==='hook_callback'?request.input:undefined,toolId=input?.tool_use_id||request.tool_use_id;
    const agentId=input?.agent_id||request.agent_id;if(agentId){const scope=this.tasks.get(agentId)?.execution,tool=this.tools.get(toolId);return tool&&tool.owner!==scope?undefined:scope;}
    return this.tools.get(toolId)?.owner||this.turn?.scope;
  }
  private agentConfig(scope:Scope,model:unknown,effort?:unknown,mode?:unknown){
    if(!scope.agentId)return;
    const config={...(typeof model==='string'&&/^[a-zA-Z0-9._:-]+(?:\[1m\])?$/.test(model)?{resolvedModel:model}:{}),...((typeof effort==='number'&&Number.isFinite(effort)||typeof effort==='string'&&/^(low|medium|high|xhigh|max|\d+)$/.test(effort))?{effort:String(effort)}:{}),...(typeof mode==='string'&&['default','manual','acceptEdits','plan','auto','bypassPermissions','dontAsk'].includes(mode)?{permissionMode:mode}:{})};
    if(Object.keys(config).length)scope.options.event(scope.options.scrubber.value({type:'runtime.agentConfig',...config}));
  }
  // tool-timing.log beside queue.log: Tris's own time per tool (protection and lock before, permission check, finish),
  // with the user's approval wait shown apart (RUN-PLAN 3f; scripts/health-report.mjs reads it).
  private timings=new Map<string,{name:string;pre:number;check:number;approval:number}>();
  private timing(key:string,r:any,ms:number){
    if(!key||!['fixed-protection','fixed-work-finish'].includes(r?.callback_id)&&r?.subtype!=='can_use_tool')return;
    const row=this.timings.get(key)||{name:String(r.input?.tool_name||r.tool_name||''),pre:0,check:0,approval:0};this.timings.set(key,row);
    if(r.callback_id==='fixed-protection')row.pre+=ms;else if(r.subtype==='can_use_tool')row.check+=ms;
    else{this.timings.delete(key);const check=row.check-row.approval,total=row.pre+check+ms,f=(n:number)=>Math.round(n);
      void fs.appendFile(path.join(this.initial.dataRoot,'tool-timing.log'),`${new Date().toISOString()} engine=claude tool=${row.name} pre=${f(row.pre)} check=${f(check)} approval=${f(row.approval)} finish=${f(ms)} total=${f(total)}\n`).catch(()=>{});}
    if(this.timings.size>200)this.timings.delete(this.timings.keys().next().value!);
  }
  private async approvalWait<T>(key:string,ask:()=>Promise<T>){const started=performance.now();try{return await ask();}finally{const row=this.timings.get(key);if(row)row.approval+=performance.now()-started;else if(key)this.timings.set(key,{name:'',pre:0,check:0,approval:performance.now()-started});}}
  private async control(message:any){
    const id=message.request_id,r=message.request;if(typeof id!=='string'||this.requests.has(id))return;
    let scope=this.owner(r);const entry={scope,controller:new AbortController()};this.requests.set(id,entry);
    const started=performance.now(),toolKey=String(r?.input?.tool_use_id||r?.tool_use_id||'');
    const respond=(value:any)=>{if(this.requests.has(id)){this.timing(toolKey,r,performance.now()-started);this.response(id,value);}};
    let toolStarted=false;
    const recordTool=(status:string,result?:unknown)=>scope?.options.event(scope.options.scrubber.value({type:'runtime.tool',id:r.input?.tool_use_id||r.tool_use_id,name:r.input?.tool_name,input:r.input?.tool_input,status,result}));
    try{
      if(r.subtype==='hook_callback'&&r.callback_id==='agent-owner'){
        const task=this.tasks.get(r.input?.agent_id);if(!task||task.type!=='local_agent'||task.execution||finished(task.status)||!task.owner.options.delegation)throw Error('This agent has no live verified launching task.');
        const agentType=String(r.input?.agent_type||''),declared=this.initialized.agents?.find((agent:any)=>agent.name===agentType)?.model;
        const requested=this.tools.get(task.toolId)?.input?.model||declared,model=requested&&requested!=='inherit'?requested:task.owner.options.model;
        const origin=this.tools.get(task.toolId)?.directory||task.owner.directory,location=await claudeDirectory(r.input?.cwd||origin,origin,task.owner.options.dataRoot);
        const next=await task.owner.options.delegation({id:task.id,toolId:task.toolId,model:task.owner.options.scrubber.text(String(model)),runtimeId:this.id,description:task.description,agentType:task.owner.options.scrubber.text(agentType)});
        if(finished(task.status)){next.complete({status:'stopped',sessionId:this.sessionId,result:{result:''},models:this.models});throw Error('This agent stopped before initialization completed.');}
        if(next.options.signal.aborted||!this.compatible(next.options)){next.complete(Error('The native agent configuration changed or was stopped.'));throw Error('The native agent cannot start.');}
        let resolve!:(value:ClaudeResult)=>void,reject!:(error:Error)=>void;const answer=new Promise<ClaudeResult>((a,b)=>{resolve=a;reject=b;});
        scope=this.createScope(next.options);Object.assign(scope,{agentId:task.id,taskId:task.id,resolve,reject,...location});task.execution=scope;entry.scope=scope;this.agents.set(task.id,scope);
        scope.abort=()=>{void this.cancelAgent(scope!).catch(()=>this.close());};next.options.signal.addEventListener('abort',scope.abort,{once:true});
        scope.options.event(scope.options.scrubber.value({type:'runtime.agentConfig',...location}));
        void answer.then(next.complete,error=>next.complete(error instanceof Error?error:Error(String(error))));
        respond({hookSpecificOutput:{hookEventName:'SubagentStart',additionalContext:next.options.projectMemory||''}});return;
      }
      if(r.subtype==='hook_callback'&&r.callback_id==='turn-owner'){
        // Answered at once from what Tris already knows (TURN-REVIEW part 1). Claude's hook input carries only the
        // prompt text, so a message from another Claude session is known by the wrapper Claude puts on it.
        const text=String(r.input?.prompt||'');
        if(/^\s*<cross-session-message[\s>]/.test(text)){
          const reason='This chat does not take messages from other Claude sessions.';
          this.refuse(scope,{kind:'cross-session',reason});respond({decision:'block',reason});return;
        }
        if(!text.startsWith('[Ghidorah turn ')){
          // A job notice, wake-up or timer: allowed (his decision 2026-10-14) while its model's account can answer.
          const reason=(scope?.options||this.initial).beforePrompt?.(this.model);
          if(reason){this.refuse(scope,{kind:'unavailable',reason});this.hooks.event?.({type:'runtime.promptBlocked',runtimeId:this.id,model:this.model,reason});respond({decision:'block',reason});return;}
          scope?.options.event({type:'runtime.automaticKind',kind:/^\s*<task-notification>/.test(text)?'notice':'self'});
        }
        respond({});return;
      }
      if(r.subtype==='mcp_message'){
        let location:{directory:string;worktree?:string}|undefined;
        if(r.message?.method==='tools/call'){
          const canonical=(value:any)=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
          // Claude carries the originating hook ID outside the tool arguments.
          // Older clients may omit it; only one matching admitted call is safe.
          const toolId=r.message.params?._meta?.['claudecode/toolUseId'];
          const candidates=(toolId===undefined?[...this.tools.values()]:typeof toolId==='string'?[this.tools.get(toolId)]:[]).filter(tool=>tool?.ready&&!tool.finished&&tool.name===`mcp__${r.server_name}__${r.message.params?.name}`&&canonical(tool.input)===canonical(r.message.params?.arguments||{}));
          if(candidates.length!==1||candidates[0]!.mcpDispatched)throw Error('MCP call has no unambiguous undispatched owning tool.');const tool=candidates[0]!;scope=tool.owner;location=tool;tool.mcpDispatched=true;
        }else scope=this.turn?.scope;
        entry.scope=scope;const o=scope?.options||this.initial;
        if(!o.mcp||scope?.cancelled||r.message?.method==='tools/call'&&scope?.settled||entry.controller.signal.aborted)throw Error('MCP exchange ended.');
        if(r.message?.method==='tools/call'&&await protectedClaudeTool(r.message.params?.arguments||{},o.dataRoot,location?.directory||scope!.directory,location?.worktree,r.message.params?.name))throw Error('Protected credential access is denied.');
        respond({mcp_response:await o.mcp.handle(r.server_name,r.message,entry.controller.signal,location?.directory)});return;
      }
      if(!scope||scope.cancelled)throw Error('This tool has no active owning turn.');entry.scope=scope;const o=scope.options;
      if(r.subtype==='hook_callback')this.agentConfig(scope,undefined,r.input?.effort?.level,r.input?.permission_mode);
      if(r.subtype==='hook_callback'&&r.callback_id==='fixed-protection'){
        const input=r.input,toolId=input?.tool_use_id||r.tool_use_id;
        if(typeof toolId!=='string'||!toolId)throw Error('Missing tool identity.');
        if(this.tools.has(toolId))throw Error('This native tool identity was already dispatched.');
        recordTool('running');toolStarted=true;
        if(input.tool_name==='Agent'&&!o.delegation)throw Error('This runner cannot own delegated tasks.');
        if(input.tool_name==='SendMessage'&&this.tasks.get(input.tool_input?.to)?.type!=='local_agent')throw Error('Choose an agent owned by this native session.');
        if(['TaskStop','TaskOutput'].includes(input.tool_name)&&!this.tasks.has(input.tool_input?.task_id||input.tool_input?.shell_id))throw Error('This native task belongs to another session. Use its desktop controls.');
        if(wakeUpTools.has(input.tool_name)&&o.wakeUps&&!o.wakeUps())throw Error('Wake-ups and timers are off in this chat (Let Claude wake itself up).');
        const location=o.hasFolder?await claudeDirectory(input.cwd||scope.directory,scope.directory,o.dataRoot):{directory:scope.directory,worktree:undefined};
        const denied=await protectedClaudeTool(input.tool_input,o.dataRoot,location.directory,location.worktree,input.tool_name)||(!o.hasFolder&&!['TodoWrite','AskUserQuestion','ToolSearch','EnterPlanMode','ExitPlanMode',...(o.mcp?.managedTools||[])].includes(input.tool_name));
        if(denied){const reason=o.hasFolder?'Protected credential access is denied.':'Choose the root working folder in Settings before using file or command tools.';recordTool('failed',reason);respond({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}});return;}
        Object.assign(scope,location);this.tools.set(toolId,{owner:scope,name:input.tool_name,input:input.tool_input,permissionMode:input.permission_mode,modeRevision:this.modeRevision,...location,check:entry.controller});await o.work?.before(toolId,input.tool_name,input.tool_input,location.directory,entry.controller.signal);if(scope.cancelled)throw Error('This task was stopped.');const tool=this.tools.get(toolId)!;tool.ready=true;
        const planning=this.mode==='plan'||input.permission_mode==='plan',differentShellMode=this.mode==='plan'&&scope.agentId&&input.tool_name==='Bash'&&input.permission_mode!=='plan';
        if(planning&&fileEditingTools.has(input.tool_name)&&!await nativePlanFile(input.tool_name,input.tool_input,o.planDirectory)||differentShellMode){const reason=differentShellMode?'This native agent retained a different permission mode. Use file inspection tools while the project is in Plan.':'Plan mode permits inspection and proposals only. Change the permission mode before editing.';await o.work?.after(toolId,reason,true,true);tool.finished=true;recordTool('failed',reason);respond({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}});return;}
        respond({});
      }else if(r.subtype==='hook_callback'&&r.callback_id==='fixed-work-finish'){
        const input=r.input,toolId=input?.tool_use_id||r.tool_use_id;
        const tool=this.tools.get(toolId);if(!tool||tool.owner!==scope)throw Error('This tool result has no registered owner.');
        recordTool(input.hook_event_name==='PostToolUseFailure'?'failed':'completed',input.tool_response??input.error);
        if(!scope.agentId&&input.hook_event_name==='PostToolUse'&&['EnterPlanMode','ExitPlanMode'].includes(tool.name)){
          const mode=input.permission_mode==='default'?'manual':Object.entries(permissionModes).find(([,value])=>value===input.permission_mode)?.[0] as Mode|undefined;
          if(!mode)throw Error('Claude did not report its resulting permission mode.');
          const current=()=>tool.modeRevision===this.modeRevision;
          try{if(o.modeChanged)await o.modeChanged(mode,current);else if(current()){this.mode=mode;this.modeRevision++;}else await this.setMode(this.mode);}catch(error){tool.error=o.scrubber.text(String(error));scope.error=Error('The permission mode could not be synchronized. '+tool.error);recordTool('failed',tool.error);throw error;}
        }
        if(input.tool_name==='Agent'){const task=[...this.tasks.values()].find(task=>task.toolId===toolId);if(task?.execution&&input.tool_response?.agentId===task.id)this.agentConfig(task.execution,input.tool_response.resolvedModel);}
        await o.work?.after(toolId,input.tool_response??input.error,input.hook_event_name==='PostToolUseFailure');this.tools.get(toolId)!.finished=true;respond({});
      }else if(r.subtype==='can_use_tool'){
        const tool=this.tools.get(r.tool_use_id),location=tool||scope;
        const planCurrent=async()=>r.tool_name!=='ExitPlanMode'||!r.input?.planFilePath||await nativePlanFile('Write',{file_path:r.input.planFilePath},o.planDirectory)&&await fs.readFile(r.input.planFilePath,'utf8')===r.input.plan;
        // Native Plan sends edits and shell commands it cannot approve as
        // read-only here. They must not become ordinary approval prompts.
        const planning=()=>this.mode==='plan'||tool?.permissionMode==='plan';
        const planBlocked=async()=>planning()&&(r.tool_name==='Bash'||fileEditingTools.has(r.tool_name)&&!await nativePlanFile(r.tool_name,r.input,o.planDirectory));
        const deny=async(message:string)=>{if(tool&&!tool.finished){await o.work?.after(r.tool_use_id,message,true,true);tool.finished=true;o.event({type:'runtime.tool',id:r.tool_use_id,name:tool.name,input:o.scrubber.value(tool.input),status:'failed',result:message});}respond({behavior:'deny',message});};
        if(!await planCurrent()){await deny('The saved plan changed. Read it and request approval again.');return;}
        if(await planBlocked()){await deny('Plan mode permits inspection and proposals only. Change the permission mode before editing or running this command.');return;}
        const allowed=!await protectedClaudeTool(r.input,o.dataRoot,location.directory,location.worktree,r.tool_name)&&(planning()&&await nativePlanFile(r.tool_name,r.input,o.planDirectory)||r.tool_name==='ToolSearch'||o.mcp?.managedTools?.includes(r.tool_name)||await this.approvalWait(toolKey,()=>o.approve(id,r.tool_name,o.scrubber.value(r.input),location.directory)));
        if(!scope.cancelled&&allowed&&!await planBlocked()&&await planCurrent()&&!await protectedClaudeTool(r.input,o.dataRoot,location.directory,location.worktree,r.tool_name))respond({behavior:'allow',updatedInput:typeof allowed==='object'?allowed.input:r.input});else await deny('The requested action was denied or the saved plan changed.');
      }else respond({behavior:'deny',message:'Unsupported app request.'});
    }catch(error){
      if(r.subtype==='hook_callback'&&r.callback_id==='turn-owner')respond({});
      else if(r.subtype==='hook_callback'&&r.callback_id==='fixed-protection'){
        if(toolStarted){recordTool('failed',String(error));const tool=this.tools.get(r.input?.tool_use_id||r.tool_use_id);if(tool)tool.finished=true;}
        respond({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:this.initial.scrubber.text(String(error))}});
      }
      else if(r.subtype==='mcp_message')respond({mcp_response:{jsonrpc:'2.0',id:r.message?.id??null,error:{code:-32603,message:'MCP request refused.'}}});
      else respond(r.subtype==='hook_callback'?{continue:false,stopReason:'App permission check failed.'}:{behavior:'deny',message:'App permission check failed.'});
    }finally{this.requests.delete(id);}
  }
  private receive(message:any){
    if(message.type==='control_response'){
      const value=message.response,entry=this.controls.get(value?.request_id);if(!entry)return;clearTimeout(entry.timer);this.controls.delete(value.request_id);
      if(value.subtype==='success')entry.resolve(value.response);else entry.reject(Error(this.initial.scrubber.text(String(value.error||'Claude control failed.'))));return;
    }
    if(message.type==='control_request'){void this.control(message);return;}
    if(message.type==='control_cancel_request'){const entry=this.requests.get(message.request_id);entry?.controller.abort();entry?.scope?.options.event({type:'approval.cancel',id:message.request_id});this.requests.delete(message.request_id);return;}
    if(typeof message.session_id==='string')this.sessionId=message.session_id;
    // Claude's own word on busy (TURN-REVIEW part 1).
    if(message.type==='system'&&message.subtype==='session_state_changed'){
      const next=message.state==='running'?'running':'idle';if(next==='running'&&this.state!=='running')this.runningSince=Date.now();this.state=next;this.changed();return;
    }
    if(message.type==='command_lifecycle'){this.lifecycle(message.command_uuid,message.state);return;}
    if(message.type==='system'&&message.subtype==='init'&&!this.turn){
      // A turn starts. Without lifecycle events (fallback) the oldest message not yet answered is the likeliest owner.
      const waiting=this.lifecycleSeen?undefined:[...this.sent.values()].find(sent=>!sent.settled&&!sent.turn);
      if(waiting)this.started(waiting);else this.open();
    }
    // A replayed message is the moment Claude reads it: his message read mid-reply joins the running reply.
    if(message.type==='user'&&message.isReplay){const sent=this.sent.get(message.uuid);if(sent){this.started(sent);return;}}
    if(message.type==='user'&&Array.isArray(message.message?.content))for(const block of message.message.content)if(block.type==='tool_result'){const tool=this.tools.get(block.tool_use_id);if(tool){
      // A result with no finish hook: Claude Code refused the tool itself (its deny rules) or gave up waiting for
      // Tris's check (its hook limit). Free the tool's work lock, or stop its wait so it never takes the lock later
      // (10-16 KOAN.live chat: 10 tools waited 10 min each). The work review settles the outcome.
      if(!tool.finished){if(tool.ready)void tool.owner.options.work?.after(block.tool_use_id,block.content,true).catch(()=>{});else tool.check?.abort();}
      tool.finished=true;if(tool.error){block.is_error=true;block.content=tool.error;}}}
    const parentTask=message.parent_tool_use_id?[...this.tasks.values()].find(task=>task.toolId===message.parent_tool_use_id):undefined;
    let scope=parentTask?.execution||this.tools.get(message.parent_tool_use_id)?.owner||this.turn?.scope;
    if(message.type==='system'&&message.subtype==='task_started'){
      const owner=this.tools.get(message.tool_use_id)?.owner;
      // Only is_backgrounded:true is a background job; foreground commands report tasks too (live check 2, item 6).
      if(owner&&typeof message.task_id==='string'){this.tasks.set(message.task_id,{id:message.task_id,toolId:message.tool_use_id,owner,status:'running',type:message.task_type||'unknown',description:owner.options.scrubber.text(String(message.description||'Claude task')),background:message.is_backgrounded===true||message.task_type==='local_agent'});scope=owner;}
    }else if(message.type==='system'&&['task_updated','task_notification'].includes(message.subtype)){
      const task=this.tasks.get(message.task_id);if(task){task.status=message.patch?.status||message.status||task.status;scope=task.owner;
        if(task.execution&&['completed','failed','killed','stopped'].includes(task.status)){
          const agent=task.execution,summary=agent.options.scrubber.value(message.summary),usage=agent.options.scrubber.value(message.usage);agent.result||={};Object.assign(agent.result,{is_error:task.status==='failed',...(summary?{result:summary}:{}),...(usage?{native_task_usage:usage}:{})});
          if(['killed','stopped'].includes(task.status))agent.cancelled=true;
          agent.options.event({type:'runtime.agentResult',summary,usage,status:task.status});this.settleAgent(agent);
        }
      }
    }
    if(message.type==='result'){
      // An agent's own result is its task's business; the session's turn closes on its own result only.
      if(message.parent_tool_use_id)return;
      // The messages this result answers: user_message_uuids (2.1.283), or the single user_message_uuid older versions send.
      const answered:string[]=[...(Array.isArray(message.user_message_uuids)?message.user_message_uuids:[]),...(typeof message.user_message_uuid==='string'?[message.user_message_uuid]:[])];
      // Fallback without lifecycle events: a result with no open turn belongs to the messages it lists.
      if(!this.turn){const first=answered.map(id=>this.sent.get(id)).find(Boolean);if(first)this.started(first);else this.open();}
      for(const id of answered){const sent=this.sent.get(id);if(sent&&!sent.turn)this.started(sent);}
      const turn=this.turn!,o=turn.scope.options;this.flush(turn.scope);o.event({...o.scrubber.value(message),runtimeId:this.id});
      this.finishTurn(turn,message);return;
    }
    if(!scope)return;const o=scope.options;
    this.agentConfig(scope,message.type==='stream_event'&&message.event?.type==='message_start'?message.event.message?.model:message.type==='assistant'?message.message?.model:undefined);
    if(scope.agentId&&message.type==='assistant'&&Array.isArray(message.message?.content)){const text=message.message.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('');if(text)scope.result={...scope.result,result:(scope.result?.result||'')+o.scrubber.text(text)};}
    if(message.type==='stream_event'){
      const delta=message.event?.delta;
      if(delta?.type==='text_delta')o.event({...message,event:{...message.event,delta:{type:'text_delta',text:scope.text(String(delta.text||''))}}});
      else if(delta?.type==='thinking_delta')o.event({...message,event:{...message.event,delta:{type:'thinking_delta',thinking:scope.thinking(String(delta.thinking||''))}}});
      else if(!delta)o.event(o.scrubber.value(message));
    }else o.event({...o.scrubber.value(message),runtimeId:this.id});
  }
  // The scrubbers hold back a few characters in case a secret spans chunks; the turn's end releases them.
  private flush(scope?:Scope){if(!scope)return;for(const [field,scrub] of [['text',scope.text],['thinking',scope.thinking]] as const){const tail=scrub('',true);if(tail)scope.options.event({type:'stream_event',event:{type:'content_block_delta',delta:{type:field+'_delta',[field]:tail}}});}}
}

// One answer with every tool, setting, hook and MCP server off. Used for a Claude model on select duty.
export function claudeOneShot(executable:string,model:string,system:string,prompt:string,cwd:string,dataRoot:string,signal:AbortSignal,timeoutMs:number,prefix:string[]=[]){
 return new Promise<{text:string;usage:any}>((resolve,reject)=>{
  signal.throwIfAborted();
  const child=spawn(executable,[...prefix,'-p','--model',model,'--output-format','json','--tools','','--setting-sources','','--settings',JSON.stringify(claudeSettings(dataRoot)),'--strict-mcp-config','--append-system-prompt',system],{env:claudeEnvironment(),cwd,windowsHide:true,stdio:'pipe'});
  let out='',settled=false;const stop=()=>{if(child.pid)execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});};
  const finish=(error:Error|null,value?:{text:string;usage:any})=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);if(error)reject(error);else resolve(value!);};
  const timer=setTimeout(()=>{stop();finish(Object.assign(Error('The model request timed out.'),{name:'TimeoutError'}));},timeoutMs);
  const abort=()=>{stop();finish(signal.reason instanceof Error?signal.reason:Error('Stopped.'));};signal.addEventListener('abort',abort,{once:true});
  child.stdout.on('data',chunk=>{out+=chunk;if(out.length>2_000_000)stop();});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
  child.once('error',error=>finish(error));
  child.once('close',()=>{try{const result=JSON.parse(out);if(result.is_error||typeof result.result!=='string')throw Error(typeof result.result==='string'?result.result:'Claude could not answer.');finish(null,{text:result.result,usage:result.usage});}catch(error){finish(error instanceof Error?error:Error(String(error)));}});
  child.stdin.end(prompt);
 });
}
export async function runClaude(options:ClaudeRun){
  const session=await ClaudeSession.open(options);
  try{return await session.submit(options);}finally{await session.close();}
}
