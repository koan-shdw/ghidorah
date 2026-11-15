// The small places a voice turns up (Koan 2026-11-15): Listen under a reply, the Speak replies switch in the chat bar
// and the voice pick on the app page. The Voices window, where voices are made, is voices-window.tsx.
import React,{useEffect,useRef,useSyncExternalStore} from 'react';
import {Button,ChoiceMenu,Icon,Switch} from './kit';
import {modelLabel} from './models';
import type {SavedApp} from './saved-apps';
import {SAMPLE,speaker} from './speaker';
import type {Chat,Snapshot,Turn} from './types';
import {voiceForChat} from './voices';

type Call=(method:string,args?:any)=>Promise<any>;
const done=(turn:Turn)=>turn.status==='completed'||turn.status==='partial';
const working=(status:string)=>['queued','running','waiting','dispatching','stopping'].includes(status);
const chatOf=(state:Snapshot,chatId:string):Chat|undefined=>state.chats.find(chat=>chat.id===chatId)||state.jobChats?.find(chat=>chat.id===chatId);

/** Whether this key is being read aloud in this window: '', 'loading' until the first sound, then 'playing'. */
export function useSpeaking(key:string){return useSyncExternalStore(speaker.subscribe,()=>speaker.phase(key));}
/** What is read aloud for a message: its reply; where several models answered, each reply after its model's name. */
export function replyAloud(turn:Turn,state:Snapshot){
 if(turn.jobs?.length)return turn.jobs.map(id=>state.turns.find(row=>row.id===id)).filter((job):job is Turn=>!!job&&done(job)&&!!job.text.trim()).map(job=>modelLabel(job.model,state.claude?.models)+'.\n\n'+job.text).join('\n\n');
 return done(turn)?turn.text:'';
}

/** Under a reply: reads it aloud in the voice of the chat's app. Before the voice is installed it opens Voices. */
export function ListenButton({turn,state,call}:{turn:Turn;state:Snapshot;call:Call}){
 const key='turn:'+turn.id,phase=useSpeaking(key),problem=useSyncExternalStore(speaker.subscribe,()=>speaker.problem(key)),voices=state.voices,text=replyAloud(turn,state);
 if(!voices||!text.trim())return null;
 const voice=voiceForChat(voices,chatOf(state,turn.chatId));
 return <><button aria-pressed={!!phase} aria-label={phase?'Stop reading':'Listen to this reply'} title={phase?'Stop reading':voices.installed?'Read this reply aloud · '+voice.name:'Install the voice to hear replies'} onClick={()=>{if(phase)speaker.stop();else if(!voices.installed)void call('voicesOpen').catch(()=>{});else void speaker.say(key,text,voice);}}><Icon name={phase?'stop':'speaker'}/>{phase==='loading'?'Starting…':phase?'Stop':'Listen'}</button>{problem&&<span className="speak-problem" role="alert">{problem}</span>}</>;
}

/** In the chat bar: once on, a reply that finishes while its chat is on screen is read aloud. One switch for every chat.
 * A chat open in its own window or a split pane is read there: `elsewhere` keeps the main view's copy quiet. */
export function SpeakReplies({state,chatId,turns,call,elsewhere=false}:{state:Snapshot;chatId:string;turns:Turn[];call:Call;elsewhere?:boolean}){
 const voices=state.voices,on=!!voices?.speakReplies&&!!voices.installed,seen=useRef<Map<string,string>|null>(null);
 useEffect(()=>{
  const before=seen.current,now=new Map(turns.map(turn=>[turn.id,turn.status]));seen.current=now;
  if(!before||!on||!voices||elsewhere)return;
  // Only a reply seen at work and now finished: opening a chat never reads its old replies.
  for(const turn of turns){
   if(turn.chatId!==chatId||turn.parentTurnId||turn.automatic||turn.contextSnapshot||!working(before.get(turn.id)||'')||!done(turn))continue;
   const text=replyAloud(turn,state);if(text.trim())speaker.after('turn:'+turn.id,text,voiceForChat(voices,chatOf(state,chatId)),turn.id);
  }
 },[turns,on]);
 if(!voices)return null;
 return <Switch className="speak-replies" checked={!!voices.speakReplies} ariaLabel="Speak replies" title={voices.installed?'Reads each reply aloud when it is finished':'Install the voice to hear replies'} label="Speak replies" onChange={next=>{
  if(!next)speaker.stop();
  if(next&&!voices.installed){void call('voicesOpen').catch(()=>{});return;}
  void call('voicesSpeakReplies',{on:next}).catch(()=>{});
 }}/>;
}

/** On the app page: the saved voice this app's chats are read aloud in. */
export function AppVoice({app,state,call}:{app:SavedApp;state:Snapshot;call:Call}){
 const key='app:'+app.id,phase=useSpeaking(key),voices=state.voices;
 if(!voices)return null;
 const own=voices.list.some(voice=>voice.id===app.voice)?app.voice!:'',standard=voices.list.find(voice=>voice.id===voices.defaultId)||voices.list[0],voice=voices.list.find(row=>row.id===own)||standard;
 return <div className="app-voice"><span>Voice</span>
  <ChoiceMenu label="This app's voice" value={own} options={{'':'Default · '+standard.name,...Object.fromEntries(voices.list.map(row=>[row.id,row.name]))}} onChange={id=>void call('savedAppSave',{id:app.id,voice:id}).catch(()=>{})}/>
  <Button variant="outline" iconOnly icon={phase?'stop':'play'} aria-pressed={!!phase} aria-label={phase?'Stop':'Play this app\'s voice'} title={voices.installed?(phase?'Stop':'Play this app\'s voice'):'Install the voice to hear it'} onClick={()=>{if(phase)speaker.stop();else if(!voices.installed)void call('voicesOpen').catch(()=>{});else void speaker.say(key,SAMPLE,voice);}}/>
  <Button variant="outline" title="Make and change voices" onClick={()=>void call('voicesOpen').catch(()=>{})}>Voices…</Button>
 </div>;
}
