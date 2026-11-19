import type {Store} from './store';
import type {OutRow} from './remote';
import type {Turn} from './types';

// topicChat: send into that chat's topic, looked up as the row is handed over, after the topic is made.
// fallback: with no topic to be had, the row goes to the bot chat's main view instead of being dropped.
export interface OutRecord extends OutRow {id:string;status:'pending'|'sending'|'sent'|'uncertain'|'cancelled';messageId?:string;topicChat?:string;fallback?:boolean}
// A chat's thread in the owner's bot chat. pending: planned, waiting for the chat's name. creating: its row is out.
// failed: Telegram refused it; tried again at retryAt. deleting: its chat is gone and the thread is being removed.
export interface TopicRecord {id:string;threadId?:string;name:string;status:'pending'|'creating'|'ready'|'failed'|'deleting';created:number;tries?:number;retryAt?:number}
export type OutPlace={thread_id?:string;topicChat?:string;op?:OutRow['op'];fallback?:boolean;notify?:boolean;keys?:OutRow['keys'];message_id?:string};
export function enqueueRemote(store:Store,owner:string,text:string,approvalId?:string,deny=false,place:OutPlace={}){
 if(!/^[1-9]\d{0,19}$/.test(owner))throw Error('Invalid Telegram owner.');
 // ponytail: linear history scan; pruneRemoteOutbox keeps the history short.
 const seq=store.all<OutRecord>('remote-out').reduce((max,row)=>Math.max(max,row.seq),0)+1;
 if(!Number.isSafeInteger(seq))throw Error('Remote message sequence exhausted.');
 const {thread_id,topicChat,op,fallback,notify,keys,message_id}=place;
 return store.put<OutRecord>('remote-out',{id:String(seq),seq,chat_id:owner,text,status:'pending',...(approvalId?{approvalId}:{}),...(deny?{deny:true}:{}),...(thread_id?{thread_id}:{}),...(topicChat?{topicChat}:{}),...(op?{op}:{}),...(fallback?{fallback:true}:{}),...(notify?{notify:true}:{}),...(keys?.length?{keys}:{}),...(message_id?{message_id}:{})});
}
// `after` is no longer read: a row's own status says whether it was handed over, and a row that waits for its
// chat's thread must not be passed by for good when a later row goes first.
export function claimRemoteOutbox(store:Store,_after:number,owner:string):OutRow[]{
 return store.transaction(()=>{
  const topics=new Map(store.all<TopicRecord>('remote-topic').map(topic=>[topic.id,topic]));
  for(const row of store.all<OutRecord>('remote-out').filter(row=>row.status==='pending'&&row.chat_id===owner)){
   // A chat's rows go in order, one at a time, and only once its thread is made.
   let thread=row.thread_id;
   if(row.topicChat&&row.op!=='topic'){
    const topic=topics.get(row.topicChat);thread=topic?.status==='deleting'?undefined:topic?.threadId;
    if(!thread){
     if(topic&&(topic.status==='pending'||topic.status==='creating'))continue;
     if(!row.fallback){store.update<OutRecord>('remote-out',row.id,{status:'cancelled'});continue;}
    }
   }
   // Persist uncertainty before handing a message to the network. A restart must never send it again blindly.
   store.update<OutRecord>('remote-out',row.id,{status:'sending'});
   const {id,status,messageId,topicChat,fallback,...message}=row;return [{...message,...(thread?{thread_id:thread}:{})}];
  }
  return [];
 });
}
/** Old rows go once they are settled; the newest stay, so the sequence carries on and a late reply is still known. */
export function pruneRemoteOutbox(store:Store,keep=400){
 // A question or approval the app sent is kept: a late reply to it must still be known as one (remotePrompt).
 const rows=store.all<OutRecord>('remote-out').sort((a,b)=>a.seq-b.seq),old=rows.slice(0,Math.max(0,rows.length-keep)).filter(row=>['sent','cancelled','uncertain'].includes(row.status)&&!row.approvalId);
 if(old.length)store.transaction(()=>{for(const row of old)store.remove('remote-out',row.id);});
 return old.length;
}
export function recordRemoteReceipt(store:Store,seq:number,ok:boolean,messageId?:string){
 const row=store.get<OutRecord>('remote-out',String(seq));
 if(row.status!=='sending')return row;
 return store.update<OutRecord>('remote-out',row.id,{status:ok?'sent':'uncertain',...(ok&&messageId?{messageId}:{})});
}
// Whether that Telegram message is a question or approval the app sent.
export function remotePrompt(store:Store,messageId:string){return store.all<OutRecord>('remote-out').some(row=>!!row.approvalId&&row.messageId===messageId);}
export function recoverRemoteOutbox(store:Store){
 return store.transaction(()=>store.all<OutRecord>('remote-out').filter(row=>row.status==='sending').map(row=>store.update<OutRecord>('remote-out',row.id,{status:'uncertain'})));
}
/** Where a message about a chat goes: its thread when it has one or is getting one, else where the message came from. */
export function chatPlace(store:Store,chatId:string,thread?:string):OutPlace{
 const topic=store.all<TopicRecord>('remote-topic').find(row=>row.id===chatId);
 return topic?{topicChat:chatId,fallback:true}:thread?{thread_id:thread}:{};
}
export function enqueueRemoteReply(store:Store,turnId:string,text:string){
 return store.transaction(()=>{
  const turn=store.get<Turn>('turn',turnId);if(!turn.remote||turn.remote.replied)return;
  const row=enqueueRemote(store,turn.remote.chatId,text,undefined,false,chatPlace(store,turn.chatId,turn.remote.thread));
  store.update<Turn>('turn',turnId,{remote:{...turn.remote,replied:true}});return row;
 });
}
