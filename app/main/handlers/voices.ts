// voices handlers: the saved voices, the Speak replies switch and speaking (Koan 2026-11-15); main.ts spreads them
// into handlers. Installing and the Voices window are in main.ts, which holds their state.
import {autoSpoken,backend,emit,holdZyphraKey,speaker,store,voiceInstall,zonosSpeaker} from '../../main';
import {isReplyEngine,isZonosVoice} from '../../reply-engines';
import type {SavedApp} from '../../saved-apps';
import {checkVoice,readVoices,speakRequest} from '../../voices';
import {checkZyphraKey} from '../../zonos-speaker';
import {replyEngine,voiceKey,voicesInstalled,voicesRow,voicesView,zyphraEndpoint} from '../voices';

export const voicesHandlers:Record<string,(args:any)=>any>={
  voicesState(){return {voices:voicesView()};},
  // A new voice or a change to one; the editor saves as its sliders move.
  voicesSave({voice}){
    const next=checkVoice(voice),{list}=readVoices(voicesRow()),known=list.some(row=>row.id===next.id);
    if(!known&&list.length>=60)throw Error('Sixty voices is the most. Delete one first.');
    store.put('settings',{...voicesRow(),voices:known?list.map(row=>row.id===next.id?next:row):[...list,next]});emit();return next;
  },
  // An app that spoke in the deleted voice goes back to the default.
  voicesRemove({id}){
    const {list,defaultId}=readVoices(voicesRow());
    if(!list.some(row=>row.id===id))throw Error('Choose a voice.');
    if(list.length===1)throw Error('Keep at least one voice.');
    const voices=list.filter(row=>row.id!==id);
    store.transaction(()=>{
      store.put('settings',{...voicesRow(),voices,defaultId:defaultId===id?voices[0].id:defaultId});
      for(const app of store.all<SavedApp>('saved-app'))if(app.voice===id)store.update<SavedApp>('saved-app',app.id,{voice:''});
    });emit();
  },
  voicesDefault({id}){
    const {list}=readVoices(voicesRow());if(!list.some(row=>row.id===id))throw Error('Choose a voice.');
    store.put('settings',{...voicesRow(),voices:list,defaultId:id});emit();
  },
  // Speak replies (the chat bar's switch): once on, every chat's finished reply is read aloud.
  voicesSpeakReplies({on}){if(typeof on!=='boolean')throw Error('Choose on or off.');store.put('settings',{...voicesRow(),speakReplies:on});emit();},
  voicesInstallCancel(){voiceInstall?.abort();},
  // Reply engines (Koan 2026-11-16): the round mark picks Kokoro or Zonos 3 Mini among those that are set up.
  voicesEngine({engine}){
    if(!isReplyEngine(engine))throw Error('Choose a reply voice from the list.');
    if(!(engine==='kokoro'?voicesInstalled():replyEngine().zonos.connected))throw Error('Set this voice up first.');
    store.put('settings',{...voicesRow(),replyEngine:engine});emit();
  },
  // Zonos 3 Mini is set up by the user's Zyphra key: the key is tried on Zyphra's model list (no sound made, nothing
  // billed), then saved in Credential Manager, and Zonos becomes the voice in use.
  async voicesZonosKey({key}){
    if(typeof key!=='string'||key.trim().length<8||key.trim().length>400||/\s/.test(key.trim()))throw Error('Paste the API key as its page shows it.');
    const value=key.trim();backend.scrubber.register(value);
    await checkZyphraKey(value,zyphraEndpoint());
    await backend.host('save_key',{provider:'zyphra',key:value});holdZyphraKey(value);
    store.put('settings',{...voicesRow(),zyphraKeySaved:true,replyEngine:'zonos'});emit();
  },
  async voicesZonosDisconnect(){
    zonosSpeaker.stop('Zonos was disconnected.');
    await backend.host('delete_key',{provider:'zyphra'});holdZyphraKey('');
    store.put('settings',{...voicesRow(),zyphraKeySaved:false});emit();
  },
  voicesZonosVoice({voice}){
    if(!isZonosVoice(voice))throw Error('Choose a Zonos voice from the list.');
    store.put('settings',{...voicesRow(),zonosVoice:voice});emit();
  },
  // owner is the asking window, set by main. auto names a reply read aloud by the switch: each is spoken once, by
  // the first window that asks, however many windows show its chat. The engine in use speaks: Kokoro on this PC, or
  // Zonos 3 Mini in its chosen voice (a saved voice's blend and speed are Kokoro's; its effects are added either way).
  async speakStart({id,pieces,voice,auto,owner}){
    const reply=replyEngine();
    if(!reply.engine)throw Error('Install the voice in Voices first.');
    if(typeof id!=='string'||!/^[A-Za-z0-9-]{1,80}$/.test(id)||!Number.isInteger(owner))throw Error('Invalid speech.');
    const request=speakRequest(pieces,voice);
    if(auto!==undefined){
      if(typeof auto!=='string'||!auto||auto.length>80)throw Error('Invalid speech.');
      if(autoSpoken.has(auto))return {started:false};
      autoSpoken.add(auto);
    }
    if(reply.engine==='zonos'){speaker.release(owner);await zonosSpeaker.speak(id,owner,{pieces:request.pieces,voice:reply.zonos.voice});}
    else{zonosSpeaker.release(owner);await speaker.speak(voiceKey(),id,owner,request);}
    return {started:true};
  },
  speakStop({id,owner}){speaker.cancel(String(id),owner);zonosSpeaker.cancel(String(id),owner);},
};
