// routines: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import {backend,store} from '../main';

export const cronNext=async(line:string,after:number)=>Number((await backend.host('cron_next',{line,after})).next);
export function wizardRow(){return store.all<any>('settings').find(row=>row.id==='wizard')||{id:'wizard',completed:false,steps:{}};}
