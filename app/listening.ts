// Listening engines (Koan 2026-11-15): dictation's hearing is the user's choice. Whisper on this PC comes first;
// Deepgram and ElevenLabs are there for anyone who wants an online one. Choosing an engine opens what it needs: a
// download for the local model, a key for an online one. Shared by the main process and the windows; no Electron.
// Prices are each company's own pricing page on 2026-11-15.
export type OnlineEngine='deepgram'|'elevenlabs';
export type EngineId='whisper'|OnlineEngine;
export const ENGINE_IDS:EngineId[]=['whisper','deepgram','elevenlabs'];
export const ONLINE:OnlineEngine[]=['deepgram','elevenlabs'];
export const ENGINES:Record<EngineId,{name:string;model:string;where:string;price:string;facts:string;keys?:string}>={
 whisper:{name:'Whisper',model:'',where:'On this PC',price:'Free',facts:'Runs on your graphics card or processor. Your voice stays on this computer.'},
 deepgram:{name:'Deepgram',model:'Nova-3',where:'Online',price:'$0.46 an hour',facts:'Pay as you go, billed by the second of talking. A new account starts with $200 of free credit and needs no card. Your voice is sent to Deepgram while you dictate.',keys:'https://console.deepgram.com/'},
 elevenlabs:{name:'ElevenLabs',model:'Scribe v3 Live',where:'Online',price:'$0.22 an hour',facts:'Pay as you go. The free plan includes 2 hours 30 minutes. Your voice is sent to ElevenLabs while you dictate.',keys:'https://elevenlabs.io/app/settings/api-keys'},
};
/** What sending the user's own names as hints adds, on both online engines. */
export const HINT_COST='$0.08 an hour';
export const isOnline=(value:unknown):value is OnlineEngine=>value==='deepgram'||value==='elevenlabs';
export const isEngine=(value:unknown):value is EngineId=>value==='whisper'||isOnline(value);

/** What moves in the message box while you dictate: bars in the bottom row (the default) or a line across the box. */
export type WaveStyle='bars'|'line';
export const WAVE_STYLES:Record<WaveStyle,string>={bars:'Bars',line:'Line'};
export const isWaveStyle=(value:unknown):value is WaveStyle=>value==='bars'||value==='line';

/** What the windows see: the engine in use ('' when none is set up), whether names go as hints, which keys are saved, the waves. */
export interface ListeningView {engine:EngineId|'';hints:boolean;connected:Record<OnlineEngine,boolean>;waves:WaveStyle}
export type ListeningRow={sttEngine?:unknown;sttHints?:unknown;sttWaves?:unknown;deepgramKeySaved?:unknown;elevenlabsKeySaved?:unknown};
/** The saved choice as it stands. The engine in use is the saved one while it is ready, else the first that is. */
export function readListening(row:ListeningRow|undefined,whisperReady:boolean):ListeningView{
 const connected={deepgram:row?.deepgramKeySaved===true,elevenlabs:row?.elevenlabsKeySaved===true};
 const ready=(id:EngineId)=>id==='whisper'?whisperReady:connected[id];
 const saved=isEngine(row?.sttEngine)&&ready(row.sttEngine)?row.sttEngine:'';
 return {engine:saved||ENGINE_IDS.find(ready)||'',hints:row?.sttHints!==false,connected,waves:isWaveStyle(row?.sttWaves)?row.sttWaves:'bars'};
}
