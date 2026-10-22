import type {Backend} from './backend';
import type {Store} from './store';
import type {AccountHealth} from './availability';
import {availabilityMessage} from './availability';
import {apiSuppliers,isApiProvider,apiModel,splitApiModel,type ApiConnection,type ApiProvider} from './api-catalog';
import exclusions from '../backend/non-chat-models.json';
const statusOperation=(provider:string)=>provider==='nous'?'nous_status':provider==='minimax-oauth'?'minimax_status':provider==='vertex'?'vertex_status':provider==='xai-oauth'?'grok_status':'api_status';
const nonChatModel=new RegExp(exclusions.pattern,'i');
// Apply the same media exclusions to saved/manual choices without losing their metadata.
const chatModels=(models:ApiConnection['models'])=>models.filter(row=>{
 try{const parsed=splitApiModel(row.id);return parsed!==null&&!nonChatModel.test(parsed.model);}catch{return false;}
});

export class ApiProviders{
 private connections:Partial<Record<ApiProvider,ApiConnection>>={};private versions=new Map<string,number>();
 constructor(private backend:Backend,private store:Store,private health:AccountHealth,private changed:()=>void){}
 rows(){return Object.keys(apiSuppliers).flatMap(provider=>this.connections[provider as ApiProvider]?[this.connections[provider as ApiProvider]!]:[]);}
 models(){return this.rows().filter(row=>row.connected).flatMap(row=>row.models.map(model=>model.id));}
 urls(){return Object.fromEntries(this.rows().filter(row=>row.baseUrl).map(row=>[row.provider,row.baseUrl]));}
 async load(){
  await Promise.all(Object.keys(apiSuppliers).map(async provider=>{
   const saved=this.store.all<ApiConnection&{id:string}>('api-connection').find(row=>row.id===provider);
   if(provider==='vertex'){for(const value of await this.backend.host('vertex_redactions'))this.backend.scrubber.register(value);}
   else if(provider!=='nous'&&!provider.endsWith('-oauth')){const credential=await this.backend.host('read_key',{provider});this.backend.scrubber.register(credential.key||'');}
   const current:ApiConnection=await this.backend.host(statusOperation(provider),{provider});
   const models=current.connected?chatModels(saved?.models||[]):[];
   this.connections[provider as ApiProvider]={...current,models,source:models.length?'cached':'unverified'};
  }));this.changed();
 }
 async check(provider:unknown,signal?:AbortSignal){
  if(!isApiProvider(provider))throw Error('Unknown supplier.');
  const version=(this.versions.get(provider)||0)+1;this.versions.set(provider,version);const started=Date.now();
  const result:ApiConnection=await this.backend.host(statusOperation(provider),{provider,check:true},signal);if(this.versions.get(provider)!==version)return;
  if(result.authFailed)this.health.observe(provider,'auth','auth',true,started);
  if(result.source==='live')this.health.clear(provider,['auth'],started);
  // An unavailable catalogue cannot erase known model choices or clear credit exhaustion.
  const old=this.connections[provider];if(result.source!=='live'&&result.connected){result.models=old?.models||[];result.source=result.models.length?'cached':'unverified';}
  if(result.source==='live')result.models.push(...(old?.models||[]).filter(model=>model.manual&&!result.models.some(item=>item.id===model.id)));
  result.models=chatModels(result.models);
  const blocked=this.health.rows().find(row=>row.provider===provider&&row.scope==='account'&&row.blocked&&!(row.resetAt&&row.resetAt<=Date.now()));if(blocked)result.status=availabilityMessage(blocked);
  this.connections[provider]=result;this.store.put('api-connection',{...result,id:provider});this.changed();return result;
 }
 forget(provider:unknown){if(!isApiProvider(provider))throw Error('Unknown supplier.');this.versions.set(provider,(this.versions.get(provider)||0)+1);this.connections[provider]={...this.connections[provider]!,provider,connected:false,models:[],status:'Not connected',source:'unverified',checkedAt:null};this.store.put('api-connection',{...this.connections[provider],id:provider});}
 loginState(status:string,login:ApiConnection['login']=null,provider:ApiProvider='xai-oauth'){this.versions.set(provider,(this.versions.get(provider)||0)+1);const row=this.connections[provider];if(row){row.status=status;row.login=login;}this.changed();}
 async addNamedModel(provider:unknown,model:unknown){
  if(!isApiProvider(provider)||typeof model!=='string'||!this.connections[provider]?.connected)throw Error('Connect the supplier first.');
  const version=this.versions.get(provider),id=apiModel(provider,model.trim()),metadata=await this.backend.host('api_model',{provider,model:model.trim()});
  if(this.versions.get(provider)!==version||!this.connections[provider]?.connected)throw Error('The connection changed. Try again.');
  const row=this.connections[provider]!;if(!row.models.some(m=>m.id===id))row.models.push({...metadata,manual:true});
  row.source='manual';this.store.put('api-connection',{...row,id:provider});this.changed();
 }
}
