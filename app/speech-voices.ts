export const speechVoices={
 'en-US-AriaNeural':'Aria · US','en-US-GuyNeural':'Guy · US',
 'en-GB-SoniaNeural':'Sonia · UK','en-GB-RyanNeural':'Ryan · UK',
 'en-AU-NatashaNeural':'Natasha · Australia','en-AU-WilliamNeural':'William · Australia',
};
export function savedSpeechVoices(row:{edgeVoice?:string;replyVoice?:string}){
 // Preserve the existing helper voice when upgrading from the single-voice setting.
 const edgeVoice=Object.hasOwn(speechVoices,row.edgeVoice||'')?row.edgeVoice!:'en-US-AriaNeural';
 const replyVoice=Object.hasOwn(speechVoices,row.replyVoice||'')?row.replyVoice!:edgeVoice==='en-US-GuyNeural'?'en-US-AriaNeural':'en-US-GuyNeural';
 return {edgeVoice,replyVoice};
}
