import type {Store} from './store';
import {parseRequest,remoteTurnId,type Inbound} from './remote';
export interface InRecord {id:string;message?:Inbound;status:'pending'|'processing'|'done'|'uncertain';chatId?:string}

export function enqueueRemoteInbound(store:Store,message:Inbound){
 if(parseRequest(message.text).kind==='code')throw Error('Authentication codes must not be persisted.');
 const id=remoteTurnId(message.user_id,message.message_id);
 if(store.all<InRecord>('remote-in').some(row=>row.id===id))return id;
 store.put<InRecord>('remote-in',{id,message,status:'pending'});return id;
}
export function finishRemoteInbound(store:Store,id:string){
 // Keep the delivery identity for deduplication; the accepted turn already retains its prompt.
 store.put<InRecord>('remote-in',{id,status:'done'});
}
export function recoverRemoteInbox(store:Store){
 // An interrupted handler may have created a chat, stopped work, or accepted a turn. Never repeat it blindly.
 return store.transaction(()=>store.all<InRecord>('remote-in').filter(row=>row.status==='processing').map(row=>store.put<InRecord>('remote-in',{id:row.id,status:'uncertain'})));
}
