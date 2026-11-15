// voices handlers: the saved voices, the Speak replies switch and speaking (Koan 2026-11-15); main.ts spreads them
// into handlers. Installing and the Voices window are in main.ts, which holds their state.
import {autoSpoken,emit,speaker,store,voiceInstall} from '../../main';
import type {SavedApp} from '../../saved-apps';
import {checkVoice,readVoices,speakRequest} from '../../voices';
import {voiceKey,voicesInstalled,voicesRow,voicesView} from '../voices';

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
  // owner is the asking window, set by main. auto names a reply read aloud by the switch: each is spoken once, by
  // the first window that asks, however many windows show its chat.
  async speakStart({id,pieces,voice,auto,owner}){
    if(!voicesInstalled())throw Error('Install the voice in Voices first.');
    if(typeof id!=='string'||!/^[A-Za-z0-9-]{1,80}$/.test(id)||!Number.isInteger(owner))throw Error('Invalid speech.');
    const request=speakRequest(pieces,voice);
    if(auto!==undefined){
      if(typeof auto!=='string'||!auto||auto.length>80)throw Error('Invalid speech.');
      if(autoSpoken.has(auto))return {started:false};
      autoSpoken.add(auto);
    }
    await speaker.speak(voiceKey(),id,owner,request);return {started:true};
  },
  speakStop({id,owner}){speaker.cancel(String(id),owner);},
};
