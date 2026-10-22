export const LIVE_MODEL='gemini-3.8-live';
export const LIVE_VOICES={Kore:'Kore · firm',Puck:'Puck · upbeat',Aoede:'Aoede · breezy',Charon:'Charon · informative',Fenrir:'Fenrir · excitable',Leda:'Leda · youthful',Orus:'Orus · firm',Zephyr:'Zephyr · bright'};
export function liveVoiceSettings(row:Record<string,unknown>){
 const helper=typeof row.liveVoice==='string'&&Object.hasOwn(LIVE_VOICES,row.liveVoice)?row.liveVoice:'Kore';
 const reply=typeof row.liveReplyVoice==='string'&&Object.hasOwn(LIVE_VOICES,row.liveReplyVoice)?row.liveReplyVoice:'Puck';
 return {liveVoice:helper,liveReplyVoice:reply===helper?(helper==='Puck'?'Kore':'Puck'):reply,freeKeySaved:row.freeKeySaved===true,freeTierConfirmed:row.freeTierConfirmed===true};
}
