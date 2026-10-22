import {createHash} from 'node:crypto';
import type {Store} from './store';
import type {Chat,Turn} from './types';
import {readChatHistory} from './chat-context';
import catalog from '../plugins/trismegistus-permissions/chat-tools.json';

export const chatTools=catalog;
type Access={approve:(description:string)=>Promise<boolean>;mode:()=>string;submit:(id:string,chatId:string,message:string,handoff:NonNullable<Turn['handoff']>)=>Promise<unknown>};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ordinary=(chat:Chat)=>!chat.parentChatId&&!chat.sideSourceId;
const title=(text:string)=>text.replace(/[\[\]\\]/g,'\\$&');
export const chatReference=(chatId:string,turnId?:string)=>'tris-chat:'+chatId+(turnId?'#'+turnId:'');
function target(store:Store,id:unknown){if(typeof id!=='string')throw Error('Choose a chat from search_chats.');const chat=store.get<Chat>('chat',id);if(!ordinary(chat))throw Error('Choose a saved main chat.');return chat;}
function page(args:any){const offset=args.offset??0,limit=args.limit??10;if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>20)throw Error('Invalid chat page.');return {offset,limit};}
function valid(name:string,args:any){const schema=chatTools.find(t=>t.name===name)?.inputSchema;if(!schema||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(schema.properties,k))||schema.required.some(k=>args[k]===undefined))throw Error('Invalid chat tool request.');}
function excerpt(value:string,query:string){const start=Math.max(0,value.toLowerCase().indexOf(query)-70);return (start?'…':'')+value.slice(start,start+250);}
function search(store:Store,source:string,query:string,archived:boolean){
 const needle=query.toLowerCase(),rows:{chatId:string;title:string;archived:boolean;turnId?:string;model?:string;excerpt?:string;link:string}[]=[];
 const turns=store.all<Turn>('turn'),tools=store.all<any>('tool');let total=0;
 for(const chat of store.all<Chat>('chat').filter(c=>ordinary(c)&&c.id!==source&&(archived||!c.archived)).reverse()){
  const boundary=turns.filter(t=>t.chatId===chat.id&&!t.parentTurnId).at(-1),base={chatId:chat.id,title:chat.title,archived:!!chat.archived};let matches=0;
  if(needle&&boundary){let offset=0;do{
   const result=readChatHistory(store,boundary,{query,offset,limit:20});if(!result.messages||result.total===undefined)throw Error('Invalid search result.');matches=result.total; 
   for(const match of result.messages){const t=turns.find(t=>t.id===match.id)!,text=[t.prompt,t.text,...tools.filter(tool=>tool.turnId===t.id).map(tool=>JSON.stringify(tool))].find(text=>text.toLowerCase().includes(needle))||t.prompt;rows.push({...base,turnId:t.id,model:t.model,excerpt:excerpt(text,needle),link:`[${title(chat.title)}](${chatReference(chat.id,t.id)})`});}
   offset=result.nextOffset??0;if(!result.nextOffset||rows.length>=1000)break;
  }while(true);}
  total+=matches;
  if(!matches&&(!needle||chat.title.toLowerCase().includes(needle))){total++;if(rows.length<1000)rows.push({...base,link:`[${title(chat.title)}](${chatReference(chat.id)})`});}
 }
 return {total,rows:rows.slice(0,1000),truncated:total>1000};
}

/** App-owned bridge: no model-supplied flag can grant access or approve a send. */
export async function chatToolCall(store:Store,current:Turn,name:string,args:any,access:Access,signal:AbortSignal){
 signal.throwIfAborted();valid(name,args);const own=store.get<Chat>('chat',current.chatId),source=store.get<Chat>('chat',own.parentChatId||own.id);
 const approve=async(description:string)=>{if(!await access.approve(description))throw Error('Chat access was denied.');signal.throwIfAborted();};
 if(name==='search_chats'){
  if(typeof args.query!=='string'||args.query.length>500||args.includeArchived!==undefined&&typeof args.includeArchived!=='boolean')throw Error('Use a search query up to 500 characters.');
  const {offset,limit}=page(args),id=current.id+':'+digest([args.query,!!args.includeArchived]);let saved=store.all<any>('chat-search').find(r=>r.id===id);
  if(!saved){await approve('Search other chats\nFrom: '+source.title+'\nQuery: '+(args.query||'(titles only)')+'\n'+(args.includeArchived?'Include archived chats. ':'')+'Matching titles and sent-message excerpts will be shared with this reply. Drafts are excluded.');signal.throwIfAborted();saved={id,chatId:source.id,turnId:current.id,...search(store,source.id,args.query,!!args.includeArchived)};store.put('chat-search',saved);}
  return {total:saved.total,truncated:saved.truncated,chats:saved.rows.slice(offset,offset+limit),nextOffset:offset+limit<saved.rows.length?offset+limit:null,readWith:'Use read_other_chat with the result’s chatId and turnId to read its original record.'};
 }
 const other=target(store,args.chatId);if(other.id===source.id)throw Error('Use read_chat_history for this chat; a handoff needs another destination.');
 if(name==='read_other_chat'){
  const {chatId,...request}=args;page(request);for(const key of ['query','turnId','toolId'])if(request[key]!==undefined&&(typeof request[key]!=='string'||request[key].length>500))throw Error('Invalid history request.');if(request.turnId&&request.toolId)throw Error('Choose a message or a tool result.');
  const id=current.id+':'+other.id;let grant=store.all<any>('chat-read-grant').find(r=>r.id===id);
  if(!grant){const through=store.all<Turn>('turn').filter(t=>t.chatId===other.id&&!t.parentTurnId).at(-1)?.id||null;await approve('Read another chat\nFrom: '+source.title+'\nRead: '+other.title+'\nAllow this reply to read its saved messages and tool results through the current last message. Drafts are excluded.');target(store,other.id);grant={id,chatId:source.id,turnId:current.id,targetChatId:other.id,through};store.put('chat-read-grant',grant);}
  const scope={throughTurnId:grant.through,note:'This approval covers messages through this boundary. Messages added later are excluded; their absence here does not establish their status. A new reply can request fresh access.'};
  if(!grant.through)return {chatId:other.id,title:other.title,scope,total:0,messages:[],nextOffset:null};
  const boundary=store.get<Turn>('turn',grant.through);if(boundary.chatId!==other.id)throw Error('The approved chat history changed.');
  return {chatId:other.id,title:other.title,scope,link:`[${title(other.title)}](${chatReference(other.id,request.turnId)})`,...readChatHistory(store,boundary,request)};
 }
 let origin=current;const seen=new Set<string>();while(origin.parentTurnId||origin.automatic?.originTurnId){if(seen.has(origin.id))throw Error('Invalid handoff origin.');seen.add(origin.id);origin=store.get<Turn>('turn',origin.parentTurnId||origin.automatic!.originTurnId);}
 if(typeof args.message!=='string'||!args.message.trim()||args.message.length>16000)throw Error('Write a handoff message up to 16,000 characters.');
 const check=()=>{signal.throwIfAborted();if(access.mode()==='plan')throw Error('Plan mode permits inspection and proposals only.');if(target(store,other.id).archived)throw Error('Restore the destination chat before sending a task.');};
 const id='handoff-'+digest([origin.id,other.id,args.message]);let sent=store.all<any>('chat-handoff').find(r=>r.id===id);
 const receipt=()=>({sent:true,chatId:other.id,turnId:id,status:store.all<Turn>('turn').find(t=>t.id===id)?.status||'cancelled',link:`[${title(other.title)}](${chatReference(other.id,id)})`});
 if(sent&&(store.all<Turn>('turn').some(t=>t.id===id)||store.all<any>('turn-removed').some(t=>t.id===id)))return receipt();
 check();
 if(!sent){await approve('Send task to another chat\nFrom: '+source.title+'\nTo: '+other.title+'\n\n'+args.message+'\n\nThe task will use that chat’s models and permissions. Its draft stays intact.');check();sent={id,chatId:source.id,turnId:current.id,targetChatId:other.id,message:args.message};store.put('chat-handoff',sent);}
 check();await access.submit(id,other.id,args.message,{id,sourceChatId:source.id,sourceTurnId:origin.id,title:source.title});
 return receipt();
}
