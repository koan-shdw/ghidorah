// One thread per chat (Koan 2026-11-19, version 3 of the Telegram mockup): which threads the bot chat needs so it
// matches the app's chats, and the short name a chat he has not named gets. No store and no Electron in this file.
import {topicName} from './remote';
import type {TopicRecord} from './remote-outbox';

// used: when the chat was last used (threads are made oldest first, so the latest used is the newest thread).
// named: its name is final; a chat still waiting for its short name gets no thread yet.
export interface TopicChat {id:string;title:string;used:number;named:boolean}
export type TopicStep=
 {do:'plan';chatId:string}                                   // a record, so rows for the chat wait for its thread
 |{do:'create';chatId:string;name:string}
 |{do:'rename';chatId:string;thread:string;name:string}
 |{do:'delete';id:string;thread?:string};                    // the chat is gone or archived
/** `chats`: every chat that should have a thread. `glyph`: the state mark that leads a chat's name, '' for none. */
export function planTopics(chats:TopicChat[],topics:TopicRecord[],now:number,glyph:(chatId:string)=>string=()=>''):TopicStep[]{
 const steps:TopicStep[]=[],records=new Map(topics.map(topic=>[topic.id,topic])),live=new Set(chats.map(chat=>chat.id));
 // A thread still being made is left until its receipt says what it became.
 for(const topic of topics)if(!live.has(topic.id)&&topic.status!=='deleting'&&topic.status!=='creating')steps.push({do:'delete',id:topic.id,...(topic.threadId?{thread:topic.threadId}:{})});
 for(const chat of [...chats].sort((a,b)=>a.used-b.used)){
  const topic=records.get(chat.id),name=topicName(chat,glyph(chat.id));
  if(!topic)steps.push({do:'plan',chatId:chat.id});
  if(!topic||topic.status==='pending'||topic.status==='failed'&&(topic.retryAt||0)<=now){if(chat.named)steps.push({do:'create',chatId:chat.id,name});}
  else if(topic.status==='ready'&&topic.threadId&&topic.name!==name)steps.push({do:'rename',chatId:chat.id,thread:topic.threadId,name});
 }
 return steps;
}
/** When a thread that could not be made is tried again: 1, 3, 9, 27 minutes, then every 30. */
export function topicRetry(tries:number,now:number){return now+Math.min(30,3**Math.max(0,tries-1))*60000;}

// A chat he has not named still carries the first words of its first message (store.accept), or "New chat".
export function autoTitled(chat:{title:string;named?:string},firstPrompt:string|undefined){
 if(chat.named)return false;
 return ['New chat','New project'].includes(chat.title)||firstPrompt!==undefined&&!!firstPrompt&&chat.title===firstPrompt.slice(0,55);
}
export const NAME_SYSTEM='You name chats. Read the first message of a chat and reply with a name for it: its subject in two to four words, at most 24 characters, no quotes, no full stop, no emoji. Reply with the name only.';
/** A model's answer as a name: its first line, without quotes, markup or a full stop, cut at a word. '' if nothing is left. */
export function cleanName(text:string,limit=28){
 let name=(text.split(/\r?\n/).map(line=>line.trim()).find(Boolean)||'').replace(/^(name|title)\s*:\s*/i,'').replace(/^["'“”‘’`*_#\s]+|["'“”‘’`*_\s.]+$/g,'').replace(/\s+/g,' ');
 if(name.length>limit){const cut=name.slice(0,limit+1),at=cut.lastIndexOf(' ');name=(at>8?cut.slice(0,at):name.slice(0,limit)).trim();}
 return name;
}
/** The name when no model can write one: the first words of the message. */
export function fallbackName(prompt:string){return cleanName(prompt.replace(/[^\p{L}\p{N}\s.'-]/gu,' '),24)||'New chat';}
/** Two chats never share a name: the second is "name 2", the third "name 3". */
export function uniqueName(name:string,taken:string[]){
 const used=new Set(taken.map(item=>item.trim().toLowerCase()));if(!used.has(name.toLowerCase()))return name;
 for(let n=2;;n++)if(!used.has((name+' '+n).toLowerCase()))return name+' '+n;
}
