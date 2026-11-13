import type {Store} from './store';
import type {OutRow} from './remote';
import type {Turn} from './types';

// topicChat: send into that chat's topic, looked up as the row is handed over, after the topic is made.
export interface OutRecord extends OutRow {id:string;status:'pending'|'sending'|'sent'|'uncertain'|'cancelled';messageId?:string;topicChat?:string}
// A chat's topic in the owner's bot chat. created: turns before it are not copied there.
export interface TopicRecord {id:string;threadId?:string;name:string;status:'creating'|'ready'|'failed';created:number}
export function enqueueRemote(store:Store,owner:string,text:string,approvalId?:string,deny=false,place:{thread_id?:string;topicChat?:string;op?:'topic'|'rename'}={}){
 if(!/^[1-9]\d{0,19}$/.test(owner))throw Error('Invalid Telegram owner.');
 // ponytail: linear history scan; index the sequence if outbox history becomes large.
 const seq=store.all<OutRecord>('remote-out').reduce((max,row)=>Math.max(max,row.seq),0)+1;
 if(!Number.isSafeInteger(seq))throw Error('Remote message sequence exhausted.');
 const {thread_id,topicChat,op}=place;
 return store.put<OutRecord>('remote-out',{id:String(seq),seq,chat_id:owner,text,status:'pending',...(approvalId?{approvalId}:{}),...(deny?{deny:true}:{}),...(thread_id?{thread_id}:{}),...(topicChat?{topicChat}:{}),...(op?{op}:{})});
}
export function claimRemoteOutbox(store:Store,after:number,owner:string):OutRow[]{
 return store.transaction(()=>{
  for(const row of store.all<OutRecord>('remote-out').filter(row=>row.status==='pending'&&row.seq>after&&row.chat_id===owner)){
   // Rows are handed over one at a time in order, so a chat's topic is made before anything is sent into it.
   const thread=row.op!=='topic'&&row.topicChat?store.all<TopicRecord>('remote-topic').find(topic=>topic.id===row.topicChat)?.threadId:row.thread_id;
   if(row.topicChat&&row.op!=='topic'&&!thread){store.update<OutRecord>('remote-out',row.id,{status:'cancelled'});continue;}
   // Persist uncertainty before handing a message to the network. A restart must never send it again blindly.
   store.update<OutRecord>('remote-out',row.id,{status:'sending'});
   const {id,status,messageId,topicChat,...message}=row;return [{...message,...(thread?{thread_id:thread}:{})}];
  }
  return [];
 });
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
export function enqueueRemoteReply(store:Store,turnId:string,text:string){
 return store.transaction(()=>{
  const turn=store.get<Turn>('turn',turnId);if(!turn.remote||turn.remote.replied)return;
  const row=enqueueRemote(store,turn.remote.chatId,text,undefined,false,{thread_id:turn.remote.thread});
  store.update<Turn>('turn',turnId,{remote:{...turn.remote,replied:true}});return row;
 });
}
