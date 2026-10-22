// Who picks the model (PLAN 3): one record per picker. Main supplies each one's connection and decide call;
// the routing state, questions and last-model fallback are the same for all (5.9).
export type PickerId='jev'|'kev'|'glide'|'gliner'|'notdiamond';
export interface Picker {id:PickerId;label:string;short:string;connects:'key'|'local'|'address';timeoutMs:number;}
export const pickers:Picker[]=[
 {id:'jev',label:'Jev · TypeSafe',short:'Jev',connects:'key',timeoutMs:500},
 {id:'kev',label:'Kev · Local',short:'Kev',connects:'address',timeoutMs:10000},
 {id:'glide',label:'Fastino GLiDE',short:'GLiDE',connects:'key',timeoutMs:300000},
 {id:'gliner',label:'GLiNER2.5-Decide · Local',short:'GLiNER',connects:'local',timeoutMs:10000},
 {id:'notdiamond',label:'Not Diamond',short:'Not Diamond',connects:'key',timeoutMs:5000},
];
export const isPicker=(value:unknown):value is PickerId=>pickers.some(picker=>picker.id===value);
export const picker=(id:string)=>pickers.find(row=>row.id===id);
// Saved turns from before one field per picker keep their Jev and LAYA counts.
export function pickerTokens(usage:{pickerTokens?:number|null;jevTokens?:number|null;layaTokens?:number|null}|undefined){return usage?.pickerTokens??usage?.jevTokens??usage?.layaTokens;}
