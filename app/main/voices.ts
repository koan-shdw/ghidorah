// voices: the saved voices and the voice that speaks replies (Koan 2026-11-15); module state stays in main.ts.
import {backend,heldZyphraKey,holdZyphraKey,pluginRuntime,store,voiceInstall,voiceProgress} from '../main';
import {readReplyEngine} from '../reply-engines';
import type {SavedApp} from '../saved-apps';
import {chatVoices,readVoices,type VoicesRow,type VoicesView} from '../voices';
import {ZYPHRA_URL} from '../zonos-speaker';
import {featureInstalled} from './remote';
import {voiceTestEndpoint} from './voice';

export function voicesRow():VoicesRow{return store.all<any>('settings').find(row=>row.id==='voices')||{id:'voices'};}
/** Kokoro's packages are in the runtime folder and its model passed its check on the last Install. */
export function voicesInstalled(){return featureInstalled('voices')&&voicesRow().installed===true;}
/** The reply engine in use (Koan 2026-11-16: Kokoro or Zonos 3 Mini) and the Zonos voice. */
export function replyEngine(){return readReplyEngine(voicesRow(),voicesInstalled());}
export function voicesView():VoicesView{
 const voices=readVoices(voicesRow()),reply=replyEngine();
 return {...voices,byChat:chatVoices(voices.list,store.all<SavedApp>('saved-app')),installed:voicesInstalled(),installing:!!voiceInstall,progress:voiceProgress,engine:reply.engine,ready:!!reply.engine,zonos:reply.zonos};
}
// A test copy may point Zyphra at a stand-in on this computer; nothing else replaces the real service.
export function zyphraEndpoint(){return voiceTestEndpoint('TRISMEGISTUS_TEST_ZYPHRA_URL')||ZYPHRA_URL;}
/** The user's Zyphra key, read from Credential Manager once and held while the app runs. */
export async function zyphraKey(){
 const held=heldZyphraKey();if(held)return held;
 const saved=await backend.host('read_key',{provider:'zyphra'});if(!saved.key)throw Error('Add your Zyphra key in Settings › Voice.');
 backend.scrubber.register(saved.key);holdZyphraKey(saved.key);return saved.key as string;
}
// The voice worker's identity: a new runtime starts a fresh worker.
export function voiceKey(){return JSON.stringify({runtime:pluginRuntime()});}
