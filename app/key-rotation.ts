// Settings, Security: the "rotate all keys" checklist (SPEC 5.21 H5). One row per connected supplier.
import type {Snapshot} from './types';
import {apiSuppliers,type ApiProvider} from './api-catalog';
import {healthOf,type Health} from './availability';

export interface RotationRow {id:string;name:string;status:string;health:Health;signIn:boolean;page:{method:string;args:any}|null;}
// Suppliers connected by signing in to an account, not by a pasted key.
const signIns=new Set<string>(['nous','minimax-oauth','xai-oauth']);
// Pickers that use their own key, and the link kind of their key page.
const pickerKeyPages:Record<string,string>={glide:'fastino',notdiamond:'notdiamond'};

export function rotationRows(state:Snapshot):RotationRow[] {
 const row=(id:string,name:string,status:string,signIn:boolean,page:RotationRow['page']):RotationRow=>({id,name,status,health:healthOf(status),signIn,page});
 const keyRow=(id:string,name:string,status:string,link:string)=>row(id,name,status,false,{method:'link',args:{kind:link}});
 return [
  ...(state.connected?[row('deepseek','DeepSeek',state.providerStatus,false,{method:'link',args:{kind:'keys'}})]:[]),
  ...(state.codex?.connected?[row('openai','OpenAI',state.codex.status,true,null)]:[]),
  ...(state.claude?.connected?[row('anthropic','Claude Code',state.claude.status,true,null)]:[]),
  ...(state.jev?.connected?[row('typesafe','TypeSafe · Jev',state.jev.status,false,{method:'link',args:{kind:'jev'}})]:[]),
  ...(state.decisionEngine?.pickers||[]).filter(row=>row.connected&&pickerKeyPages[row.id]).map(row=>keyRow(row.id,row.label,row.status,pickerKeyPages[row.id]!)),
  ...(state.apiProviders||[]).filter(api=>api.connected).map(api=>row(api.provider,apiSuppliers[api.provider as ApiProvider].name,api.status,signIns.has(api.provider),{method:'apiLink',args:{provider:api.provider}})),
 ];
}
