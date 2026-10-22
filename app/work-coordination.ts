import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './store';
import type {Turn,ToolCall} from './types';
import {toolResultFailed} from './tool-result';
import {captureCheckpoint} from './checkpoints';
import {appFolderName,type SavedApp} from './saved-apps';

type Resource={kind:'path'|'service'|'port';value:string;access:'read'|'write'|'observe'};
type Inspection={id:string;job:string;signature:string;summary:string;resources:Resource[];evidence:{path:string;hash:string}[]};
export type WorkAction={toolId?:string;id:string;group:string;job:string;name:string;args:any;resource:string;scope?:Resource[];files?:{path:string;before:string|null;after?:string|null}[];evidence?:Inspection['evidence'];access:'read'|'write'|'unknown';signature:string;before:string|null;after?:string|null;expectedAfter?:string;status:'running'|'background'|'completed'|'failed'|'blocked'|'uncertain'|'inspected';result?:unknown;inspection?:string;owner?:{generation:string;sessionId:string;chatId:string;profile:string};};
type Action=WorkAction;
const processTools=new Set(['process_manage','TaskOutput','TaskStop','background_process','mcp__ghidorah__background_process']);
const fileReads=new Set(['Read','read_file']);
const fileWrites=new Set(['Write','Edit','MultiEdit','write_file','edit_file','patch']);
// Cross-chat actions use the durable dispatcher and their own approval/deduplication records.
const inspections=new Set(['link_app_chat','mcp__ghidorah__link_app_chat','search_chats','read_other_chat','send_chat_message','mcp__ghidorah__search_chats','mcp__ghidorah__read_other_chat','mcp__ghidorah__send_chat_message','image_options','mcp__ghidorah__image_options','document_tools','list_chat_files','mcp__ghidorah__document_tools','mcp__ghidorah__list_chat_files','save_chat_output','mcp__ghidorah__save_chat_output','search_web','read_web_page','query_chat_history','read_chat_history','mcp__ghidorah__search_web','mcp__ghidorah__read_web_page','mcp__ghidorah__query_chat_history','mcp__ghidorah__read_chat_history','list_apps','mcp__ghidorah__list_apps','goal_status','mcp__ghidorah__goal_status','Glob','Grep','search_files','ToolSearch','connected_tools','tool_search','tool_describe','skills_list','skill_view','session_search','todo','todo_list','TodoWrite','AskUserQuestion','EnterPlanMode','ExitPlanMode','clarify','parallel_work','mcp__ghidorah__parallel_work','inspect_action','mcp__ghidorah__inspect_action']);
type Claim={id:string;group:string;job:string;resource:string;task:string;status:'held'|'released'};
const overlaps=(a:string,b:string)=>a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);
export const parallelTool={name:'parallel_work',description:'Coordinate this parallel group. Read status before choosing work. Claim exact file/directory paths or a distinct task, publish findings with note, and release a claim when another job may take over. Claims do not execute tools or grant permission.',inputSchema:{type:'object',properties:{operation:{type:'string',enum:['status','claim','note','release']},task:{type:'string'},path:{type:'string'},claim:{type:'string'},text:{type:'string'}},required:['operation'],additionalProperties:false}};
const canonical=(value:any):string=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const signature=(name:string,args:any,directory:string)=>createHash('sha256').update(canonical({name,args,directory:process.platform==='win32'?directory.toLowerCase():directory})).digest('hex');
// A reported process exit is a settled result, including a failing test or a
// missing-file check. Timeouts, killed processes and missing results remain
// uncertain: an ordinary nonzero exit must not become a global mutation lock.
function processExit(name:string,result:unknown):number|null{
 if(!['Bash','terminal'].includes(name))return null;
 let value:any=result,code:unknown;
 if(typeof value==='string'){
  const native=name==='Bash'&&/^Exit code (\d+)(?:\r?\n|$)/.exec(value);
  if(native)code=Number(native[1]);else try{value=JSON.parse(value);}catch{return null;}
 }
 if(code===undefined){
  if(!value||typeof value!=='object'||value.error||value.interrupted||value.timed_out||value.is_interrupted||value.completion_reason&&value.completion_reason!=='exited'||value.status&&!['completed','exited'].includes(value.status))return null;
  code=value.exit_code;
 }
 return typeof code==='number'&&Number.isInteger(code)&&code>=0&&code<0xC0000000&&![124,130,137,143].includes(code)?code:null;
}
function processInterrupted(name:string,result:unknown):boolean{
 if(!['Bash','terminal'].includes(name))return false;
 let value:any=result;
 if(typeof value==='string'){
  const native=name==='Bash'&&/^Exit code (-?\d+)(?:\r?\n|$)/.exec(value);
  if(native)value={exit_code:Number(native[1])};else try{value=JSON.parse(value);}catch{return false;}
 }
 if(!value||typeof value!=='object')return false;
 const code=value.exit_code;
 return !!(value.interrupted||value.is_interrupted||value.timed_out||['interrupted','cancelled','timed_out','lost','stopped','killed'].includes(value.status)||value.completion_reason&&value.completion_reason!=='exited'||typeof code==='number'&&(code<0||code>=0xC0000000||[124,130,137,143].includes(code)));
}
// The pinned Hermes skill batch reports a confirmed rollback with this exact
// envelope. Other errors, failed rollbacks and missing results remain uncertain.
function skillRollback(name:string,result:unknown):boolean{
 if(name!=='skill_manage')return false;
 let value:any=result;if(typeof value==='string')try{value=JSON.parse(value);}catch{return false;}
 return value?.success===false&&Number.isInteger(value.failed_index)&&value.failed_index>=0&&value.completed_before_failure===value.failed_index&&typeof value.error==='string'&&value.error.startsWith('operations['+value.failed_index+'] (')&&value.error.endsWith(' — batch aborted, all touched skills rolled back.');
}
// Older builds rejected supplied repository paths before any app/file mutation,
// but recorded the validation error as an unknown write. Repair only that exact
// result; lost replies and failures after folder creation still need inspection.
function appPathRefusal(action:Action):boolean{
 if(!['create_app','mcp__ghidorah__create_app','mcp__trismegistus__create_app'].includes(action.name)||!Array.isArray(action.args?.repositories)||!action.args.repositories.length)return false;
 let result:any=action.result;if(typeof result==='string')try{result=JSON.parse(result);}catch{return false;}
 return result?.error==='Error: Choose a path inside the working folder.'||result?.error==='Error: This link points outside the working folder.';
}
// Hermes returns this envelope before calling its file writer. A stale/partial
// read refusal has no write to inspect and must not lock unrelated work.
function staleWriteRefusal(action:Action,result:unknown):boolean{
 if(action.name!=='write_file')return false;
 let value:any=result;if(typeof value==='string')try{value=JSON.parse(value);}catch{return false;}
 const file=value?.resolved_path||value?.path;
 return value?.stale_write_blocked===true&&typeof value.error==='string'&&value.error.includes('The file was NOT modified.')&&typeof file==='string'&&path.isAbsolute(file)&&(process.platform==='win32'?path.normalize(file).toLowerCase():path.normalize(file))===action.resource;
}
// Hermes validates every V4A hunk before any write. This exact rejection is a
// failed edit, not an unknown mutation; apply-phase failures still need review.
function patchValidationFailure(action:Action,result:unknown):boolean{
 if(action.name!=='patch'||action.args?.mode!=='patch')return false;
 let value:any=result;if(typeof value==='string')try{value=JSON.parse(value);}catch{return false;}
 return value?.success===false&&typeof value.error==='string'&&value.error.startsWith('Patch validation failed (no files were modified):\n');
}
function observerOnly(action:Action){return ['terminal','Bash'].includes(action.name)&&!!action.scope?.length&&action.scope.every(row=>row.access!=='write'||row.kind==='port');}
// Read-only shell commands run without inspect_action (speed plan, Koan 2026-10-06). Every part of a chain or
// pipeline must be a known reader; redirection, substitution, backgrounding and writing flags send it to inspection.
const READERS=/^(?:pwd|cd(?:\s+\S+)?|ls|dir|cat|type|head|tail|wc|grep|rg|findstr|find|tree|stat|file|du|df|which|where|whoami|hostname|date|echo|printf|basename|dirname|realpath|sort|uniq|cut|tr|awk|sed|jq|diff|cmp|md5sum|sha256sum|test|true|git\s+(?:status|log|diff|show|branch|rev-parse|ls-files|ls-tree|blame|grep|remote|describe|shortlog|cat-file|config\s+--get|stash\s+list|tag(?:\s+-l|\s+--list)?)|(?:node|python|python3|npm|pip|git)\s+--version|node\s+--check|Get-[A-Za-z]+|Select-[A-Za-z]+|Test-Path|Measure-Object|Sort-Object|Where-Object|ForEach-Object|Format-[A-Za-z]+|Resolve-Path|Split-Path|Join-Path|Out-String|ConvertTo-Json|ConvertFrom-Json)(?:\s|$)/i;
const WRITING=/>|<\(|\$\(|`|\s-(?:delete|exec|execdir|ok|okdir|fprint\w*)\b|\bsed\s+(?:-[a-zA-Z]*i|--in-place)|\bsed\b[^|&;]*[/;']\s*w\s|\bsystem\s*\(|-OutFile|\|\s*(?:sh|bash|cmd|powershell|pwsh|iex|Invoke-Expression)\b|(?:^|\s)&(?:\s|$)|\bgit\s+branch\s+(?:-[dDmMcCfu]|--(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description))|\bgit\s+remote\s+(?:add|remove|rm|set-url|rename)|\bgit\s+tag\s+(?!-l|--list)\S/i;
function diagnosticCommand(name:string,args:any){
 if(!['terminal','Bash'].includes(name)||typeof args?.command!=='string'||args.background||args.run_in_background)return false;
 const command=args.command.replace(/\s*2>\s*(?:\/dev\/null|nul|&1)/gi,'').trim();
 if(!command||/[\r\n]/.test(command)||WRITING.test(command))return false;
 return command.split(/&&|\|\||;|\|/).every((part:string)=>READERS.test(part.trim()));
}
export const inspectionTool={name:'inspect_action',description:'Before overlapping an unfamiliar shell or service action, inspect its command, scripts and tool schema. Record the exact tool name/arguments, affected file/directory paths and stable service/resource identities, and your findings. Local ports use kind port and value tcp:3000 or udp:3000, covering all interfaces. Read script/config files first and list them in evidence; they must still match when executed. Use observe only for a watcher or read that is designed to tolerate concurrent changes. An empty resource list asserts no shared effects. Include every potential write, port, process and external effect; if you cannot establish them, do not scope the action. This records your assessment, not permission or execution.',inputSchema:{type:'object',properties:{tool:{type:'string'},arguments:{type:'object'},summary:{type:'string'},evidence:{type:'array',description:'Exact paths of files read with Read/read_file in this turn. One path per entry; no annotations or comma-separated lists. Put explanations in summary and directories in resources.',items:{type:'string'}},resources:{type:'array',items:{type:'object',properties:{kind:{type:'string',enum:['path','service','port']},value:{type:'string'},access:{type:'string',enum:['read','write','observe']}},required:['kind','value','access'],additionalProperties:false}}},required:['tool','arguments','summary','evidence','resources'],additionalProperties:false}};

export async function resolveWorkPath(file:string):Promise<string>{
 try{return await fs.realpath(file);}catch(error){
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  const parent=path.dirname(file);if(parent===file)throw error;
  return path.join(await resolveWorkPath(parent),path.basename(file));
 }
}
// How an uncertain action settles without asking anyone: facts first; "unknown" only for cut-off shell work.
async function autoOutcome(action:Action):Promise<{status:Action['status'];inspection:string}>{
 const result:any=action.result,text=typeof result==='string'?result:JSON.stringify(result??'');
 if(/tool use was rejected|doesn't want to proceed|refused before execution|Approval expired before execution/i.test(text))return {status:'blocked',inspection:'Auto-resolved: it never ran, so nothing changed.'};
 const exited=result&&typeof result==='object'&&result.status==='exited'&&Number.isInteger(result.exit_code)&&!result.completion_reason&&!result.interrupted&&!result.timed_out;
 const code=processExit(action.name,result)??(exited?result.exit_code:null);
 if(code!==null)return {status:code===0?'completed':'failed',inspection:`Auto-resolved: it ran to the end and exited with code ${code}.`};
 const files=action.files?.length?action.files:action.access==='write'&&action.resource!=='*'&&!processTools.has(action.name)?[{path:action.resource,before:action.before??null,after:action.expectedAfter}]:[];
 if(files.length){
  const now=await Promise.all(files.map(file=>fingerprint(file.path)));
  if(now.every((hash,i)=>hash===files[i].before))return {status:'blocked',inspection:'Auto-resolved: the files are unchanged, so it did not take effect.'};
  if(files.every((file,i)=>file.after!=null&&now[i]===file.after))return {status:'completed',inspection:'Auto-resolved: the files match the intended result.'};
  return {status:'inspected',inspection:'Auto-resolved: these files changed but may be partial; read them before editing again: '+files.filter((file,i)=>now[i]!==file.before).map(file=>file.path).join(', ')};
 }
 return {status:'inspected',inspection:'Auto-resolved: this command was cut off mid-run and its effects are unknown. Check its effects before redoing it.'};
}
async function fingerprint(file:string){
 try{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
// Retain knowledge of this job's own edit only when disk matches the exact
// requested result. A tool's success message alone cannot establish that.
async function expectedWrite(name:string,args:any,file:string,before:string|null){
 const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
 if(['Write','write_file'].includes(name)&&typeof args.content==='string')return hash(args.content);
 if(!['Edit','patch'].includes(name)||args.mode==='patch'||typeof args.old_string!=='string'||typeof args.new_string!=='string')return;
 if(before===null)return args.old_string===''?hash(args.new_string):undefined;
 let bytes:Buffer;try{bytes=await fs.readFile(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 if(hash(bytes)!==before)return;
 const source=bytes.toString('utf8');if(!Buffer.from(source).equals(bytes)||!args.old_string)return;
 // Claude Code matches LF text against a CRLF file and writes CRLF: predict the same bytes.
 const eol=(text:string)=>source.includes('\r\n')?text.replace(/\r?\n/g,'\r\n'):text;
 const pieces=source.split(eol(args.old_string));if(pieces.length<2||pieces.length>2&&args.replace_all!==true)return;
 return hash(pieces.join(eol(args.new_string)));
}

// Main is the shared owner for both engine processes. File operations can overlap
// on independent targets; unfamiliar commands/services obtain an exclusive lease.
export class WorkCoordination {
 private held=new Map<string,Action>();
 // asking: actions waiting for the user's Allow. They hold no lease, so other chats' work goes on (Koan 2026-10-15:
 // one chat's command waiting for Allow stalled another chat's command for ten minutes). Allow takes the lease back.
 private asking=new Map<string,{action:Action;stop:AbortController}>();
 private reads=new Map<string,Map<string,string|null>>();
 private changed=new Set<()=>void>();
 // autoResolve (the app sets it): an uncertain earlier action is settled from recorded facts the moment it would
 // block new work, instead of waiting for a person (Koan, 2026-10-06, as in Claude Code). Tests of the hold
 // machinery itself run without it.
 constructor(private store:Store,private notify:()=>void=()=>{},private autoResolve=false){
  // Repair only historical holds with a recorded, definite outcome.
  // Preserve interrupted/unknown actions and their original results.
  for(const action of store.all<Action>('work-action'))if(action.status==='uncertain'){
   const code=processExit(action.name,action.result);
   if(action.scope&&!action.scope.some(row=>row.access==='write'))store.update<Action>('work-action',action.id,{status:'inspected',inspection:'The inspected action had no declared mutations. No action was replayed.'});
   else if(observerOnly(action)&&action.result&&typeof action.result==='object'&&['stopped','killed'].includes((action.result as any).status))store.update<Action>('work-action',action.id,{status:'inspected',inspection:'The inspected observer was confirmed stopped. It had no file or service writes. No action was replayed.'});
   else if(staleWriteRefusal(action,action.result))store.update<Action>('work-action',action.id,{status:'blocked',inspection:'The file writer refused stale or incomplete read context before changing the file. No action was replayed.'});
   else if(patchValidationFailure(action,action.result))store.update<Action>('work-action',action.id,{status:'failed',inspection:'Patch validation failed before any files were modified. No action was replayed.'});
   else if(appPathRefusal(action))store.update<Action>('work-action',action.id,{status:'blocked',inspection:'App registration rejected the repository path before making changes. No action was replayed.'});
   else if(skillRollback(action.name,action.result))store.update<Action>('work-action',action.id,{status:'failed',inspection:'The skill batch failed and confirmed that all touched skills were rolled back.'});
   else if(code!==null)store.update<Action>('work-action',action.id,{status:code===0?'completed':'failed',inspection:'Recorded process exited with code '+code+'. Inspect any partial changes before retrying.'});
  }
 }
 async reconcileObservers(){
  // Windows socket binds can overlap wildcard/specific listeners. Read the OS
  // listener table instead of treating a successful bind as proof of a free port.
  if(process.platform!=='win32')return;
  const candidates=this.pending().filter(action=>observerOnly(action)&&this.store.all<any>('background').some(row=>row.actionId===action.id&&row.status==='lost')&&action.scope!.filter(row=>row.access==='write').every(row=>/^tcp:\d+$/.test(row.value)));
  if(!candidates.length)return;
  let ports:unknown;
  try{ports=JSON.parse(await new Promise<string>((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command','ConvertTo-Json -Compress -InputObject @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Select-Object -ExpandProperty LocalPort -Unique)'],{windowsHide:true,timeout:10000},(error,stdout)=>error?reject(error):resolve(stdout))));}catch{return;}
  if(!Array.isArray(ports)||ports.some(port=>!Number.isInteger(port)))return;
  for(const action of candidates){
   if(action.scope!.some(row=>row.access==='write'&&(ports as number[]).includes(Number(row.value.slice(4))))||[...this.held.values()].some(other=>this.conflicts(action,other)))continue;
   if(this.store.get<Action>('work-action',action.id).status==='uncertain')this.store.update<Action>('work-action',action.id,{status:'inspected',inspection:'The lost process was inspected as read-only. Windows reports no listeners on its recorded TCP ports; no file or service writes were declared. No command was replayed.'});
  }
 }
 private async settleQuietly(action:Action){
  const outcome=await autoOutcome(action);
  if(this.store.get<Action>('work-action',action.id).status!=='uncertain')return;
  this.store.update<Action>('work-action',action.id,outcome);
  // The model learns the outcome on that command's own record; the user is never asked.
  const tool=action.toolId?[this.store.find<ToolCall>('tool',action.toolId)].find(tool=>tool?.turnId===action.job):undefined;
  if(tool&&['running','uncertain'].includes(tool.status))this.store.update<ToolCall>('tool',tool.id,{status:outcome.status==='completed'?'completed':'failed',result:[action.result,outcome.inspection].filter(value=>value!=null&&value!=='').map(value=>typeof value==='string'?value:JSON.stringify(value)).join('\n')});
 }
 // Reads are remembered per chat, not per turn, so a later turn can edit a file an earlier turn read.
 private readKey(job:string){try{return this.store.get<Turn>("turn",job).chatId||job;}catch{return job;}}
 private wake(){for(const listener of this.changed)listener();this.notify();}
 private release(id:string){this.held.delete(id);this.asking.get(id)?.stop.abort();this.asking.delete(id);}
 private conflicts(a:Action,b:Action){
  // Owning-session validation precedes process control. It must remain usable
  // while the launch action holds its resources, including an unknown command.
  if(processTools.has(a.name)&&a.access!=='unknown'||processTools.has(b.name)&&b.access!=='unknown')return processTools.has(a.name)&&processTools.has(b.name)&&a.resource===b.resource&&(a.access!=='read'||b.access!=='read');
  // Inspection can read a live background target without granting a write.
  if(a.status==='background'&&b.access==='read'||b.status==='background'&&a.access==='read')return false;
  if(a.access==='unknown'&&!a.scope||b.access==='unknown'&&!b.scope)return true;
  const resources=(action:Action):Resource[]=>action.scope||[{kind:'path',value:action.resource,access:action.access==='read'?'read':'write'}];
  return resources(a).some(x=>resources(b).some(y=>x.access!=='observe'&&y.access!=='observe'&&(x.access==='write'||y.access==='write')&&x.kind===y.kind&&(x.kind==='path'?overlaps(x.value,y.value):x.value===y.value)));
 }
 // Holds the action once nothing held conflicts with it. Background work never ends by waiting, so it refuses at once.
 private async reserve(action:Action,signal:AbortSignal,overlapped=new Set<string>(),waiting?:()=>void){
  while(true){const conflicts=[...this.held.values()].filter(other=>this.conflicts(action,other));if(!conflicts.length)break;const background=conflicts.find(other=>other.status==='background');if(background)throw Error('Background work owns resources this action may affect: '+String(background.args?.command||background.name).slice(0,240)+' (action '+background.id+'). This request did not run. Use background_process to list or stop this chat’s job, or inspect and scope the requested command before running it.');for(const other of conflicts)overlapped.add(other.id);waiting?.();waiting=undefined;await this.wait(signal);}
  signal.throwIfAborted();this.held.set(action.id,action);
 }
 private async wait(signal:AbortSignal){
  signal.throwIfAborted();
  await new Promise<void>((resolve,reject)=>{
   const cleanup=()=>{this.changed.delete(changed);signal.removeEventListener('abort',abort);};
   const changed=()=>{cleanup();resolve();},abort=()=>{cleanup();reject(Error('Work cancelled.'));};
   this.changed.add(changed);signal.addEventListener('abort',abort,{once:true});
  });
 }
 async begin(group:string,job:string,directory:string,name:string,args:any,signal:AbortSignal,patchPaths?:string[]){
  signal.throwIfAborted();
  await this.reconcileObservers();
  if(inspections.has(name)||name==='mcp__ghidorah__read_project_memory'||name==='memory'&&['read','view','list'].includes(args?.action))return null;
  let resource='*',access:Action['access']='unknown';
  if(diagnosticCommand(name,args))access='read';
  const candidate=args?.file_path||args?.path;
  if((fileReads.has(name)||fileWrites.has(name))&&typeof candidate==='string'&&candidate){
   resource=await resolveWorkPath(path.resolve(directory,candidate));if(process.platform==='win32')resource=resource.toLowerCase();
   access=fileReads.has(name)?'read':'write';
  }
  if(name==='process_manage'){resource='process:'+String(args?.session_id||'list');access=['list','poll','log','wait'].includes(args?.action)?'read':['kill','close','handoff'].includes(args?.action)?'write':'unknown';}
  if(name==='TaskOutput'||name==='TaskStop'){resource='process:'+String(args?.task_id||args?.shell_id||'');access=name==='TaskOutput'?'read':'write';}
  if(name==='background_process'||name==='mcp__ghidorah__background_process'){resource='process:'+String(args?.id||'list');access=args?.action==='stop'?'write':'read';}
  const hash=signature(name,args,await resolveWorkPath(directory)),plan=access==='unknown'?this.store.where<Inspection>('work-inspection','signature',hash).find(row=>row.job===job):undefined;
  const action:Action={id:randomUUID(),group,job,name,args,resource,access,signature:hash,...(plan?{scope:plan.resources,evidence:plan.evidence,inspection:plan.summary}:{}),before:null,status:'running'};
  const tool=name.replace(/^mcp__ghidorah__/,'');
  if(['create_app','update_app','add_app_todo','update_app_todo'].includes(tool)){
   action.scope=[{kind:'service',value:'saved-apps',access:'write'}];
   if(tool==='update_app'&&typeof args?.icon_path==='string'){
    const file=await resolveWorkPath(path.resolve(directory,args.icon_path));
    action.scope.push({kind:'path',value:process.platform==='win32'?file.toLowerCase():file,access:'read'});
   }
   if(tool==='create_app'){
    const known=this.store.all<SavedApp>('saved-app').find(app=>app.name.toLowerCase()===String(args?.name).trim().slice(0,80).toLowerCase());
    const repositories=args?.repositories??known?.repositories;
    const identity=async(file:string)=>{const full=await resolveWorkPath(path.resolve(directory,file));return process.platform==='win32'?full.toLowerCase():full;};
    for(const file of [...(Array.isArray(repositories)?repositories:[]),...(typeof args?.icon_path==='string'?[args.icon_path]:[])])if(typeof file==='string')action.scope.push({kind:'path',value:await identity(file),access:'read'});
    if(!args?.register_only&&!repositories?.length&&typeof args?.name==='string'){
     const folder=appFolderName(args.name.trim().slice(0,80));if(folder)action.scope.push({kind:'path',value:await identity(folder),access:'write'});
    }
   }
  }
  // Paths come from Hermes's own V4A parser, outside the model's tool arguments.
  // Reserve the whole patch before checking any file; retain per-file baselines.
  if(patchPaths!==undefined){
   if(name!=='patch'||args?.mode!=='patch'||!Array.isArray(patchPaths)||!patchPaths.length||patchPaths.length>1000||patchPaths.some(file=>typeof file!=='string'||!file))throw Error('Invalid patch targets.');
   const targets=await Promise.all(patchPaths.map(async file=>{const full=await resolveWorkPath(path.resolve(directory,file));return process.platform==='win32'?full.toLowerCase():full;}));
   action.files=[...new Set(targets)].map(file=>({path:file,before:null}));action.resource='*';action.access='write';action.scope=action.files.map(file=>({kind:'path',value:file.path,access:'write'}));access='write';resource='*';
  }
  if(['generate_image','copy_chat_artifact','copy_chat_file','render_document','recalculate_spreadsheet'].includes(name.replace(/^mcp__ghidorah__/,''))&&typeof args?.destination==='string'){
   const identity=async(value:string)=>{const p=await resolveWorkPath(path.resolve(directory,value));return process.platform==='win32'?p.toLowerCase():p;};
   action.scope=[{kind:'path',value:await identity(args.destination),access:'write'},...(typeof args.path==='string'?[{kind:'path' as const,value:await identity(args.path),access:'read' as const}]:[])];
   if(name.endsWith('generate_image')){for(const ref of args.references||[])if(typeof ref==='string'&&!/^(upload|output):/.test(ref))action.scope.push({kind:'path',value:await identity(ref),access:'read'});action.scope.push({kind:'service',value:'image-generation',access:'write'});}
  }
  if(access==='unknown'&&action.scope&&!action.scope.some(row=>row.access==='write'))action.access=access='read';
  // Reserve before asynchronous disk inspection so simultaneous arrivals cannot
  // both observe the target as free.
  const overlapped=new Set<string>();await this.reserve(action,signal,overlapped);
  const patchClaims:string[]=[];
  try{
   const parent=this.store.find<Turn>('turn',group),run=this.store.find<Turn>('turn',job);
   if(parent?.collaboration?.strategy==='review'&&run?.model!==parent.collaboration.lead&&access!=='read')throw Error('This job is reviewing. Publish the proposed change on parallel_work for the implementer.');
   // Only same-signature rows matter to the duplicate checks below.
   let previous=this.store.where<Action>('work-action','signature',hash);
   const mayWrite=access!=='read'&&(!action.scope||action.scope.some(row=>row.access==='write'));
   // Historical uncertainty is not an active global lease. Keep an unscoped
   // outcome for review and prevent blind repeats/unscoped mutations; current
   // file baselines and inspected scopes can establish the next action.
   const findUnresolved=()=>this.store.where<Action>('work-action','status','uncertain').find(row=>row.access!=='read'&&(row.access==='unknown'&&!row.scope?row.signature===hash||mayWrite&&action.access==='unknown'&&!action.scope:mayWrite&&this.conflicts(action,row)));
   let unresolved=findUnresolved();
   while(unresolved&&this.autoResolve){await this.settleQuietly(unresolved);unresolved=findUnresolved();previous=this.store.where<Action>('work-action','signature',hash);}
   if(unresolved)throw Error('An earlier '+unresolved.name+' action has an uncertain outcome (Work review ID '+unresolved.id+'): '+String(unresolved.args?.command||unresolved.name).slice(0,400)+'. Affected resources: '+JSON.stringify(unresolved.scope||[{kind:'path',value:unresolved.resource}])+'. This request did not run and did not create a new hold. Read/search tools and inspected read-only commands remain available. Use inspect_action to scope a different command to its actual resources; unrelated work can continue. Do not repeat this blocked call. If the original outcome cannot be established, resolve that specific entry in Work review.');
   if(previous.some(row=>row.status==='background'&&row.signature===hash))throw Error('This action already has a running background process. Inspect its status instead of starting a duplicate.');
   const duplicate=access==='unknown'&&previous.find(row=>row.job!==job&&row.signature===hash&&row.status==='completed'&&(row.group===group||overlapped.has(row.id)));
   if(duplicate)throw Error(duplicate.group===group?'Another model already completed this action. Use its recorded result instead of repeating it: '+canonical(duplicate.result):'Another chat completed the same action while this request was waiting. Ask the user before repeating it.');
   for(const file of plan?.evidence||[])if(await fingerprint(file.path)!==file.hash)throw Error('Inspected command source changed. Read it and inspect the action again before execution.');
   for(const file of action.files||[]){
    file.before=await fingerprint(file.path);
    if(file.before!==null&&this.reads.get(this.readKey(job))?.get(file.path)!==file.before)throw Error('The file changed or has not been read by this job. Read its current contents and reconcile your edit before writing: '+file.path);
   }
   for(const file of action.files||[]){const existing=new Set(this.store.all<Claim>('work-claim').map(row=>row.id)),claim=await this.claim(group,job,directory,{path:file.path,task:'Patch '+path.relative(directory,file.path)});if(!existing.has(claim.id))patchClaims.push(claim.id);}
   if(resource!=='*'&&!processTools.has(name)){
    action.before=await fingerprint(resource);
    if(access==='write'&&action.before!==null&&this.reads.get(this.readKey(job))?.get(resource)!==action.before)throw Error('The file changed or has not been read by this job. Read its current contents and reconcile your edit before writing.');
    if(access==='write')action.expectedAfter=await expectedWrite(name,args,resource,action.before);
    if(access==='write')await this.claim(group,job,directory,{path:resource,task:'Edit '+path.relative(directory,resource)});
   }
   signal.throwIfAborted();this.store.transaction(()=>{captureCheckpoint(this.store,action,directory);this.store.put('work-action',action);});this.notify();return action.id;
  }catch(error){for(const id of patchClaims)this.store.update<Claim>('work-claim',id,{status:'released'});this.release(action.id);this.wake();throw error;}
 }
 async finish(id:string|null,job:string,result:unknown,uncertain=false,refused=false){
  if(!id)return;
  const action=this.store.get<Action>('work-action',id);if(action.job!==job)throw Error('This action belongs to another job.');
  if(!['running','uncertain'].includes(action.status))return;
  if(refused||staleWriteRefusal(action,result)){this.store.update<Action>('work-action',id,{status:'blocked',result});this.finishToolRecord(id);this.reads.get(this.readKey(job))?.delete(action.resource);this.release(id);this.wake();return;}
  // A failed read cannot leave a mutation in flight. A missing file is also a
  // useful observation when checking the outcome of an earlier uncertain write.
  const failedRead=action.access==='read'&&uncertain;
  const stoppedObserver=observerOnly(action)&&result&&typeof result==='object'&&['stopped','killed'].includes((result as any).status);
  if(processInterrupted(action.name,result)&&!stoppedObserver)uncertain=true;
  if(action.access==='read')uncertain=false;
  const exit=processExit(action.name,result),rolledBack=skillRollback(action.name,result),patchRejected=patchValidationFailure(action,result);
  if(exit!==null||rolledBack||patchRejected)uncertain=false;
  try{
   if(action.files){
    const files=await Promise.all(action.files.map(async file=>({...file,after:await fingerprint(file.path)})));
    this.store.update<Action>('work-action',id,{files});for(const file of files)if(!patchRejected||this.reads.get(this.readKey(job))?.get(file.path)!==file.after)this.reads.get(this.readKey(job))?.delete(file.path);
   }
   if(!uncertain&&action.resource!=='*'&&!processTools.has(action.name)){
    const now=await fingerprint(action.resource);
    this.store.update<Action>('work-action',id,{after:now});
    const reads=this.reads.get(this.readKey(job))||new Map<string,string|null>();this.reads.set(this.readKey(job),reads);
    // Outside edits still require a fresh read, even after a successful write.
    const inspected=action.access==='read'&&now===action.before&&(!failedRead||now===null);
    const written=action.access==='write'&&now!==null&&now===action.expectedAfter;
    if(inspected||written)reads.set(action.resource,now);else reads.delete(action.resource);
    if(inspected)for(const previous of this.store.where<Action>('work-action','status','uncertain'))if(previous.resource===action.resource)this.store.update<Action>('work-action',previous.id,{status:'inspected',inspection:id});
   }
   this.store.update<Action>('work-action',id,{status:uncertain?'uncertain':patchRejected||rolledBack||exit!==null&&exit!==0?'failed':'completed',result});
  }catch(error){this.store.update<Action>('work-action',id,{status:'uncertain',result});throw error;}
  finally{this.finishToolRecord(id);this.release(id);this.wake();}
 }
 private finishToolRecord(id:string){
  const action=this.store.get<Action>('work-action',id);if(!action.toolId||!['completed','failed','blocked'].includes(action.status))return;
  const tool=[this.store.find<ToolCall>('tool',action.toolId)].find(tool=>tool?.turnId===action.job);
  if(tool&&['running','uncertain'].includes(tool.status))this.store.update<ToolCall>('tool',tool.id,{result:action.result,status:action.status!=='completed'||toolResultFailed(action.result)?'failed':'completed'});
 }
 holdBackground(id:string,job:string,result:unknown){
  const action=this.store.get<Action>('work-action',id);if(action.job!==job||!['running','uncertain'].includes(action.status))throw Error('Background action is no longer owned by this job.');
  const held=this.store.update<Action>('work-action',id,{status:'background',result});this.held.set(id,held);this.notify();
 }
 async finishBackground(id:string,result:unknown,uncertain:boolean){
  const action=this.store.get<Action>('work-action',id);if(!['background','uncertain'].includes(action.status))return;
  // An inspected observer only owns its listener. Confirmed Stop releases that
  // listener; writers and lost processes still require outcome inspection.
  if(observerOnly(action)&&result&&typeof result==='object'&&['stopped','killed'].includes((result as any).status))uncertain=false;
  this.store.update<Action>('work-action',id,{status:'running'});await this.finish(id,action.job,result,uncertain);
 }
 async inspectAction(job:string,directory:string,args:any){
  if(!args||typeof args.tool!=='string'||!args.arguments||typeof args.arguments!=='object'||Array.isArray(args.arguments)||typeof args.summary!=='string'||args.summary.trim().length<10||args.summary.length>4000||!Array.isArray(args.resources)||args.resources.length>32||!Array.isArray(args.evidence)||args.evidence.length>32)throw Error('Describe the inspected action, evidence and affected resources.');
  if(fileReads.has(args.tool)||fileWrites.has(args.tool)||processTools.has(args.tool)&&(args.tool!=='process_manage'||!['write','submit'].includes(args.arguments.action)))throw Error('Use the existing file and process ownership checks for this tool.');
  const identity=async(value:string)=>{const full=await resolveWorkPath(path.resolve(directory,value));return process.platform==='win32'?full.toLowerCase():full;};
  const resources:Resource[]=[];
  for(const item of args.resources){if(!item||!['path','service','port'].includes(item.kind)||!['read','write','observe'].includes(item.access)||typeof item.value!=='string'||!item.value.trim()||item.value.length>2000)throw Error('Invalid affected resource.');let value=item.kind==='path'?await identity(item.value):item.value.trim().toLowerCase();if(item.kind==='port'){const port=/^(tcp|udp):(\d{1,5})$/.exec(value);if(!port||Number(port[2])<1||Number(port[2])>65535)throw Error('Use a local port such as tcp:3000 or udp:3000.');value=port[1]+':'+Number(port[2]);}resources.push({kind:item.kind,value,access:item.access});}
  const evidence:Inspection['evidence']=[];
  for(const file of args.evidence){
   if(typeof file!=='string'||!file.trim())throw Error('Each evidence entry must be one exact file path. Put explanations in summary and directories in resources.');
   const stat=await fs.stat(path.resolve(directory,file)).catch(error=>{if(['ENOENT','ENOTDIR'].includes(error.code))return null;throw error;});
   if(!stat?.isFile())throw Error('Evidence is not an existing file: '+JSON.stringify(file.slice(0,500))+'. Supply one exact file path per entry, without annotations or lists. Put explanations in summary and directories in resources.');
   const target=await identity(file),hash=await fingerprint(target);
   if(!hash||this.reads.get(this.readKey(job))?.get(target)!==hash)throw Error('Read the current file with Read/read_file before recording it as evidence: '+JSON.stringify(file.slice(0,500))+'. Earlier turns and shell reads do not establish a current file read.');
   evidence.push({path:target,hash});
  }
  const hash=signature(args.tool,args.arguments,await resolveWorkPath(directory));this.store.put<Inspection>('work-inspection',{id:job+':'+hash,job,signature:hash,summary:args.summary.trim(),resources,evidence});this.notify();return {recorded:true,tool:args.tool,resources,summary:args.summary.trim()};
 }
 interrupt(job?:string){
  for(const action of this.store.all<Action>('work-action'))if((action.status==='running'||!job&&action.status==='background')&&(!job||action.job===job))this.store.update<Action>('work-action',action.id,{status:action.access==='read'?'blocked':'uncertain'});
  for(const [id,action] of this.held)if(!job||action.job===job&&action.status!=='background')this.held.delete(id);
  for(const [id,{action}] of this.asking)if(!job||action.job===job)this.release(id);
  // Reads survive the end of a turn: each one stores the file fingerprint, and a write is refused if the file
  // changed since, so remembering them per chat is safe (speed plan, Koan 2026-10-06; Claude Code keeps reads per session).
  if(!job)this.reads.clear();this.wake();
  for(const claim of this.store.all<Claim>('work-claim'))if(claim.status==='held'&&(!job||claim.job===job))this.store.update<Claim>('work-claim',claim.id,{status:'released'});
 }
 private async claim(group:string,job:string,directory:string,args:any){
  args={...args,task:args.task??args.path};
  if(typeof args.task!=='string'||!args.task.trim()||args.task.length>1000)throw Error('Describe the task you will own.');
  let resource='task:'+args.task.trim().toLowerCase();
  if(args.path!==undefined){if(typeof args.path!=='string'||!args.path.trim())throw Error('Choose a file or directory path.');resource=await resolveWorkPath(path.resolve(directory,args.path));if(process.platform==='win32')resource=resource.toLowerCase();}
  const claims=this.store.all<Claim>('work-claim').filter(claim=>claim.status==='held');
  const conflict=claims.find(claim=>claim.job!==job&&(!resource.startsWith('task:')||claim.group===group)&&overlaps(claim.resource,resource));
  if(conflict)throw Error(conflict.group===group?'Another job owns this resource: '+canonical(conflict)+'. Coordinate through parallel_work before changing it.':'Another chat owns this file or directory. Wait for its work to finish.');
  const previous=claims.find(claim=>claim.job===job&&claim.resource===resource);if(previous)return previous;
  const claim:Claim={id:randomUUID(),group,job,resource,task:args.task,status:'held'};this.store.put('work-claim',claim);this.notify();return claim;
 }
 async board(group:string,job:string,directory:string,args:any){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['operation','task','path','claim','text'].includes(key)))throw Error('Invalid collaboration request.');
  const parent=this.store.get<Turn>('turn',group);if(!parent.jobs?.includes(job))throw Error('This job does not belong to the group.');
  if(args.operation==='claim'){
   if(args.path&&parent.collaboration?.strategy==='review'&&this.store.get<Turn>('turn',job).model!==parent.collaboration.lead)throw Error('Reviewers can claim a review task; file ownership belongs to the implementer.');
   return this.claim(group,job,directory,args);
  }
  if(args.operation==='release'){
   const claim=this.store.get<Claim>('work-claim',args.claim);if(claim.job!==job||claim.group!==group)throw Error('Only the owning job can release this claim.');
   this.store.update<Claim>('work-claim',claim.id,{status:'released'});this.wake();return {released:claim.id};
  }
  if(args.operation==='note'){
   if(typeof args.text!=='string'||!args.text.trim()||args.text.length>8000)throw Error('Write a finding of up to 8,000 characters.');
   this.store.put('work-note',{id:randomUUID(),group,job,text:args.text,created:Date.now()});this.notify();
  }else if(args.operation!=='status')throw Error('Unknown collaboration operation.');
  return {strategy:parent.collaboration,jobs:parent.jobs.map(id=>{const turn=this.store.get<Turn>('turn',id);return {id,model:turn.model,status:turn.status,answer:turn.text,error:turn.error};}),claims:this.store.all<Claim>('work-claim').filter(row=>row.group===group),notes:this.store.all<any>('work-note').filter(row=>row.group===group),actions:this.records(group)};
 }
 records(group:string){return this.store.all<Action>('work-action').filter(action=>action.group===group);}
 completionOwner(id:string,generation:string,sessionId:string){
  const action=this.store.get<Action>('work-action',id);
  if(!action.owner||action.owner.generation!==generation||action.owner.sessionId!==sessionId)throw Error('This result does not belong to the action’s original session.');
  return action;
 }
 pending(){return this.store.where<Action>('work-action','status','uncertain').filter(action=>action.access!=='read');}
 inspect(id:string,note:string){
  if(typeof note!=='string'||note.trim().length<5||note.length>4000)throw Error('Describe the outcome you checked.');
  const action=this.store.get<Action>('work-action',id);if(action.status!=='uncertain')throw Error('This action is no longer awaiting inspection.');
  if([...this.held.values()].some(other=>this.conflicts(action,other)))throw Error('Wait for related active work before recording the checked outcome.');
  this.store.update<Action>('work-action',id,{status:'inspected',inspection:'User checked: '+note.trim()});this.wake();
 }
 private approvalAction(job:string,description:unknown,command?:unknown){
  if(typeof description!=='string')return;
  const match=/^([\w:.-]+)(?:: |\n)(\{[\s\S]*\})$/.exec(description),name=match?.[1]||(typeof command==='string'?/^<([\w:.-]+)> \(plugin approval rule\)$/.exec(command)?.[1]:undefined);if(!name)return;
  let args:any;if(match)try{args=JSON.parse(match[2]);}catch{return;}
  const matches=[...this.held.values(),...[...this.asking.values()].map(row=>row.action)].filter(action=>action.job===job&&action.name===name&&(!match||canonical(action.args)===canonical(args)));
  return matches.length===1?matches[0]:matches.length>1?null:undefined;
 }
 // The approval is shown: its action steps out of the lock until the user answers.
 ask(job:string,description:unknown,command?:unknown){
  const action=this.approvalAction(job,description,command);if(!action||!this.held.has(action.id))return;
  this.held.delete(action.id);this.asking.set(action.id,{action,stop:new AbortController()});this.wake();
 }
 // Allow: the action takes its lease back first (waiting for a related command that started meanwhile), then the
 // files it read are checked again.
 async checkApproval(job:string,description:unknown,command?:unknown,waiting?:()=>void){
  const action=this.approvalAction(job,description,command);
  if(action===null)throw Error('The approval cannot identify a single pending action. The action was denied; ask the model to request these actions one at a time.');
  const asking=action&&this.asking.get(action.id);
  if(asking){await this.reserve(action,asking.stop.signal,undefined,waiting);this.asking.delete(action.id);}
  for(const file of action?.files||[])if(await fingerprint(file.path)!==file.before)throw Error('A patch target changed while approval was pending. Read the current files before trying again.');
  if(action?.access==='write'&&!action.files&&!processTools.has(action.name)&&await fingerprint(action.resource)!==action.before)throw Error('The file changed while approval was pending. The action was denied; ask the model to read the current file before trying again.');
  for(const file of action?.evidence||[])if(await fingerprint(file.path)!==file.hash)throw Error('Inspected command source changed during approval. Read it and inspect the action again.');
 }
 denied(job:string,description:unknown,command?:unknown,reason="Approval refused before execution."){
  const action=this.approvalAction(job,description,command);if(!action)return;
  this.store.update<Action>('work-action',action.id,{status:'blocked',result:reason});this.release(action.id);this.wake();
 }
}
