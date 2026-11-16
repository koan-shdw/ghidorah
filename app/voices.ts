// Voices (Koan 2026-11-15, his pick: version 2 of the voice menu): a saved voice is one Kokoro voice or two blended at
// any point, a speed, and a stack of effects each with an amount and one character setting. Voices are saved under a
// name; one is the default and an app may be given its own. Shared by the main process and the windows; no Electron.
import {EFFECT_ORDER,age,type EffectId,type EffectSetting} from './voice-effects';

/** Kokoro's English voices: a/b for American/British, f/m for a woman's or a man's voice. */
export const VOICE_IDS=['af_alloy','af_aoede','af_bella','af_heart','af_jessica','af_kore','af_nicole','af_nova','af_river','af_sarah','af_sky','am_adam','am_echo','am_eric','am_fenrir','am_liam','am_michael','am_onyx','am_puck','am_santa','bf_alice','bf_emma','bf_isabella','bf_lily','bm_daniel','bm_fable','bm_george','bm_lewis'];
export const VOICE_GROUPS:Record<string,string>={af:'American women',am:'American men',bf:'British women',bm:'British men'};
export const voiceLabel=(id:string)=>id?id[3].toUpperCase()+id.slice(4):'';
export const VOICE_SIZE='337 MB';
export const SPEED={min:0.7,max:1.4,step:0.05};

export type Effect={id:EffectId;name:string;note:string;label:string;min:number;max:number;step:number;start:number;format:(value:number)=>string};
export const EFFECTS:Effect[]=[
 {id:'robot',name:'Flat robot',note:'Holds the voice on one note.',label:'Note',min:60,max:220,step:5,start:110,format:v=>v+' Hz'},
 {id:'whisper',name:'Whisper',note:'The breath without the note.',label:'Smear',min:1,max:4,step:1,start:2,format:v=>Math.round((128<<v)/24)+' ms'},
 {id:'ring',name:'Ring machine',note:'The voice times a low hum.',label:'Hum',min:20,max:400,step:5,start:50,format:v=>v+' Hz'},
 {id:'pipe',name:'Metal pipe',note:'A tuned metal echo.',label:'Tuning',min:80,max:600,step:10,start:180,format:v=>v+' Hz'},
 {id:'crush',name:'Old computer',note:'Few bits and a low sample rate.',label:'Age',min:0,max:100,step:5,start:60,format:v=>{const a=age(v);return a.bits+' bits · '+(a.to/1000).toFixed(1)+' kHz';}},
 {id:'intercom',name:'Intercom',note:'A small speaker, driven hard.',label:'Drive',min:1,max:12,step:0.5,start:6,format:v=>'×'+v},
];

export interface SavedVoice {id:string;name:string;a:string;b:string;balance:number;speed:number;fx:Record<EffectId,EffectSetting>}
/** What the windows see: the saved voices, the chats whose app has its own voice, whether Kokoro is installed, and the
 * reply engine in use (Kokoro or Zonos 3 Mini, '' when neither is set up; ready when it can speak). */
export interface VoicesView {list:SavedVoice[];defaultId:string;speakReplies:boolean;byChat:Record<string,string>;installed:boolean;installing:boolean;progress:number|null;
 engine:import('./reply-engines').ReplyEngine|'';ready:boolean;zonos:{connected:boolean;voice:string}}
export type VoicesRow={id:'voices';voices?:unknown;defaultId?:unknown;speakReplies?:unknown;installed?:unknown}&import('./reply-engines').ReplyEngineRow;

function starter(id:string,name:string,a:string,effects:Partial<Record<EffectId,[number,number]>>={}):SavedVoice{
 const fx={} as Record<EffectId,EffectSetting>;
 for(const effect of EFFECTS)fx[effect.id]={amount:effects[effect.id]?.[0]??0,value:effects[effect.id]?.[1]??effect.start};
 return {id,name,a,b:'',balance:50,speed:1,fx};
}
/** The voices a new copy starts with: Heart plain, and the eight effects of the samples page by the names used there. */
export function starterVoices():SavedVoice[]{
 return [starter('heart','Heart','af_heart'),starter('robot-low','Flat robot, low','am_onyx',{robot:[100,90]}),starter('robot-high','Flat robot, high','bf_emma',{robot:[100,160]}),
  starter('ring','Ring machine','am_onyx',{ring:[100,50]}),starter('pipe','Metal pipe','am_onyx',{pipe:[100,180]}),starter('crush','Old computer','bf_emma',{crush:[100,60]}),
  starter('intercom','Intercom','am_onyx',{intercom:[100,6]}),starter('whisper','Whisper','bf_emma',{whisper:[100,2]}),starter('robot-crush','Flat robot, old computer','am_onyx',{robot:[100,110],crush:[100,40]})];
}
/** A plain new voice. */
export function newVoice(id:string,name='New voice'):SavedVoice{return starter(id,name,'af_heart');}

const number=(value:unknown,min:number,max:number,step:number)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max?Math.round(value/step)*step:null;
/** A voice as it may be saved, or an error naming what is wrong with it. */
export function checkVoice(input:any):SavedVoice{
 if(!input||typeof input!=='object')throw Error('Invalid voice.');
 const id=input.id,name=typeof input.name==='string'?input.name.replace(/\s+/g,' ').trim():'';
 if(typeof id!=='string'||!/^[A-Za-z0-9-]{1,40}$/.test(id))throw Error('Invalid voice.');
 if(!name||name.length>40)throw Error('Give the voice a name up to 40 characters.');
 if(!VOICE_IDS.includes(input.a)||input.b!==''&&!VOICE_IDS.includes(input.b))throw Error('Choose a voice from the list.');
 const balance=number(input.balance,0,100,1),speed=number(input.speed,SPEED.min,SPEED.max,SPEED.step);
 if(balance===null||speed===null)throw Error('Invalid voice balance or speed.');
 const fx={} as Record<EffectId,EffectSetting>;
 for(const effect of EFFECTS){
  const amount=number(input.fx?.[effect.id]?.amount,0,100,1),value=number(input.fx?.[effect.id]?.value,effect.min,effect.max,effect.step);
  if(amount===null||value===null)throw Error('Invalid '+effect.name.toLowerCase()+' setting.');
  fx[effect.id]={amount,value};
 }
 return {id,name,a:input.a,b:input.b===input.a?'':input.b,balance,speed:Math.round(speed*100)/100,fx};
}
/** The saved voices as they stand: the starters until something is saved, a default that exists. */
export function readVoices(row?:VoicesRow|null){
 const list:SavedVoice[]=[];
 if(Array.isArray(row?.voices))for(const item of row.voices.slice(0,60)){try{const voice=checkVoice(item);if(!list.some(other=>other.id===voice.id))list.push(voice);}catch{/* a voice that no longer fits the rules is left out */}}
 if(!list.length)list.push(...starterVoices());
 return {list,defaultId:list.some(voice=>voice.id===row?.defaultId)?row!.defaultId as string:list[0].id,speakReplies:row?.speakReplies===true};
}
export const blended=(voice:SavedVoice)=>!!voice.b&&voice.b!==voice.a&&voice.balance>0;
export const balanceWords=(voice:SavedVoice)=>voice.b?voiceLabel(voice.a)+' '+(100-voice.balance)+'% · '+voiceLabel(voice.b)+' '+voice.balance+'%':'No blend';
export const speedWords=(voice:SavedVoice)=>voice.speed.toFixed(2)+'×';
/** One line saying what a voice is made of. */
export function voiceSummary(voice:SavedVoice){
 const parts=[blended(voice)&&voice.balance<100?voiceLabel(voice.a)+' + '+voiceLabel(voice.b):voiceLabel(blended(voice)?voice.b:voice.a)];
 for(const effect of EFFECTS)if(voice.fx[effect.id].amount>0)parts.push(effect.name+(voice.fx[effect.id].amount<100?' '+voice.fx[effect.id].amount+'%':''));
 if(voice.speed!==1)parts.push(speedWords(voice));
 return parts.join(' · ');
}
/** The chats whose app was given a voice of its own: chat id to voice id. A chat in several such apps takes the first. */
export function chatVoices(list:SavedVoice[],apps:{chatIds:string[];voice?:string}[]){
 const byChat:Record<string,string>={};
 for(const app of apps)if(app.voice&&list.some(voice=>voice.id===app.voice))for(const chatId of app.chatIds)byChat[chatId]??=app.voice;
 return byChat;
}
/** The voice a chat speaks in: its app's voice when the app has one, else the default. A side chat speaks as its parent. */
export function voiceForChat(view:Pick<VoicesView,'list'|'defaultId'|'byChat'>,chat?:{id:string;parentChatId?:string}):SavedVoice{
 const own=chat&&view.byChat[chat.parentChatId||chat.id];
 return view.list.find(voice=>voice.id===(own||view.defaultId))||view.list[0];
}
/** What the engine is asked to say: the pieces of text and the voice without its effects (the window adds those). */
export function speakRequest(pieces:unknown,voice:unknown){
 const checked=checkVoice(voice);
 if(!Array.isArray(pieces)||!pieces.length||pieces.length>400||pieces.some(piece=>typeof piece!=='string'||!piece.trim()||piece.length>2000))throw Error('Invalid text to speak.');
 return {pieces:pieces as string[],a:checked.a,b:blended(checked)?checked.b:'',balance:blended(checked)?checked.balance:0,speed:checked.speed};
}
export {EFFECT_ORDER};
