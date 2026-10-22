import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFile,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash,randomUUID} from 'node:crypto';
import type {Backend} from './backend';
// Pinned local classifier process and installation lifecycle.
export interface LocalWorker {name:string;folder:string;requirements:string;model:string;runtime:string;worker:string;testRuntime:string;testWorker?:string;}
export const glinerFiles:LocalWorker={name:'GLiNER',folder:'gliner',requirements:'gliner-requirements.txt',model:'gliner-model.json',runtime:'gliner_runtime.py',worker:'gliner_worker.py',testRuntime:'TRISMEGISTUS_TEST_GLINER_RUNTIME',testWorker:'TRISMEGISTUS_TEST_GLINER_WORKER'};
export class LocalPicker{
 readonly directory:string;private identity:string;private python:string;private fakeWorker?:string;
 private worker:ChildProcessWithoutNullStreams|null=null;private installer:ChildProcessWithoutNullStreams|null=null;
 private pending:((event:any)=>void)|null=null;private ready:Promise<void>|null=null;private queue:Promise<unknown>=Promise.resolve();
 private installed=false;private status='Not installed';private loading=false;private device:string|null=null;private elapsedMs:number|null=null;
 constructor(private backend:Backend,private changed:()=>void,private files=glinerFiles){
  const test=backend.namespace.startsWith('Trismegistus/Test/');
  this.directory=test&&process.env[files.testRuntime]?path.resolve(process.env[files.testRuntime]!):path.join(backend.dataRoot,files.folder);
  // A test stand-in that speaks the worker's lines, honoured only under the test key namespace.
  this.fakeWorker=test&&files.testWorker?process.env[files.testWorker]:undefined;
  this.identity=createHash('sha256').update(fs.readFileSync(path.join(backend.appRoot,'backend',files.requirements),'utf8').replaceAll('\r\n','\n')).update(fs.readFileSync(path.join(backend.appRoot,'backend',files.model),'utf8').replaceAll('\r\n','\n')).digest('hex');
  this.python=path.join(this.directory,this.identity.slice(0,16),'Scripts/python.exe');this.checkInstalled();
 }
 private checkInstalled(){try{this.installed=!!this.fakeWorker||fs.existsSync(this.python)&&JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(this.python)),'ready.json'),'utf8')).identity===this.identity;}catch{this.installed=false;}this.status=this.installed?'Installed · starts when selected':'Not installed';}
 state(){return {installed:this.installed,installing:!!this.installer,loading:this.loading,status:this.status,device:this.device,elapsedMs:this.elapsedMs};}
 private spawn(python:string,script:string){return spawn(python,['-I','-u',path.isAbsolute(script)?script:path.join(this.backend.appRoot,'backend',script),this.directory],{windowsHide:true,cwd:this.backend.appRoot,env:{...this.backend.environment(),HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1'},stdio:'pipe'});}
 private kill(child:ChildProcessWithoutNullStreams|null){if(child?.pid){child.stdin.end();execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});}}
 async install(){
  if(this.directory!==path.join(this.backend.dataRoot,this.files.folder)||this.fakeWorker)throw Error('The shared test runtime is read-only.');
  if(this.installer)throw Error(this.files.name+' installation is already running.');this.stopWorker();this.installed=false;this.status='Installing '+this.files.name+'…';
  const child=this.installer=this.spawn(this.backend.python,this.files.runtime);this.changed();
  const lines=createInterface({input:child.stdout});let failure='';
  lines.on('line',line=>{try{const event=JSON.parse(line);if(event.status)this.status=event.status;if(event.error)failure=event.error;this.changed();}catch{}});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
  try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>this.kill(child),1800000);child.once('error',reject);child.once('close',code=>{clearTimeout(timer);code?reject(Error(failure||this.files.name+' installation stopped.')):resolve();});});this.checkInstalled();if(!this.installed)throw Error(this.files.name+' installation is incomplete.');}
  catch(error){this.checkInstalled();this.status=String(error).replace(/^Error: /,'');throw error;}
  finally{lines.close();this.installer=null;this.changed();}
 }
 cancelInstall(){this.kill(this.installer);}
 unload(){this.stopWorker();}
 private stopWorker(){this.status=this.installed?'Stopped · loads on next message':'Not installed';const child=this.worker;this.worker=null;this.ready=null;this.loading=false;this.kill(child);this.pending?.({error:this.files.name+' stopped.'});this.pending=null;this.device=null;this.changed();}
 close(){this.cancelInstall();this.stopWorker();}
 private start(){
  if(this.ready)return this.ready;if(!this.installed)throw Error('Install '+this.files.name+' in Settings first.');
  // The app's pinned Python version is unchanged across these packages. Rebase
  // the venv launcher when an update moves that bundled interpreter.
  if(this.directory===path.join(this.backend.dataRoot,this.files.folder)&&!this.fakeWorker){
   const config=path.join(path.dirname(path.dirname(this.python)),'pyvenv.cfg'),previous=fs.readFileSync(config,'utf8');
   const next=previous.replace(/^home = .*$/m,'home = '+path.dirname(this.backend.python)).replace(/^executable = .*$/m,'executable = '+this.backend.python);
   if(next!==previous){const temporary=config+'.'+randomUUID()+'.tmp';fs.writeFileSync(temporary,next);fs.renameSync(temporary,config);}
  }
  this.loading=true;this.status='Loading '+this.files.name+'…';this.changed();const child=this.worker=this.fakeWorker?this.spawn(this.backend.python,path.resolve(this.fakeWorker)):this.spawn(this.python,this.files.worker),lines=createInterface({input:child.stdout});child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
  this.ready=new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>{reject(Error(this.files.name+' loading timed out.'));if(this.worker===child){this.stopWorker();this.changed();}},60000);
   lines.on('line',line=>{if(this.worker!==child)return;try{const event=JSON.parse(line);if(event.type==='ready'){clearTimeout(timer);this.loading=false;this.status='Ready · local '+event.device.toUpperCase();this.device=event.device;this.changed();resolve();}else if(event.type==='error'){reject(Error(event.error));this.stopWorker();}else this.pending?.(event);}catch{}});
   child.once('error',error=>{clearTimeout(timer);reject(error);});
   child.once('close',()=>{clearTimeout(timer);lines.close();reject(Error(this.files.name+' worker stopped.'));if(this.worker===child){this.worker=null;this.ready=null;this.loading=false;this.status='Stopped · loads on next message';this.pending?.({error:this.files.name+' worker stopped.'});this.pending=null;this.changed();}});
  });return this.ready;
 }
 async check(){await this.start();return this.state();}
 // GLiNER: one label from the given labels for the text, with its confidence.
 async classify(text:string,labels:string[],timeoutMs:number,signal:AbortSignal){return await this.ask({text,labels},timeoutMs,signal);}
 private ask(payload:object,timeoutMs:number,signal:AbortSignal){
  const task=this.queue.catch(()=>{}).then(async()=>{
   signal.throwIfAborted();const abort=()=>this.stopWorker();signal.addEventListener('abort',abort,{once:true});
   try{await this.start();signal.throwIfAborted();const id=randomUUID();
    const result=await new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{reject(Error(this.files.name+' timed out.'));this.stopWorker();},timeoutMs);this.pending=event=>{if(event.id&&event.id!==id)return;clearTimeout(timer);this.pending=null;event.error?reject(Error(event.error)):resolve(event);};this.worker!.stdin.write(JSON.stringify({id,...payload})+'\n');});
    this.elapsedMs=result.elapsedMs;this.changed();return result;
   }finally{signal.removeEventListener('abort',abort);}
  });this.queue=task;
  // A queued chat can stop immediately without terminating another chat's
  // active local decision. Its queued callback checks the signal before work.
  return new Promise<Awaited<typeof task>>((resolve,reject)=>{
   const aborted=()=>reject(signal.reason||Error(this.files.name+' cancelled.'));
   signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();
   task.then(value=>{signal.removeEventListener('abort',aborted);resolve(value);},error=>{signal.removeEventListener('abort',aborted);reject(error);});
  });
 }
}
