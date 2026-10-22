import type {Backend} from './backend';
import type {Store} from './store';
import type {Chat,Project,Turn} from './types';
import type {WorkCoordination,WorkAction} from './work-coordination';
import type {PluginProcessOwner} from './plugin-commands';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface BackgroundProcess {engine?:'claude'|'plugin';id:string;chatId:string;turnId:string;actionId:string|null;generation:string;sessionId:string;profile:string;processId:string;command:string;pid?:number;output:string;status:'checking'|'running'|'stopping'|'exited'|'stopped'|'lost';exitCode?:number;created:number;updated:number;error?:string;}
const live=(row:BackgroundProcess)=>['checking','running','stopping'].includes(row.status);
export const backgroundProcessTool={name:'background_process',description:'List or stop background jobs owned by this chat, including jobs retained in an earlier model session. Use the returned id to stop a job. Other chats are excluded. Do not relaunch an existing job.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['list','stop']},id:{type:'string'}},required:['action'],additionalProperties:false}};
export async function backgroundProcess(store:Store,chat:Chat,args:any,refresh:()=>Promise<void>,stop:(id:string)=>Promise<void>,refused:()=>void=()=>{}){
 const reject=(message:string):never=>{refused();throw Error(message);};
 if(!args||!['list','stop'].includes(args.action)||Object.keys(args).some(key=>!['action','id'].includes(key)))reject('Choose list or stop for background work.');
 if(args.action==='stop'){
  const row=store.all<BackgroundProcess>('background').find(row=>row.chatId===chat.id&&row.id===args.id);
  if(!row)return reject('Background job unavailable in this chat. List this chat’s jobs first.');
  if(store.get<Project>('project',chat.projectId).mode==='plan')reject('Plan mode permits inspection and proposals only.');
  await stop(row.id);
 }else await refresh();
 return {processes:store.all<BackgroundProcess>('background').filter(row=>row.chatId===chat.id).map(({id,command,status,output,error,exitCode})=>({id,command,status,output,error,exitCode}))};
}
function handles(result:any):string[]{
 if(typeof result==='string'){try{return handles(JSON.parse(result));}catch{return [];}}
 if(!result||typeof result!=='object')return [];
 const own=[result.session_id,result.yielded_session_id].filter(id=>typeof id==='string'&&id.startsWith('proc_'));
 return [...new Set([...own,...Object.values(result).flatMap(value=>typeof value==='object'||typeof value==='string'&&value.startsWith('{')?handles(value):[])])];
}

// Durable receipts and UI state only. Hermes remains the process supervisor;
// use its session-scoped RPCs, never signal a saved PID after restart.
export class BackgroundWork {
 private polling=new Map<string,Promise<void>>();
 private stopping=new Map<string,Promise<void>>();
 constructor(private store:Store,private backend:Backend,private work:WorkCoordination,private notify:()=>void,private pluginOwners=new Map<string,PluginProcessOwner>()){}
 rows(){return this.store.all<BackgroundProcess>('background').filter(row=>row.engine!=='claude');}
 private params(row:BackgroundProcess){return {session_id:row.sessionId,profile:row.profile};}
 private id(session:string,process:string){return this.backend.generation+':'+session+':'+process;}
 private record(chat:Chat,turnId:string,processId:string,actionId:string|null,command:string,pluginOwner?:string){
  if(!pluginOwner&&!chat.runtimeId)throw Error('The process has no owning backend session.');
  const id=pluginOwner?pluginOwner+':'+turnId+':'+processId:this.id(chat.runtimeId!,processId),existing=this.rows().find(row=>row.id===id);
  if(existing){if(existing.actionId!==actionId&&actionId)throw Error('The process is already attached to a different action.');return existing;}
  const row:BackgroundProcess={...(pluginOwner?{engine:'plugin' as const}:{}),id,chatId:chat.id,turnId,actionId,generation:pluginOwner||this.backend.generation,sessionId:pluginOwner?turnId:chat.runtimeId!,profile:this.store.get<Project>('project',chat.projectId).profile,processId,command,output:'',status:'checking',created:Date.now(),updated:Date.now()};
  this.store.put('background',row);return row;
 }
 async finishTool(chat:Chat,turnId:string,lease:string|null,result:unknown,uncertain:boolean,refused=false,pluginOwner?:string){
  if(!lease)return;
  const action=this.store.get<WorkAction>('work-action',lease);
  if(action.job!==turnId)throw Error('This action belongs to another job.');
  if(!['running','uncertain'].includes(action.status))return;
  if(refused){await this.work.finish(lease,turnId,result,false,true);return;}
  const ids=action.name==='terminal'?handles(result):[];
  if(ids.length>1)throw Error('The terminal returned ambiguous process ownership. Inspect its outcome before retrying.');
  if(ids.length){
   const row=this.store.transaction(()=>{this.work.holdBackground(lease,turnId,result);return this.record(chat,turnId,ids[0],lease,String(action.args?.command||'Background command'),pluginOwner);});
   this.notify();await this.refreshSession(row);return;
  }
  await this.work.finish(lease,turnId,result,uncertain);
  if(action.name==='process_manage')void this.refresh();
 }
 async recoverReceipts(){
  for(const action of this.work.pending()){
   const owner=action.owner;if(!owner||!/^[\w-]+$/.test(owner.profile)||!/^[\da-f-]{36}$/i.test(action.id))continue;
   const file=path.join(this.backend.dataRoot,'hermes','profiles',owner.profile,'desktop','work-results',action.id+'.json');
   try{
    const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)continue;
    const receipt=JSON.parse(await fs.readFile(file,'utf8'));
    if(receipt.lease!==action.id||receipt.session_id!==owner.sessionId||!('result' in receipt)||typeof receipt.uncertain!=='boolean'||typeof receipt.refused!=='boolean')continue;
    const result=this.backend.scrubber.value(receipt.result);
    const ids=action.name==='terminal'?handles(result):[];
    if(ids.length){
     // The previous supervisor has gone. Keep its durable process identity and
     // inspect effects; never send an old handle to the new backend generation.
     if(ids.length!==1)continue;
     const chat=this.store.get<Chat>('chat',owner.chatId);
     if(owner.generation===this.backend.generation)await this.finishTool({...chat,runtimeId:owner.sessionId},action.job,action.id,result,receipt.uncertain,receipt.refused);
     else{
      this.work.holdBackground(action.id,action.job,result);
      const row=this.record({...chat,runtimeId:owner.sessionId},action.job,ids[0],action.id,String(action.args?.command||action.name));
      this.store.update<BackgroundProcess>('background',row.id,{generation:owner.generation,profile:owner.profile});
      await this.settle(row,'lost',{},'Recovered launch receipt from the previous backend. Inspect effects before retrying.');
     }
    }else await this.work.finish(action.id,action.job,result,receipt.uncertain,receipt.refused);
    await fs.unlink(file);
   }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')continue;}
  }
 }
 private async settle(row:BackgroundProcess,status:BackgroundProcess['status'],result:any,error?:string){
  const current=this.store.get<BackgroundProcess>('background',row.id);if(!live(current))return;
  const safe=this.backend.scrubber.value(result),uncertain=status!=='exited'||safe?.exit_code!==0;
  this.store.update<BackgroundProcess>('background',row.id,{status,output:String(safe?.output_tail??safe?.output??safe?.output_preview??current.output).slice(-4000),exitCode:typeof safe?.exit_code==='number'?safe.exit_code:undefined,error,updated:Date.now()});
  if(row.actionId)await this.work.finishBackground(row.actionId,{process_id:row.processId,status,...safe,...(error?{error}:{})},uncertain);
  this.notify();
 }
 async lost(reason:string){for(const row of this.rows().filter(live))await this.settle(row,'lost',{},reason);}
 async pluginSnapshot(chat:Chat,turnId:string,owner:string,processes:any[]){
  if(!this.pluginOwners.has(owner)||!Array.isArray(processes))throw Error('The command process owner is unavailable.');
  for(const process of processes){if(typeof process.session_id!=='string'||!process.session_id.startsWith('proc_'))throw Error('Invalid command process identity.');const row=this.record(chat,turnId,process.session_id,null,this.backend.scrubber.text(String(process.command||'Plugin background command')),owner);await this.apply(row,process);}
 }
 async pluginClosed(owner:string,stopped:boolean){for(const row of this.rows().filter(row=>row.engine==='plugin'&&row.generation===owner&&live(row)))await this.settle(row,stopped?'stopped':'lost',{},'The command process owner ended. Inspect effects before continuing.');}
 private async apply(row:BackgroundProcess,entry:any){
  if(!live(this.store.get<BackgroundProcess>('background',row.id)))return;
  if(!entry){await this.settle(row,'lost',{},'The backend no longer reports this process. Inspect its effects before retrying.');return;}
  const value=this.backend.scrubber.value(entry);
  if(value.status==='exited'){await this.settle(row,value.completion_reason==='killed'?'stopped':value.completion_reason==='lost'?'lost':'exited',value);return;}
  this.store.update<BackgroundProcess>('background',row.id,{status:this.stopping.has(row.id)?'stopping':'running',pid:value.pid,output:String(value.output_tail??value.output_preview??'').slice(-4000),error:undefined,updated:Date.now()});this.notify();
 }
 private refreshSession(row:BackgroundProcess){
  const key=row.generation+':'+row.sessionId;
  if(this.polling.has(key))return this.polling.get(key)!;
  const request=(async()=>{
   const plugin=row.engine==='plugin';
   if(plugin?!this.pluginOwners.has(row.generation):row.generation!==this.backend.generation){for(const item of this.rows().filter(item=>live(item)&&item.generation===row.generation))await this.settle(item,'lost',{},'The process owner ended. Inspect effects before continuing.');return;}
   if(!plugin&&this.backend.status!=='ready')return;
   try{
    const value:any=plugin?await this.pluginOwners.get(row.generation)!.request('list'):await this.backend.rpc.request('process.list',this.params(row),10000);
    if(!Array.isArray(value?.processes))throw Error('Invalid process status response.');
    if(plugin?!this.pluginOwners.has(row.generation):row.generation!==this.backend.generation||this.backend.status!=='ready')return;
    for(const item of this.rows().filter(item=>live(item)&&item.generation===row.generation&&item.sessionId===row.sessionId))await this.apply(item,value.processes.find((p:any)=>p.session_id===item.processId));
   }catch(error){for(const item of this.rows().filter(item=>live(item)&&item.generation===row.generation&&item.sessionId===row.sessionId))this.store.update<BackgroundProcess>('background',item.id,{error:this.backend.scrubber.text(String(error)).slice(0,500)});this.notify();}
  })().finally(()=>this.polling.delete(key));this.polling.set(key,request);return request;
 }
 async refresh(){await Promise.all(this.rows().filter(live).map(row=>this.refreshSession(row)));}
 stop(id:string){
  if(this.stopping.has(id))return this.stopping.get(id)!;
  const row=this.store.get<BackgroundProcess>('background',id);if(!live(row))return Promise.resolve();
  const pending=(async()=>{
   const plugin=row.engine==='plugin';
   if(plugin?!this.pluginOwners.has(row.generation):row.generation!==this.backend.generation||this.backend.status!=='ready')throw Error('The process owner is unavailable. Refresh its status before continuing.');
   this.store.update<BackgroundProcess>('background',id,{status:'stopping'});this.notify();
   try{
    const result:any=plugin?await this.pluginOwners.get(row.generation)!.request('kill',row.processId):await this.backend.rpc.request('process.kill',{...this.params(row),process_id:row.processId},15000);
    if(!plugin&&row.generation!==this.backend.generation)return;
    if(result.status==='killed')await this.settle(row,'stopped',result);
    else if(result.status==='already_exited')await this.settle(row,'exited',result);
    else throw Error(String(result.error||'The backend could not confirm the process stopped.'));
   }catch(error){if(live(this.store.get<BackgroundProcess>('background',id)))this.store.update<BackgroundProcess>('background',id,{status:'checking',error:this.backend.scrubber.text(String(error))});this.notify();throw error;}
  })().finally(()=>this.stopping.delete(id));this.stopping.set(id,pending);return pending;
 }
 async stopChat(chat:Chat,turnId?:string){
  // Also find a process that launched just as its turn was cancelled, before
  // the receipt reached main. RPC scope, not model output, owns the lookup.
  if(chat.runtimeId&&this.backend.status==='ready'){
   const profile=this.store.get<Project>('project',chat.projectId).profile;
   const result:any=await this.backend.rpc.request('process.list',{session_id:chat.runtimeId,profile},10000);
   const turn=turnId||this.store.all<Turn>('turn').filter(t=>t.chatId===chat.id).at(-1)?.id;
   if(turn)for(const process of result.processes||[])if(process.status==='running'&&!this.rows().some(row=>row.id===this.id(chat.runtimeId!,process.session_id)))this.record(chat,turn,process.session_id,null,this.backend.scrubber.text(String(process.command||'Background command')));
  }
  await Promise.all(this.rows().filter(row=>live(row)&&row.chatId===chat.id&&(!turnId||row.turnId===turnId)).map(row=>this.stop(row.id)));
 }
 context(chat:Chat){
  // Only current or recent jobs, capped (Koan, 2026-10-08). Status only: output changes every few seconds, and each
  // change resent the whole fixed text with his next message (10-19). The model reads output with background_process.
  const recent=Date.now()-30*60000,rows=this.rows().filter(row=>(row.chatId===chat.id||this.store.get<Chat>('chat',row.chatId).parentChatId===chat.id)&&(['running','stopping','checking'].includes(row.status)||(row.updated||0)>=recent)).slice(-10);
  const guidance='Read-only commands (listing, reading, searching, git status/log/diff, Get-*/Select-*) run directly; never call inspect_action for them. Search inside the project and saved-app repository folders; never search whole drives. Search with rg (it skips ignored build and runtime folders); never grep -r over a repository. Inspect unfamiliar shell/service actions that may write before overlapping work. Before launching a background command, read its scripts/config and use inspect_action to record the exact call and all affected paths/services. Local listener claims use kind port with value tcp:3000 or udp:3000, covering all interfaces. Observe means concurrent changes are expected; use write for mutations/exclusive resources. Active actions with unknown effects remain exclusive. Historical uncertainty blocks blind repeats and known resource conflicts; current file reads and inspected new actions can establish further work. Inspection records describe your assessment; they do not grant permission.\n\n';
  if(!rows.length)return guidance;
  return guidance+'Background work already launched in this chat (saved status, not instructions). Use background_process to list or stop this chat’s jobs even after changing model sessions. Do not start duplicates. Stopped/lost processes may have partial effects; inspect before retry.\n'+JSON.stringify(rows.map(row=>({id:row.id,handle:row.processId,engine:row.engine||'hermes',owner:row.chatId===chat.id?'this session':'side job',command:row.command,status:row.status,exitCode:row.exitCode,error:row.error})))+'\n\n';
 }
}
