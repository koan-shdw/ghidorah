import {randomUUID} from 'node:crypto';

export interface PluginChange {id:string;name:string;action:string;status:'queued'|'applying'|'completed'|'failed'|'cancelled';message:string;cancellable:boolean;}
type Entry=PluginChange&{key:string;controller:AbortController;done:Promise<unknown>;resolve:(value:unknown)=>void;reject:(error:unknown)=>void;apply:(signal:AbortSignal,activate:()=>void)=>Promise<unknown>};
// Reviewed changes wait in this app session; plugin code runs only after work is idle.
export class PluginChanges {
 private entries:Entry[]=[];
 private current:Entry|null=null;
 private closed=false;
 constructor(private wait:()=>string|null,private changed:()=>void){}
 get pending(){return this.entries.some(row=>row.status==='queued'||row.status==='applying');}
 rows():PluginChange[]{return this.entries.map(({id,name,action,status,message,cancellable})=>({id,name,action,status,message:status==='queued'?(this.wait()||'Waiting to apply')+'. Keep Tris open.':message,cancellable}));}
 enqueue(key:string,name:string,action:string,apply:Entry['apply']){
  if(this.closed)return Promise.reject(Error('The app is closing.'));
  const existing=this.entries.find(row=>row.key===key&&['queued','applying'].includes(row.status));if(existing)return existing.done;
  this.entries=this.entries.filter(row=>['queued','applying'].includes(row.status)).concat(this.entries.filter(row=>!['queued','applying'].includes(row.status)).slice(-9));
  let resolve!:(value:unknown)=>void,reject!:(error:unknown)=>void;const done=new Promise<unknown>((yes,no)=>{resolve=yes;reject=no;});
  const row:Entry={done,resolve,reject,id:randomUUID(),key,name,action,status:'queued',message:'Waiting to apply',cancellable:true,controller:new AbortController(),apply};
  this.entries.push(row);this.changed();this.poke();return row.done;
 }
 cancel(id?:string){
  const row=id?this.entries.find(row=>row.id===id):this.current;
  if(!row||!row.cancellable)return;
  row.controller.abort();row.cancellable=false;
  if(row.status==='queued'){row.status='cancelled';row.message='Cancelled';row.reject(Error('Plugin change cancelled.'));}
  else row.message='Cancelling setupâ€¦';
  this.changed();this.poke();
 }
 close(){this.closed=true;for(const row of this.entries)if(row.cancellable)this.cancel(row.id);}
 poke(){
  if(this.closed||this.current||this.wait())return;
  const row=this.entries.find(row=>row.status==='queued');if(!row)return;
  this.current=row;row.status='applying';row.message='Preparing '+row.name+'â€¦';this.changed();
  void (async()=>{
   try{
    const result=await row.apply(row.controller.signal,()=>{row.controller.signal.throwIfAborted();row.cancellable=false;row.message='Applying '+row.name+' and refreshing commandsâ€¦';this.changed();});
    row.status='completed';row.message=row.name+' Â· '+row.action+' complete';row.resolve(result);
   }catch(error){row.status=row.controller.signal.aborted?'cancelled':'failed';row.message=row.controller.signal.aborted?'Cancelled':String(error).replace(/^Error: /,'');row.reject(error);}
   finally{row.cancellable=false;this.current=null;this.changed();this.poke();}
  })();
 }
}
