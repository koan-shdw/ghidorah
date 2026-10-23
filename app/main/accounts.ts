// accounts: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import {readAlwaysOn} from '../always-on';
import {backend,data,store} from '../main';
import {inspectProjectTrust} from '../project-trust';
import {fixtureClaude} from './models';
import fs from 'node:fs/promises';
import path from 'node:path';

export function alwaysOn(){return readAlwaysOn(store.all<any>('settings').find(row=>row.id==='always-on'));}
export function fixtureClaudeArgs(){return fixtureClaude()?[fixtureClaude()!,'--fixture-record',path.join(data,'claude-requests.jsonl')]:undefined;}
export function trustRecord(folder:string){return store.all<{id:string;folder:string;hash:string;skillFolders?:string[]}>('trust').find(record=>record.folder===folder);}
export async function projectSettingsReview(folder:string,skillFolders?:string[]){
  const canonical=await fs.realpath(folder),review=await inspectProjectTrust(canonical,skillFolders||trustRecord(canonical)?.skillFolders||[]);
  const register=(value:any)=>{if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){if(/key|token|secret|password|authorization|cookie/i.test(key)&&typeof item==='string')backend.scrubber.register(item);else if(typeof item==='object')register(item);}};
  register(review.settings);register(review.agents);register(review.skills);return review;
}
