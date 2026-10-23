// pickers: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import {glinerLabels,ownPicks,parseGliner} from '../gliner';
import {JevDecision,JevSettings,JevState,decideGlide,decideJev,decideKev,glideEndpoint,jevEndpoint} from '../jev';
import {withLearning} from '../learning';
import {gliner,jevKey,jevStatus,kevStatus,namespace,pickerKeyNames,pickerKeyStatus,pickerKeys,store} from '../main';
import {decideNotDiamond,notDiamondEndpoint} from '../notdiamond';
import {PickerId,isPicker,picker} from '../pickers';
import type {Chat} from '../types';
import {availableModels} from './models';

export function jevSettings():JevSettings{return store.all<any>('settings').find(row=>row.id==='jev')||{summaryModel:'deepseek-flash',confidence:0.7,timeoutMs:500};}
export function decisionEngine():PickerId{const engine=store.all<any>('settings').find(row=>row.id==='decision-engine')?.engine;return isPicker(engine)?engine:'jev';}
export function chatSelector(chat:Chat){const model=chat.selector;return model&&(chat.pool||[]).includes(model)&&availableModels().includes(model)?model:null;}
export function classifierActive(){return pickerConnected(decisionEngine());}
// One reader per picker: its settings, whether it can answer, its status line, and its decide call.
export function pickerSettings(id:PickerId):JevSettings{return id==='jev'?jevSettings():store.all<any>('settings').find(row=>row.id===id)||{summaryModel:'deepseek-flash',confidence:0.7,timeoutMs:picker(id)!.timeoutMs};}
export function kevAddress():string|undefined{return store.all<any>('settings').find(row=>row.id==='kev')?.address;}
export function testUrl(name:string){return namespace.startsWith('Trismegistus/Test/')?process.env[name]:undefined;}
export function pickerConnected(id:PickerId){return id==='jev'?!!jevKey:id==='kev'?!!kevAddress():id==='gliner'?!!gliner?.state().installed:id in pickerKeyNames?!!pickerKeys[id]:false;}
export function pickerStatus(id:PickerId){return id==='jev'?jevStatus:id==='kev'?(kevAddress()?kevStatus||'Unverified':'Not set up'):id==='gliner'?gliner?.state().status||'Not installed':id in pickerKeyNames?(pickerKeys[id]?pickerKeyStatus[id]||'Key saved · checked on first use':'Add key'):'Not set up';}
export async function decidePick(id:PickerId,state:JevState,settings:JevSettings,signal:AbortSignal):Promise<JevDecision>{
  // GLiNER answers the main pick only, from the routing summary; Koan's own picks are kept as they are.
  if(id==='gliner'){const picks=ownPicks(state);if(picks)return picks;const labels=glinerLabels(state),result=await gliner.classify(withLearning(state.summary,state.history),labels.map(row=>row.label),settings.timeoutMs,signal);return parseGliner(result.result,labels,settings,result.elapsedMs);}
  if(id==='jev')return decideJev(jevUrl(),jevKey!,state,settings,signal);
  if(id==='kev'&&kevAddress())return decideKev(kevAddress()!,state,settings,signal);
  // Not Diamond answers the main pick only; Koan's own picks are kept as they are.
  if(id==='notdiamond'&&pickerKeys.notdiamond)return ownPicks(state)||decideNotDiamond(notDiamondEndpoint(testUrl('TRISMEGISTUS_TEST_NOTDIAMOND_URL')),pickerKeys.notdiamond,state,settings,signal);
  if(id==='glide'&&pickerKeys.glide)return decideGlide(glideEndpoint(testUrl('TRISMEGISTUS_TEST_GLIDE_URL')),pickerKeys.glide,state,settings,signal);
  throw Error(picker(id)!.short+' is not set up.');
}
export function jevUrl(){return jevEndpoint(namespace.startsWith('Trismegistus/Test/')?process.env.TRISMEGISTUS_TEST_JEV_URL:undefined);}
