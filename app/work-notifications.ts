import type {Store} from './store';
import type {Approval,Chat,Turn} from './types';
import type {WorkAction} from './work-coordination';

export type WorkNotice={id:string;chatId:string;turnId:string;label:string};
const results:Record<string,string>={completed:'Reply ready',partial:'Some work needs attention',failed:'Work failed',interrupted:'Work interrupted','needs-model':'Choose an available model'};

export class WorkNotifications {
 private seen:Set<string>;
 constructor(private store:Store){
  this.seen=new Set(store.all<{id:string}>('work-notice').map(row=>row.id));
  // Existing replies are history. Initialize before crash recovery so newly interrupted work can alert.
  for(const turn of store.all<Turn>('turn'))if(results[turn.status])this.seen.add('turn:'+turn.id+':'+turn.status);
 }
 private mark(id:string){if(!this.seen.has(id)){this.seen.add(id);this.store.put('work-notice',{id});}}
 scan(enabled:boolean,visible:(chatId:string)=>boolean,show:(notice:WorkNotice)=>void,attention?:()=>void){
  const chats=new Map(this.store.all<Chat>('chat').map(chat=>[chat.id,chat])),turns=this.store.all<Turn>('turn'),byId=new Map(turns.map(turn=>[turn.id,turn]));
  const notices:WorkNotice[]=[];
  const add=(id:string,turn:Turn|undefined,label:string)=>{
   if(!turn||turn.contextSnapshot)return;
   const chat=chats.get(turn.chatId),root=chat?.parentChatId||chat?.id;
   if(Object.values(chat?.historyAliases||{}).includes(turn.id))return;
   if(root&&chats.has(root))notices.push({id,chatId:root,turnId:turn.parentTurnId||turn.id,label});
  };
  for(const turn of turns)if(!turn.parentTurnId&&!turn.automatic&&results[turn.status])add('turn:'+turn.id+':'+turn.status,turn,results[turn.status]);
  for(const approval of this.store.all<Approval>('approval'))if(approval.status==='pending')add('approval:'+approval.id,byId.get(approval.turnId),approval.method.startsWith('clarify')?'Your answer is needed':'Your approval is needed');
  let needsAnswer=false;
  for(const notice of notices){
   if(this.seen.has(notice.id))continue;
   // Record before delivery: repeats/restarts must not replay a toast, including when muted or focused.
   this.mark(notice.id);
   if(notice.id.startsWith('approval:'))needsAnswer=true;
   if(enabled&&!visible(notice.chatId))show(notice);
  }
  if(needsAnswer)attention?.();
 }
}
