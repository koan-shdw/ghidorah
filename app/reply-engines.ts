// Reply voice engines (Koan 2026-11-16: Zonos 3 Mini as a choice beside Kokoro, through Zyphra's API; the Reply voice
// card lists them the way the Listening card lists its engines). Kokoro runs on this PC; Zonos 3
// Mini runs on Zyphra Cloud on the user's own key. The engine in use reads replies; a saved voice's effects are added
// by the window either way. Shared by the main process and the windows; no Electron.
// Zyphra's facts are its own pages on 2026-11-16 (zyphra.com/models/zonos3-mini, the model's gguf/voices/README.md).
import {VOICE_SIZE} from './voices';

export type ReplyEngine='kokoro'|'zonos';
export const REPLY_ENGINE_IDS:ReplyEngine[]=['kokoro','zonos'];
export const REPLY_ENGINES:Record<ReplyEngine,{name:string;where:string;price:string;facts:string;keys?:string}>={
 kokoro:{name:'Kokoro',where:'On this PC',price:'Free',facts:'Kokoro reads replies aloud on this computer, with no service. It is a one-time '+VOICE_SIZE+' download and nothing is fetched until you press Install.'},
 zonos:{name:'Zonos 3 Mini',where:'Online',price:'$10 per 1M bytes of text',facts:'Zyphra Cloud, pay as you go. Zyphra lists 1 request at a time and 100 generations a day for this model. The text of each reply is sent to Zyphra and its sound comes back.',keys:'https://cloud.zyphra.com/keys'},
};
/** Zonos 3 Mini's English default voices, by Zyphra's names, with the style and voice Zyphra gives each. */
export const ZONOS_VOICES:{id:string;style:string;gender:'woman'|'man'}[]=[
 {id:'Savannah',style:'American',gender:'woman'},{id:'Wyatt',style:'American',gender:'man'},{id:'Imogen',style:'British',gender:'woman'},{id:'Rupert',style:'British',gender:'man'},
 {id:'Cillian',style:'Irish',gender:'man'},{id:'Jett',style:'Energetic',gender:'man'},{id:'Thaddeus',style:'Announcer',gender:'man'},{id:'Morgana',style:'Witch',gender:'woman'},
 {id:'Sakura',style:'Anime',gender:'woman'},{id:'Willow',style:'ASMR',gender:'woman'},
];
export const ZONOS_DEFAULT_VOICE='Savannah';
export const zonosVoiceLabel=(id:string)=>{const voice=ZONOS_VOICES.find(row=>row.id===id);return voice?voice.id+' · '+voice.style+' '+voice.gender:id;};
export const isReplyEngine=(value:unknown):value is ReplyEngine=>value==='kokoro'||value==='zonos';
export const isZonosVoice=(value:unknown):value is string=>ZONOS_VOICES.some(voice=>voice.id===value);

export type ReplyEngineRow={replyEngine?:unknown;zyphraKeySaved?:unknown;zonosVoice?:unknown};
/** The engine in use is the saved one while it is ready, else the first that is; '' when neither is set up. */
export function readReplyEngine(row:ReplyEngineRow|undefined|null,kokoroReady:boolean){
 const connected=row?.zyphraKeySaved===true,ready=(id:ReplyEngine)=>id==='kokoro'?kokoroReady:connected;
 const saved=isReplyEngine(row?.replyEngine)&&ready(row.replyEngine)?row.replyEngine:'';
 return {engine:(saved||REPLY_ENGINE_IDS.find(ready)||'') as ReplyEngine|'',zonos:{connected,voice:isZonosVoice(row?.zonosVoice)?row.zonosVoice:ZONOS_DEFAULT_VOICE}};
}
