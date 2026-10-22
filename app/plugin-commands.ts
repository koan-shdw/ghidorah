import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Backend} from './backend';

export interface PluginHandler {name:string;command:string;plugin:string;pluginKey:string;pluginId:string;hash:string;description:string;kind:'Plugin command';}
export interface PluginProcessOwner {id:string;request:(method:'list'|'kill',processId?:string)=>Promise<any>;close:()=>Promise<void>;}

export function pluginWorker(backend:Backend,request:Record<string,unknown>,signal:AbortSignal,output:(text:string)=>void=()=>{},approve:(description:string,command?:string)=>Promise<boolean>=async()=>false,work?:(request:any)=>Promise<any>,lifecycle?:{opened:(owner:PluginProcessOwner)=>void;processes:(rows:any[])=>Promise<void>;closed:(stopped:boolean)=>Promise<void>}){
 signal.throwIfAborted();
 return new Promise<any>((resolve,reject)=>{
  const child=spawn(backend.python,[path.join(backend.appRoot,'backend','claude_worker.py')],{cwd:backend.appRoot,env:backend.environment(),windowsHide:true,stdio:'pipe'});
  const lines=createInterface({input:child.stdout});let result:any,complete=false,failure:Error|undefined,diagnostic='',requestedClose=false,hasProcesses=false;
  let receipts=Promise.resolve(),closed!:()=>void;const closing=new Promise<void>(resolve=>closed=resolve),controls=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  const stream=backend.scrubber.stream();
  child.stdin.on('error',()=>{});child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-8000);});
  const abort=()=>child.stdin.end();signal.addEventListener('abort',abort,{once:true});
  lifecycle?.opened({id:randomUUID(),close:()=>{requestedClose=true;abort();return closing;},request:(method,processId)=>new Promise((resolve,reject)=>{if(child.stdin.writableEnded){reject(Error('The command process owner ended.'));return;}const id=randomUUID(),timer=setTimeout(()=>{controls.delete(id);reject(Error('Command process status timed out.'));},15000);controls.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({type:'process',id,method,processId})+'\n');})});
  // The existing supervisor closes its kill-on-close job after EOF or app death.
  const timeout=request.operation==='catalog'?setTimeout(()=>{failure=Error('Plugin command discovery timed out.');abort();},60000):undefined;
  lines.on('line',line=>{
   let message:any;try{message=JSON.parse(line);}catch{failure=Error('Invalid plugin command response.');abort();return;}
   if(message.type==='process'){const control=controls.get(message.id);if(control){clearTimeout(control.timer);controls.delete(message.id);if(message.error)control.reject(Error(backend.scrubber.text(message.error)));else control.resolve(backend.scrubber.value(message.value));}return;}
   if(message.type==='processes'){hasProcesses=Array.isArray(message.value)&&message.value.some((row:any)=>row.status==='running');receipts=receipts.then(()=>lifecycle?.processes(backend.scrubber.value(message.value))).then(()=>{}).catch(error=>{failure=error;abort();});return;}
   if(complete||failure)return;
   if(message.type==='output'&&typeof message.text==='string')output(stream(message.text));
   else if(message.type==='approval')void approve(backend.scrubber.text(String(message.description||message.command)),backend.scrubber.text(String(message.command||''))).then(approved=>{if(!signal.aborted&&!child.stdin.writableEnded)child.stdin.write(JSON.stringify({id:message.id,approved})+'\n');},()=>abort());
   else if(message.type==='work')void (async()=>{try{if(!work)throw Error('Action coordination is unavailable.');return await work(backend.scrubber.value(message));}catch(error){return {error:backend.scrubber.text(String(error))};}})().then(value=>{if(!signal.aborted&&!child.stdin.writableEnded)child.stdin.write(JSON.stringify({id:message.id,...value})+'\n');});
   else if(message.type==='result'){result=backend.scrubber.value(message.value);complete=true;if(lifecycle&&hasProcesses)void receipts.then(()=>{if(failure)reject(failure);else if(signal.aborted)reject(Error('Command stopped. Check any effects before retrying.'));else resolve(result);});}
   else if(message.type==='error'){failure=Error(backend.scrubber.text(message.message));}
  });
  child.once('error',error=>{failure=error;});
  child.once('close',async code=>{
   if(timeout)clearTimeout(timeout);signal.removeEventListener('abort',abort);lines.close();output(stream('',true));
   for(const control of controls.values()){clearTimeout(control.timer);control.reject(Error('The command process owner ended.'));}controls.clear();
   await receipts;try{await lifecycle?.closed(signal.aborted||requestedClose);}catch(error){failure=error instanceof Error?error:Error(String(error));}finally{closed();}
   if(signal.aborted)reject(Error('Command stopped. Check any effects before retrying.'));
   else if(failure)reject(failure);
   else if(!complete||code)reject(Error(backend.scrubber.text(diagnostic)||'Plugin command stopped before its result was saved. Check any effects before retrying.'));
   else resolve(result);
  });
  child.stdin.write(JSON.stringify({executable:backend.python,args:[path.join(backend.appRoot,'backend','plugin_commands.py')],cwd:backend.appRoot})+'\n');
  child.stdin.write(JSON.stringify({root:path.join(backend.dataRoot,'hermes'),namespace:backend.namespace,provider_access:backend.providerAccess,provider_urls:{deepseek:process.env.TRISMEGISTUS_TEST_PROVIDER_URL||'https://api.deepseek.com/v1','openai-codex':process.env.TRISMEGISTUS_TEST_CODEX_URL||'https://chatgpt.com/backend-api/codex'},...request})+'\n');
 });
}
