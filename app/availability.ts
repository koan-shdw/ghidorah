import type {Store} from './store';
import type {Snapshot} from './types';
import {providerFor} from './models';
import {isApiProvider} from './api-catalog';

export interface Availability {
 id:string;provider:string;key:string;scope:string;blocked:boolean;
 reason:'auth'|'credit'|'limit'|'model';resetAt:number|null;observedAt:number;
}
export function resetTime(value:unknown){const time=typeof value==='number'?value*1000:typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(time)&&time>0&&time<=8.64e15?time:null;}
export function affects(row:Availability,model:string,provider=providerFor(model)){return row.provider===provider&&(row.scope==='account'||row.scope===model||(['opus','sonnet'].includes(row.scope)&&model.toLowerCase().includes(row.scope)));}
export function blockedFor(rows:Availability[],model:string,now=Date.now(),provider=providerFor(model)){
 return rows.find(row=>row.blocked&&affects(row,model,provider)&&!(row.reason==='limit'&&row.resetAt!==null&&row.resetAt<=now));
}
export function availabilityMessage(row:Availability){
 const reason={auth:'Sign in again',credit:'Credit exhausted',limit:'Usage limit reached',model:'Model unavailable for this account'}[row.reason];
 return reason+(row.resetAt&&row.resetAt>Date.now()?' · resets '+new Date(row.resetAt).toLocaleString():'');
}
// Model pill dot, fed by the 5-minute checks: green fine, amber limited or out of credit, red down, grey not checked yet.
export type Health='ok'|'limited'|'down'|'unknown';
export function healthOf(status:string|undefined,blocked?:Availability):Health{
 if(blocked)return blocked.reason==='credit'||blocked.reason==='limit'?'limited':'down';
 if(!status)return 'unknown';
 if(/^(connected|signed in)$/i.test(status))return 'ok';
 if(/limit|credit|exhausted/i.test(status))return 'limited';
 if(/not connected|sign in|signed out|authentication failed|denied|refresh failed|not installed/i.test(status))return 'down';
 return 'unknown';
}
export function modelStatus(state:Snapshot,model:string){
 // Signed out or model refused outranks out of credit, so the worst problem shows.
 const blocking=(state.availability||[]).filter(row=>blockedFor([row],model)),blocked=blocking.find(row=>row.reason==='auth'||row.reason==='model')||blocking[0],provider=providerFor(model);
 const status=blocked?availabilityMessage(blocked):provider==='deepseek'?state.providerStatus:provider==='claude-code'?state.claude?.status:provider==='openai-codex'?state.codex?.status:state.apiProviders?.find(row=>row.provider===provider)?.status;
 return {status,health:healthOf(status,blocked)};
}
export class AccountHealth {
 constructor(private store:Store){}
 rows(){return this.store.all<Availability>('availability');}
 observe(provider:string,key:string,reason:Availability['reason'],blocked:boolean,observedAt=Date.now(),resetAt:number|null=null,scope='account'){
  const id=provider+':'+key+':'+scope,previous=this.rows().find(row=>row.id===id);
  // A check started before a newer request failed cannot restore the account.
  if(previous&&previous.observedAt>observedAt)return;
  this.store.put('availability',{id,provider,key,scope,reason,blocked,observedAt,resetAt});
 }
 clear(provider:string,keys:string[],observedAt:number,model?:string){
  for(const row of this.rows())if(row.provider===provider&&keys.includes(row.key)&&(!model||affects(row,model)))this.observe(provider,row.key,row.reason,false,observedAt,null,row.scope);
 }
 hermes(model:string,payload:any,provider=providerFor(model)){
  const surface=payload.error_surface;
  if(surface?.provider&&surface.provider!==provider)return;
  if(surface?.code==='model_quota_exhausted')this.observe(provider,'limit','limit',true,Date.now(),resetTime(surface.resets_at),model);
  else if(surface?.code==='quota_exhausted')this.observe(provider,'limit','limit',true,Date.now(),resetTime(surface.resets_at));
  else if(payload.billing&&!payload.billing.unverified||surface?.layer==='billing'&&surface.code!=='billing_unverified')this.observe(provider,'billing',provider==='deepseek'||isApiProvider(provider)&&provider!=='nous'&&!provider.endsWith('-oauth')?'credit':'limit',true,Date.now(),resetTime(surface?.resets_at));
  else if(surface?.layer==='auth')this.observe(provider,'auth','auth',true);
  else if(surface?.code==='rate_limit'&&resetTime(surface.resets_at)!==null)this.observe(provider,'limit','limit',true,Date.now(),resetTime(surface.resets_at));
  else if(['model_not_found','model_entitlement'].includes(surface?.code))this.observe(provider,'model','model',true,Date.now(),null,model);
 }
 claude(model:string,event:any,started:number){
  const info=event.type==='rate_limit_event'?event.rate_limit_info:null;
  if(info&&['allowed','allowed_warning','rejected'].includes(info.status)){
   const key=typeof info.rateLimitType==='string'?info.rateLimitType:'unknown';
   const scope=key==='seven_day_opus'?'opus':key==='seven_day_sonnet'?'sonnet':['five_hour','seven_day','seven_day_oauth_apps','overage'].includes(key)?'account':model;
   this.observe('claude-code','rate:'+key,'limit',info.status==='rejected',info.status==='rejected'?Date.now():started,resetTime(info.resetsAt),scope);
   return true;
  }
  if(event.type==='assistant'&&['authentication_failed','oauth_org_not_allowed','billing_error','model_not_found'].includes(event.error)){
   const reason=event.error==='billing_error'?'limit':event.error==='model_not_found'?'model':'auth';
   this.observe('claude-code',reason==='limit'?'billing':reason,reason,true,Date.now(),null,reason==='model'?model:'account');
  }
  return false;
 }
 claudeUsage(response:any,started:number){
  if(response?.rate_limits_available!==true)return;
  const limits=response.rate_limits||{};let globalAvailable=false;
  for(const key of ['five_hour','seven_day','seven_day_opus','seven_day_sonnet','seven_day_oauth_apps']){
   const value=limits[key];if(typeof value?.utilization!=='number'||!Number.isFinite(value.utilization)||value.utilization<0)continue;
   const scope=key==='seven_day_opus'?'opus':key==='seven_day_sonnet'?'sonnet':'account';
   this.observe('claude-code','rate:'+key,'limit',value.utilization>=100,started,resetTime(value.resets_at),scope);
   if(scope==='account'&&value.utilization<100)globalAvailable=true;
  }
  this.clear('claude-code',['auth'],started);
  if(globalAvailable)this.clear('claude-code',['billing','limit'],started);
 }
}
