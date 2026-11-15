// voices: the saved voices and the voice that speaks replies (Koan 2026-11-15); module state stays in main.ts.
import {pluginRuntime,store,voiceInstall,voiceProgress} from '../main';
import type {SavedApp} from '../saved-apps';
import {chatVoices,readVoices,type VoicesRow,type VoicesView} from '../voices';
import {featureInstalled} from './remote';

export function voicesRow():VoicesRow{return store.all<any>('settings').find(row=>row.id==='voices')||{id:'voices'};}
/** Kokoro's packages are in the runtime folder and its model passed its check on the last Install. */
export function voicesInstalled(){return featureInstalled('voices')&&voicesRow().installed===true;}
export function voicesView():VoicesView{
 const voices=readVoices(voicesRow());
 return {...voices,byChat:chatVoices(voices.list,store.all<SavedApp>('saved-app')),installed:voicesInstalled(),installing:!!voiceInstall,progress:voiceProgress};
}
// The voice worker's identity: a new runtime starts a fresh worker.
export function voiceKey(){return JSON.stringify({runtime:pluginRuntime()});}
