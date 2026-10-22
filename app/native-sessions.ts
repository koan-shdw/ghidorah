import {ClaudeSession,type ClaudeRun,type ClaudeResult,type ClaudeSessionHooks} from './claude';
import type {Store} from './store';
import type {Chat,Turn} from './types';
import type {EnginePosition} from './history';
import type {BackgroundProcess} from './background-work';
import type {WorkCoordination,WorkAction} from './work-coordination';

// rows: every message row this process has answered or is answering, so a handover into the live process starts
// after the last of them (TURN-REVIEW part 1). last: the newest options sent, the context a turn Claude starts itself
// inherits.
type Runtime={chatId:string;model:string;session:ClaudeSession;rows:Set<string>;last?:ClaudeRun};
// What main supplies: the chat runner's wake-up on idle, a visible warning, and automatic rows.
export interface NativeHooks {
 idle?:(chatId:string)=>void;
 warning?:(chatId:string,message:string)=>void;
 automatic?:(chatId:string,runtimeId:string,last:ClaudeRun|undefined,model:string)=>ReturnType<NonNullable<ClaudeSessionHooks['automatic']>>;
}
const live=(row:BackgroundProcess)=>['checking','running','stopping'].includes(row.status);

// Native Claude owns execution. Main owns durable receipts and the only live
// writer for each native session; saved IDs are never execution instructions.
export class NativeSessions {
 private runtimes=new Map<string,Runtime>();
 private stopping=new Map<string,Promise<void>>();
 private cancelledTurns=new Set<string>();
 constructor(private store:Store,private work:WorkCoordination,private notify:()=>void,public hooks:NativeHooks={}){}
 rows(){return this.store.all<BackgroundProcess>('background').filter(row=>row.engine==='claude');}
 get busy(){return [...this.runtimes.values()].some(row=>row.session.hasPendingWork);}
 // Claude's own word: this chat's Claude is answering or owes a reply (TURN-REVIEW part 1).
 processing(chatId:string){return [...this.runtimes.values()].some(row=>row.chatId===chatId&&row.session.busy);}
 processingReasons(chatId:string){return [...this.runtimes.values()].filter(row=>row.chatId===chatId).flatMap(row=>row.session.busyReasons);}
 private chatRuntimes(chatId:string){return [...this.runtimes.values()].filter(row=>row.chatId===chatId&&row.session.live);}
 // The row whose reply Claude is writing in this chat, and the model the chat's live process runs.
 replyRow(chatId:string){for(const row of this.chatRuntimes(chatId)){const id=row.session.replyRow;if(id)return id;}return undefined;}
 liveModel(chatId:string){return this.chatRuntimes(chatId).at(-1)?.session.currentModel;}
 // Where a handover into the chat's live process starts: after the last row before this one that it already has.
 // A busy process is used before Claude reports its session ID, so its own ID stands in for the handover.
 livePosition(chatId:string,before:string[]):EnginePosition|undefined{
  const runtimes=this.chatRuntimes(chatId),runtime=runtimes.find(row=>row.session.busy)||runtimes.at(-1);
  const sessionId=runtime?.session.sessionId||(runtime?.session.busy?runtime.session.id:undefined);if(!runtime||!sessionId)return undefined;
  const through=[...before].reverse().find(id=>runtime.rows.has(id));if(!through)return undefined;
  return {id:chatId+':claude',chatId,engine:'claude',sessionId,throughTurnId:through,uncertain:false};
 }
 // While Claude answers in this chat, a message for the same model goes into that process, whatever its saved
 // position says: a second process for one chat would answer without the first one's context.
 busyRuntime(chatId:string){return this.chatRuntimes(chatId).find(row=>row.session.busy)?.session;}
 // Stop: the reply Claude is writing in this chat, only that (TURN-REVIEW part 5).
 async interrupt(chatId:string){const out:string[]=[];for(const row of this.chatRuntimes(chatId))if(row.session.replyRow)out.push(...(await row.session.interrupt()).stillQueued);return out;}
 // His remove button on a message Claude has not taken yet. false: Claude already took it.
 async withdraw(chatId:string,turnId:string){for(const row of this.chatRuntimes(chatId))if(row.rows.has(turnId))return row.session.withdraw(turnId);return true;}
 // Sends a message into the picked process at once; the promise ends when Claude has answered it.
 submit(picked:{session:ClaudeSession;options:ClaudeRun}){
  const runtime=this.runtimes.get(picked.session.id);if(runtime){runtime.last=picked.options;if(picked.options.turnId)runtime.rows.add(picked.options.turnId);}
  return picked.session.submit(picked.options);
 }
 private sessionHooks(chatId:string,id:()=>string):ClaudeSessionHooks{
  return {
   event:event=>{
    if(event.type==='runtime.idle'){this.hooks.idle?.(chatId);this.notify();}
    else if(event.type==='runtime.warning')this.hooks.warning?.(chatId,event.message);
    else void this.event(event.runtimeId||id(),undefined,undefined,event,()=>undefined).catch(()=>{});
   },
   automatic:info=>{const runtime=this.runtimes.get(info.runtimeId);const made=this.hooks.automatic?.(chatId,info.runtimeId,runtime?.last,info.model);if(made?.options.turnId)runtime?.rows.add(made.options.turnId);return made;},
  };
 }
 position(id:string){try{return this.store.get<EnginePosition>('native-session',id);}catch{return undefined;}}
 session(id:string){const runtime=this.runtimes.get(id);if(!runtime)throw Error('The native task owner is unavailable.');return runtime.session;}
 async recover(){
  for(const row of this.rows().filter(live)){
   await this.settle(row,'lost','The app restarted. Inspect the saved effects before continuing.');
   const position=this.store.enginePosition(row.chatId,'claude');this.store.put('engine',{...position,uncertain:true});
  }
 }
 async acquire(chat:Chat,options:ClaudeRun,reseed:()=>ClaudeRun){
  let owned=[...this.runtimes.values()].find(row=>row.session.sessionId===options.sessionId&&row.session.live);
  if(owned&&owned.chatId!==chat.id)throw Error('This native session belongs to another chat.');
  // Keep other chats' idle sessions warm like Claude Code; close the oldest idle ones only past 4 processes.
  for(const runtime of [...this.runtimes.values()]){if(this.runtimes.size<4)break;if(runtime.chatId!==chat.id&&!runtime.session.hasPendingWork){await runtime.session.close();this.runtimes.delete(runtime.session.id);}}
  // A Claude model switch runs set_model in the same session (ClaudeSession.run).
  if(owned&&owned.session.compatible(options)){owned.model=options.model;return {session:owned.session,options};}
  // A changed effort/root/plugin configuration cannot open a second --resume
  // writer while the old native process still owns tasks or a completion reply.
  if(owned){options=reseed();if(!owned.session.hasPendingWork){await owned.session.close();this.runtimes.delete(owned.session.id);}}
  for(const runtime of [...this.runtimes.values()])if(runtime.chatId===chat.id&&!runtime.session.hasPendingWork){await runtime.session.close();this.runtimes.delete(runtime.session.id);}
  let opened='';const session=await ClaudeSession.open(options,this.sessionHooks(chat.id,()=>opened));opened=session.id;this.runtimes.set(session.id,{chatId:chat.id,model:options.model,session,rows:new Set()});return {session,options};
 }
 finished(runtimeId:string,turn:Turn,result:ClaudeResult){
  // A task update may overlap a human reply on another engine. Keep the last
  // explicit-turn cursor so later handovers refresh those intervening results.
  if(turn.automatic)return;
  const old=this.position(runtimeId);
  this.store.put<EnginePosition>('native-session',{id:runtimeId,chatId:turn.chatId,engine:'claude',sessionId:result.sessionId||null,throughTurnId:turn.id,uncertain:result.status!=='completed',exchanges:(old?.exchanges||0)+1});
 }
 async event(runtimeId:string,chat:Chat|undefined,turn:Turn|undefined,event:any,lease:(toolId:string)=>string|null|undefined){
  if(event.type==='runtime.closed'){
   for(const row of this.rows().filter(row=>row.generation===runtimeId&&live(row)))await this.settle(row,'lost','The native worker ended. Inspect effects before continuing.');return;
  }
  if(event.type==='runtime.promptBlocked'){
   for(const row of this.rows().filter(row=>row.generation===runtimeId))this.store.update<BackgroundProcess>('background',row.id,{error:event.reason,updated:Date.now()});this.notify();return;
  }
  if(event.type!=='system')return;
  const id=runtimeId+':'+event.task_id;
  if(event.subtype==='task_started'){
   // Foreground commands report tasks too; they belong to their tool call, never a background row (TURN-REVIEW part 1).
   if(event.is_backgrounded!==true&&event.task_type!=='local_agent'||!chat||!turn)return;
   const actionId=lease(event.tool_use_id);if(actionId===undefined)throw Error('Native task has no registered launching action.');
   const action=actionId?this.store.get<WorkAction>('work-action',actionId):null,owner=action?this.store.get<Turn>('turn',action.job):turn;
   const row:BackgroundProcess={engine:'claude',id,chatId:chat.id,turnId:owner.id,actionId,generation:runtimeId,sessionId:event.session_id||this.session(runtimeId).sessionId||'',profile:'',processId:event.task_id,command:String(event.description||action?.args?.command||'Native task'),status:'running',output:'',created:Date.now(),updated:Date.now()};
   this.store.transaction(()=>{if(actionId&&action?.status==='running')this.work.holdBackground(actionId,owner.id,{task_id:event.task_id});this.store.put('background',row);});
   this.notify();if(this.cancelledTurns.has(owner.id))void this.stop(row.id).catch(()=>{});return;
  }
  const row=this.rows().find(row=>row.id===id);if(!row)return;
  if(event.subtype==='task_notification'&&event.summary)this.store.update<BackgroundProcess>('background',id,{output:String(event.summary).slice(-4000),updated:Date.now()});
  const status=event.patch?.status||event.status;
  if(['completed','failed','killed','stopped'].includes(status)&&live(row))await this.settle(row,status==='killed'||status==='stopped'?'stopped':'exited',status==='failed'?'The native task failed. Inspect its effects.':undefined,status==='completed'?0:status==='failed'?1:undefined);
  else this.notify();
 }
 async finishTool(lease:string|null,turnId:string,result:any,failed:boolean,refused=false){
  if(!lease)return;const action=this.store.get<WorkAction>('work-action',lease);
  // A launch receipt keeps its lease until a terminal lifecycle frame arrives.
  if(this.rows().some(row=>row.actionId===lease))return;
  await this.work.finish(lease,turnId,result,failed,refused);
 }
 private async settle(row:BackgroundProcess,status:BackgroundProcess['status'],error?:string,exitCode?:number){
  this.store.update<BackgroundProcess>('background',row.id,{status,error,exitCode,updated:Date.now()});
  // A task that exited ran to its end: any exit code is a known outcome the model has already seen.
  // Only a task cut off mid-run (stopped, killed, lost) leaves effects uncertain.
  if(row.actionId)await this.work.finishBackground(row.actionId,{task_id:row.processId,status,exit_code:exitCode,error},status!=='exited');this.notify();
 }
 stop(id:string){
  if(this.stopping.has(id))return this.stopping.get(id)!;
  const row=this.store.get<BackgroundProcess>('background',id);if(row.engine!=='claude')throw Error('Not a native task.');if(!live(row))return Promise.resolve();
  const request=(async()=>{
   const runtime=this.runtimes.get(row.generation);if(!runtime||runtime.chatId!==row.chatId||!runtime.session.live)throw Error('The native task owner is unavailable.');
   this.store.update<BackgroundProcess>('background',id,{status:'stopping'});this.notify();
   try{await runtime.session.stopTask(row.processId);}
   catch(error){if(live(this.store.get<BackgroundProcess>('background',id)))this.store.update<BackgroundProcess>('background',id,{status:'checking',error:String(error)});this.notify();throw error;}
  })().finally(()=>this.stopping.delete(id));this.stopping.set(id,request);return request;
 }
 async stopChat(chatId:string,turnId?:string){
  if(turnId)this.cancelledTurns.add(turnId);
  await Promise.all(this.rows().filter(row=>row.chatId===chatId&&live(row)&&(!turnId||row.turnId===turnId)).map(row=>this.stop(row.id)));
 }
 async setMode(chatIds:string[],mode:ClaudeRun['mode'],commit?:()=>Promise<void>){
  const changed:{session:ClaudeSession;previous:ClaudeRun['mode']}[]=[];
  try{for(const runtime of this.runtimes.values())if(chatIds.includes(runtime.chatId)&&runtime.session.live){changed.push({session:runtime.session,previous:runtime.session.permissionMode});await runtime.session.setMode(mode);}await commit?.();}
  catch(error){
   let stopped=false;
   await Promise.all(changed.map(async row=>{try{await row.session.setMode(row.previous);}catch{stopped=true;await row.session.close();}}));
   if(stopped)throw Error('The permission change failed. A native session was stopped because its previous mode could not be restored. '+String(error));throw error;
  }
 }
 async closeChat(chatId:string){for(const runtime of [...this.runtimes.values()])if(runtime.chatId===chatId){if(runtime.session.hasPendingWork)throw Error('Stop this chat’s native work first.');await runtime.session.close();this.runtimes.delete(runtime.session.id);}}
 async closeIdle(){for(const runtime of [...this.runtimes.values()])if(!runtime.session.hasPendingWork){await runtime.session.close();this.runtimes.delete(runtime.session.id);}}
 async close(){await Promise.all([...this.runtimes.values()].map(row=>row.session.close()));this.runtimes.clear();}
 context(chat:Chat){const recent=Date.now()-30*60000,rows=this.rows().filter(row=>(row.chatId===chat.id||this.store.get<Chat>('chat',row.chatId).parentChatId===chat.id)&&(['running','stopping','checking'].includes(row.status)||(row.updated||0)>=recent)).slice(-10);return rows.length?'Saved native Claude tasks in this chat. Do not relaunch them. Use background_process to list or stop this chat’s jobs, including tasks retained in an older native session. Inspect stopped/lost task effects before retrying.\n'+JSON.stringify(rows.map(({id,processId,command,status,error})=>({id,handle:processId,command,status,error})))+'\n\n':'';}
}
