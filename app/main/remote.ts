// remote: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import featureWheels from '../../backend/feature-wheels.json';
import {backend,claude,data,drainRemoteInbox,emit,handlers,namespace,pluginRuntime,remoteChannel,remoteDesk,remoteEpoch,remoteSecret,root,store} from '../main';
import {modelLabel} from '../models';
import {redactPastedKeys} from '../redaction';
import {OutRow,approvalPrompt,clip,markFor,parseRequest,readInbound,readRemote,replyFor,replyShare,secretApproval,topicLink} from '../remote';
import {RemoteCodeState,bindingDigest,checkCode} from '../remote-code';
import {enqueueRemoteInbound} from '../remote-inbox';
import {claimRemoteOutbox,enqueueRemote,enqueueRemoteReply,pruneRemoteOutbox,recordRemoteReceipt,recoverRemoteOutbox,type OutPlace,type OutRecord,type TopicRecord} from '../remote-outbox';
import {NAME_SYSTEM,autoTitled,cleanName,fallbackName,planTopics,topicRetry,uniqueName,type TopicChat} from '../remote-threads';
import type {Approval,Chat,Turn} from '../types';
import {alwaysOn} from './accounts';
import {contextCompletion,sideModel} from './context';
import {Notification} from 'electron';
import {ChildProcess,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

// A Telegram message becomes a turn through the normal submit handler; its mark is set as the turn is accepted, so
// routing and the reply step see it. Only main sets it: a window cannot.
export function remoteSend(text:string,deny=false,approvalId?:string,thread?:string,more:OutPlace={}){
  const owner=remoteSettings().owner;if(!owner)return;
  const row=enqueueRemote(store,owner,backend.scrubber.text(text),approvalId,deny,{...(thread?{thread_id:thread}:{}),...more});remoteChannel?.notify();return row;
}
export function remoteOutbox(after:number):OutRow[]{return claimRemoteOutbox(store,after,remoteSettings().owner);}
export function remoteSent(seq:number,ok:boolean,messageId?:string,gone=false){
  const before=store.find<OutRecord>('remote-out',String(seq)),row=recordRemoteReceipt(store,seq,ok,messageId),shown=remoteShown();
  if(before?.status!=='sending')return;
  const topics=store.all<TopicRecord>('remote-topic');
  if(row.op==='topic'&&row.topicChat&&topics.some(topic=>topic.id===row.topicChat&&topic.status==='creating')){
    if(row.status==='sent'&&row.messageId){
      store.update<TopicRecord>('remote-topic',row.topicChat,{status:'ready',threadId:row.messageId,tries:0,retryAt:undefined});
      if(remoteSettings().topicError)remoteSave({topicError:''});
      // A chat started by a text in the main view: say there where its thread is.
      const chat=store.find<Chat>('chat',row.topicChat);
      if(chat&&store.where<Turn>('turn','chatId',chat.id).some(turn=>turn.remote&&!turn.remote.thread&&!turn.parentTurnId&&!turn.automatic)){const link=topicLink(remoteSettings().username,row.messageId);remoteSend('New chat: '+row.text,false,undefined,undefined,link?{keys:[[{text:'Open '+clip(row.text,40),url:link}]]}:{});}
    }else{
      // Usually Threaded Mode is off for the bot. It is tried again by itself, a little later each time.
      const tries=(topics.find(topic=>topic.id===row.topicChat)?.tries||0)+1;
      store.update<TopicRecord>('remote-topic',row.topicChat,{status:'failed',tries,retryAt:topicRetry(tries,Date.now())});
      if(tries===1){
        remoteSave({topicError:'Telegram did not make a thread for a chat. Open your bot’s chat in Telegram and tap Start, and in BotFather turn on Threaded Mode (your bot, Bot Settings, Threads Settings). Ghidorah tries again by itself.'});
        remoteAlert('Telegram thread not made','Tap Start in your bot’s Telegram chat and turn on Threaded Mode in BotFather.');
      }
    }
  }
  // A deleted thread's record goes whatever Telegram answered: nothing more can be done about it from here.
  if(row.op==='delete'&&row.thread_id)for(const topic of topics)if(topic.threadId===row.thread_id&&topic.status==='deleting')store.remove('remote-topic',topic.id);
  // He cleared the bot's chat, or deleted the thread there: the chat gets a new one, and this row goes into it.
  if(gone&&row.thread_id&&row.op!=='delete'){
    const topic=topics.find(topic=>topic.threadId===row.thread_id&&topic.status==='ready');
    if(topic){
      store.update<TopicRecord>('remote-topic',topic.id,{status:'pending',threadId:undefined,name:''});
      if(!row.op&&!row.approvalId){const {id,seq:old,status,messageId:sentId,thread_id,chat_id,text,deny,approvalId,...rest}=row;enqueueRemote(store,chat_id,text,undefined,false,{...rest,topicChat:topic.id,fallback:true});}
    }
  }
  if(shown?.seq===seq&&row.approvalId===shown.approvalId){
    if(row.status==='sent'&&row.messageId)store.put('settings',{...shown,id:'remote-shown',messageId:row.messageId});
    else if(row.status==='uncertain'||!row.messageId){store.put('settings',{...shown,id:'remote-shown',kind:'desktop'});remoteAlert('Remote approval delivery unconfirmed','Review the pending approval on the desktop.');}
  }
}
export async function remoteInbound(value:unknown){
  const message=readInbound(value,remoteSettings().owner);if(!message||!remoteSettings().enabled)return;
  if(parseRequest(message.text).kind==='code'){await remoteDesk.receive(message);return;}
  if(backend.scrubber.text(message.text)!==message.text||redactPastedKeys(message.text)!==message.text){remoteSend('This looks like an API key. Save it in Settings.',false,undefined,message.thread_id);return;}
  enqueueRemoteInbound(store,message);void drainRemoteInbox();
}
// If the picker is unsure about a Telegram message, the chat's last model answers, else the first available one,
// and the reply says so; a message from Telegram never waits for a choice at the desktop (section 5, call 13).
export function remoteFallback(turn:Pick<Turn,'remote'>,input:{eligible:string[];previous:string|null}){
  if(!turn.remote)return null;
  const model=input.previous&&input.eligible.includes(input.previous)?input.previous:input.eligible[0]||null;
  if(model)turn.remote={...turn.remote,fallback:true};
  return model;
}
// A desktop alert for every remote task, blocked and failed ones included (5.21 H6). Tests record them only.
export function remoteAlert(title:string,body:string){
  const row={id:randomUUID(),title,body:backend.scrubber.text(body).slice(0,200),at:Date.now()};store.put('remote-alert',row);
  for(const old of store.all<any>('remote-alert').slice(0,-30))store.remove('remote-alert',old.id);
  if(alwaysOn().desktopNotifications&&!namespace.startsWith('Trismegistus/Test/')&&Notification.isSupported())new Notification({title,body:row.body}).show();
  emit();
}
export function remoteCounters(){const {id,...counters}=store.all<any>('settings').find(row=>row.id==='remote-code')||{};return counters as Omit<RemoteCodeState,'secret'>;}
export function remoteShown(){return store.all<any>('settings').find(row=>row.id==='remote-shown') as {approvalId:string;kind:'approval'|'question'|'desktop';digest:string;at:number;seq?:number;messageId?:string}|undefined;}
export function remoteBinding(approval:Approval){return {owner:remoteSettings().owner,origin:'telegram',chatId:approval.chatId,approvalId:approval.id,action:JSON.stringify([approval.turnId,approval.method,approval.params])};}
export async function remoteCode(code:string,replyTo?:string){
  const shown=remoteShown();if(shown?.kind!=='approval')return 'No approval is waiting.';
  const approval=store.all<Approval>('approval').find(row=>row.id===shown.approvalId);
  if(!approval||approval.status!=='pending'){store.remove('settings','remote-shown');return 'That approval is no longer waiting.';}
  if(!remoteSecret)return 'Pair an authenticator on the desktop first: Settings, Remote.';
  const result=checkCode({secret:remoteSecret,...remoteCounters()},code,shown,remoteBinding(approval),Date.now(),replyTo);
  const {secret,...counters}=result.state;store.put('settings',{id:'remote-code',...counters});
  if(!result.ok){
    if(['expired','changed'].includes(result.reason))store.remove('settings','remote-shown');emit();
    return ({paused:'Too many wrong codes. Try again later.',wrong:'That code is not right.',changed:'The approval changed; here it is again.',expired:'That approval timed out; here it is again.','not-a-code':'Send the 6-digit code.','reply-required':'Reply to the current approval message with the code; a code without that reply cannot approve an action.'} as Record<string,string>)[result.reason];
  }
  const expectedRemote={digest:shown.digest,epoch:remoteEpoch};store.remove('settings','remote-shown');try{await handlers.approve({id:approval.id,choice:'once',expectedRemote});return 'Approved.';}finally{emit();}
}
// Approvals of remote turns go to Telegram one at a time, oldest first. One for the secrets list is refused, never
// offered (5.21 H6). Without a paired authenticator an approval waits on the desktop.
export function settleApprovals(){
  const shown=remoteShown();
  if(shown&&store.all<Approval>('approval').find(row=>row.id===shown.approvalId)?.status!=='pending')store.remove('settings','remote-shown');
  if(remoteShown()||!remoteSettings().enabled)return;
  const remote=new Set(store.all<Turn>('turn').filter(turn=>turn.remote).map(turn=>turn.id));
  const next=store.all<Approval>('approval').find(row=>row.status==='pending'&&remote.has(row.turnId));if(!next)return;
  if(next.method!=='clarify'&&secretApproval(next.params)){void handlers.approve({id:next.id,choice:'deny'}).catch(()=>{});remoteSend('Refused: a message from Telegram cannot open the protected credentials. Use the desktop.',false,undefined,store.get<Turn>('turn',next.turnId).remote?.thread);remoteAlert('Remote task blocked','Protected credentials were refused.');return;}
  const question=next.method==='clarify',description=String(question?(next.params?.question||next.params?.questions?.[0]?.question||'The AI has a question.'):(next.params?.description||next.params?.command||'An action needs your approval.'));
  const kind=description.length>3600||question&&next.params?.questions?.length>1||!question&&!remoteSecret?'desktop':question?'question':'approval';
  store.transaction(()=>{
    const text=kind==='desktop'?'An approval is waiting on the desktop. Open the app to review it.':question?'Question:\n'+description+'\n\nReply to this message with your answer.':approvalPrompt(description);
    const row=remoteSend(text,kind==='approval',next.id,store.get<Turn>('turn',next.turnId).remote?.thread);
    store.put('settings',{id:'remote-shown',approvalId:next.id,kind,digest:bindingDigest(remoteBinding(next)),at:Date.now(),seq:row?.seq});
  });
}
export function remoteChats(){return store.all<Chat>('chat').filter(chat=>!chat.archived&&!chat.parentChatId).sort((a,b)=>(b.updated??b.created??0)-(a.updated??a.created??0)).map(({id,title})=>({id,title}));}
// One thread per chat (Koan 2026-11-19, version 3 of the Telegram mockup): every chat with a message has a thread
// in the owner's bot chat, named as in the app, and the thread goes when its chat is deleted or archived. Desktop
// work in a chat is copied into its thread; a message in the thread goes to the chat.
export function remoteTopicChat(thread:string){
  const topic=store.all<TopicRecord>('remote-topic').find(row=>row.threadId===thread&&row.status!=='deleting');if(!topic)return null;
  try{const chat=store.get<Chat>('chat',topic.id);return chat.archived?null:{id:chat.id,title:chat.title};}catch{return null;}
}
// A topic the owner made in Telegram, or one whose chat is gone: a new chat takes it over, renamed after that chat.
export async function remoteLinkTopic(thread:string){
  const id=await handlers.newChat({});
  for(const old of store.all<TopicRecord>('remote-topic').filter(row=>row.threadId===thread))store.remove('remote-topic',old.id);
  store.put<TopicRecord>('remote-topic',{id,threadId:thread,name:'',status:'ready',created:Date.now()});
  return {id,title:store.get<Chat>('chat',id).title};
}
// A chat started by a text in the bot chat's main view: its record is made at once, so the reply waits for the thread.
export function remotePlanTopic(chatId:string){
  const settings=remoteSettings();if(!settings.topics||store.all<TopicRecord>('remote-topic').some(row=>row.id===chatId))return;
  store.put<TopicRecord>('remote-topic',{id:chatId,name:'',status:'pending',created:store.find<Chat>('chat',chatId)?.created??Date.now()});
}
// "Make all threads again" (Settings, Remote), for after he has cleared the bot's chat in Telegram: every thread the
// app knows is deleted there, and settleTopics makes one per chat again, the oldest used first.
export function remoteRebuildTopics(){
  const settings=remoteSettings();if(!settings.owner)throw Error('Add your Telegram user ID first.');
  store.transaction(()=>{
    for(const row of store.all<OutRecord>('remote-out'))if(row.status==='pending'&&(row.topicChat||row.thread_id||row.op))store.update<OutRecord>('remote-out',row.id,{status:'cancelled'});
    for(const topic of store.all<TopicRecord>('remote-topic')){
      if(topic.threadId)enqueueRemote(store,settings.owner,'',undefined,false,{op:'delete',thread_id:topic.threadId});
      store.remove('remote-topic',topic.id);
    }
  });
  remoteSave({topicError:''});remoteChannel?.notify();emit();
}
const topicChats=()=>store.all<Chat>('chat').filter(chat=>!chat.archived&&!chat.parentChatId&&!chat.sideSourceId);
// The message a chat started with: his own, never one the app or an agent sent.
const firstMessage=(chatId:string)=>store.where<Turn>('turn','chatId',chatId).filter(turn=>!turn.parentTurnId&&!turn.automatic&&!turn.contextSnapshot).sort((a,b)=>a.created-b.created)[0] as Turn|undefined;
// The state mark that leads a chat's thread name; none until the state is drawn (part 6 of the build).
function topicGlyph(_chatId:string){return '';}
// A chat he has not named gets a short name, written by a fast model from its first message, one chat at a time,
// the oldest used first; the sidebar shows the same name (his calls of 2026-11-19). A chat he named, or one whose
// title the app made for a purpose (a goal, a fork, a handover), is marked as named and left alone.
let naming=false;
async function nameNext(){
  if(naming)return;
  const records=new Set(store.all<TopicRecord>('remote-topic').filter(row=>row.status!=='deleting').map(row=>row.id));
  let next:{chat:Chat;prompt:string}|undefined;
  for(const chat of topicChats().filter(chat=>!chat.named&&records.has(chat.id)).sort((a,b)=>(a.updated??a.created??0)-(b.updated??b.created??0))){
    const first=firstMessage(chat.id);if(!first)continue;
    if(autoTitled(chat,first.prompt)){next={chat,prompt:first.prompt};break;}
    store.update<Chat>('chat',chat.id,{named:'user'});
  }
  if(!next)return;
  naming=true;
  try{
    const prompt=redactPastedKeys(backend.scrubber.text(next.prompt)).trim().slice(0,800),model=prompt?sideModel():null;let name='';
    if(model)try{name=cleanName((await contextCompletion(next.chat,model,NAME_SYSTEM,prompt,AbortSignal.timeout(30000),true)).text);}catch{}
    // He may have renamed the chat, or deleted it, while the name was written.
    const chat=store.find<Chat>('chat',next.chat.id);
    if(chat&&autoTitled(chat,next.prompt))store.update<Chat>('chat',chat.id,{title:uniqueName(name||fallbackName(prompt),topicChats().filter(row=>row.id!==chat.id).map(row=>row.title)),named:'app'});
  }finally{naming=false;emit();}
}
let topicTimer:NodeJS.Timeout|undefined;
function settleTopicsSoon(){topicTimer??=setTimeout(()=>{topicTimer=undefined;try{settleTopics();}catch{}},1000);topicTimer.unref?.();}
function settleTopics(){
  const settings=remoteSettings();if(!settings.enabled||!settings.topics||!settings.owner)return;
  const records=store.all<TopicRecord>('remote-topic'),known=new Set(records.map(row=>row.id)),chats:TopicChat[]=[];
  // A chat gets its thread with its first message, never before.
  for(const chat of topicChats())if(known.has(chat.id)||firstMessage(chat.id))chats.push({id:chat.id,title:chat.title,used:chat.updated??chat.created??0,named:!!chat.named});
  let queued=false;
  store.transaction(()=>{
    for(const step of planTopics(chats,records,Date.now(),topicGlyph)){
      if(step.do==='plan')store.put<TopicRecord>('remote-topic',{id:step.chatId,name:'',status:'pending',created:store.find<Chat>('chat',step.chatId)?.created??0});
      else if(step.do==='create'){store.update<TopicRecord>('remote-topic',step.chatId,{name:step.name,status:'creating'});enqueueRemote(store,settings.owner,step.name,undefined,false,{op:'topic',topicChat:step.chatId});queued=true;}
      else if(step.do==='rename'){store.update<TopicRecord>('remote-topic',step.chatId,{name:step.name});enqueueRemote(store,settings.owner,step.name,undefined,false,{op:'rename',thread_id:step.thread});queued=true;}
      else if(step.thread){store.update<TopicRecord>('remote-topic',step.id,{status:'deleting'});enqueueRemote(store,settings.owner,'',undefined,false,{op:'delete',thread_id:step.thread});queued=true;}
      else store.remove('remote-topic',step.id);
    }
    const topics=new Map(store.all<TopicRecord>('remote-topic').map(row=>[row.id,row]));
    // Desktop work in a chat with a topic: the message and its final reply, once each.
    const cursor=store.all<any>('settings').find(row=>row.id==='remote-mirror')?.at;
    if(typeof cursor!=='number'){store.put('settings',{id:'remote-mirror',at:Date.now()});return;}
    let at=cursor;
    for(const turn of store.turnsFinishedAfter<Turn>(cursor)){
      at=Math.max(at,turn.finished||0);
      const topic=topics.get(turn.chatId);
      // Work that finished while Remote was off stays on the desktop rather than arriving in a burst.
      if(!topic||topic.status==='failed'||topic.status==='deleting'||turn.remote||turn.parentTurnId||turn.automatic||turn.goal?.automatic||(turn.finished||0)<Date.now()-600000)continue;
      if(copyDesktopTurn(turn))queued=true;
    }
    // ponytail: a turn finishing in the same millisecond as the cursor is missed; key on ids if that ever matters.
    if(at!==cursor)store.put('settings',{id:'remote-mirror',at});
  });
  if(queued)remoteChannel?.notify();
  void nameNext();
}
const ENDED=['completed','partial','failed','stopped','interrupted'];
// The Telegram message a remote turn came from: its id is the tail of the turn's id (remoteTurnId).
export function remoteMessageId(turn:Pick<Turn,'id'>){return /^telegram-\d+-(\d+)$/.exec(turn.id)?.[1];}
export function remoteMark(messageId:string|undefined,emoji:string){
  const owner=remoteSettings().owner;if(!owner||!messageId)return;
  enqueueRemote(store,owner,emoji,undefined,false,{op:'react',message_id:messageId});remoteChannel?.notify();
}
// The messages from Telegram that a reply read while it was being written.
const readIn=(owner:Turn)=>store.where<Turn>('turn','chatId',owner.chatId).filter(row=>row.answeredIn===owner.id&&row.id!==owner.id&&!!row.remote);
// Desktop work in a chat with a thread: the message and its final reply, once. What the reply wrote after it read a
// message from Telegram is left out here: that part goes out as the answer to that message (settleRemote).
function copyDesktopTurn(turn:Turn){
  const owner=remoteSettings().owner,copied=store.all<any>('settings').find(row=>row.id==='remote-copied')?.ids as string[]|undefined;
  if(!owner||copied?.includes(turn.id))return false;
  const models=turn.jobs?.length?turn.jobs.map(id=>store.get<Turn>('turn',id)).filter(job=>!job.automatic):[turn],joined=readIn(turn);
  const text='🖥 '+clip(turn.prompt.trim(),600)+'\n\n'+models.map(job=>replyFor(job===turn&&joined.length?{...job,text:replyShare(turn,turn.id,joined)||'…'}:job,modelLabel(job.model,claude.models))).join('\n\n');
  enqueueRemote(store,owner,backend.scrubber.text(text),undefined,false,{topicChat:turn.chatId});
  store.put('settings',{id:'remote-copied',ids:[...(copied||[]).slice(-49),turn.id]});
  return true;
}
// The reply to each finished remote turn, sent once, and the mark on his message; called in emit(), the way
// settleParallel works. A message Claude read in the middle of another reply is answered by its share of that reply,
// after the message that reply belongs to.
export function settleRemote(){
  settleTopicsSoon();
  settleApprovals();
  const reply=(turn:Turn)=>{
    if(!turn.remote||turn.remote.replied)return;
    const owner=turn.answeredIn&&turn.answeredIn!==turn.id?store.find<Turn>('turn',turn.answeredIn):undefined;
    const models=turn.jobs?.length?turn.jobs.map(id=>store.get<Turn>('turn',id)).filter(job=>!job.automatic):[turn],joined=readIn(owner||turn);
    // Its own words, when another reply answered it or its reply was shared with messages read later.
    const share=owner?replyShare(owner,turn.id,joined):joined.length?replyShare(turn,turn.id,joined):null,label=(row:Turn)=>modelLabel(row.model,claude.models);
    const text=share===null?models.map(job=>replyFor(job,label(job))).join('\n\n'):turn.status!=='completed'&&turn.status!=='partial'?replyFor(turn,label(turn)):share?share+'\n\n'+label(owner||turn):'';
    // An empty share sends nothing: the answer is in the message beside it, and the mark says it is answered.
    if(text)enqueueRemoteReply(store,turn.id,backend.scrubber.text(text+(turn.remote.fallback?'\nThe picker was unsure; an available model answered.':'')));
    else store.update<Turn>('turn',turn.id,{remote:{...turn.remote,replied:true}});
    remoteMark(remoteMessageId(turn),markFor(turn.status));remoteChannel?.notify();
    if(turn.status!=='completed')remoteAlert('Remote task '+(turn.status==='stopped'?'stopped':'failed'),turn.error||turn.prompt);
  };
  for(const turn of store.turnsWith<Turn>('remote'))if(turn.remote&&!turn.remote.replied&&!turn.parentTurnId&&!turn.automatic&&ENDED.includes(turn.status)){
    const owner=turn.answeredIn&&turn.answeredIn!==turn.id?store.find<Turn>('turn',turn.answeredIn):undefined;
    if(owner){
      if(!ENDED.includes(owner.status))continue;                    // its answer is still being written
      if(owner.remote)reply(owner);else if(store.all<TopicRecord>('remote-topic').some(topic=>topic.id===owner.chatId&&(topic.status==='ready'||topic.status==='pending'||topic.status==='creating')))copyDesktopTurn(owner);
    }
    reply(store.get<Turn>('turn',turn.id));
  }
}
export function remoteRow(){return store.all<any>('settings').find(row=>row.id==='remote');}
export function remoteSettings(){return readRemote(remoteRow());}
export function remoteSave(patch:any){store.put('settings',{...remoteRow(),id:'remote',...patch});}
export function featureInstalled(feature:'telegram'|'speech'|'speech-gpu'|'voices'){
  const runtime=pluginRuntime() as any,pins=featureWheels.packages as Record<string,{version:string}>;
  return !!runtime?.features?.includes(feature)&&featureWheels.features[feature].every(name=>runtime.packages?.some((pkg:any)=>pkg.name.toLowerCase().replace(/[-_.]+/g,'-')===name&&pkg.version===pins[name].version));
}
export function telegramInstalled(){return featureInstalled('telegram');}
export function gatewayHome(){return path.join(data,'hermes-gateway');}
export function launchGateway():ChildProcess{
  const uncertain=recoverRemoteOutbox(store);if(uncertain.length)remoteAlert('Remote delivery unconfirmed',uncertain.length+' outgoing messages need review; none will be sent again automatically.');
  // A thread whose making a restart cut short is made again (its row is no longer on its way), and a thread whose
  // removal was cut short is forgotten. Old settled rows go.
  const moving=new Set(store.all<OutRecord>('remote-out').filter(row=>row.status==='pending').map(row=>row.op==='topic'?row.topicChat:row.op==='delete'?row.thread_id:undefined));
  for(const topic of store.all<TopicRecord>('remote-topic')){
    if(topic.status==='creating'&&!moving.has(topic.id))store.update<TopicRecord>('remote-topic',topic.id,{status:'failed',retryAt:0});
    if(topic.status==='deleting'&&!moving.has(topic.threadId))store.remove('remote-topic',topic.id);
  }
  pruneRemoteOutbox(store);
  const home=gatewayHome(),child=spawn(backend.python,[path.join(root,'backend','host.py')],{windowsHide:true,stdio:'pipe',env:{...backend.environment(),HERMES_HOME:home,HERMES_SHARED_AUTH_DIR:path.join(home,'shared')}});
  child.stdin.on('error',()=>{});child.stdout.on('data',()=>{});
  // The open stdin is the lease: main's end closing ends the gateway. The bot token never leaves the vault here.
  child.stdin.write(JSON.stringify({operation:'gateway',credential_namespace:namespace,owner:remoteSettings().owner,channel:remoteChannel!.rotate(),runtime:pluginRuntime()})+'\n');
  return child;
}
