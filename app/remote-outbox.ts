import type {Store} from './store';
import type {OutRow} from './remote';
import type {Turn} from './types';

export interface OutRecord extends OutRow {id:string;status:'pending'|'sending'|'sent'|'uncertain'|'cancelled';messageId?:string}
export function enqueueRemote(store:Store,owner:string,text:string,approvalId?:string,deny=false){
 if(!/^[1-9]\d{0,19}$/.test(owner))throw Error('Invalid Telegram owner.');
 // ponytail: linear history scan; index the sequence if outbox history becomes large.
 const seq=store.all<OutRecord>('remote-out').reduce((max,row)=>Math.max(max,row.seq),0)+1;
 if(!Number.isSafeInteger(seq))throw Error('Remote message sequence exhausted.');
 return store.put<OutRecord>('remote-out',{id:String(seq),seq,chat_id:owner,text,status:'pending',...(approvalId?{approvalId}:{}),...(deny?{deny:true}:{})});
}
export function claimRemoteOutbox(store:Store,after:number,owner:string):OutRow[]{
 return store.transaction(()=>{
  const row=store.all<OutRecord>('remote-out').find(row=>row.status==='pending'&&row.seq>after&&row.chat_id===owner);
  if(!row)return [];
  // Persist uncertainty before handing a message to the network. A restart must never send it again blindly.
  store.update<OutRecord>('remote-out',row.id,{status:'sending'});
  const {id,status,messageId,...message}=row;return [message];
 });
}
export function recordRemoteReceipt(store:Store,seq:number,ok:boolean,messageId?:string){
 const row=store.get<OutRecord>('remote-out',String(seq));
 if(row.status!=='sending')return row;
 return store.update<OutRecord>('remote-out',row.id,{status:ok?'sent':'uncertain',...(ok&&messageId?{messageId}:{})});
}
export function recoverRemoteOutbox(store:Store){
 return store.transaction(()=>store.all<OutRecord>('remote-out').filter(row=>row.status==='sending').map(row=>store.update<OutRecord>('remote-out',row.id,{status:'uncertain'})));
}
export function enqueueRemoteReply(store:Store,turnId:string,text:string){
 return store.transaction(()=>{
  const turn=store.get<Turn>('turn',turnId);if(!turn.remote||turn.remote.replied)return;
  const row=enqueueRemote(store,turn.remote.chatId,text);
  store.update<Turn>('turn',turnId,{remote:{...turn.remote,replied:true}});return row;
 });
}
